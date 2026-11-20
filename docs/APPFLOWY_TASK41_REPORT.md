# Task 41 — Investigate and Resolve Pending Collaboration-Conformance Cases

**Date:** 2026-10-29
**Result:** One of the seven pending conformance cases — **duplicate-admission** — is resolved with a new durable, two-delivery integration fixture. No production code was changed: the implementation that makes this case pass (payload-digest idempotent admission, shared by both the WebSocket and HTTP full-sync/batch lanes) already existed in `storage.js` and `postgres-collab-repository.js`, but was previously untested above the in-memory offline prototype and was therefore still listed as pending. The remaining six cases are re-classified with updated, more specific evidence gaps; none of them can be resolved without either upstream AppFlowy server source (not available in this checkout) or infrastructure (a second server instance, a crash-injection harness) explicitly out of this task's scope.

## 1. Baseline: the exact seven pending cases before this task

From `test/collab-conformance.js` as it existed before this task (verbatim):

1. **rid-allocation-ordering** — "Server-issued Rid allocation, workspace/object ordering, and resume semantics are absent from the Web-only checkout." Evidence needed: "Upstream server stream implementation plus reconnect integration fixture."
2. **duplicate-admission** — "The client retries durable outbox records but does not define the server duplicate key or replay response." Evidence needed: "Upstream admission code or a two-delivery server fixture proving idempotence."
3. **realtime-ack** — "The realtime client removes a sent record without a response frame; durable acknowledgement timing is therefore not established." Evidence needed: "Crash-window integration test proving when a WebSocket update is acknowledged/broadcast."
4. **compaction-retention** — "No source defines stream trimming, Yjs compaction, or the recovery response after history is removed." Evidence needed: "Upstream retention/compaction implementation and state-vector recovery fixture."
5. **restore-transition** — "Client restore fencing is visible, but authoritative generation changes and notifications are server behavior." Evidence needed: "Database restore integration test covering stale writes and AccessChanged/notification behavior."
6. **cross-instance-replay** — "The protocol comments imply a shared Redis stream, but no server implementation proves ordering or failover across instances." Evidence needed: "Two-instance replay/restart integration fixture using the authoritative stream."
7. **websocket-http-convergence** — "The WebSocket and HTTP slow-sync paths have shapes but no evidence that both converge on identical admission and retirement semantics." Evidence needed: "End-to-end fixture sending the same edit through both paths and comparing durable state/Rid."

Baseline suite results before any change: `npm test` 16/16, `npm run test:offline-collab` 5/5, `npm run test:collab-conformance` 6 pass/0 fail/7 pending (unchanged from Task 40).

Confirmed before writing any code: `/Volumes/work disk/Codes/Tracker/AppFlowy` has no checked-out AppFlowy Cloud/server Rust source (only client-side Flutter/Rust and audit artifacts), and `/Volumes/work disk/Codes/Tracker/AppFlowy-SelfHost-Commercial` has only deployment configuration (Docker/Helm/nginx), no server source. This matches every prior task's finding and means no upstream evidence became newly available for this task.

## 2. Classification of each pending case

