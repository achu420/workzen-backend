# E2E Testing Guide for AppFlowy Independent Backend

This document describes the end-to-end testing framework using Playwright and an isolated backend instance.

## Architecture

The test suite uses a "screen object" pattern combined with an isolated backend runner:

- **Screens**: UI abstraction layer (e.g., LoginScreen, WorkspaceScreen)
- **Backend Manager**: Starts/stops isolated backend instances on random ports  
- **Tests**: Orchestrate screens and assert backend state via storage inspection

## Running Tests

### Prerequisites

```bash
npm install playwright
npx playwright install chromium  # or firefox/webkit
```

### Quick Start (Phase 1)

Run the login flow tests:

```bash
./scripts/run-e2e-tests.sh --browser=chromium
```

Or with explicit project name:
```bash
npx playwright test test/tests/login.spec.ts --project=chromium
```

## Test Phases

### Phase 1: Authentication & Workspace Access (Implemented)

**File**: `test/tests/login.spec.ts`  
**Coverage**:
- Browser-based signup (POST /token)
- Browser-based login with credentials  
- Error handling for invalid credentials
- Workspace selection navigation

**How it works**:
1. Starts isolated backend on random port, writes to `/tmp/test-*.json`
2. Launches browser and navigates to http://localhost:${PORT}
3. Performs signup/login via UI interactions (filling forms, clicking buttons)
4. Asserts navigation to workspace selector screen (`/workspace/:id`)
5. Optionally verifies JSON storage contains user record

### Phase 2: Workspace & Space Management (Planned)

Will cover:
- Creating public spaces  
- Navigating to space home page  
- Creating pages/documents via UI  
- Persisting content and verifying reload after refresh

### Phase 3: Collaboration Protocol (Future)

Will cover:
- WebSocket handshake and authentication  
- SyncRequest/SyncUpdate message flow  
- Yjs state reconciliation between clients
- Real-time synchronization validation

## Screen Object Pattern

Each screen class extends `BaseScreen` and provides:
- `init()` - Navigate to page, wait for load  
- `cleanup()` - Close browser context
- Domain-specific methods (e.g., `signup()`, `login()`)
- Debug helpers (`getDebugInfo()`, `getStorageState()`)

Example usage:
```typescript
const screen = new LoginScreen(browser);
await screen.init();
await screen.signup('user@example.com');
await screen.verifyWorkspaceSelectionVisible();
```

## Storage Inspection

Tests can inspect the JSON storage file to verify backend state:

```typescript
const data = require('../helpers/storage-reader').readDataFile(dataPath);
expect(data.userMap).toBeDefined();
```

This allows verification that HTTP requests actually persisted data.

## Troubleshooting

**Backend fails to start**:  
Check `dist/index.js` exists (run `npm run build` first)

**Browser cannot connect**:  
Ensure `BACKEND_PORT` is exported and Playwright can resolve http://localhost:${PORT}

**Test hangs on navigation**:  
Add debug logs:
```typescript
console.log('Current URL:', await page.url());
console.log('HTML snippet:', await page.content().substring(0, 500));
```

## Adding New Tests

1. Create screen class if needed (e.g., `WorkspaceScreen`)  
2. Add test case in `.spec.ts` file or new file  
3. Use `test.describe()` for grouping  
4. Follow Arrange-Act-Assert pattern  

**Note**: Each test runs against an isolated backend instance to avoid cross-test contamination.

## Integration with CI/CD

The runner script automatically:
1. Allocates a random port (0)  
2. Starts the server in background  
3. Waits for HTTP readiness via curl polling  
4. Runs tests with timeout 60s per test  
5. Cleans up and displays storage state on completion  

For CI environments, set `CI=true` to enable headed mode debugging when failures occur.
