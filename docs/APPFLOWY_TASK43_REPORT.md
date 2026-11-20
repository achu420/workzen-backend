# Task 43 — WebSocket/HTTP Convergence Fixture (test-first)

**Date:** 2026-11-05
**Nature of this task:** test-first. Only `test/backend.test.js` and `test/collab-conformance.js` were changed. No production code was modified — the new test passed cleanly against the existing implementation; no defect was found or needed fixing.

## 1. Test design

Added a new test to `test/backend.test.js`:

> `websocket-http-convergence: WebSocket update and HTTP full-sync/batch update converge on one durable document state`

It runs on the existing isolated per-suite backend instance (`before()` in `test/backend.test.js:23` already starts a fresh `startServer({ host: '127.0.0.1', port: 0, file: <temp dir>/state.json, devKey: 'test-key' })` — port `0` lets the OS assign a verified-unused ephemeral port, and the JSON data file lives in a `mkdtemp`-created temp directory removed in `after()`), so no additional server/port/data-file plumbing was needed.

Steps, following the exact conventions of the existing reconnect test (`test/backend.test.js:923-1093`, Task 41) and full-sync-batch test (`test/backend.test.js:1095-1326`):

1. Register/login a fresh user, create a workspace, a public space, and one Document page via the real HTTP API.
2. `GET` the Document's initial collab state, build a real `Y.Doc` (`clientA`) from it.
3. Open an authenticated Document WebSocket (`/ws/v2/{workspaceId}/?clientId=&deviceId=&token=&cv=&cp=`), send a `SyncRequest`, await the manifest frame.
4. Insert marker text A into `clientA`, encode it as a proper incremental update (`Y.encodeStateAsUpdate(clientA, preAStateVector)`), send it as a WebSocket `update` frame, and await the `update` acknowledgement frame (which carries a server-issued `messageId`).
5. Insert marker text B into the **same** `clientA` (which has already applied A, so it carries correct causal/state-vector context), and submit the resulting full doc state (`sv`/`docState`) through `POST /api/workspace/v1/{workspaceId}/collab/full-sync/batch` using `CollabBatchSyncRequest`, matching the exact request shape used by the existing full-sync-batch test (`test/backend.test.js:1150-1176`). Assert a 200 response, `error === ''`, and a server-issued `messageId` that orders strictly after A's WebSocket `messageId`.
6. Read the document back via `GET /api/workspace/v1/{workspaceId}/collab/{pageId}?collab_type=0`, apply the returned `doc_state` to a fresh `Y.Doc`, and assert both markers A and B are present and the resulting `Y.encodeStateVector(...)` exactly equals an independently computed local merge of A and B (a `reference` doc that applied A then B's full update itself).
7. Reopen the Document on a brand-new WebSocket with an empty state vector (simulating a fresh client), capture both the `update` frame (missing-data payload) and the `syncRequest` manifest frame — following the same two-frame pattern as the reconnect test (`test/backend.test.js:1053-1069`) — apply the missing-update payload to a fresh `Y.Doc`, and assert both markers are present and the state vector again matches the reference merge.

## 2. Protocol evidence followed (file:line)

- WebSocket handshake query params and frame encode/decode: `test/backend.test.js:962-995` (reconnect test), reused verbatim.
- Document WebSocket `SyncRequest` → manifest (`server.js:1014-1023`, `sendDocumentManifest`) and, when the client's state vector is behind, a prior `update` frame carrying the missing data (`server.js:1045-1063`) — confirmed by reading `server.js:1026-1071` directly, which is why step 7 of the test reads two frames (an `update` then a `syncRequest`), not a single frame with an embedded `docState` field.
- Document WebSocket `update` admission and ack: `server.js:1073-1131`, calling `store.acceptPageCollabUpdate` at `server.js:1084` and sending the ack only after that `await` resolves (`server.js:1093-1110`).
- HTTP full-sync/batch request/response shape: `test/backend.test.js:1150-1176` (existing test), and the handler itself at `server.js:491-581`, which calls the same `store.acceptPageCollabUpdate` at `server.js:581`.
- Shared admission function and its durability guarantee: `storage.js:162-245` (`acceptPageCollabUpdate`), run inside `mutate()` (`storage.js:269-274`), which awaits the atomic temp-file-write-then-rename disk persist before returning — traced and documented by Task 42 (`docs/APPFLOWY_TASK42_RESUME_ASSESSMENT.md` §3), re-confirmed by reading the same lines in this task. This is why the test's comments describe the WS ack and the HTTP response as proof of durable admission by construction (already-established code-level guarantee), rather than re-deriving it with crash injection — consistent with the task brief's guidance on this point.

## 3. Exact assertions made

- WS `SyncRequest` yields a manifest frame (`manifest.syncRequest`) before any update is sent.
- WS `update` for A yields an `update` ack frame with a server-issued `messageId.timestamp > 0`.
- HTTP full-sync/batch for B returns HTTP 200, one result, `error === ''`, matching `objectId`, and a `messageId` with `timestamp > 0` that orders strictly after A's WS `messageId` (same-timestamp tie broken by `counter`).
- `GET` read-back's `doc_state`, applied to a fresh `Y.Doc`, contains both marker A and marker B text, and its `Y.encodeStateVector(...)` deep-equals an independently computed reference merge of A and B.
- A brand-new WebSocket `SyncRequest` from an empty state vector returns an `update` frame (missing data) and a `syncRequest` manifest frame; applying the missing-data payload reproduces both markers and the same state vector as the reference merge.
- Existing `duplicate-admission` conformance behavior (Task 41's reconnect test) was re-run unchanged and still passes.

## 4. Exact results

```
npm test
...
✔ websocket-http-convergence: WebSocket update and HTTP full-sync/batch update converge on one durable document state (71.181458ms)
...
ℹ tests 18
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
(Was 17/17 before this task; now 18/18 — all pre-existing tests still pass unchanged.)

```
npm run test:offline-collab
ℹ tests 5
ℹ pass 5
ℹ fail 0
```
(Unchanged from baseline.)

```
npm run test:collab-conformance
COLLAB_CONFORMANCE_SUMMARY
passed=6
failed=0
pending=5
skipped=0
resolved=2
```
(Was passed=6/pending=6/resolved=1. `websocket-http-convergence` moved from `pendingVectors` to `resolvedVectors` in `test/collab-conformance.js`, citing the new `test/backend.test.js` case as evidence. The other six `check()` cases and the `duplicate-admission` resolution are unchanged.)

## 5. Discovered defect

**None.** The new test passed on the first attempt against the unmodified implementation. No production code (`server.js`, `storage.js`, or any other non-test file) was changed in this task.

## 6. Remaining pending conformance cases (5)

- `rid-allocation-ordering`
- `realtime-ack`
- `compaction-retention`
- `restore-transition`
- `cross-instance-replay`

Each still requires upstream AppFlowy server source or infrastructure explicitly out of scope for this repository (crash injection, a second live instance, a restore endpoint), per Task 41/42's prior analysis — unchanged by this task.

## 7. Recommended next task

Of the five remaining pending cases, `realtime-ack` is the most tractable without upstream server source: a crash-window integration test that kills/delays the disk-persist step (e.g. by injecting a failure into the JSON store's `mutate()` write) and proves the WebSocket never sends an `update` ack before the write completes, and that a crash between write and ack causes the client to safely resend (already covered partially by the Task 41 reconnect test, but not from the server's crash-timing side). This would convert the already-traced code-level ordering guarantee (awaited `mutate()` before ack) into an observable, fault-injected proof rather than static code reading.
