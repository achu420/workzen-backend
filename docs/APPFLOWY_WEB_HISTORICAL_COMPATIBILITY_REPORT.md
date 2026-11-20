# AppFlowy-Web historical compatibility with archived AppFlowy-Cloud

**Review date:** 2026-10-28  
**Scope:** Read-only inspection of locally available Web and Cloud source history  
**Conclusion:** `3ff072838202a4d47f0fa6683b4179fd0ad5fb4f` is the newest plausible Web revision for the older Cloud collaboration WebSocket contract. Its core collab protobuf shape and state-vector flow align with Cloud source, and its legacy HTTP `web-update` shape aligns with Cloud. However, it does not use Cloud's single-object HTTP full-sync endpoint; the first Web full-sync implementation found is an incompatible batch endpoint. No historical Web revision was established as satisfying every requested contract or as end-to-end compatible.

## Revisions examined

| Revision | Date / relationship | Why it matters |
|---|---|---|
| AppFlowy-Web `57bdf395a17a0837baae18435b9653b619dd54ab` | Current checked-out `HEAD`, 2026-10-26 | Current frontend; expects batch full-sync, additional state-vector/version fields, and database restore metadata. |
| AppFlowy-Web `947740b68381e91cea7672951aa9b6fd31a1258a` | 2025-08-07, “integrate new realtime sync protocol” | Introduces `src/proto/collab.proto` and the WebSocket sync protocol used by the Cloud-style stream contract. |
| AppFlowy-Web `3ff072838202a4d47f0fa6683b4179fd0ad5fb4f` | 2026-02-01, direct parent of `27c042c2c5a999fdc1daf4b36e5cf2c3abd9bd5a` | Newest source candidate before the first Web batch full-sync API change found in reachable history. It is contained in the locally available `main` and `origin/main` history. |
| AppFlowy-Web `27c042c2c5a999fdc1daf4b36e5cf2c3abd9bd5a` | 2026-02-01, “Sync and duplicate” | Adds `/collab/full-sync/batch` and its batch protobuf messages. This is incompatible with Cloud's single-object full-sync API. |
| AppFlowy-Web `7ee06689d2e7dbbf8eebc4051dacbab421129a54` | 2026-07-03 | Adds `before_state_vector`, a field absent from Cloud's collab update schema. |
| AppFlowy-Web `d6cfd276910f0ea29251de5685791d35c129ddcd` | 2026-09-28, database history and restore | Adds restore-aware update and notification behavior absent from Cloud. |
| AppFlowy-Cloud `c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da` | Checked-out `HEAD` and publicly reported `main`, 2026-09-11 | Archived Rust server revision used for the source comparison. |

The Web worktree had pre-existing `vite.config.ts` modifications and untracked files. They were not changed. The Cloud worktree remained clean. The independent-backend directory has no Git metadata, so its status cannot be reported via Git; the requested report path did not previously exist. No refs were fetched, switched, or changed.

## Candidate comparison: Web `3ff0728` vs Cloud `c5bcfd3`

### Collaboration protobuf and WebSocket messages

At `3ff0728`, Web `src/proto/collab.proto` contains the older `Rid`, `SyncRequest`, `Update`, `AwarenessUpdate`, `AccessChanged`, and `CollabMessage` fields. The relevant layouts are `Rid` and `SyncRequest` at lines 12–38, `Update` at 45–62, and `CollabMessage` at 86–99. Cloud's `libs/appflowy-proto/proto/collab.proto` at `c5bcfd3` has the same field layout and numbers (lines 12–99). The Web and Cloud `messages.proto` wrappers both put `collab.CollabMessage` in `Message.payload = 1` and notifications in field 2 (Web lines 1–16; Cloud lines 1–16).

The Web sync implementation at this candidate:

- Computes a Yjs diff using the server-provided state vector (`src/application/services/js-services/sync-protocol.ts`, lines 38–54).
- Applies v1/v2 updates, tracks the received `messageId`, and requests a diff if Yjs reports missing dependencies (lines 71–101).
- Sends its local state vector and last received message ID at initialization (lines 155–165).
- Wraps WebSocket payloads as `messages.Message` protobuf bytes (`src/components/ws/useAppflowyWebSocket.ts`, lines 195–212).

Cloud source has matching `Manifest`/`Update` concepts and maps them to/from `SyncRequest`, `Rid`, `UpdateFlags`, and protobuf `Update` (`libs/appflowy-proto/src/client_message.rs`, lines 20–85; `libs/appflowy-proto/src/server_message.rs`, lines 145–190, 245–290). Cloud's workspace actor replays updates after the supplied cursor and emits update messages with their IDs (`services/appflowy-collaborate/src/ws2/actors/workspace.rs`, lines 270–320); it advances its workspace cursor and fans updates out to other clients (lines 409–446). These are substantial source-level matches for the older collaboration WebSocket protocol. They do not prove full client/server interoperability.

