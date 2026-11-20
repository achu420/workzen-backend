# Task 35 — Atomic Default Document Creation Report

## Result

The checked-out AppFlowy-Web created and displayed a persisted blank Document in the independent backend. This verifies initial page creation and rendering only. The editor remains at **“Connecting…”**; editing and collaborative persistence are not implemented or claimed.

## Contract and implementation

The frontend contract is evidenced by:

- `AppFlowy-Web/src/application/atomic-creation/types.ts`: `CreateDefaultDocumentPageRequest` and `AtomicPageResult`.
- `AppFlowy-Web/src/application/services/js-services/http/atomic-creation-api.ts`: maps the `document` kind to `document/default` and posts to `/api/workspace/{workspaceId}/v2/page-view/{kind}`.
- `AppFlowy-Web/src/application/slate-yjs/utils/yjs.ts`: constructs the initial page, paragraph, children and text maps using deterministic IDs.
- `AppFlowy-Web/src/application/services/js-services/http/created-page-hydration.ts`: validates the root page block, parent relationship, child arrays and text maps before hydration.
- `AppFlowy-Web/src/application/services/js-services/http/collab-api.ts`: reads page-view data and converts `encoded_collab` to binary for the client.

The backend implements the authenticated default-Document route, validates the request and its public-space parent, constructs the initial Yjs state, and returns an AppFlowy `{ code, message, data }` receipt. The JSON store persists the page, collaboration state and request receipt together; PostgreSQL uses one transaction for the page, collaboration state and idempotency record. Reusing the same request ID and body returns `already_applied`; reuse for a different request is rejected.

The frontend permits `start`, `end`, `index` and `after` positions. This implementation accepts `start` and `end`, which covers the exercised New Page flow; the other position variants remain unsupported.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Expected atomic Document contract is supported by source evidence | PASS | Frontend request types, route mapping, Yjs initializer and hydration validator listed above |
| 2 | Collaboration read returns a valid object in the verified format | PASS | Browser-loaded page-view response was HTTP 200 with `view` and `data: { encoded_collab, row_data }`; the frontend displayed the initialized blank Document |
| 3 | Object is persisted and scoped to the correct workspace | PASS | Backend regression test reads the created page and collaboration record back from the store; the browser-created page-view reads also returned HTTP 200 |
| 4 | Authorized and unauthorized access tests pass | PASS | Regression test covers unauthenticated requests, invalid credentials, another user's workspace, invalid input and a parent space outside the authorized workspace |
| 5 | Existing backend and relevant collaboration tests pass | PASS | Backend, offline-collaboration, conformance and focused frontend hydration test results below. PostgreSQL runtime tests were skipped because no database was configured |
| 6 | Real frontend request is verified, if environment allows | PASS | Isolated browser used backend port `45220` and Vite port `45221`; no commercial services were used |
| 7 | Next browser/network blocker is recorded without claiming full compatibility | PASS | Browser remained at “Connecting…” with `InlineComment` revalidation retries reporting `websocket-reconnect`; Document WebSocket initialization/update admission is not implemented |

## Browser evidence and limits

Using disposable test data and an isolated account, the browser created Documents through the actual UI. It displayed an `Untitled` page with the expected blank paragraph. Authenticated reads of both created page-view records returned HTTP 200 with the expected `view` and `data` envelope; each `encoded_collab` contained 827 bytes and `row_data` was empty. These results establish page creation, persisted initial state and page rendering—not a successful editor connection.

No edit was attempted. Durable edit admission, acknowledgement, restart-after-edit, reconnect and collaborative convergence remain untested and unimplemented. PostgreSQL atomicity is supported by transaction code but was not exercised at runtime because no isolated test database was configured.

The backend advertises both atomic-creation flags to enable the verified default-Document path. The current frontend exposes these as global flags rather than per-creation-kind capabilities; its other default database routes are not implemented here. Those routes must not be presented as supported.

## Files changed

- `page-document.js` — source-derived initial Document Yjs state and stable IDs.
- `server.js` — atomic default-Document route, capability advertisement, page collaboration read, page-view read and outline projection.
- `storage.js` — JSON persistence for page state and idempotency receipts.
- `postgres-storage.js` — transactional PostgreSQL persistence and reads.
- `migrations/003_atomic_document_creation.sql` — page presentation metadata and atomic-request ledger.
- `test/backend.test.js` — initial-state, persistence, authorization, idempotency, outline and page-view regression coverage.
- `docs/AGENT_HANDOVER.md` — Task 35 status, validation evidence and blocker.
- `docs/APPFLOWY_TASK35_ATOMIC_PAGE_CREATION_REPORT.md` — this report.

The AppFlowy-Web checkout was not modified. Its pre-existing modified `vite.config.ts` and untracked files were preserved.

## Validation

Commands were run from `/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend`, except the focused Jest test, which was run from the AppFlowy-Web checkout:

| Command | Result |
|---|---|
| `npm test` | Passed: 12 tests, 0 failures |
| `npm run test:offline-collab` | Passed: 5 tests, 0 failures |
| `npm run test:collab-conformance` | Passed: 6, 0 failures; 7 protocol vectors remain pending |
| `env -u DATABASE_URL RUN_POSTGRES_TESTS=1 npm run test:postgres` | 3 skipped, 0 failures; no database was contacted |
| `node --check server.js && node --check storage.js && node --check postgres-storage.js && node --check page-document.js` | Passed |
| `./node_modules/.bin/jest src/application/services/js-services/http/__tests__/created-page-hydration.test.ts --runInBand --no-coverage` | Passed: 19 tests, 0 failures |

The isolated backend and Vite processes were stopped; browser local storage was cleared; temporary test data and the temporary Vite configuration were removed; ports `45220` and `45221` were verified free.

## Next single blocker

Implement and verify the Document-specific WebSocket initialization and durable update path required to move the actual browser beyond “Connecting…”. Do not claim editing works until a real edit is transmitted, durably persisted, and read back.
