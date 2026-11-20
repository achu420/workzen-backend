# Task 47: compaction/retention investigation and tests (no production code changed)

## Scope and method

Investigation-and-test task. Read `server.js`, `storage.js`, `postgres-storage.js`,
`postgres-collab-repository.js`, `collab-repository.js`, and `migrations/*.sql`, and
grepped the whole repository (excluding `node_modules`) for
`snapshot|compact|prune|retention|expire|cleanup|gc|cron|background job|setInterval`.
All findings below marked "read" were verified by reading source; findings marked
"ran"/"tested" were verified by executing the test suite.

## 1. Where are accepted Yjs updates actually stored?

**Both storages keep a single full-document-state blob that is unconditionally
rewritten on every accepted update** — not an update log that must be replayed.

- JSON (`storage.js`): `pageCollabDocuments[pageId]` holds `document_state` and
  `state_vector` (plain arrays of bytes). `acceptPageCollabUpdate`
  (`storage.js:162-245`) calls `preparePageCollabUpdate` (in
  `postgres-collab-repository.js:26-79`, shared by both backends), which merges the
  stored state with the incoming update via `Y.applyUpdate` and re-serializes the
  *entire* document with `Y.encodeStateAsUpdate`/`Y.encodeStateVector`
  (`postgres-collab-repository.js:72-75`). The result overwrites `row.document_state`
  and `row.state_vector` in place (`storage.js:213-214`).
- PostgreSQL (`postgres-collab-repository.js`): `collab_documents` table, columns
  `document_state`/`state_vector` (`migrations/001_initial.sql:77-88`), updated the
  same way: `UPDATE collab_documents SET document_state=$3,state_vector=$4,...`
  (`postgres-collab-repository.js:197-198`), guarded by an optimistic
  `generation=$8` check.

## 2. Individually stored, or complete state rewritten?

Complete state is rewritten on every single accepted update, in both backends (see
above). This confirms Task 42's finding.

In parallel, **both backends also keep a per-update record for deduplication**, but
these records are asymmetric between the two backends:

- JSON: `s.pageCollabUpdates[pageId]` (`storage.js:186-222`) is an array of
  `{ payload_digest, message_key, message_id }` only — **the actual update bytes are
  never stored here**, only a SHA-256 digest and the allocated message id. There is no
  way to replay history from this array; it exists purely so a resend of an identical
  payload can be recognized and the original `messageId` returned
  (`storage.js:187-203`).
- PostgreSQL: `collab_updates` table (`migrations/001_initial.sql:90-106`) stores the
  **full `payload` bytes** per accepted update (`postgres-collab-repository.js:195-196`,
  column `payload bytea NOT NULL`), plus `before_state_vector`, `collab_version`,
  `restore_id`, and the allocated `message_id`. This is read back only once, for
  dedup-by-digest/`message_key` lookup (`postgres-collab-repository.js:161`) — **never**
  to reconstruct document state. `load()`/sync paths (`postgres-collab-repository.js:143-148`)
  read only `collab_documents`, never `collab_updates`.

So: JSON mode keeps *no* history at all (only hashes); PostgreSQL mode keeps a
write-mostly history log of raw bytes that is currently unused for anything except
duplicate detection.

## 3. Is there an existing compaction or snapshot mechanism at all?

**No.** Grep across the whole repository (excluding `node_modules`) for
`snapshot|compact|prune|retention|expire|cleanup|gc|cron|background job|setInterval`
matches only unrelated code: auth/session `expires_at`/`refresh_expires_at` fields and
checks (`server.js`, `storage.js`, `postgres-storage.js`) and documentation prose
about *what doesn't exist yet*. There is no snapshot operation, no compaction routine,
no scheduled job, no `setInterval`, and no size/age-based trimming of either
`pageCollabUpdates`/`collab_updates` or `document_state` anywhere in `server.js`,
`storage.js`, or `postgres-storage.js`.

## 4. Is any update history deleted, pruned, or expired anywhere?

**No deletion of `collab_updates` rows or `pageCollabUpdates` entries exists** in any
code path read. The only places rows are removed from any table at all are: session
revocation (`DELETE FROM sessions ...`, unrelated to collaboration), and
`collab_updates`' `ON DELETE CASCADE` from `pages`/`collab_documents`
(`migrations/001_initial.sql:104`) — i.e. collab-update rows are removed only as a
side effect of a *page itself* being deleted, not by any retention policy. Since
`server.js` has no page-deletion route exercised in this investigation (not checked
further, out of scope), this cascade was not exercised.

## 5. What would happen to synchronization if old updates were removed (hypothetically)?

