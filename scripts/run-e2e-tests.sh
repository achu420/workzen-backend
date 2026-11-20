#!/bin/bash
# E2E Test Runner for AppFlowy Independent Backend
# Usage: ./scripts/run-e2e-tests.sh [--browser chromium|firefox|webkit]

set -e

PORT=$((39000 + RANDOM % 1000))  # Random port in 39xxx range to avoid conflicts
DATA_FILE="/tmp/test-$(date +%s).json"
BROWSER="${1:-chromium}"
HEADLESS=false

echo "=== AppFlowy E2E Test Suite ==="
echo "Browser: $BROWSER"
echo "Data file: $DATA_FILE"

# Cleanup function  
cleanup() {
    echo ""
    echo "Cleaning up..."
    
    if [ -n "$SERVER_PID" ] && kill -0 $SERVER_PID 2>/dev/null; then
        kill $SERVER_PID
        wait $SERVER_PID 2>/dev/null || true
        echo "Backend stopped (PID: $SERVER_PID)"
    fi
    
    # Remove test data file if requested
    rm -f "$DATA_FILE"
}

trap cleanup EXIT

# Start isolated backend server in background
echo ""
echo "Starting isolated backend..."
node server.js --port $PORT --dataFile $DATA_FILE > /tmp/backend.log 2>&1 &
SERVER_PID=$!

# Wait for server to be ready (poll until HTTP responds)  
TIMEOUT=30
COUNT=0
until curl -s http://localhost:${PORT} >/dev/null 2>&1; do
    sleep 0.5
    COUNT=$((COUNT + 1))
    if [ $COUNT -gt $((TIMEOUT * 2)) ]; then
        echo "Error: Backend failed to start within ${TIMEOUT}s"
        cat /tmp/backend.log || true
        exit 1
    fi
done

echo "Backend ready on port ${PORT}"
echo ""

# Export environment variables for tests
export BACKEND_PORT=${PORT}
export TEST_DATA_FILE=$DATA_FILE

# Run Playwright with custom reporter and timeout
echo "Running tests..."
npx playwright test \
  --project=chromium \
  --timeout=60000 \
  --reporter=list,json \
  --output-dir=test-results \
  "$@"

RESULT=$?

# Print summary  
if [ $RESULT -eq 0 ]; then
    echo ""
    echo "=== Test Results ==="
    node -e "const fs = require('fs'); const report = JSON.parse(fs.readFileSync('playwright-report.json')); console.log(JSON.stringify(report, null, 2))" 2>/dev/null || true
    
    # Show final storage state for debugging  
    echo ""
    echo "=== Final Storage State ===" 
    node -e "const fs = require('fs'); const data = require('$DATA_FILE'); console.log(JSON.stringify(data, null, 2))" 2>/dev/null || echo "Storage file not found or empty"

else
    echo ""
    echo "Tests failed. Check logs above."
fi

exit $RESULT