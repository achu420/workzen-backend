# Task 45 — Restore-generation fencing: test-first verification

## Scope

Task 45 is test-first: verify the restore-generation fencing mechanism
already present in `storage.js`'s `acceptPageCollabUpdate`, and the
`restore-transition` conformance case it corresponds to
(`test/collab-conformance.js`). No production behavior change was
requested unless a genuine defect was found; none was found, so no
production code changed.

## What restore-generation fencing actually is, in this codebase (file:line evidence)

- `storage.js:127` — every collab document row is created with
  `restore_id: null`. This is the only place in the JSON-mode storage
  layer that ever *writes* `restore_id`.
- `storage.js:162-184` — `acceptPageCollabUpdate` reads the caller-supplied
  `restoreId` and the durable `row.restore_id`, and calls
  `preparePageCollabUpdate({ ..., restoreId, expectedRestoreId: row.restore_id })`.
- `postgres-collab-repository.js:26-44` — `preparePageCollabUpdate` is the
  shared fencing function. Lines 43-44:
  `if ((restoreId || null) !== (expectedRestoreId || null)) throw failure('RESTORE_GENERATION_MISMATCH', 'restore generation mismatch');`
  This is the entire fencing check: the admitted update's `restoreId` must
  exactly equal the document's currently durable `restore_id`, else the
  write is rejected before any state mutation.
- `postgres-collab-repository.js:133-135,150-199` — the PostgreSQL
  repository's `persistInitial` and `acceptUpdate` mirror the same
  `restore_id` column and the same `preparePageCollabUpdate` fencing check,
  so JSON mode and PostgreSQL mode share identical semantics here.
- `server.js:1091` — the WebSocket update handler passes
  `update.databaseRestoreId || null` straight through as `restoreId` to
  `store.acceptPageCollabUpdate`.
- `server.js:544,588,626` — the HTTP full-sync/batch lane does the
  equivalent comparison against `item.databaseRestoreId` /
  `current.restore_id`, returning `'restore_generation_mismatch'` in the
  per-item result rather than throwing.
- `server.js:1114-1129` — on the WebSocket lane, `RESTORE_GENERATION_MISMATCH`
  (along with `UNSUPPORTED_FLAGS`, `EMPTY_UPDATE`, `VERSION_MISMATCH`,
  `INVALID_BEFORE_STATE_VECTOR`, `MISSING_CAUSAL_STATE`,
  `MALFORMED_YJS_UPDATE`, `UNRESOLVED_DEPENDENCY`) closes the socket with
  code **1008**, reason `"Document update was rejected"`. This confirms
  Task 42's trace was correct.

### The critical finding: there is no real "restore" trigger anywhere

An exhaustive grep across `storage.js`, `server.js`, `postgres-storage.js`,
and `postgres-collab-repository.js` for every assignment to `restore_id`
found exactly one write site in each storage backend — the document's
*creation* path, which always writes `null` (JSON: `storage.js:127`;
PostgreSQL: the `INSERT ... restore_id` in `persistInitial`, always
invoked with its default `restoreId = null`). **No HTTP route, WebSocket
message type, or repository method in this codebase ever changes
`restore_id` away from its creation-time value.** This matches exactly
what the `restore-transition` pending-conformance entry already said:
*"Client restore fencing is visible, but authoritative generation changes
and notifications are server behavior"* — i.e., the fencing *check* is
real production code, but the thing it fences (an actual restore
operation that bumps the generation and notifies peers) does not exist
yet in this backend.

Per the task's explicit instruction not to invent a production restore
API to make tests pass, no such route or repository method was added.
Instead, the new test exercises the real fencing logic by directly
setting the durable `restore_id` field via `storage.js`'s own exported
`mutate` function — the same function `acceptPageCollabUpdate` itself
uses to persist — on the same row the real fencing check reads. This is
not a new production surface; it is using the actual persisted field,
through the actual durability path, to establish the precondition that
a real restore feature would someday set.