Reasoning from code, not tested (there is nothing to remove):

- Removing rows from `collab_updates` (Postgres) or entries from `pageCollabUpdates`
  (JSON) today would have **no effect on sync correctness**, because sync
  (`getPageCollab`/`load()`) never reads either structure — it reads only the single
  `document_state`/`state_vector` pair. The only observable effect would be losing
  duplicate-delivery detection for updates whose digest/message_key was in a removed
  row (a resend would then be re-applied as if new, though since Yjs updates are
  idempotent/CRDT-mergeable, applying the same op twice would not corrupt state, but
  could return a different (duplicate-processed) ack messageId than today's `status:
  'duplicate'` contract documents — a behavior change worth avoiding if trimming is
  added).
- Removing or rewriting `document_state` itself (the actual "compaction" target one
  would imagine for a real compaction feature, i.e. periodically re-merging accumulated
  updates into a smaller encoded form) is **already effectively what happens on every
  update** — `Y.encodeStateAsUpdate` always emits the minimal encoding of the full
  merged document, not a delta chain. There is no larger "update log" backing the
  current document representation that a future compaction could meaningfully shrink;
  the thing that *would* grow unboundedly if left alone is `collab_updates` in
  Postgres (JSON's per-update records are already tiny, digest-only).

## 6. Can a newly connected client reconstruct the complete current document state from what's actually stored?

**Yes — tested, not just read.** This is exactly what this task's new test
demonstrates: `getPageCollab`/HTTP collab route (`server.js:649`, `server.js:678`) and
the WebSocket `SyncRequest` manifest path (`server.js:1026-1063`) both serve directly
from `document_state`/`state_vector`, and a fresh `Y.Doc` built from that single blob
reconstructs every edit ever applied — because, per (1)/(2), that blob already *is*
the fully-merged current state, not a replay target.

## 7. Could a hypothetical future compaction interfere with state-vector-based incremental sync?

Given current code: **not with the `document_state`/`state_vector` pair itself**
(any future compaction of that pair would have to preserve the invariant that
`Y.decodeStateVector(state_vector)` exactly matches `Y.encodeStateVector` of the Yjs
document encoded in `document_state`, which `preparePageCollabUpdate` already relies
on for the `beforeStateVector` causal-coverage check, `postgres-collab-repository.js:54-60`).
Compacting/trimming the **separate** `collab_updates`/`pageCollabUpdates` dedup
records, however, *could* interfere with the duplicate-detection contract described in
(5) if done naively (e.g. trimming by age could let an old retried update be
double-processed under a fresh messageId instead of returning the original one). Any
future design must keep retention of dedup records independent from, and not confused
with, compaction of `document_state`.

## 8. Could it destroy information needed for future document version history/restore?

**Yes, this is the main risk**, and it ties directly to Task 45's finding. Task 45
confirmed `restore_id` fencing exists (`preparePageCollabUpdate`,
`postgres-collab-repository.js:43-44`) but **no server-side restore operation exists
yet that changes `restore_id`** or that would need to roll a document back to an
earlier point. If that restore feature is ever built, it will almost certainly need
either (a) point-in-time document states, or (b) the individual update log, to
reconstruct "document state as of generation N." Since `collab_updates` in Postgres is
currently the *only* structure anywhere in this codebase that holds individual update
payloads at all (JSON mode holds none), **any future compaction that deletes rows from
`collab_updates` without first building an alternative point-in-time snapshot
mechanism would permanently foreclose a straightforward restore implementation in
Postgres, and JSON mode already has nothing to lose today** (it never had
per-update history to begin with). This is exactly the reasoning Task 45's report
anticipated without this task's full trace confirming it.

## 9. Are JSON and PostgreSQL storage behaviorally equivalent here?

**No — this is the one concrete, documented asymmetry this task found.** Both are
equivalent for synchronization/reconstruction (both serve the same
`document_state`/`state_vector` contract, confirmed by the one shared test suite
exercising JSON mode and by reading the parallel Postgres code path). They are **not**
equivalent for retained history: JSON mode never persists update payload bytes at all
(only digests), while PostgreSQL mode persists every update's full payload bytes
indefinitely in `collab_updates`, unused today except for dedup. This is not a defect
— nothing currently depends on that history existing — but it means a future
restore/version-history feature could be built on top of PostgreSQL's existing data
with no schema change, while JSON mode would need a new write path added first.

## 10. Safest future compaction design (recommendation only, not implemented)

1. Never touch `document_state`/`state_vector` for "compaction" — that representation
   is already minimal/current and sync-critical; there's nothing to compact there.
2. If/when `collab_updates` (Postgres) growth becomes a real operational concern,
   separate "compaction" from "retention": only prune update rows once a feature that
   depends on them (restore/version history) has consumed what it needs, and only
   after confirming no resend window (sync-outbox retry) can still reference the
   pruned row's digest/`message_key`.
3. Decide the version-history/restore design *before* adding any deletion logic, since
   (per Q8) deleting `collab_updates` rows forecloses the cheapest implementation path
   for that feature in Postgres.
4. If retention of `collab_updates` is added, make the JSON backend's behavior
   explicit (it already stores no payload bytes) rather than silently diverging further
   from Postgres mode — e.g. decide whether JSON mode needs to grow a payload-storing
   update log to reach feature parity with Postgres, or whether JSON mode is accepted to
   never support restore/version history.
5. Any trimming of dedup records must preserve the "resend of an unconfirmed update
   gets back its original messageId" contract (Task 41/44), not just avoid corrupting
   `document_state`.

## Tests performed

Added one new test to `test/backend.test.js`: `"compaction-retention: no
compaction/snapshot mechanism exists; many sequential updates remain reconstructable
from the single stored current-state blob, by a fresh client, and after a storage
restart"`. It uses an isolated, disposable temp-file JSON store (same `before`/`after`
harness as the rest of the suite) and asserts, against the running server:

