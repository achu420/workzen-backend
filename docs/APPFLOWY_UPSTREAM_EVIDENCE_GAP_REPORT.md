# AppFlowy upstream synchronization evidence gaps

**Review date:** 2026-10-28  
**Scope:** Task 21 evidence review; documentation only  
**Decision:** all seven server-side synchronization cases remain unresolved. Do not implement network synchronization or claim AppFlowy-Web compatibility from the evidence currently available.

## Executive summary

The checked-out AppFlowy-Web source establishes the client-visible protobuf shapes, state-vector exchange, v1/v2 update handling, HTTP slow-sync request/response expectations, outbox retry behavior, and client-side restore fencing. The AppFlowy-specific golden fixtures verify deterministic Yjs documents and protobuf frame encoding/decoding offline.

Neither source set contains an authoritative server implementation or an end-to-end server fixture for `Rid` allocation, admission, acknowledgement, history retention, restore transitions, distributed replay, or WebSocket/HTTP convergence. Local backend repository behavior is evidence about this prototype only; it cannot resolve the upstream contract. Therefore none of the seven pending vectors can safely be promoted to a server compatibility pass.

## Evidence reviewed

1. This project's `docs/AGENT_HANDOVER.md`, `ARCHITECTURE.md`, `docs/PAGE_SYNC_PATH_DESIGN.md`, `docs/DURABLE_COLLAB_STORAGE_DESIGN.md`, `docs/APPFLOWY_SYNC_SEMANTICS_AND_ADMISSION.md`, and `docs/OFFLINE_ADMISSION_CONFORMANCE.md`.
2. The parent AppFlowy checkout's `docs/APPFLOWY_COLLAB_PROTOCOL_AUDIT.md`, `docs/APPFLOWY_GOLDEN_FIXTURE_PLAN.md`, `contracts/mvp/websocket-contracts.md`, `contracts/mvp/binary-fixtures-and-convergence.md`, and `contracts/mvp/appflowy-golden/README.md` and `manifest.json`.
3. Checked-out AppFlowy-Web client protocol source: `src/proto/collab.proto`, `src/proto/notification.proto`, `src/application/services/js-services/sync-protocol.ts`, `src/application/services/js-services/http/collab-api.ts`, and `src/application/sync-outbox/`.
4. The independent backend's `test/collab-conformance.js` and `postgres-collab-repository.js`, plus the recorded Task 18 PostgreSQL test evidence in the handover.

The AppFlowy-Web checkout is client source, not a synchronization server. The 17-file AppFlowy golden manifest records deterministic page, database, row, row-page, awareness, and protobuf fixtures generated from Web dependencies. Those fixtures establish offline encoding and data-shape behavior; they do not establish server admission or transport semantics.

### Classification terms

- **Confirmed** — explicitly defined by checked-in protocol or client source, limited to exactly the stated behavior.
- **Fixture-verified** — exercised by an existing deterministic local fixture/test; not equivalent to server interoperability.
- **Inferred** — a plausible requirement implied by client behavior, but not specified as server behavior.
- **Unresolved** — no authoritative server implementation or integration fixture establishes the behavior.

The status in the table is the status of the **server-side question**. Client-side facts and local fixture results are called out separately so they are not mistaken for server evidence.

## Seven pending cases

