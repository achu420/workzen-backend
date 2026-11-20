# Task 37 — AppFlowy HTTP full-sync batch

**Result:** Implemented and verified a bounded, authenticated Document-only (`collab_type=0`) HTTP batch synchronization path. This is not a claim of full AppFlowy synchronization compatibility.

## Contract evidence

- The checked-out AppFlowy-Web revision is `57bdf395a17a0837baae18435b9653b619dd54ab`.
- `collabFullSyncBatch` in [collab-api.ts](../../AppFlowy-Web/src/application/services/js-services/http/collab-api.ts#L295) posts a protobuf `CollabBatchSyncRequest` to `POST /api/workspace/v1/{workspaceId}/collab/full-sync/batch` with `application/octet-stream`, then decodes an `application/octet-stream` `CollabBatchSyncResponse` ([request and decode](../../AppFlowy-Web/src/application/services/js-services/http/collab-api.ts#L329)).
- The request item schema in [collab.proto](../../AppFlowy-Web/src/proto/collab.proto#L125) carries object ID, collab type, compression, state vector, document state, optional version, and optional restore ID. The batch also specifies response compression ([batch messages](../../AppFlowy-Web/src/proto/collab.proto#L148)). The response schema carries a per-item missing update, error, server state vector, version, and `Rid` message ID ([result messages](../../AppFlowy-Web/src/proto/collab.proto#L158)).
- The client supports uncompressed payloads and gzip-compressed slow-sync payloads and requests an uncompressed response ([compression and protobuf construction](../../AppFlowy-Web/src/application/services/js-services/http/collab-api.ts#L307)).

## Implementation

- [server.js](../server.js#L377) adds the authenticated batch route, media-type and bounded-body checks, protobuf validation, and per-item workspace/page authorization.
- Document requests reconcile Yjs state vectors; admitted deltas go through the existing `acceptPageCollabUpdate` storage abstraction before a success response is constructed ([reconciliation and persistence](../server.js#L426)). Stale versions return the server version/state without admitting the submitted state. Restore-generation mismatches, invalid vectors, unsupported compression, inaccessible objects, and unsupported collaboration types produce explicit per-item errors.
- [collab-protocol.js](../collab-protocol.js#L18) adds source-derived protobuf descriptors and codecs.
- [backend.test.js](../test/backend.test.js#L815) covers batch persistence/read-back, two objects, stale-state probes, workspace authorization, gzip, stale-version non-admission, restore mismatch, invalid vectors, malformed protobuf, and incorrect media type.

The route intentionally supports Documents only. Other collaboration types return `unsupported_collab_type`; it does not implement Redis stream allocation/replay, authoritative restore transitions, cross-instance ordering, compaction, or WebSocket/HTTP acknowledgement convergence. PostgreSQL uses the existing storage abstraction but was not runtime-tested because no isolated test database was configured.

## Verification

| Check | Result |
|---|---|
| `npm test` | **PASS** — 14 passed, 0 failed |
| `npm run test:offline-collab` | **PASS** — 5 passed, 0 failed |
| `npm run test:collab-conformance` | **PASS** — 6 passed, 0 failed, 7 pending |
| PostgreSQL runtime tests | **NOT RUN** — no explicitly configured isolated test database was available |

The isolated browser used only the independent backend at `127.0.0.1:45240` and AppFlowy-Web/Vite at `127.0.0.1:45241`. In the authenticated browser, the checked-out frontend's `collabFullSyncBatch` function sent a Document request and received HTTP **200** with `application/octet-stream`; the frontend protobuf decoder returned a successful Document result with `appflowy-page-v1`, a server state vector, and a message ID. The browser's normal edit path did not automatically select HTTP slow sync while its WebSocket remained open; the checked-out helper was invoked directly in the browser to exercise the exact HTTP client code.

The unique text marker entered during Task 36 over the WebSocket path remained editable and was recovered after this task's browser reload and backend restart against the same disposable JSON store. The Task 37 browser batch request sent the current state; it did not introduce a new browser edit through HTTP. The batch upload/persist/read-back path is covered by the backend integration test. This verifies recovery of the marker, not multi-client convergence or the unresolved global `Rid`/replay semantics.

After reload, DevTools recorded actual 404 responses for auxiliary client calls, including `GET /api/workspace/{workspaceId}/view/{pageId}/navigation?depth=0`, which logged a selected-view hydration failure and “We couldn't find this content.” Other 404s were observed for user update, favorites, sharing view, workspace database catalog, trash, recent pages, workspace profile, and inline-comment requests. The navigation-hydration route is the next page-flow blocker; no related endpoints were added in this task.

## Acceptance status

1. **PASS** — Request, response, compression, and metadata contract supported by the checked-out frontend protobuf and client implementation.
2. **PASS** — The exact frontend HTTP helper received and decoded a successful protobuf response in the authenticated browser.
3. **PASS** — Existing edit/recovery behavior remained intact: the Task 36 WebSocket marker survived reload and backend restart. HTTP batch upload persistence was verified in the backend regression test, not by introducing a new edit through the browser batch call.
4. **PASS** — The next actual browser blocker was recorded: selected-view navigation hydration returns 404.
5. **PASS** — Backend, offline-collaboration, and conformance test commands passed as listed.
6. **PASS** — The browser and temporary resources started for this test were cleaned up; no commercial service was used or changed.

**Next single task:** establish and implement the checked-out frontend's selected-view navigation hydration contract, beginning with the observed `GET /api/workspace/{workspaceId}/view/{pageId}/navigation?depth=0` request. Do not treat this recommendation as permission to begin it automatically.