### HTTP synchronization

At `3ff0728`, the Web HTTP client has `updateCollab`, which posts JSON fields `doc_state` and `collab_type` to `/api/workspace/v1/{workspace}/collab/{object}/web-update`, with `client-version` and `device-id` headers (`src/application/services/js-services/http/http_api.ts`, lines 705–739). Its only direct callsite found in that revision is `src/application/services/js-services/http/__tests__/collab.integration.test.ts` (lines 74–94), not a production synchronization caller.

Cloud registers the corresponding POST route (`src/api/workspace.rs`, lines 185–186). Its handler reads `Json<UpdateCollabWebParams>`, checks write access, applies `doc_state`, and returns an empty success envelope (`workspace.rs`, lines 1322–1355). The DTO contains the same `doc_state: Vec<u8>` and `collab_type` fields (`libs/database-entity/src/dto.rs`, lines 252–255). Web's `Array.from(docState)` representation is a JSON byte array, matching the DTO's serialized byte vector. This establishes a source-level shape match for the legacy `web-update` request, not proof the candidate's production app uses that lane.

**The candidate does not call Cloud's full-sync endpoint.** Cloud's endpoint is single-object `/api/workspace/v1/{workspace}/collab/{object}/full-sync` and decodes `CollabDocStateParams` (`src/api/workspace.rs`, lines 181–182, 2842–2865). That protobuf has `object_id`, `collab_type`, compression, state vector, and doc state (`libs/collab-rt-entity/proto/collab.proto`, lines 10–15); the handler returns a compressed binary response (`workspace.rs`, lines 2933–2945). The first Web full-sync use found is commit `27c042c2…`: `src/application/services/js-services/http/http_api.ts` lines 750–802 adds a different URL, `/api/workspace/v1/{workspace}/collab/full-sync/batch`, and encodes/decodes batch messages. Its `src/proto/collab.proto` lines 101–148 add `CollabBatchSyncRequest` / `CollabBatchSyncResponse`. That route, body, and response do not match Cloud's single-object endpoint.

### Restore and notifications

Web `3ff0728` has no `database_restore_id`, restore-aware update field, or `DatabaseRestored` event in its collaboration/notification protobufs. Cloud's collab protobuf also has no such fields, and its notification protobuf only defines profile and permission events (`libs/appflowy-proto/proto/notification.proto`, lines 5–21). The Web notification schema at the candidate contains additional event variants beyond Cloud's two; this is a superset, not an exact match for all Web features.

The later Web restore work at `d6cfd276…` adds a restore ID to updates/batch data and a `DatabaseRestored` notification (its changes to `src/proto/collab.proto` and `src/proto/notification.proto`). Those requirements cannot be satisfied by Cloud `c5bcfd3` source. Likewise, Web's later `before_state_vector` field is absent from the Cloud schema.

## Finding

**Newest plausible source-compatible candidate:** `3ff072838202a4d47f0fa6683b4179fd0ad5fb4f` (2026-02-01), for the core WebSocket collaboration contract and the legacy `web-update` API shape.

**Strict full match established:** No. This candidate has no full-sync call to compare with Cloud's `/full-sync`; Web's first full-sync implementation is the incompatible `/full-sync/batch` added by `27c042c2…`. In addition, the Web notification schema includes events that are not in Cloud's notification schema. The source suggests a credible older sync pairing but does not establish that the complete AppFlowy-Web application at `3ff0728` works with Cloud `c5bcfd3`.

## Choosing between the two options

- **A — Pin an older Web frontend:** This can avoid the newer batch-sync and database-restore requirements. `3ff0728` is a concrete candidate whose core collab WebSocket field layouts match Cloud and whose legacy `web-update` request shape matches Cloud source. The trade-off is losing later frontend behavior and features; even this candidate's complete REST surface and end-to-end page workflow remain unverified.
- **B — Keep current Web and implement a newer independent backend contract:** This preserves current frontend behavior, but requires implementing the current batch full-sync route/schema, newer update metadata/state-vector behavior, restore transitions/notifications, and the still-unresolved server admission, replay, and durability semantics. This is materially more work, but avoids pinning the product to an older UI/protocol.

## Recommended next task

Run a narrowly scoped, isolated compatibility test using an immutable Web source snapshot at `3ff072838202a4d47f0fa6683b4179fd0ad5fb4f` and Cloud source `c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da`. Verify authenticated page open, one text edit over WebSocket, server persistence, reconnect/reopen, and whether the HTTP `web-update` path is actually invoked. Keep the candidate in a separate disposable worktree/clone and use only explicitly isolated test dependencies. Do not treat a pass as evidence for batch full-sync, database restore, or the newer current Web revision.