## Test scenarios (test/backend.test.js, single fixture: "restore-transition: ...")

All five scenarios run as one fixture against the shared in-process test
server (`before`/`after` in `test/backend.test.js`, isolated temp-dir JSON
file, OS-assigned port via `port: 0`), consistent with every other fixture
in this file.

- **Test A — normal update before restore**: PASS. A Document is created,
  an update is admitted via `store.acceptPageCollabUpdate` with
  `restoreId: null` (matching the document's creation-time generation),
  `status === 'applied'`, and the marker text is durably readable back
  over HTTP.
- **Test B — restore transition**: PASS. `row.restore_id` is set from
  `null` to a new generation id via `storage.js`'s exported `mutate`
  (the real durability path — this is the one place production code has
  no real trigger, as explained above). The new value is confirmed durable
  in `store.state`, and the "restored" document state (unchanged content
  under the new generation) still reads back correctly over HTTP.
- **Test C — stale update rejection**: PASS. A valid Yjs update is built
  against the restored state and submitted with the *previous*
  (pre-restore, `null`) `restoreId`, both via direct
  `store.acceptPageCollabUpdate` (rejected with
  `error.code === 'RESTORE_GENERATION_MISMATCH'`) and via a live WebSocket
  (`update.databaseRestoreId` set to the stale value), which closes with
  code **1008**, reason `"Document update was rejected"`, confirming
  server.js's documented behavior. The document state is confirmed
  byte-for-byte unchanged (`Y.encodeStateAsUpdate` equality) after the
  rejected attempt.
- **Test D — valid update after restore**: PASS. A new update built
  against the restored state is submitted with the *new* `restoreId` and
  is admitted (`status === 'applied'`), persists over a fresh HTTP read,
  and is also visible after a fresh WebSocket SyncRequest/resync from an
  empty state vector.
- **Test E — persistence and restart**: **skipped**, documented in the test
  itself. This test file shares one long-lived server/store instance
  across the whole suite (`before`/`after`); tearing it down mid-file to
  spawn a second `startServer` against the same `state.json` risked
  cross-test interference with every other fixture in the file. The
  restart-specific behavior left unverified is narrowly "does a brand-new
  process reading the same file see the same `restore_id`" — which follows
  directly from `storage.js`'s `openStore` doing a plain
  `JSON.parse(await readFile(file))` with no separate restore-id handling
  (there is no special-cased field), and is not independently re-verified
  by a dedicated process restart in this task. The durability of the
  `restore_id` write itself (via `mutate`, which always calls
  `persist`/`store.persist`) *is* exercised in Tests B-D.

## Production changes

None. No defect was found in the fencing logic itself; it behaves exactly
as `preparePageCollabUpdate` and server.js's error-code table document.
The only "gap" found — no real restore-triggering route exists yet — is
not a defect, it is simply an unimplemented feature, consistent with the
`restore-transition` pending-conformance note already on file before this
task.

## Verification (exact output)

`npm test`:
```
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
(21 pre-existing tests + 1 new "restore-transition: ..." fixture, all passing.)

`npm run test:offline-collab`:
```
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
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
Pending cases unchanged: `rid-allocation-ordering`, `compaction-retention`,
`restore-transition`, `cross-instance-replay`. `restore-transition`
deliberately stays pending — see "critical finding" above; flipping it to
resolved would require a real server-side restore route/repository method
and notification behavior, which does not exist and was explicitly out of
scope to invent.

PostgreSQL runtime testing was **not performed** — no isolated PostgreSQL
instance was configured for this task, consistent with every prior task
(42-44) in this series. `postgres-collab-repository.js` and
`postgres-storage.js` were read and traced structurally only.

## Recommended next task

`rid-allocation-ordering` or `cross-instance-replay` are the next
highest-value pending cases, since both concern multi-connection/
multi-instance ordering guarantees this single-process test harness
cannot exercise today. `compaction-retention` is lowest priority since
there is no compaction implementation to test at all yet.
