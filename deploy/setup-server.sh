#!/usr/bin/env bash
# One-shot installer / updater for Ubuntu 22.04 / 24.04 (tested target: Hostinger KVM VPS, Ubuntu 24.04).
#
#   First install:   sudo DOMAIN=workzen.example.com bash setup-server.sh backend.tgz web.tgz
#   Update later:    sudo bash setup-server.sh backend.tgz web.tgz        (same command; it detects the install)
#
# What it does: installs PostgreSQL, Node 22 and Caddy (automatic HTTPS), creates a locked-down "tracker" service user,
# a database, the settings file /etc/tracker.env (generated secrets, mode 640), a systemd service, the Caddy site, a
# firewall (SSH, 80, 443 only) and a nightly verified backup. It takes a backup before an update, waits for the service to
# answer, and stops with a clear message if anything fails. Safe to run again.
#
# Optional environment variables (first install only; afterwards edit /etc/tracker.env):
#   DOMAIN            public name, required on first install; its DNS A record must already point at this server
#   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS EMAIL_FROM     outgoing mail
#   SIGNUP_ALLOWED_DOMAINS   e.g. "yourcompany.com": only those addresses may create accounts.
#                            Leave empty to open sign-up for the first account; then lock it (see the end of the output).
#   SKIP_FIREWALL=1   do not touch ufw
#   PROXY=nginx       shared server: an nginx already serves other sites on 80/443. Workzen is added as one more nginx site
#                     (certificate from certbot); Caddy, the firewall, fail2ban and an existing Node are left alone.
#                     Remembered for updates. Default: PROXY=caddy (a server of its own).
#   CERTBOT_EMAIL     PROXY=nginx only: address Let's Encrypt writes to about expiring certificates (optional)
#   SKIP_DNS_CHECK=1  do not compare the domain's DNS with this server's public address (behind NAT, or tests)
set -Eeuo pipefail

BACKEND_TGZ="${1:-}"
WEB_TGZ="${2:-}"
ENV_FILE=/etc/tracker.env
APP_DIR=/opt/tracker
DATA_DIR=/var/lib/tracker
BACKUP_DIR=/var/backups/tracker
SERVICE_USER=tracker
DEPLOY_CONF=/etc/tracker-deploy.conf
NGINX_SITE=/etc/nginx/sites-available/workzen.conf
ACME_ROOT=/var/www/workzen-acme

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "stopped at line $LINENO (command: $BASH_COMMAND). Nothing after that step was done; fix the cause and run the same command again."' ERR

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -r /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script is for Ubuntu (found: ${PRETTY_NAME:-unknown})"
[ -n "$BACKEND_TGZ" ] && [ -f "$BACKEND_TGZ" ] || die "usage: bash setup-server.sh <backend.tgz> <web.tgz>   (backend archive not found: '$BACKEND_TGZ')"
[ -n "$WEB_TGZ" ] && [ -f "$WEB_TGZ" ] || die "web archive not found: '$WEB_TGZ'"

UPDATE=0
[ -f "$ENV_FILE" ] && UPDATE=1
if [ "$UPDATE" = 0 ]; then
  [ -n "${DOMAIN:-}" ] || die "first install needs DOMAIN=your.domain.name in front of the command"
else
  DOMAIN="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | head -1 | sed -E 's#^PUBLIC_URL=https?://##; s#/.*##')"
  [ -n "$DOMAIN" ] || die "could not read PUBLIC_URL from $ENV_FILE"
fi
[ -z "${PROXY:-}" ] && [ -f "$DEPLOY_CONF" ] && PROXY="$(sed -n 's/^PROXY=//p' "$DEPLOY_CONF")"
PROXY="${PROXY:-caddy}"
case "$PROXY" in caddy|nginx) ;; *) die "PROXY must be caddy or nginx (got '$PROXY')" ;; esac
say "Mode: $([ "$UPDATE" = 1 ] && echo "update of the install for $DOMAIN" || echo "first install for $DOMAIN"), front door: $PROXY"

# ---------------------------------------------------------------- what else uses this server
port_owner() { ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1; }
if [ "$PROXY" = caddy ]; then
  for port in 80 443; do
    owner="$(port_owner "$port")"
    [ -z "$owner" ] || [ "$owner" = caddy ] \
      || die "port $port is already used by '$owner' (another website on this server?). Run again with PROXY=nginx in front of the command to add Workzen next to it (docs/DEPLOYMENT.md, section 2c)."
  done