| Case | Expected protocol behavior | Current implementation | Missing prerequisite | Safely testable in isolation? | Risk of corrupting/losing persisted state |
|---|---|---|---|---|---|
| rid-allocation-ordering | `Rid` allocation/ordering scope and resume semantics across a shared Redis stream | Each storage backend allocates a locally-monotonic `{timestamp, counter}` per workspace (`storage.js`'s `s.workspaceRids`, `postgres-collab-repository.js`'s `allocateMessageId`); this is **not** claimed to be AppFlowy's `Rid` scheme | Upstream server stream-allocator source | No — nothing to compare our ordering against | None (no behavior change proposed) |
| **duplicate-admission** | Idempotent admission of a resent client update | Payload-digest (+ optional caller `messageKey`) dedup in both storage backends, shared by WS and HTTP lanes, but never tested end-to-end before this task | None — resolved this task | **Yes** — resolved |  — |
| realtime-ack | When/how a WebSocket update is acknowledged relative to durable commit | Server replies with an `update` frame carrying the assigned `messageId` only after `store.acceptPageCollabUpdate` has returned (i.e. after the in-process transaction/mutate has completed) — this is already crash-safe *for a single-process server*: the ack frame cannot be sent before the JSON file rename or the PostgreSQL `COMMIT` | Proving the acknowledgement is correctly timed relative to a genuine process crash (not just happens-after in normal control flow) requires injecting a crash between commit and send | Partially — a "no crash between commit and send in the happy path" check is checkable now; a true crash-window test needs process-kill infrastructure beyond `node --test` | Testing this safely would require intentionally killing the backend process mid-request, which risks leaving `/tmp` test fixtures in an inconsistent state if not carefully sandboxed — out of scope for this task's smallest-slice mandate |
| compaction-retention | Stream trimming / Yjs compaction and the recovery path after history is removed | The backend has no compaction or retention logic of any kind — all updates and the full document state are kept indefinitely | No trimming to test; nothing exists to validate | Not meaningfully — there is no behavior to assert beyond "we never delete history," which is already implicit in every persistence test | None — but implementing compaction without upstream semantics risks inventing a lossy policy AppFlowy doesn't use |
| restore-transition | Authoritative generation changes and client notification on a database restore | Client-driven restore-ID fencing exists and is tested offline (`RESTORE_GENERATION_MISMATCH`); no "restore" operation exists that changes a document's `restore_id` server-side | A server-initiated restore endpoint/operation does not exist; inventing one here would be a new feature, which is out of scope ("do not implement auxiliary endpoints") | No — there is nothing to integration-test without first building the restore operation itself | Building an unvalidated restore path carries real risk of corrupting persisted collab state if the generation-transition semantics are wrong |
| cross-instance-replay | Shared ordering/fan-out/failover across multiple server instances | The independent backend has no shared-stream component (no Redis); JSON mode is single-process by construction, PostgreSQL mode uses row-level locking (`FOR UPDATE`) for single-database correctness but was never designed for multi-instance fan-out | Running two backend instances against the same PostgreSQL database and defining replay/failover semantics is new infrastructure work | Only with a live, isolated PostgreSQL cluster and two concurrently running backend processes — explicitly larger than "smallest safe slice" | Low risk if done against a disposable database, but it is a meaningfully larger task than this one, not a verification of existing behavior |
| websocket-http-convergence | Both lanes converge on identical durable state/retirement rules | **New finding this task**: both lanes already call the exact same `store.acceptPageCollabUpdate` function (confirmed by reading `server.js` — the WebSocket `update` handler and the `full-sync/batch` handler both call it, passing no `messageKey` in either case), so by construction they cannot diverge on admission logic | An end-to-end fixture that sends the same logical edit through both paths back-to-back and compares results has not been written | Yes, but this is the natural "next slice" after duplicate-admission, not something this task's single-slice mandate covers (see §5) | None — purely additive test work |

## 3. Selected case: duplicate-admission

### Root cause / why it was pending despite being implemented

`storage.js::acceptPageCollabUpdate` (JSON mode) and `PostgresPageCollabRepository.acceptUpdate` (`postgres-collab-repository.js`, PostgreSQL mode) have computed a SHA-256 digest of the incoming Yjs update payload and checked it against previously-admitted updates for the same page since at least Task 18/35 — this is pre-existing code, not written in this task. Both `server.js`'s WebSocket `update` handler (`collabMessage.update`, around line 1084) and its HTTP `full-sync/batch` handler (around line 581) call this same function, so the dedup logic is already shared between both lanes.

