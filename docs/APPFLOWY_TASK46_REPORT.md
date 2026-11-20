# Task 46: rid-allocation-ordering conformance

## RID semantics (traced, not inferred)

The identifier is called `Rid` in the wire protocol (`collab-protocol.js:7`):
`{ timestamp: fixed64, counter: uint32 }`, carried as `messageId` on `Update`
and `SyncRequest.lastMessageId` (`collab-protocol.js:30,36,37`).

- **Allocation side**: entirely server-side. `storage.js:162-245`
  (`acceptPageCollabUpdate`) allocates the Rid inside `mutate()`
  (`storage.js:269-274`), the JSON store's single-writer serialization point.
  Clients never set `messageId` on an outbound `Update`; `server.js:1079-1082`
  closes the socket (1008) if a client tries ("Client cannot assign a
  Document message ID").
- **Scope**: per-**workspace**, not per-document, per-connection, or
  per-client. The counter lives at `s.workspaceRids[workspaceId]`
  (`storage.js:204-212`): `timestamp = max(Date.now(), previous.timestamp)`,
  `counter` increments when `timestamp` is unchanged, else resets to 0. Every
  admitted update to any page within a workspace advances that workspace's
  single Rid sequence.
- **Ordering guarantee**: strict monotonic increase within a workspace,
  guaranteed by `mutate()` serializing all admissions (not by any
  client-supplied value, since clients never allocate Rids). This is a
  single-instance guarantee — there is one store/process in this backend.
  No cross-instance/failover ordering is proven or claimed here (that is the
  separately-pending `cross-instance-replay` vector).
- **Duplicates/retries**: deduped independently of the Rid, keyed per-document
  on a payload-digest of the admitted Yjs update (optionally also a caller
  `messageKey`) — `storage.js:185-203`. A dedup hit returns the **original**
  `messageId`/documentState without re-applying or re-allocating, so no
  resend can collide with or skip a Rid slot. This matches the semantics
  established by Task 41/44 for `duplicate-admission`.
- **HTTP vs. WebSocket**: identical allocation scheme. Both
  `server.js:581` (HTTP full-sync/batch) and `server.js:1084` (WebSocket
  update) call the same `store.acceptPageCollabUpdate`, drawing from the same
  per-workspace allocator — proven directly by test F below (cross-lane
  ordering), not merely inferred from the shared call site.

No weaker-than-expected or stronger-than-supported guarantee was invented:
the backend provides per-workspace strict ordering with single-writer
serialization, not a stronger cross-instance guarantee.

## Test coverage (A-F), in `test/backend.test.js`

All six tests are prefixed `rid-allocation-ordering:` and reuse the existing
`setupCollabDocumentForAckTests` / `connectAckTestSocket` / `ackTestFrameReader`
helpers (Task 44) and the `store.persist` gate-promise hook convention (Task 44)
— no sleeps, only explicit promises/barriers.

- **A. Sequential updates, one connection.** 5 sequential updates; asserts
  each ack's Rid is strictly greater than the previous, and each
  accompanying manifest frame's `lastMessageId` matches that ack's Rid.
- **B. Sequential across a reconnect.** One update, full disconnect, fresh
  socket reconnect (Task 41 convention, resumed via the client's post-update
  state vector), one more update; asserts the post-reconnect Rid is strictly
  greater than the pre-reconnect Rid.
- **C. Concurrent updates, two connections.** Two separate WebSocket
  connections send concurrent updates to the same Document; asserts both are
  acknowledged, their Rids do not collide, neither update is silently lost,
  and the durable merged state vector matches an independently computed
  local Yjs merge.
- **D. Duplicate/retried submission.** Resends the identical update payload
  (same bytes -> same payload-digest); asserts the second ack returns the
  **same** Rid as the first (not a new one) and the marker text appears
  exactly once in durable state. Reuses, rather than reinvents, Task 41/44's
  established dedup semantics.
- **E. HTTP/WebSocket lane interaction.** One update over WebSocket, one over
  HTTP full-sync/batch, same Document; asserts the HTTP-lane Rid is strictly
  ordered after the WebSocket-lane Rid — extending Task 43's convergence
  angle specifically to Rid ordering, not just final content.
- **F. Ack/Rid ordering under persistence delay.** Reuses Task 44's
  `store.persist` gate hook: a baseline update, then a second update is held
  under a gated persist; asserts the ack observed after release carries a
  Rid strictly after the baseline (i.e., its own Rid, not a stale/unrelated
  one) and durable state reflects both updates.

Nothing was skipped or weakened: all six properties the task asked for
(no collisions where uniqueness is required, no silently lost updates,
dedup matches established semantics, acks reference correct admitted
updates, final Yjs state is valid/convergent) are directly asserted.

## Defect found

None. This was a protocol-verification task; no production code was
changed. The one issue found was in the first draft of my own test code
(not production): two tests initially consumed only one of the two frames
(`update` ack + `syncRequest` manifest) the server sends per admitted
update, causing a leftover manifest frame to be misread as the next ack.
Fixed by draining both frames per send, matching the convention already
used elsewhere in the file (e.g., the Task 36 WebSocket test).

## Exact verification results

- `npm test` → 28/28 pass, 0 fail (22 pre-existing + 6 new `rid-allocation-ordering:` tests).
- `npm run test:offline-collab` → 5/5 pass.
- `npm run test:collab-conformance` → `passed=6 failed=0 pending=3 skipped=0 resolved=4`.
  `rid-allocation-ordering` moved from `pendingVectors` to `resolvedVectors`
  in `test/collab-conformance.js`, with its evidence string pointing at the
  six new fixtures above.

## Remaining limitations

- Remaining pending conformance cases (3): `compaction-retention`,
  `restore-transition`, `cross-instance-replay`.
- `cross-instance-replay` specifically still covers what
  `rid-allocation-ordering` explicitly does NOT: whether Rid ordering or
  failover holds across multiple server instances/processes sharing a
  store. This backend runs a single in-process JSON (or single Postgres
  connection) store, so that property remains unproven.
- Rid ordering here is a per-workspace guarantee, not per-document; this
  was traced and tested as the actual implemented semantic, not assumed.

## Recommended next task

`compaction-retention` — it is the next vector requiring genuinely new
production tracing (stream trimming / Yjs history compaction / state-vector
recovery), distinct from `restore-transition` (fencing logic already traced
in Task 45 but with no real trigger) and `cross-instance-replay` (requires a
two-instance fixture, a larger undertaking). `compaction-retention` can
likely be resolved the same way as this task: trace what currently exists
(probably "nothing trims/compacts yet"), and either confirm that absence
with a fixture or identify the smallest defect if something is silently
discarding history.