else
  command -v nginx >/dev/null 2>&1 || die "PROXY=nginx, but nginx is not installed here. Use the default (Caddy) on a server of its own."
  nginx -t >/dev/null 2>&1 || die "the existing nginx configuration does not pass 'nginx -t' before any change; fix that first (nothing was changed)."
  if grep -rlE "server_name[^;]*[[:space:]]${DOMAIN//./\\.}([[:space:];]|$)" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -qv "/workzen.conf$"; then
    die "another nginx site already uses server_name $DOMAIN; remove it or pick another DOMAIN (nothing was changed)."
  fi
fi
# DATABASE_URL points at 127.0.0.1:5432, so that port must be this machine's own PostgreSQL (or free), not e.g. a container.
PG_PORT_OWNER="$(port_owner 5432)"
[ -z "$PG_PORT_OWNER" ] || [ "$PG_PORT_OWNER" = postgres ] \
  || die "port 5432 is used by '$PG_PORT_OWNER', not by a PostgreSQL installed on this machine (a database in a container?). Nothing was changed; see docs/DEPLOYMENT.md section 2c."

# ---------------------------------------------------------------- DNS check (first install)
if [ "$UPDATE" = 0 ] && [ "${SKIP_DNS_CHECK:-0}" != 1 ]; then
  SERVER_IP="$(curl -fsS -4 --max-time 8 https://ifconfig.me 2>/dev/null || true)"
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ -z "$RESOLVED" ]; then
    die "$DOMAIN does not resolve yet. Create a DNS A record  $DOMAIN -> ${SERVER_IP:-the server IPv4 address}  at your DNS provider, wait a few minutes, then run this again (HTTPS certificates need it)."
  elif [ -n "$SERVER_IP" ] && [ "$RESOLVED" != "$SERVER_IP" ]; then
    die "$DOMAIN points to $RESOLVED but this server is $SERVER_IP. Fix the A record, wait, and run again."
  fi
  echo "DNS ok: $DOMAIN -> $RESOLVED"
fi

# ---------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
if [ "$PROXY" = caddy ]; then
  say "Installing system packages (PostgreSQL, Caddy, Node 22, firewall)"
  apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades postgresql postgresql-contrib debian-keyring debian-archive-keyring apt-transport-https openssl rsync
  if ! command -v caddy >/dev/null 2>&1; then
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
  fi
else
  say "Installing system packages (PostgreSQL, certbot, Node 22 if missing); nginx and the firewall stay as they are"
  apt-get install -y ca-certificates curl gnupg postgresql postgresql-contrib openssl rsync
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot
fi
NODE_MAJOR=0
command -v node >/dev/null 2>&1 && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  # On a shared server another app may rely on the installed Node; replacing it is the operator's call.
  [ "$PROXY" = caddy ] || [ "$NODE_MAJOR" = 0 ] || [ "${ALLOW_NODE_UPGRADE:-0}" = 1 ] \
    || die "Node $(node --version) is installed and Workzen needs 20+. Upgrading replaces it for every app on this server: if that is fine, run again with ALLOW_NODE_UPGRADE=1 in front of the command."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node --version), postgres $(psql --version | awk '{print $3}'), $([ "$PROXY" = caddy ] && caddy version | head -1 || nginx -v 2>&1)"
systemctl enable --now postgresql

# ---------------------------------------------------------------- user and folders
say "Service user and folders"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR/backend/logs" "$APP_DIR/web" "$DATA_DIR/files" "$BACKUP_DIR"

# ---------------------------------------------------------------- backup before an update
if [ "$UPDATE" = 1 ] && systemctl is-active --quiet tracker; then
  say "Backing up before the update"
  sudo -u "$SERVICE_USER" bash -c "set -a; . $ENV_FILE; set +a; cd $APP_DIR/backend && node scripts/backup.mjs --out $BACKUP_DIR --keep 14"
  systemctl stop tracker
fi

