# Task 33 — First AppFlowy-Web WebSocket exchange

**Date:** 2026-10-28  
**Result:** Authenticated `/ws/v2/{workspaceId}/` upgrades and a source-derived WorkspaceDatabase manifest exchange pass isolated integration tests. The browser's authenticated upgrade succeeds, but this empty workspace does not cause the frontend to send a sync frame, so the complete exchange remains browser-blocked.

## Revisions examined

- AppFlowy-Web: `57bdf395a17a0837baae18435b9653b619dd54ab`
- AppFlowy-Cloud source: `c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da`
- AppFlowy source/docs: `5cf3a365dec0d59f64bad1ee4bb1050471a39b93`

The Cloud revision is not a full schema match for this Web revision: its protobuf omits Web's later `SyncRequest.version` and `Update.version`, state-vector, and restore fields. The initial WorkspaceDatabase manifest path uses the shared protobuf envelope, object/type fields, `SyncRequest.last_message_id`, and `state_vector`. The implementation is limited to this versionless read/manifest exchange; it does not claim general protocol or Cloud-revision compatibility.

## Contract evidence

- `AppFlowy-Web/src/components/ws/useAppflowyWebSocket.ts`, `useAppflowyWebSocket`: constructs `/ws/v2/{workspaceId}/?clientId=...&deviceId=...&token=...&cv=0.10.0&cp=web`.
- `AppFlowy-Web/src/application/services/js-services/sync-protocol.ts`, `bindSyncContext`: sends a binary `messages.Message` wrapping `CollabMessage.syncRequest`, with object ID, collab type, local Yjs state vector, last `Rid` (default `0-0`) and version. It then sends awareness if that document has an awareness context.
- `AppFlowy-Web/src/proto/messages.proto` and `collab.proto`, `Message`, `CollabMessage`, `SyncRequest`, and `Update`: define the envelope and shared fields.
- Cloud `src/api/ws.rs`, `establish_ws_connection_v2` and `WsConnectionV2Params::parse`: reads token, client ID and device ID from query parameters, verifies the token before upgrading, and routes `/ws/v2/{workspace_id}`.
- Cloud `services/appflowy-collaborate/src/ws2/actors/session.rs`, `handle_protocol`: decodes client binary frames as `ClientMessage`.
- Cloud `services/appflowy-collaborate/src/ws2/actors/workspace.rs`, `hande_ws_input`: handles a manifest by computing the state-vector diff and returning an `Update` followed by a server `Manifest`; for an absent object it returns an empty-state manifest.
- Cloud `libs/appflowy-proto/src/server_message.rs`, `From<ServerMessage>`: encodes the server manifest as the shared `CollabMessage.sync_request` variant.
- Web `sync-protocol.ts`, `handleSyncRequest`: computes a local Yjs diff against the server state vector and emits a client `Update` only when non-empty. For an identical persisted state, it completes the manifest without sending a write.

## Implementation

`server.js` now handles the exact `/ws/v2/{workspaceId}/` upgrade. It validates the current Web connection parameters, authenticates the query token against the existing session store, checks workspace membership before upgrade and again before each frame, and restricts sync reads to the authenticated workspace's persisted `database_storage_id` with `collab_type=2`.

For a valid binary `SyncRequest` whose state vector matches the persisted WorkspaceDatabase, it returns a server `SyncRequest` carrying the persisted state vector. If the state vectors diverge, it closes explicitly because this backend has no authoritative server `Rid`/replay history; it does not fabricate a diff acknowledgement. Malformed protobuf, unsupported envelopes, unauthorized object IDs, and updates outside this read-only milestone are rejected with explicit close codes. WebSocket message processing is serialized per connection.

The integration test sends the frontend-shaped protobuf request and checks the response object ID, collab type, and exact persisted Yjs state vector. It also checks missing/invalid credentials, unauthorized workspace and object access, malformed and unsupported frames, explicit refusal of divergent-state replay, and refusal of realtime updates.

## Files changed

- `server.js` — authenticated WebSocket upgrade, manifest handling, message validation, and path-safe CLI entry detection.
- `test/backend.test.js` — exact binary exchange and negative WebSocket cases.
- `package.json`, `package-lock.json` — `ws` server dependency and patched `protobufjs` minimum (`^7.6.6`).
- `docs/AGENT_HANDOVER.md` — current integration boundary and test evidence.
- `docs/APPFLOWY_TASK33_WEBSOCKET_REPORT.md` — this report.

## Browser result

Used only disposable account/data and isolated loopback services: backend `127.0.0.1:45210`, Vite `127.0.0.1:45212`. A process-only Vite API/GoTrue/WebSocket proxy targeted that backend; no frontend files, commercial services, or existing service configuration were changed.

- The actual Web app authenticated and reached its workspace.
- The browser requested the checked-out `/ws/v2/{workspaceId}/` URL. The backend accepted the authenticated upgrade (HTTP 101); the previous WebSocket 404 is gone.
- The empty workspace rendered **“No spaces available”** when opening the new-page flow. The browser console also reported the structured `/spaces` endpoint unavailable and its legacy `/space` fallback returning 404.
- No client `SyncRequest` frame was observed on this empty-workspace browser flow, so no browser-side server manifest response was observed. The isolated exact-protocol integration test passed, but the first exchange is **not** claimed as browser-verified.
- No page was opened, no edit was sent, and no collaboration write or persistence behavior was tested.

## Validation

| Command/check | Result |
|---|---|
| `npm test` | PASS — 10 passed, 0 failed |
| `npm run test:offline-collab` | PASS — 5 passed, 0 failed |
| `npm run test:collab-conformance` | PASS — 6 passed, 0 failed, 7 remain pending |
| `npm run test:postgres` | 3 skipped — `DATABASE_URL` unset; no database contacted |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities; protobufjs resolved to 7.6.6 |
| `npm start` from the workspace path | PASS — isolated health check on port 45213; temporary process/data removed |
| Browser WebSocket upgrade | PASS — authenticated upgrade accepted; no 404 |
| Browser first `SyncRequest`/manifest exchange | BLOCKED — empty workspace did not send a sync frame |
| Temporary resources | PASS — backend/Vite stopped; test browser page navigated to `about:blank`; temporary JSON removed |

## Acceptance status

1. **Handshake succeeds:** PASS.
2. **Browser sends the expected initialization message:** BLOCKED; the empty workspace has no opened space/document context, and no frame was observed.
3. **Server returns the protocol-correct response:** PASS in the exact isolated WebSocket integration test; browser confirmation is BLOCKED.
4. **Frontend progresses past the previous WebSocket 404:** PASS; it reaches the workspace and the authenticated upgrade is accepted. This does not establish editor startup.
5. **Next browser blocker recorded:** PASS — no spaces are available; the create-space flow reports `/spaces` unavailable and `/space` returns 404.

**Boundary:** this implements only an authenticated WorkspaceDatabase read/manifest exchange. It does not admit realtime updates, implement Redis `Rid` allocation/replay, or establish editable-page compatibility.
