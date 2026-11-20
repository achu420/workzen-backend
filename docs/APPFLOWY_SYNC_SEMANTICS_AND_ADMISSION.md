# AppFlowy sync semantics and admission

**Audit date:** 2026-10-28  
**Status:** protocol decision document; no network synchronization implementation.

## Executive decision

The checked-out Web client gives us a precise wire shape and several client-side safety rules, but it does not provide a complete server contract. A replacement server may safely implement binary Yjs state-vector exchange, v1/v2 update decoding, version/restore metadata validation, and durable storage. It must not yet claim AppFlowy compatibility for Redis-stream ordering, server-issued `Rid` allocation, duplicate admission, compaction, restore fences, or WebSocket acknowledgement timing without upstream server evidence.

The existing offline and PostgreSQL repositories remain deliberately narrower than a network server. Their local `durable` result means a local transaction committed; it is not an AppFlowy wire acknowledgement.

## Evidence inventory

| Behavior | Observation | Classification |
|---|---|---|
| `Rid` shape | `collab.proto:6-20` documents a Redis stream ID scoped to a workspace: millisecond UNIX timestamp plus a counter; default `0-0`. | **Source-confirmed** shape and intended scope |
| `Rid` allocation/order | `Update.message_id` is described as assigned after server storage; no server allocator or ordering implementation is in the checked-out Web source. | **Unknown / requires upstream server evidence** |
| Initial handshake | `sync-protocol.ts:92-124` sends a `SyncRequest` with the local v1 state vector, last known `Rid` or `0-0`, and document version; awareness is sent separately. | **Source-confirmed** |
| Sync response | `sync-protocol.ts:131-191` computes `Y.encodeStateAsUpdate(doc, requestedVector)`. Empty v1 updates complete a manifest locally; non-empty responses are sent as `Update`, or persisted to the outbox when oversized. | **Source-confirmed client behavior**; server response policy is **unknown** |
| Missing dependencies | `sync-protocol.ts:220-255` applies v1/v2 updates, records `messageId`, and sends another `SyncRequest` if Yjs pending structs/deletes remain. | **Source-confirmed** |
| Update flags | `collab.proto:56-60` and `sync-protocol.ts:228-235` define 0 as lib0 v1 and 1 as lib0 v2; other flags are rejected by the client. | **Source-confirmed; fixture-verified** |
| Before/after vectors | `collab.proto:70-80` says `before_state_vector` lets the server detect a missing earlier update; `after_state_vector` is advisory and the server derives its own. | **Source-confirmed requirement**, server enforcement **unknown** |
| Version/restore fields | `Update` carries `version` and optional `database_restore_id`; client restore gating and outbox tests keep database bytes within a captured generation. | **Source-confirmed client fencing**; server transition policy **unknown** |
| Client-originated message IDs | The proto comment says client updates omit `message_id`; server assigns it after storage. | **Source-confirmed wire expectation** |
| Duplicate delivery | The client persists outbox records and deletes exact records after a send/confirmed slow-sync. It does not define a server duplicate key or replay response. | **Unknown / requires upstream server evidence** |
| Durable acknowledgement | `CollabBatchSyncResult.message_id` is documented as confirming durable persistence. Slow-sync callers require it before retiring an upload, unless a version supersession applies. The realtime path deletes after `send()` and has no response acknowledgement in this client code. | **Source-confirmed slow-sync expectation**; realtime timing **unknown** |
| Reconnect | WebSocket URL refreshes token and nonce (`useAppflowyWebSocket.ts:219-224`); `bindSyncContext` is called again without duplicate observers (`sync-protocol.ts:337-348`) and sends a manifest request. | **Source-confirmed client behavior** |
| IndexedDB recovery | `sync-outbox/index.ts:199-369,1360-1575` writes edits to IndexedDB, drains when ready, keeps records on failures, uses bounded HTTP slow-sync for oversized records, and deletes exact IDs only after the relevant operation. | **Source-confirmed client behavior; fixture-verified by Web tests** |
| HTTP fallback | `collab-api.ts:285-430` sends protobuf `CollabBatchSyncRequest` to `/api/workspace/v1/{workspace}/collab/full-sync/batch`, supports gzip slow lane and treats 429/503 as retryable. | **Source-confirmed client contract**; server admission **unknown** |
| Compaction/history | The client can retain long Yjs history and route a large manifest through slow-sync, but no compaction, retention, or historical replay policy is specified. | **Unknown / requires upstream server evidence** |
| Multiple instances | The protocol comments imply a shared workspace Redis stream; no checked-out server implementation proves locking, fan-out, failover, or ordering across instances. | **Unknown / requires upstream server evidence** |

## Minimum safe server contract

These are the smallest behaviors that can be implemented without inventing undocumented semantics.

### Initial sync and missing updates

1. Authenticate and authorize the workspace/object before decoding or returning state.
2. Accept a v1 state vector in `SyncRequest`; validate its encoding.
3. Compare it with the durable Yjs document and return only a state-vector diff when possible.
4. Return a `SyncRequest` when the peer advertises a state that the server cannot satisfy from its retained state, rather than fabricating an acknowledgement.
5. Preserve the document version and return a server-derived state vector. Empty diffs must not become fake durable updates.