# ---------------------------------------------------------------- code
say "Installing the backend and the web app"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar -xzf "$BACKEND_TGZ" -C "$TMP" && mkdir -p "$TMP/backend-src"
# the archive holds the backend folder's contents at its top level
rsync -a --delete --exclude node_modules --exclude logs "$TMP/" "$APP_DIR/backend/" --exclude backend-src
mkdir -p "$APP_DIR/backend/logs"
rm -rf "$APP_DIR/web.new" && mkdir -p "$APP_DIR/web.new"
tar -xzf "$WEB_TGZ" -C "$APP_DIR/web.new"
rm -rf "$APP_DIR/web.old"; [ -d "$APP_DIR/web" ] && mv "$APP_DIR/web" "$APP_DIR/web.old"; mv "$APP_DIR/web.new" "$APP_DIR/web"
[ -f "$APP_DIR/web/index.html" ] || die "the web archive has no index.html at its top level"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$APP_DIR/backend"
chmod -R a+rX "$APP_DIR/web"
chown -R root:root "$APP_DIR/web"; chmod -R a+rX "$APP_DIR/web"
sudo -u "$SERVICE_USER" bash -c "cd $APP_DIR/backend && npm ci --omit=dev --no-audit --no-fund"

# ---------------------------------------------------------------- database and settings (first install)
if [ "$UPDATE" = 0 ]; then
  say "Database and settings"
  DB_PASS="$(openssl rand -hex 24)"
  AI_SECRET="$(openssl rand -hex 32)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -tc "SELECT 1 FROM pg_roles WHERE rolname='tracker'" | grep -q 1 \
    || sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE tracker LOGIN PASSWORD '$DB_PASS'"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE tracker PASSWORD '$DB_PASS'"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='tracker'" | grep -q 1 \
    || sudo -u postgres createdb -O tracker tracker
  if [ -n "${SIGNUP_ALLOWED_DOMAINS:-}" ]; then
    SIGNUP_LINES="SIGNUP_ENABLED=true
SIGNUP_ALLOWED_DOMAINS=${SIGNUP_ALLOWED_DOMAINS}"
  else
    SIGNUP_LINES="# Sign-up is OPEN so the first (owner) account can be created. Change to SIGNUP_ENABLED=false afterwards.
SIGNUP_ENABLED=true"
  fi
  umask 027
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
STORAGE=postgres
DATABASE_URL=postgresql://tracker:${DB_PASS}@127.0.0.1:5432/tracker
DATA_FILE=${DATA_DIR}/state.json
FILE_STORAGE_DIR=${DATA_DIR}/files
AI_KEY_SECRET=${AI_SECRET}
TRUST_PROXY=true
HSTS=true
CORS_ALLOWED_ORIGINS=
PUBLIC_URL=https://${DOMAIN}
${SIGNUP_LINES}
SMTP_HOST=${SMTP_HOST:-}
SMTP_PORT=${SMTP_PORT:-587}
SMTP_USER=${SMTP_USER:-}
SMTP_PASS=${SMTP_PASS:-}
EMAIL_FROM=${EMAIL_FROM:-}
# EMAIL_NOTIFICATIONS=true
EOF
  chown root:"$SERVICE_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  umask 022   # everything created from here on (unit file, Caddyfile) must be readable by its service
  # An empty SMTP_HOST must read as "mail not configured", so drop the empty lines.
  if [ -z "${SMTP_HOST:-}" ]; then sed -i '/^SMTP_\(HOST\|PORT\|USER\|PASS\)=/d; /^EMAIL_FROM=/d' "$ENV_FILE"; echo "# SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASS= EMAIL_FROM=   (fill in to send e-mail, then restart)" >> "$ENV_FILE"; fi
  FIRST_SECRET="$AI_SECRET"
fi

# ---------------------------------------------------------------- systemd
say "Service"
cat > /etc/systemd/system/tracker.service <<EOF
[Unit]
Description=Team tracker backend
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}/backend
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${APP_DIR}/backend/logs ${BACKUP_DIR}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tracker >/dev/null
systemctl stop tracker 2>/dev/null || true
BACKEND_PORT_OWNER="$(port_owner 8787)"
[ -z "$BACKEND_PORT_OWNER" ] || die "port 8787 is already used by '$BACKEND_PORT_OWNER' (another app on this server); the backend needs it on 127.0.0.1."
systemctl restart tracker
printf 'Waiting for the backend'
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then echo " - up"; break; fi
  printf '.'; sleep 1
  if [ "$i" = 60 ]; then echo; journalctl -u tracker -n 40 --no-pager; die "the backend did not start; the log above says why (configuration refused? database?)"; fi
