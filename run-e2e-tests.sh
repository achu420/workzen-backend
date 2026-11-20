#!/bin/bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Working in: $BACKEND_DIR"
cd "$BACKEND_DIR"

cleanup() {
  echo "Stopping backend server..."
  [ -n "${SERVER_PID:-}" ] && kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Clean test data
rm -f ./data/appflowy-independent.json
echo "Cleared previous database."

# Start backend server
export PORT=8787 STORAGE="json" DATA_FILE="./data/appflowy-independent.json"
echo "Starting backend on port $PORT..."
node server.js > /tmp/backend.log 2>&1 &
SERVER_PID=$!
echo "Backend PID: $SERVER_PID"

# Wait for health check
for i in $(seq 1 30); do
  if curl -s http://localhost:$PORT/health >/dev/null; then
    echo "Backend ready."
    break
  fi
  sleep 1
done

# Run tests
echo "Running Playwright E2E tests..."
npx playwright test --reporter=line
exit_code=$?

# Cleanup and report
[ -f /tmp/backend.log ] && cat /tmp/backend.log > ./test/test-output.log || true
echo "Exit code: $exit_code"
exit $exit_code