The first four items follow the proto comments and client handlers. The exact server response sequence for divergent `last_message_id` and state vectors remains an upstream question.

### Update admission and persistence

1. Require flags 0 or 1 and apply the corresponding Yjs decoder.
2. Validate object identity, authorization, version, optional restore identity, and a syntactically valid `before_state_vector`.
3. Apply the update to the current durable state and reject malformed or unresolved updates.
4. Derive the post-update state vector from the resulting Y.Doc; never trust `after_state_vector` as authoritative.
5. Persist the accepted payload and resulting binary state atomically.
6. Do not emit a durable result until the transaction commits.

The independent PostgreSQL repository implements this local transaction boundary. It intentionally does not assign a Redis `Rid` or send a network acknowledgement.

### Duplicate and retry handling

The client can retry after reconnect and can leave an IndexedDB row queued after a failed send. A compatible server therefore needs idempotent admission, but the source does not establish whether the key is `Rid`, payload digest, client-generated ID, or another server key. The implementation must choose and document a stable key only after upstream evidence or a separately approved protocol extension. Until then, duplicate behavior is an acceptance gap, not a verified feature.

### Version and restore fencing

Reject updates whose collab version does not match the authoritative document. For database/row objects, reject or quarantine updates carrying a stale restore identity. The client-side outbox tests prove that captured generations are not mixed and that a reset can discard stale records; they do not prove the server's generation transition or notification protocol.

### Reconnect and outbox replay

On every socket bind, accept the client's state vector and last known `Rid`, then perform a manifest exchange. Replayed outbox records must be admitted in their durable order or returned as an explicit retry/conflict result. HTTP slow-sync must return a result with a server state vector, collab version, and a message ID when the upload was durably accepted; otherwise the client leaves the record queued.

### Acknowledgements and ordering

For the HTTP slow lane, a `message_id` is the source-documented confirmation boundary. For realtime WebSocket updates, the client source has no corresponding response/retirement protocol, so a server must not be described as compatible until upstream code or an integration fixture demonstrates whether the server broadcasts an assigned `Update`, sends a separate acknowledgement, or relies on the client's optimistic send/delete behavior.

`Rid` ordering must be established by the upstream server: determine whether IDs are globally ordered per workspace stream, per object, or only used as a resume cursor. Do not substitute PostgreSQL sequence order or local generation for an AppFlowy `Rid`.

### Restart and cross-instance recovery

After restart, the server must recover the canonical binary state, state vector, collab version, restore identity, and whatever replay cursor it promises to clients. Multiple instances must share that state and serialize or otherwise reconcile concurrent updates. PostgreSQL row locking proves this property for the independent repository's local model, not for the AppFlowy Redis-stream protocol.

## Fixture and test evidence

The independent backend's existing offline suite (`test/offline-collab.test.js`) verifies source-derived page bytes, v1/v2 application, state-vector diffs, duplicate classification within the in-memory prototype, protobuf round trips, malformed-frame rejection, and the absence of a durability claim. The golden binaries and manifest under `contracts/mvp/appflowy-golden/` are deterministic source-derived fixtures.

The Web source tests additionally verify outbox durability notification, exact-ID retirement, retry retention, slow-lane confirmation, permission blocking, restore-generation fencing, and reconnect-safe draining (`AppFlowy-Web/src/application/sync-outbox/__tests__/sync-outbox.test.ts:630-654,1174-1223,1532-1580`). These tests are client tests; they do not prove a server implementation.

No new offline test was added in this audit because the existing tests already cover the established subset. Adding a guessed `Rid` allocator, acknowledgement frame, compaction rule, or restore transition test would incorrectly turn an assumption into evidence.

## Evidence required before network integration

Obtain or build an isolated upstream-compatible fixture suite that proves:

1. Two clients with known vectors receive the exact missing-update response sequence.
2. A client update receives its assigned `Rid`, and `last_message_id` resumes correctly after reconnect.
3. Retrying the same client update is idempotent and does not create two durable stream entries.
4. Acknowledgement/broadcast timing is after durable admission, including process crash between write and send.
5. Version and database restore transitions reject stale updates and notify connected clients.
6. Compaction or stream trimming reports a recoverable full-state path instead of silently losing history.
7. Two server instances share ordering, replay, authorization, and restart recovery.
8. HTTP batch-sync and WebSocket delivery converge on the same durable state and retirement rules.

## Decision and next milestone

The protocol is **partially specified**. Initial state-vector exchange, binary framing, v1/v2 flags, client-side outbox durability, reconnect rebinding, and HTTP slow-sync request/response shapes are established. Server-issued ordering, duplicate admission, realtime acknowledgement, compaction, restore transitions, and multi-instance replay remain unresolved.

The smallest safe next milestone is an **offline admission conformance harness** that consumes the existing AppFlowy-specific page fixture and models only source-confirmed inputs/outputs. It should leave `Rid`, acknowledgement, compaction, and restore-transition cases as explicit pending vectors until upstream server evidence is available. Only after that review should a WebSocket adapter be designed.
