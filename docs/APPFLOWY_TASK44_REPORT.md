# Task 44 — realtime-ack fault-injection report

## Goal

Prove, via actual fault injection into the persistence layer (not static code tracing, which Task 42 already did), that the Document WebSocket `update` handler in `server.js` never emits a successful ack before the update is durably persisted to disk.

## Fault-injection method

Task 42 established that `mutate()` (`storage.js:269-274`) calls `store.persist(state)` if `store.persist` is set, otherwise falls back to the module-level `persist(file, state)` function. This override hook pre-existed Task 44's changes and required **no production code change**: it was used exactly as-is as the injection seam.

Three new tests were added to `test/backend.test.js`, each:
1. Opens an authenticated Document WebSocket, completes `SyncRequest`/manifest exchange.
2. Builds a real Yjs update locally.
3. Installs `store.persist = <fault-injecting function>` before sending the update.
4. Sends the update over the socket and observes the actual wire behavior (ack frame, absence of ack, or close frame/code).
5. Restores `store.persist` to its original value in a `finally` block.

Timing control uses explicit promises/barriers (a manually-resolved gate promise for the delayed case; polling a boolean `persistInvoked` flag with a bounded deadline loop only to confirm the hook was *entered* before racing the "no ack yet" assertion) — not sleep-based synchronization as the primary mechanism. The "no ack while blocked" assertion is a `Promise.race` between the ack-frame promise and a short (300ms) grace-timeout, not an instant check.

## Test A — delayed persistence

**Result: PASS.** With `store.persist` holding an unresolved gate promise, no ack frame was observed within a 300ms grace window while persistence was confirmed in-flight (`persistInvoked === true`, `persistCompleted === false`). After releasing the gate, persistence completed (confirmed by `persistCompleted === true`) strictly before the ack frame was observed, and the acked update was independently confirmed durable via a fresh HTTP `GET` on the collab route.

## Test B — failed persistence

**Result: PASS.** With `store.persist` always throwing, no ack frame was ever observed (raced directly against the socket's `close` event). The documented behavior in `server.js` (`admissionError` not matching a known rejection code) triggered: the socket closed with code **1011**, reason **"Document update could not be persisted"**. After restoring working persistence, a fresh `GET` on the collab route confirmed the failed update's marker text is absent from durable state — the in-memory rollback in `acceptPageCollabUpdate`'s `catch` block (restoring `store.state = previousState`) combined with the persist failure means nothing was ever written.

## Test C — retry after failure

**Implemented**, using retry semantics already established by Task 41's own fixture, not invented: the AppFlowy-Web sync-outbox keeps a queued record until confirmed and resends it after reconnecting with the client's pre-update state vector (`docs/APPFLOWY_SYNC_SEMANTICS_AND_ADMISSION.md`; Task 41's reconnect test in `test/backend.test.js`). The new test reproduces attempt 1 exactly as Test B (persist fails, socket closes 1011, update not durable), then opens a second socket, resends the identical update payload with working persistence restored, and confirms: the retry receives a normal ack with a server-issued `messageId`, and the final durable state contains the marker text **exactly once** (not zero, not twice) — exactly-once admission across a failed-then-retried attempt.

**Result: PASS.**

## Production code changes

**None.** The `store.persist` override hook already existed in `storage.js` from before Task 44 and needed no modification. No defect was found in the ack-before-persist invariant, the 1011 close path, or the in-memory rollback-on-failure behavior — all three matched Task 42's static trace exactly under live fault injection.

## Exact verification results

`npm test`:
```
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
(includes the 3 new realtime-ack fault-injection tests plus all 18 pre-existing tests, all passing.)

`npm run test:offline-collab`:
```
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`npm run test:collab-conformance`:
```
COLLAB_CONFORMANCE_SUMMARY
passed=6
failed=0
pending=4
skipped=0
resolved=3
```
`realtime-ack` moved from `pendingVectors` to `resolvedVectors` in `test/collab-conformance.js`, alongside `duplicate-admission` (Task 41) and `websocket-http-convergence` (Task 43).

## Remaining pending conformance cases (4)

- `rid-allocation-ordering`
- `compaction-retention`
- `restore-transition`
- `cross-instance-replay`

## Recommended next task

Tackle `restore-transition` or `rid-allocation-ordering` next — both are scoped to this backend's own behavior (unlike `cross-instance-replay`, which needs a second server instance, and `compaction-retention`, which needs a retention/compaction implementation that doesn't exist yet). `restore-transition` in particular has visible client-side restore fencing (`restoreId`/`expectedRestoreId` already present in `storage.js`'s `acceptPageCollabUpdate`) that a focused integration fixture could likely exercise without new upstream evidence, similar to how Task 41 and Task 44 resolved their targets using only this repository's existing code and fixtures.
