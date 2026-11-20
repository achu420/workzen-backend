# AppFlowy-Web minimum page-loading investigation

**Date:** 2026-10-28  
**Result:** **BLOCKED** before application-code changes. The available evidence proves client-side document and message shapes, but not a safe server initialization contract.

## Investigation findings

### Page/view and collaboration identities

- For the checked-out Web default document workflow, `page-default-creation.ts:55-76` creates a request ID and a client-generated `view_id` (unless a view ID was already supplied). The request goes to `/api/workspace/{workspaceId}/v2/page-view/document/default`; this path is selected in `atomic-creation-api.ts:9-15,113-119`.
- `created-page-hydration.ts:154-160,174-188,212-219` reads the created document collab using the folder/view ID as its object ID and `Types.Document` (`0`). The client requires the result identity/type to match and validates the AppFlowy document root.
- The legacy `page-api.ts:151-179` path explicitly sends `collab_id: view_id` when the caller supplied a view ID. This is a separate route; the source does not justify assuming every arbitrary server-generated page ID and collab ID are interchangeable.
- The browser's Task 28 startup trace instead requested `collab_type=2`. `AppFlowy-Web/src/application/types.ts:1310-1317` defines this as `Types.WorkspaceDatabase`, not a page document. `cached-api.ts:690-701` loads this object using the workspace's persisted `database_storage_id` and reads the `data.databases` relationships. That workspace-database collab record does not exist in this backend.

### Collab-state and page-view response shapes

- `collab-api.ts:439-470` calls `GET /api/workspace/v1/{workspaceId}/collab/{objectId}?collab_type=...` and expects `{ code, message, data: { object_id, doc_state: number[] } }`; it applies `doc_state` as Yjs update bytes.
- The source-provenance-aware `readCollabStates` path (`collab-api.ts:68-87`) expects `object_id`, `doc_state`, `state_vector`, `version`, and optional `collab_version`, and rejects mismatched object identity or unsupported encoding versions.
- The ordinary page loader uses `GET /api/workspace/{workspaceId}/page-view/{viewId}` and expects `data.view`, `data.encoded_collab: number[]`, `data.row_data`, and optional owner/editor data (`collab-api.ts:472-505`). A page outline entry or JSON REST page is not a substitute for this binary page state.

### Initial AppFlowy document construction and fixture limits

- The source audit confirms that `initializeDocumentStructure(doc, true, documentId)` constructs the normal page's `data.document` Yjs graph, including a structural Page block, child array, text map, and an initial Paragraph. The `Y.Doc.guid` is the collab object identity. See `AppFlowy/docs/APPFLOWY_DOCUMENT_SCHEMA_AUDIT.md:12-35` and Web `src/application/slate-yjs/utils/yjs.ts:322-419`.
- The public local fixture set contains a valid page update/state vector, database update, row updates, row-page updates, awareness messages, and sync/update protobuf envelopes. Its manifest records the byte lengths and hashes. See `AppFlowy/contracts/mvp/appflowy-golden/manifest.json` and `appflowy-golden/README.md`.
- The fixtures are fixed synthetic offline examples. They do not provide a workspace-database document fixture, a persisted user page record, an atomic-creation receipt, a server response, or evidence of server admission. The workspace-database fixture needed by the observed `collab_type=2` request is not present. The page fixture therefore cannot safely be installed as a user's page or returned as if it were that user's persisted content.
- A normal page document can be constructed and decoded offline. The available evidence and browser run do **not** establish that the current Web app will render it before a successful socket/sync initialization; no such behavior is claimed.

### WebSocket initialization and unknown server behavior

- `useAppflowyWebSocket.ts:216-224` constructs the `/ws/v2/{workspaceId}/` connection URL with client/device IDs, access token, client version, and platform.
- `sync-protocol.ts:86-124` binds a document by emitting `SyncRequest` with its state vector, last known `Rid` (default `0-0`), and document version; it separately sends awareness when present. `sync-protocol.ts:126-191` shows how the client responds if it receives a server `SyncRequest`: it calculates a Yjs state-vector diff and emits a v1 `Update` when non-empty.
- `docs/APPFLOWY_SYNC_SEMANTICS_AND_ADMISSION.md:16-29,37-45,68-74,88-103` records that the client wire shapes are known, but server allocation/order of `Rid`, divergent-cursor handling, duplicate admission, realtime acknowledgement timing, and replay behavior are unresolved. `OFFLINE_ADMISSION_CONFORMANCE.md` explicitly keeps those vectors pending. Client code and protobuf fixtures do not establish which server message sequence finishes initialization or when it is safe to treat edits as admitted.

## Browser evidence

The Task 28 actual-browser trace proves the outline request returned HTTP 200, then the first collab-state request for `collab_type=2` returned 404 and the WebSocket handshake returned 404. The browser stayed at **“Connecting...”**. Exact requests and the captured collab object/workspace IDs are in `APPFLOWY_FOLDER_OUTLINE_REPORT.md`.

No separate Task 29 browser run was started: implementing a fabricated workspace database state or a guessed WebSocket response would contradict the safety requirements. A real page load was not attempted against a new Task 29 backend, because there is no supported page record or verified server sync path to test.

## Code and safety boundary

No application code, fixtures, databases, Docker state, or services were changed or started for Task 29. The Task 28 code remains the last application implementation. The user's existing manual-test services on ports 50710, 45123, and 45124 were left untouched. PostgreSQL was not started.

## Tests

- `npm test` — **PASS**, 8 tests, 0 failures.
- `npm run test:offline-collab` — **PASS**, 5 tests, 0 failures.
- `npm run test:collab-conformance` — **PASS for confirmed vectors**, 6 passed, 0 failed, 7 pending. Pending items include server `Rid` allocation/order, duplicate admission, realtime acknowledgements, restore transitions, cross-instance replay, and HTTP/WebSocket convergence.

These are regression and offline fixture checks only; they do not prove network page loading or browser compatibility.

## Conclusion and one next action

The exact blocking contract is the authenticated, persisted `WorkspaceDatabase` collab state required at startup, followed by server-side WebSocket sync behavior for `SyncRequest`, state-vector reconciliation, `Rid` resume, and durable update admission. The existing fixtures confirm valid local Yjs/protobuf shapes but do not define these server semantics. There is also no actual AppFlowy page persisted in the new workspace to read.

**One next action:** obtain and review authoritative public server implementation or integration evidence for workspace-database initialization and the first WebSocket sync/replay exchange; resume endpoint implementation only after that contract is specified.
