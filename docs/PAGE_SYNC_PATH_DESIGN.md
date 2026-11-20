# First AppFlowy page-sync path: feasibility and blocked design

**Date:** 2026-10-28  
**Status:** investigation complete; implementation intentionally not started.

## Selected workflow

The smallest requested workflow is: authenticated user opens an ordinary page, loads its existing document, edits ordinary text, persists the edit, and reopens the page.

The actual Web client does not use the prototype's JSON page endpoint for this workflow. `AppFlowy-Web/src/application/services/js-services/http/collab-api.ts:472-505` loads a page view from:

```text
GET /api/workspace/{workspaceId}/page-view/{viewId}
```

The response must contain `view`, `data.encoded_collab`, `data.row_data`, and optional owner/editor profiles. The encoded collab is decoded into the AppFlowy Yjs document. This is distinct from the prototype's `POST /api/workspaces/{workspaceId}/pages` JSON document.

After opening, the editor binds a Y.Doc and sends a binary protobuf WebSocket handshake. `useAppflowyWebSocket.ts:219-224` constructs a URL containing workspace ID, client ID, device ID, token, client version, and platform. `useAppflowyWebSocket.ts:427-428,524-554` requires binary `messages.Message` frames.

## Required protocol chain

The minimum real page-edit path requires all of the following:

1. Authenticated workspace and page-view authorization.
2. Page-view response containing a valid AppFlowy page collab update, not arbitrary JSON.
3. Yjs page document structure from `initializeDocumentStructure` and the block/child/text maps audited in `docs/APPFLOWY_DOCUMENT_SCHEMA_AUDIT.md`.
4. WebSocket upgrade and protobuf `messages.Message`/`collab.CollabMessage` framing.
5. `SyncRequest` handling with state vectors and `Rid` values.
6. `Update` handling for lib0 v1/v2 payloads, including `before_state_vector`, version, and restore metadata.
7. Durable update persistence before acknowledgement.
8. Duplicate/retry handling and reconnect rebind behavior required by `sync-protocol.ts:92-348`.
9. HTTP full-sync fallback at `/api/workspace/{workspace}/collab/full-sync/batch` for the durable outbox path (`collab-api.ts:285-430`).

The frontend's outbox is IndexedDB-backed and deliberately assumes the server will acknowledge an update only after durable admission. A JSON page overwrite cannot satisfy this contract.

## Existing backend reuse

The independent backend can reuse:

- bearer authentication and session revocation;
- workspace membership checks;
- page ownership/workspace authorization;
- PostgreSQL page versioning for conventional JSON CRUD.

It cannot currently reuse its page storage for AppFlowy synchronization because `document` is stored as JSON and there is no binary Yjs state/vector, collab version, message ID, or update admission table. There is also no WebSocket server implementation or protobuf transport dependency.

## Acceptance contract to implement later

For an isolated AppFlowy-compatible page service, acceptance tests must prove:

- `GET page-view` returns a valid source-derived page update and correct view identity;
- an authenticated client can send a protobuf `SyncRequest` and receive only the missing Yjs update;
- a lib0 v1 ordinary text update is persisted before the server emits its `Update` acknowledgement;
- duplicate delivery is idempotent;
- stale `version`/restore generation and malformed flags/payloads are rejected;
- an unauthorized workspace cannot load the view or open its socket;
- two independent application instances share the same binary document state;
- reconnect and HTTP full-sync recover an interrupted outbox update;
- reopening the page returns the persisted AppFlowy document state.

## Why implementation stops here

Implementing only a JSON `PUT /pages` route would pass a backend-only test but would not connect the actual AppFlowy-Web page editor. Implementing a fake WebSocket acknowledgement would risk losing edits and would falsely claim compatibility. Implementing the real path requires a new binary collab repository, page-view/folder contract, protobuf WebSocket server, Yjs update admission, and outbox recovery tests—a broader collaboration subsystem rather than a small isolated change.

Therefore no frontend or backend source was changed for Task 16. No service, database, account, or commercial stack was contacted.

## Smallest safe next task

Build an offline collab repository prototype around the existing AppFlowy-specific golden page fixture: store one page's v1 Yjs update and state vector, implement pure `SyncRequest`/`Update` admission functions, and test duplicate, malformed, and state-vector-diff behavior without a WebSocket or live frontend. Only after those functions have a reviewed contract should a WebSocket adapter be added.