| # | Case | Status | What the available evidence establishes | What remains unknown / required evidence |
|---|---|---|---|---|
| 1 | `Rid` allocation, ordering, and resume | **Unresolved**; wire shape **confirmed** | `collab.proto` describes `Rid` as a Redis stream ID scoped to a workspace, with a millisecond timestamp and duplicate-timestamp counter. It says the server assigns an update's `message_id` after storing it. A `SyncRequest` carries the last known ID. The golden sync/update envelopes verify protobuf representation only. | The allocator, total ordering under concurrency, relationship between workspace stream and object history, client cursor advancement, and reconnect behavior are not demonstrated. Need authoritative server stream code plus a reconnect/replay integration fixture with known IDs. |
| 2 | Duplicate admission and retry response | **Unresolved**; retry expectation partly **confirmed**, idempotency **inferred** | Web source and tests exercise durable outbox retention/retry and exact-record retirement. The Yjs fixture tests establish that applying the same update locally is idempotent. The independent PostgreSQL repository deduplicates using its own payload digest/message key. | None of this defines the server's deduplication key, behavior for the same payload with different metadata, durable stream-entry count, or response to a replay. Need upstream admission code or a two-delivery server fixture that records persistence and response behavior. |
| 3 | Realtime acknowledgement timing | **Unresolved**; part of the message contract **confirmed** | `collab.proto` documents `message_id` assignment after Redis storage. The Web HTTP slow-sync contract uses a returned message ID as a durable confirmation boundary. The realtime client path does not define a separate response-frame retirement handshake. The local repository reports `acknowledged: false`, correctly making no wire claim. | Whether and when the server broadcasts an assigned `Update`, sends another acknowledgement, or otherwise confirms realtime admission—and what happens if the process crashes between persistence and send—requires a server crash-window integration test. |
| 4 | Compaction, retention, and missing-history recovery | **Unresolved**; basic Yjs diff **fixture-verified** | Web source supports state-vector diffs and an HTTP slow-sync lane for oversized updates. Golden page/state-vector fixtures verify local Yjs diff generation and application. | No reviewed source defines stream trimming, Yjs compaction, retention limits, or the required recovery sequence when a client's cursor predates retained history. Need authoritative retention/compaction code and fixtures for both retained-history and trimmed-history recovery. |
| 5 | Restore-generation transitions | **Unresolved**; client fences **confirmed**, local checks **fixture-verified** | The protocol carries optional `database_restore_id`; notification schemas include a database-restored event. Web client code/tests fence queued edits by captured restore/version state. The independent backend rejects updates whose restore identity differs from its stored value. | The authoritative transition point, stale-write response, in-flight update handling, and notification ordering are server behavior not established by client guards or the local equality check. Need an isolated restore integration test covering stale and current writes plus notifications. |
| 6 | Cross-instance replay and recovery | **Unresolved**; local concurrency **fixture-verified** only | The proto describes a workspace-scoped Redis stream. The independent PostgreSQL tests recorded in the handover exercise local repository locking and concurrent Yjs updates across two repository instances. | Local database row locking does not prove upstream stream fan-out, ordering, cursor replay, failover, or restart behavior. Need a two-instance upstream stream test including restart and replay from a known cursor. |
| 7 | WebSocket/HTTP full-sync convergence | **Unresolved**; client message shapes **confirmed**, offline frame handling **fixture-verified** | Web source documents protobuf WebSocket frames and `/api/workspace/v1/{workspace}/collab/full-sync/batch` request/result expectations. Golden fixtures round-trip WebSocket sync/update messages; local tests do not start a server. | No evidence shows that both lanes share admission, deduplication, `Rid` assignment, durable state, error semantics, or outbox retirement rules. Need an isolated comparison fixture that submits equivalent edits over each lane and compares persisted state, IDs, and client-visible results. |

## Evidence boundaries and discrepancies to preserve

- A protobuf comment is authoritative evidence of the declared wire intent, not proof that a server implements it correctly.
- `Rid` is described as workspace-stream-scoped, while a `SyncRequest` is about one collaboration object. The source does not explain the complete mapping between stream cursor and object state; do not resolve that ambiguity by substituting a local generation or database sequence.
- A Yjs duplicate application test proves local Yjs behavior, not duplicate network admission or a server replay response.
- Local PostgreSQL transaction, deduplication, restore-equality, and concurrency tests prove only the independent prototype's behavior under their test conditions. They do not model an AppFlowy Redis stream or wire acknowledgement.
- The golden `message-sync-request` and `message-update` binaries are deterministic encoding fixtures, not captured server exchanges. No full-sync end-to-end fixture is present in the reviewed manifest.
- Client outbox tests demonstrate client safety policies, not that an upstream server honors them.

## Safety and repository status

The requested backend directory has no `.git` metadata, so its own working-tree status cannot be queried. The parent `/Volumes/work disk/Codes/Tracker/AppFlowy` worktree is on `main` and already contains numerous untracked files, including `docs/` and `contracts/`; none were changed for this review. The requested report path did not exist before this document was added.

No AppFlowy-Web files, commercial checkout files, application code, fixtures, databases, credentials, or running services were changed or contacted. No synchronization network calls or tests were run for this documentation-only review; prior test results are attributed to the handover rather than presented as rerun evidence.

## Smallest safe next step

Review this gap report and identify an approved, authoritative upstream server source revision or an isolated conformance fixture that may be examined without involving a commercial deployment. Then resolve one protocol case at a time from that evidence and update its classification; if such evidence is unavailable, keep the case unresolved. Do not implement a WebSocket listener, HTTP sync route, Redis stream, or frontend integration until that evidence review is approved.