However, the only test exercising duplicate detection was `test/offline-collab.test.js`'s `accepts a valid ordinary-text Yjs update and rejects duplicate delivery`, which runs entirely against `collab-repository.js`'s **in-memory, process-local, non-durable** `OfflinePageCollabRepository` — explicitly documented (`durable: false`) as a prototype, not the actual storage-backed admission path. No test ever sent two deliveries of the same update through a real WebSocket session against the real (JSON-mode) storage-backed `acceptPageCollabUpdate`. This is exactly the gap the pending vector described: "a two-delivery server fixture proving idempotence" did not exist.

### Protocol evidence (traced, not invented)

Per `docs/APPFLOWY_SYNC_SEMANTICS_AND_ADMISSION.md` (`Duplicate delivery` row): "The client persists outbox records and deletes exact records after a send/confirmed slow-sync. It does not define a server duplicate key or replay response." and the "Duplicate and retry handling" section: "A compatible server therefore needs idempotent admission, but the source does not establish whether the key is `Rid`, payload digest, client-generated ID, or another server key. The implementation must choose and document a stable key only after upstream evidence **or a separately approved protocol extension**."

This task treats the existing payload-digest choice as exactly that kind of separately-approved, documented extension — it is **not** claimed to be AppFlowy's own wire-compatible duplicate key (no upstream evidence establishes that), only a choice that correctly achieves idempotent admission for THIS server, consistent with the client's own documented outbox-retry model (the client resends the exact queued binary record, so the same bytes arriving twice is the realistic retry shape to defend against).

### New test (the implemented slice)

`test/backend.test.js`: new test `AppFlowy-Web Document WebSocket reconnect replays the manifest and resent updates are admitted exactly once`. It:

