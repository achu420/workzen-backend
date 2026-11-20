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
set -Eeuo pipefail

BACKEND_TGZ="${1:-}"
WEB_TGZ="${2:-}"
ENV_FILE=/etc/tracker.env
APP_DIR=/opt/tracker
DATA_DIR=/var/lib/tracker
BACKUP_DIR=/var/backups/tracker
SERVICE_USER=tracker

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
say "Mode: $([ "$UPDATE" = 1 ] && echo "update of the install for $DOMAIN" || echo "first install for $DOMAIN")"

# ---------------------------------------------------------------- DNS check (first install)
SERVER_IP="$(curl -fsS -4 --max-time 8 https://ifconfig.me 2>/dev/null || true)"
if [ "$UPDATE" = 0 ]; then
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ -z "$RESOLVED" ]; then
    die "$DOMAIN does not resolve yet. Create a DNS A record  $DOMAIN -> ${SERVER_IP:-the server IPv4 address}  at your DNS provider, wait a few minutes, then run this again (HTTPS certificates need it)."
  elif [ -n "$SERVER_IP" ] && [ "$RESOLVED" != "$SERVER_IP" ]; then
    die "$DOMAIN points to $RESOLVED but this server is $SERVER_IP. Fix the A record, wait, and run again."
  fi
  echo "DNS ok: $DOMAIN -> $RESOLVED"
fi

# ---------------------------------------------------------------- packages
say "Installing system packages (PostgreSQL, Caddy, Node 22, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades postgresql postgresql-contrib debian-keyring debian-archive-keyring apt-transport-https openssl rsync

if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
NODE_MAJOR=0
command -v node >/dev/null 2>&1 && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node --version), postgres $(psql --version | awk '{print $3}'), $(caddy version | head -1)"
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
systemctl restart tracker
printf 'Waiting for the backend'
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then echo " - up"; break; fi
  printf '.'; sleep 1
  if [ "$i" = 60 ]; then echo; journalctl -u tracker -n 40 --no-pager; die "the backend did not start; the log above says why (configuration refused? database?)"; fi
done
journalctl -u tracker -n 12 --no-pager | grep -i "config\|warn\|listening" || true

# ---------------------------------------------------------------- Caddy
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

# ---------------------------------------------------------------- firewall
if [ "${SKIP_FIREWALL:-0}" != 1 ]; then
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
  || warn "https://${DOMAIN} did not answer yet. Caddy needs a minute to get the certificate: wait, then open the address. If it still fails: journalctl -u caddy -n 50"

say "Done"
cat <<EOF
Open https://${DOMAIN} and create the first account: that person becomes the owner of the workspace.

${FIRST_SECRET:+IMPORTANT - save this secret somewhere OUTSIDE this server (password manager). Without it, saved AI keys cannot be read after a restore:
  AI_KEY_SECRET=${FIRST_SECRET}
}
Next:
  1. After the owner account exists, lock sign-up:  edit ${ENV_FILE}, set SIGNUP_ENABLED=false (and remove SIGNUP_ALLOWED_DOMAINS), then:  systemctl restart tracker
     People are then added with invitations from Settings > People (an invited e-mail address may create its account).
  2. Mail: put SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM in ${ENV_FILE}, restart, then check
     GET /api/workspace/<id>/email-status (see docs/DEPLOYMENT.md).
  3. Copy ${BACKUP_DIR} off this server regularly, and rehearse one restore (docs/DEPLOYMENT.md section 5).
  4. SSH: use a key and turn off password login when you can. Hostinger's panel firewall, if enabled, must also allow 22, 80 and 443.
Logs:   journalctl -u tracker -f        Status: systemctl status tracker caddy
Update: build new archives, copy them here, and run the same command again (no DOMAIN needed).
EOF
