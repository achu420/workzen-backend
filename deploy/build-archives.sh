#!/usr/bin/env bash
# Builds the two archives that setup-server.sh installs, into deploy/out/:
#   tracker-backend.tgz   the backend (code, migrations, templates, scripts; no node_modules, data, logs or tests)
#   tracker-web.tgz       the web app built for your address
# Usage: DOMAIN=workzen.example.com bash deploy/build-archives.sh [path-to-AppFlowy-Web]
set -Eeuo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
web="${1:-$here/../AppFlowy-Web}"
[ -n "${DOMAIN:-}" ] || { echo "set DOMAIN=your.domain.name" >&2; exit 1; }
[ -d "$web" ] || { echo "web app folder not found: $web" >&2; exit 1; }
[ -d "$web/node_modules" ] || { echo "the web app has no dependencies yet: cd $web && npx -y pnpm@10.9.0 install --frozen-lockfile" >&2; exit 1; }
out="$here/deploy/out"; rm -rf "$out"; mkdir -p "$out"

echo "== backend archive"
(cd "$here" && COPYFILE_DISABLE=1 tar -czf "$out/tracker-backend.tgz" \
  --exclude='./node_modules' --exclude='./data' --exclude='./logs' --exclude='./deploy/out' --exclude='./test' --exclude='./test-results' \
  --exclude='./playwright-report' --exclude='./.env' --exclude='./.env.*' --exclude='*.bak' --exclude='./docs/Templates' --exclude='./backups' \
  --exclude='.DS_Store' .)

echo "== web build for https://$DOMAIN"
(cd "$web" && NODE_ENV=production APPFLOWY_BASE_URL="https://$DOMAIN" APPFLOWY_GOTRUE_BASE_URL="https://$DOMAIN/gotrue" APPFLOWY_WS_BASE_URL="wss://$DOMAIN/ws/v2" \
  npx vite build --outDir "$out/web" --emptyOutDir >"$out/web-build.log" 2>&1) || { tail -20 "$out/web-build.log"; exit 1; }
COPYFILE_DISABLE=1 tar -czf "$out/tracker-web.tgz" -C "$out/web" .
rm -rf "$out/web"
ls -lh "$out"
cat <<EOF

Copy to the server and run (replace SERVER with its IP or name):
  scp "$out/tracker-backend.tgz" "$out/tracker-web.tgz" "$here/deploy/setup-server.sh" root@SERVER:/root/
  ssh root@SERVER 'DOMAIN=$DOMAIN bash /root/setup-server.sh /root/tracker-backend.tgz /root/tracker-web.tgz'
EOF
