#!/bin/sh
# Runs everything that can run without a browser: the default suite (JSON storage) and, when DATABASE_URL points at a
# DISPOSABLE PostgreSQL database, the PostgreSQL suites. Fails on the first failing step.
#   DATABASE_URL=postgres://user@127.0.0.1:5432/disposable_test sh scripts/ci.sh
set -eu
cd "$(dirname "$0")/.."
export API_LOG_FILE="${API_LOG_FILE:-/dev/null}"

echo "== default suite (JSON storage)"
npm test

if [ -n "${DATABASE_URL:-}" ]; then
  echo "== PostgreSQL suites against $(echo "$DATABASE_URL" | sed 's#//[^@]*@#//***@#')"
  RUN_POSTGRES_TESTS=1 npm run test:postgres
  npm run test:pg-features
  npm run test:pg-modes
else
  echo "== PostgreSQL suites skipped (set DATABASE_URL to a disposable database to run them)"
fi
echo "== all steps passed"