done
journalctl -u tracker -n 12 --no-pager | grep -i "config\|warn\|listening" || true

printf 'PROXY=%s\n' "$PROXY" > "$DEPLOY_CONF"

# ---------------------------------------------------------------- nginx (PROXY=nginx: next to the sites already there)
# Only $NGINX_SITE (and its sites-enabled link) is ever written; every change is checked with nginx -t first and
# undone if it fails, and nginx is reloaded (never restarted), so the other sites keep serving throughout.
write_nginx_site() { # $1: "tls" once the certificate exists, otherwise only the port 80 part
  local ipv6=0 proxy loaded
  # Captured first: with pipefail, grep -q closing the pipe early would make "nginx -T | grep -q" fail at random.
  loaded="$(nginx -T 2>/dev/null || true)"
  grep -qE '^\s*listen\s+\[::\]' <<<"$loaded" && ipv6=1
  proxy="proxy_pass http://127.0.0.1:8787;
		proxy_http_version 1.1;
		proxy_set_header Host \$host;
		proxy_set_header X-Forwarded-For \$remote_addr;
		proxy_set_header X-Forwarded-Proto \$scheme;
		proxy_set_header Upgrade \$http_upgrade;
		proxy_set_header Connection \$workzen_connection_upgrade;
		proxy_read_timeout 1h;
		proxy_send_timeout 1h;
		proxy_buffering off;"
  {
    echo "# Workzen - written by setup-server.sh on every run; edit the script, not this file."
    echo "map \$http_upgrade \$workzen_connection_upgrade { default upgrade; '' close; }"
    echo "server {"
    echo "	listen 80;"; [ "$ipv6" = 1 ] && echo "	listen [::]:80;"
    echo "	server_name ${DOMAIN};"
    echo "	location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }"
    echo "	location / { return 301 https://\$host\$request_uri; }"
    echo "}"
    if [ "$1" = tls ]; then
      cat <<EOF
server {
	listen 443 ssl http2;
$([ "$ipv6" = 1 ] && printf '\tlisten [::]:443 ssl http2;')
	server_name ${DOMAIN};
	ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
	client_max_body_size 110m;
	gzip on;
	gzip_types text/css application/javascript application/json image/svg+xml text/plain;
	root ${APP_DIR}/web;

	location ~ ^/(api|ws)/ {
		${proxy}
	}
	location = /mcp {
		${proxy}
	}
	location = /health {
		${proxy}
	}
	location /gotrue/ {
		${proxy/http:\/\/127.0.0.1:8787;/http://127.0.0.1:8787/;}
	}
	# The backend sets these on its own responses; here only for the static web app.
	location / {
		add_header X-Content-Type-Options nosniff always;
		add_header Referrer-Policy no-referrer always;
		add_header X-Frame-Options DENY always;
		add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
		try_files \$uri /index.html;
	}
}
EOF
    fi
  } > "$NGINX_SITE.new"
  [ -f "$NGINX_SITE" ] && cp "$NGINX_SITE" "$NGINX_SITE.previous"
  mv "$NGINX_SITE.new" "$NGINX_SITE"
  ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/workzen.conf
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t || true
    if [ -f "$NGINX_SITE.previous" ]; then mv "$NGINX_SITE.previous" "$NGINX_SITE"; else rm -f "$NGINX_SITE" /etc/nginx/sites-enabled/workzen.conf; fi
    die "the Workzen nginx site did not pass nginx -t (output above); it was taken out again and nginx was not reloaded, so the other sites are untouched."
  fi
  rm -f "$NGINX_SITE.previous"
  systemctl reload nginx
  loaded="$(nginx -T 2>/dev/null || true)"
  grep -qF "server_name ${DOMAIN};" <<<"$loaded" \
    || die "nginx does not read /etc/nginx/sites-enabled/ (its nginx.conf has no include for it); add 'include /etc/nginx/sites-enabled/*;' to the http block and run again."
}

if [ "$PROXY" = nginx ]; then
  say "HTTPS front door (a site in the existing nginx)"
  mkdir -p "$ACME_ROOT"
  if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    write_nginx_site http
    certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring \
      ${CERTBOT_EMAIL:+-m "$CERTBOT_EMAIL"} $([ -z "${CERTBOT_EMAIL:-}" ] && echo --register-unsafely-without-email) \
      --deploy-hook "systemctl reload nginx" \
      || die "certbot could not get a certificate for $DOMAIN (output above). Usually DNS does not point here yet, or port 80 is blocked in the provider's firewall. Workzen is only reachable over plain HTTP for now; the other sites are untouched. Fix it and run the same command again."
  fi
  write_nginx_site tls
  systemctl is-active --quiet nginx || die "nginx is not running after the reload"
fi

# ---------------------------------------------------------------- Caddy
if [ "$PROXY" = caddy ]; then
say "HTTPS front door (Caddy)"
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	encode gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
	}
	@backend path /api/* /ws/* /mcp /health
	handle @backend {
		reverse_proxy 127.0.0.1:8787
	}
	handle_path /gotrue/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		root * ${APP_DIR}/web
		try_files {path} /index.html
		file_server
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable --now caddy
systemctl reload caddy
fi

# ---------------------------------------------------------------- firewall
if [ "$PROXY" = nginx ]; then
  echo "Firewall left as it is (shared server). Ports 80 and 443 must already be open for the other sites."
elif [ "${SKIP_FIREWALL:-0}" != 1 ]; then
  say "Firewall (SSH, 80, 443)"
  # Never lock yourself out: allow every port sshd is configured for (22 if it cannot be read).
  SSH_PORTS="$(sshd -T 2>/dev/null | awk '/^port / {print $2}' | sort -u)"; SSH_PORTS="${SSH_PORTS:-22}"
  for port in $SSH_PORTS; do ufw allow "${port}/tcp" >/dev/null; done
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status | head -8
fi

# ---------------------------------------------------------------- nightly backup
say "Nightly backup (03:00, 14 kept in $BACKUP_DIR)"
cat > /etc/cron.d/tracker-backup <<EOF
0 3 * * * ${SERVICE_USER} bash -c 'set -a; . ${ENV_FILE}; set +a; cd ${APP_DIR}/backend && node scripts/backup.mjs --out ${BACKUP_DIR} --keep 14' >> ${APP_DIR}/backend/logs/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/tracker-backup

# ---------------------------------------------------------------- smoke test
say "Smoke test"
curl -fsS http://127.0.0.1:8787/api/server-info | head -c 200; echo
curl -fsS -o /dev/null -w "front door over HTTPS: HTTP %{http_code}\n" --max-time 30 "https://${DOMAIN}/api/server-info" \
  || warn "https://${DOMAIN} did not answer yet. $([ "$PROXY" = caddy ] && echo "Caddy needs a minute to get the certificate: wait, then open the address. If it still fails: journalctl -u caddy -n 50" || echo "Check: nginx -t, journalctl -u nginx -n 50, and that $DOMAIN resolves to this server")"

say "Done"
cat <<EOF
Open https://${DOMAIN} and create the first account: that person becomes the owner of the workspace.

${FIRST_SECRET:+IMPORTANT - save this secret somewhere OUTSIDE this server (password manager). Without it, saved AI keys cannot be read after a restore:
  AI_KEY_SECRET=${FIRST_SECRET}
}
Next:
  1. If sign-up is open to anyone (no SIGNUP_ALLOWED_DOMAINS), close it once the owner account exists:  edit ${ENV_FILE}, set SIGNUP_ENABLED=false, then:  systemctl restart tracker
     People are then added with invitations from Settings > People (an invited e-mail address may create its account).
  2. Mail: put SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM in ${ENV_FILE}, restart, then check
     GET /api/workspace/<id>/email-status (see docs/DEPLOYMENT.md).
  3. Copy ${BACKUP_DIR} off this server regularly, and rehearse one restore (docs/DEPLOYMENT.md section 5).
  4. SSH: use a key and turn off password login when you can. Hostinger's panel firewall, if enabled, must also allow 22, 80 and 443.
Logs:   journalctl -u tracker -f        Status: systemctl status tracker ${PROXY}
Update: build new archives, copy them here, and run the same command again (no DOMAIN needed).
EOF