1. 8 sequential WebSocket updates on one connection are all present in a fresh `Y.Doc`
   built only from the HTTP-served `document_state` (no replay of any update log is
   involved, matching Q1/Q2's finding that none exists to replay).
2. A brand-new client (fresh `Y.Doc`, fresh WebSocket `SyncRequest` with an empty
   state vector) receives a correct manifest and a fresh HTTP read reconstructs the
   same complete state.
3. After closing and restarting the server process against the *same* JSON file
   (`storage.js`'s plain `JSON.parse`/`persist` round trip, same restart pattern used
   by the pre-existing "data survives reopening..." test and Tasks 39/42/44), the
   document is still fully reconstructable, and a stale client (pre-edit state vector)
   reconnecting after restart still gets a correct, version-tagged manifest —
   demonstrating state-vector-based sync is unaffected by a storage restart.

No test simulates or asserts "survives compaction," because — per Q3 — no compaction
mechanism exists to survive; doing so would have been inventing behavior, which was
explicitly out of scope.

### Exact verification output

`npm test`: **29/29 pass** (was 28/28; +1 new test, 0 regressions).

`npm run test:offline-collab`: **5/5 pass** (unchanged).

`npm run test:collab-conformance`:
```
COLLAB_CONFORMANCE_SUMMARY
passed=6
failed=0
pending=3
skipped=0
resolved=4
```
Unchanged from the stated baseline (passed=6, pending=3, resolved=4).
`compaction-retention` **remains pending** — deliberately not resolved. Resolving it
for real would require an actual upstream-compatible compaction/retention
implementation and a "recovery after history is removed" fixture against it; neither
exists, and inventing one was explicitly out of scope for this task. The new test adds
confidence about *today's* reconstruction/no-compaction-yet behavior but does not
change what `compaction-retention` requires to resolve.

## Production code changes

**None.** Only `test/backend.test.js` was modified (one new test added). No changes
to `server.js`, `storage.js`, `postgres-storage.js`, `postgres-collab-repository.js`,
or any migration.

## Risks for future compaction/version-history work

- See Q8/Q10: any future compaction touching `collab_updates` risks destroying the
  only existing path to point-in-time restore in Postgres before that feature is built.
- JSON and Postgres modes are not at parity for history retention (Q9); a future
  feature built against one backend's data may silently not work on the other.
- No notification/consumer of `collab_updates` exists today, so adding retention is
  currently low-risk *in isolation* — but only until something starts depending on
  that history (e.g. a restore feature), at which point retention policy becomes
  safety-critical.

## Recommended next task

Per the task brief's own guidance and this investigation, `compaction-retention`
should remain low priority (nothing to test without an implementation). The two
candidates flagged by Task 45/46 are `restore-transition`'s server-side authoritative
piece (building an actual restore route/operation, now informed by this task's finding
that Postgres's `collab_updates` already holds the raw data such a feature would need)
and `cross-instance-replay` (needs a second server instance / shared stream, per
Task 41's existing conformance notes). Recommend `restore-transition`'s server-side
piece next, since this task's trace of `collab_updates` gives it a concrete data
source to design against, whereas `cross-instance-replay` still needs infrastructure
(a second instance/shared stream) outside this project's current scope.
