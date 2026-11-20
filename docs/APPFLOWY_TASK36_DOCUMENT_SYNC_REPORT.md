# Task 36 — Document collaboration initialization and update admission

**Result:** A single authenticated AppFlowy-Web Document session initialized, submitted an ordinary-text edit over WebSocket, and recovered that edit after a browser reload and backend process restart. This is not a claim of full AppFlowy synchronization compatibility.

## Contract evidence

- The checked-out AppFlowy-Web revision is `57bdf395a17a0837baae18435b9653b619dd54ab`.
- The pinned AppFlowy-Collab revision recorded by the AppFlowy source checkout is `4dfccefb9e4fd35240107b93fb4b5966295b452e` in [Cargo.lock](../../AppFlowy/frontend/rust-lib/Cargo.lock#L974). Its client-side contract is used as evidence; unresolved server-side Redis/Rid behavior is not inferred from that pin.
- `Types.Document` is `0` in [types.ts](../../AppFlowy-Web/src/application/types.ts#L510).
- The checked-out frontend's initial Yjs page/paragraph structure is constructed by `initializeDocumentStructure` in [yjs.ts](../../AppFlowy-Web/src/application/slate-yjs/utils/yjs.ts#L332); the backend's persisted blank Document was opened by this frontend before the sync exchange.
- `bindSyncContext` emits a `SyncRequest` carrying the Yjs state vector, last `Rid`, and `doc.version` in [sync-protocol.ts](../../AppFlowy-Web/src/application/services/js-services/sync-protocol.ts#L93). `handleSyncRequest` computes the missing Yjs update and completes the manifest exchange in the same file.
- [collab.proto](../../AppFlowy-Web/src/proto/collab.proto#L28) defines the `SyncRequest` state vector and version; its `Update` carries the payload, version, and causal `before_state_vector`. The checked-in client can omit the version when `doc.version` is unset. The actual browser SyncRequest did omit it.
- The permission contract is `CollabObjectPermission` in [types.ts](../../AppFlowy-Web/src/application/types.ts#L2718), requested at `/api/workspace/{workspaceId}/collab/{objectId}/permission` by [access-api.ts](../../AppFlowy-Web/src/application/services/js-services/http/access-api.ts#L279). A failed probe left the browser editor non-editable, so the backend now returns the narrowly scoped Document permission for a persisted Document in a supported public space.
- The checked-in frontend also defines HTTP full sync at `/api/workspace/v1/{workspaceId}/collab/full-sync/batch` in [collab-api.ts](../../AppFlowy-Web/src/application/services/js-services/http/collab-api.ts#L301). That endpoint remains unimplemented.

## Implementation

- [server.js](../server.js) authorizes the Document WebSocket, accepts the observed missing `version` while rejecting an explicitly different version, sends the Yjs manifest, and handles Document updates. The update path persists before sending the server-assigned message ID and follow-up manifest.
- [server.js](../server.js) also implements the authenticated Document permission response used to enable editing; it is limited to the supported public-space ACL.
- [storage.js](../storage.js) persists the JSON document state and update metadata; [postgres-collab-repository.js](../postgres-collab-repository.js) and [postgres-storage.js](../postgres-storage.js) implement the corresponding transactional PostgreSQL path. Migration [004_document_sync_admission.sql](../migrations/004_document_sync_admission.sql) adds the required RID storage.
- [backend.test.js](../test/backend.test.js) covers the exact Document initialization/update exchange, omitted client version, durable read-back, permission response, and unauthorized access. [postgres-collab.test.js](../test/postgres-collab.test.js) covers PostgreSQL repository behavior but was not run against a database.
- [AGENT_HANDOVER.md](./AGENT_HANDOVER.md) records the current boundary and next blocker.

The absent client version is treated as “not supplied,” so the server binds the update to the persisted Document version. A non-empty version mismatch remains rejected. This matches the observed frontend request; it does not establish restore-generation or stale-client semantics.

The backend's workspace-scoped `Rid` allocator is a local MVP implementation choice. The protocol documents a server-assigned ID after storage, but authoritative allocation, replay, and cross-instance ordering semantics remain unresolved.

## Verification

| Check | Result |
|---|---|
| `npm test` | **PASS** — 13 passed, 0 failed |
| `npm run test:offline-collab` | **PASS** — 5 passed, 0 failed |
| `npm run test:collab-conformance` | **PASS** — 6 passed, 0 failed, 7 pending |
| `node --check server.js && node --check storage.js && node --check postgres-storage.js && node --check postgres-collab-repository.js && node --check test/backend.test.js` | **PASS** |
| `node --check test/postgres-collab.test.js` | **PASS** |
| PostgreSQL runtime tests | **NOT RUN** — no explicitly configured isolated test database was available |

The isolated browser used the backend at `127.0.0.1:45230` and AppFlowy-Web/Vite at `127.0.0.1:45231`; no commercial service was used. Browser DevTools observed a successful WebSocket handshake and binary frames in both directions. The editor became editable and no longer displayed “Connecting…”. Typing `task36-document-body-20261028-1543-task36-next-probe` changed the persisted Yjs state and advanced its server message ID. The exact text remained visible after browser reload and after restarting the backend against the same disposable JSON file.

After editing, the browser logged a **404** for background HTTP full sync. The frontend source identifies this request as `/api/workspace/v1/{workspaceId}/collab/full-sync/batch`; the backend does not implement it. A WebSocket reconnect attempt also failed once after the deliberate backend restart, so reconnect reliability is not established by this test. The browser displayed the recovered text after restart, but that does not prove a successful post-restart synchronization session.

## Acceptance status and boundary

1. **PASS** — Document type, initial Yjs state, initialization messages, update payload, and permission contract are supported by checked-in source and the actual browser exchange.
2. **PASS** — The browser completed initial WebSocket exchange and rendered an editable Document.
3. **PASS** — The browser's unique text update was admitted, persisted, and recovered after reload and backend process restart.
4. **PASS** — Backend tests cover authorization, persistence/read-back, and the permission response.
5. **PASS** — Backend, offline-collaboration, and conformance commands passed as listed above.
6. **BLOCKED** — PostgreSQL runtime behavior was not verified because no isolated test database was configured.
7. **BLOCKED** — HTTP full-sync batching returns 404; after a deliberate backend restart, one WebSocket reconnect attempt also failed. Full compatibility, multi-client convergence, Redis/Rid replay semantics, restore behavior, and WebSocket/HTTP convergence remain unproven.

**Next blocker:** implement and verify the checked-in frontend's HTTP full-sync batch contract. No work on that milestone was started here.

**Historical note:** Task 37 subsequently implemented and verified the Document-only HTTP batch path. See [APPFLOWY_TASK37_HTTP_FULL_SYNC_BATCH_REPORT.md](./APPFLOWY_TASK37_HTTP_FULL_SYNC_BATCH_REPORT.md) for its scope, test evidence, and remaining browser blocker.