1. Creates a disposable account/workspace/space/Document and opens a WebSocket session (session 1).
2. Sends a `SyncRequest`, then an `update` inserting a unique marker, and captures the assigned `messageId` from the ack frame.
3. Closes session 1 (modeling a client that disconnects before it can confirm the update was durably admitted — the exact scenario the Web client's `sync-outbox` module is documented to defend against).
4. Opens a new WebSocket session (session 2) — a "reconnect" — using the client's **pre-update** state vector, as if the client never learned whether session 1's update was admitted.
5. Sends `SyncRequest` again and asserts the server correctly replays the missing update (proving **reconnect correctness**, not just duplicate-admission) with the same `messageId` as the original.
6. Resends the **identical** update payload on session 2 and asserts the ack carries the **same `messageId`** as the original (not a new one) — proving the resend was recognized as a duplicate, not re-applied.
7. Reads back the persisted document via the HTTP collab-read route and asserts the marker text appears **exactly once**, not twice.

This single fixture satisfies the pending vector's own evidence bar ("a two-delivery server fixture proving idempotence") and additionally exercises reconnect/retry correctness (Step 2's priority #1) along the way, since the two are naturally the same scenario (a client that reconnects after an unconfirmed send must not have its resend double-applied).

### Conformance harness update

`test/collab-conformance.js`: `duplicate-admission` removed from `pendingVectors` and added to a new `resolvedVectors` list, printed as a `RESOLVED` line in the suite's summary output (added a `resolved=N` count alongside the existing `passed`/`failed`/`pending`/`skipped` counts). The resolved entry's text explicitly states what is and is not proven (our server's own idempotent admission — not AppFlowy wire-key compatibility), matching the project's standing rule against overclaiming compatibility.

No change was made to `collab-repository.js` (the offline prototype) or its existing offline test — that test still correctly describes a non-durable, in-memory duplicate check and was not conflated with the new durable, storage-backed evidence.

## 4. Files changed

- `test/backend.test.js` — one new integration test (described above). No production code touched.
- `test/collab-conformance.js` — `duplicate-admission` moved from `pendingVectors` to a new `resolvedVectors` list with updated evidence text; `websocket-http-convergence`'s pending description updated to note the newly-observed shared-admission-function evidence (still pending — see §5); summary output extended with a `resolved=N` line and `RESOLVED` entries.

`server.js`, `storage.js`, `postgres-collab-repository.js`, and all other production files are **unchanged** — this task found that the necessary implementation already existed and needed only verification and correct classification, not new code.

## 5. Test results

```
npm test                          17 passed, 0 failed (was 16; +1 for the new reconnect/duplicate-admission fixture)
npm run test:offline-collab        5 passed, 0 failed (unchanged)
npm run test:collab-conformance    6 passed, 0 failed, 6 pending, 1 resolved (was 6 passed/0 failed/7 pending)
```

PostgreSQL tests: **not run** — no isolated test database was configured, consistent with every prior task. Note: the new evidence is specific to the code path exercised by the test run, which starts the backend in JSON mode (as `test/backend.test.js`'s existing `before()` hook always does). `postgres-collab-repository.js`'s duplicate-detection query (`WHERE ... payload_digest=$3 OR (...message_key=$4)`) was read and is structurally the same dedup strategy, but it has **not** been exercised by this task's two-delivery fixture against a real PostgreSQL instance — this is an explicit remaining gap, not a claim of parity.

## 6. Unresolved protocol questions and known limitations

- **Payload-digest is not proven to be AppFlowy's own duplicate key.** It is a documented, locally-chosen idempotency strategy that correctly prevents double-admission for this server's own two-delivery scenario. If a future upstream evidence source reveals AppFlowy uses a different key (e.g., a client-generated UUID or `Rid`-based key), this choice may need to change; nothing in this task's evidence rules that out as a future finding.
- **Digest-only dedup cannot distinguish two different logical edits that happen to produce byte-identical Yjs update payloads.** This is an inherent limitation of any content-addressed key and is noted here rather than silently accepted; it was not observed to occur, and fixing it would require a client-generated per-operation ID that the current AppFlowy-Web client's wire format does not appear to provide (per the audit's own "Client-originated message IDs" row: "client updates omit `message_id`; server assigns it after storage").
- **realtime-ack, compaction-retention, restore-transition, and cross-instance-replay remain pending**, each for a distinct, now more precisely documented reason (see §2's table) — none can be resolved without either upstream server source (unavailable in this checkout) or new infrastructure/features explicitly out of this task's scope (a crash-injection harness, a restore endpoint, a second live server instance).
- **rid-allocation-ordering remains pending**: this task did not change or re-examine the existing local `{timestamp, counter}` allocator; it remains explicitly not claimed as AppFlowy's `Rid` scheme.
- **websocket-http-convergence remains pending but its evidence gap narrowed**: both lanes share one admission function (new finding, confirmed by reading `server.js`), which structurally prevents the two lanes from applying different admission rules — but no fixture yet proves this end-to-end by sending the same edit through both paths and comparing results. This is explicitly called out as the next smallest task rather than being implemented here, to respect "do not expand scope merely to clear the pending count."

## 7. Recommended next smallest task

**Write the websocket-http-convergence fixture**: in `test/backend.test.js`, create a Document, send update A via WebSocket, then send a logically-equivalent-but-independent update B via `POST .../collab/full-sync/batch`, and assert both lanes' resulting `documentState`/`stateVector`/`messageId` sequencing are mutually consistent (e.g., the HTTP lane correctly reconciles against the state the WebSocket lane already committed, and vice versa for a second ordering). This is the natural, directly-evidenced follow-up to this task's finding that both lanes already share one admission function — it requires no new production code (unless the fixture surfaces a real bug) and no upstream evidence, matching this task's same "verify what's already built" pattern. It would resolve or more precisely re-scope the `websocket-http-convergence` pending case.

Real-browser verification was **not** attempted in this task, per its own instructions (the deliverables list only calls for `npm test` / `test:offline-collab` / `test:collab-conformance` plus targeted tests) — no claim of browser-verified or multi-client/multi-instance behavior is made here.
