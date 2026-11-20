# Task 49B: Document Version History and Restore — PostgreSQL Parity

## Scope

Ports Task 49A's JSON-storage document version-history/restore feature to
PostgreSQL, additively, without redesigning it. JSON (`storage.js`) remains
the reference implementation and is untouched. `server.js`'s 5 HTTP routes
needed **no changes**: they already call generic `store.*` methods
(`listPageCollabVersions`, `getPageCollabVersion`, `createPageCollabVersion`,
`tombstonePageCollabVersion`, `restorePageCollabVersion`); this task only
had to make `postgres-storage.js` implement those same methods against a new
Postgres-backed repository.

## Part A: JSON reference behavior (read, not re-derived)

Read directly from `storage.js` (lines ~262-435):

- **History listing** (`listPageCollabVersions`): filters `pageCollabVersions[pageId]`
  to non-tombstoned entries, optional `since` (ms) filter on `created_at`, sorted
  ascending by `created_at`. Returns `null` if the page/collab row doesn't belong
  to `workspaceId` (ownership check), which server.js maps to 404.
- **Preview** (`getPageCollabVersion`): looks up a version by id scoped to the
  page; returns the raw full Yjs `document_state` bytes.
- **Named snapshot creation** (`createPageCollabVersion`): validates ownership,
  computes `parent` as the latest non-tombstoned version, stores a full
  reconstructable state (already validated as replayable by the HTTP layer
  before calling), `kind: 'named'`.
- **Tombstone deletion** (`tombstonePageCollabVersion`): sets `deleted_at`;
  never physically deletes; idempotent (`already_deleted` status).
- **Restore** (`restorePageCollabVersion`): runs on the *same single-writer
  queue* (`pageCollabUpdateQueue`) as ordinary collaboration updates, so
  restores and updates serialize against each other (first durable write
  wins). Steps: (1) idempotency check — digest of `(pageId, versionId)`
  compared against the last restore event for the page; if it matches **and**
  the current `restore_id` still equals that event's resulting id (nothing
  else mutated the row since), return the previous result unchanged
  (`status: 'duplicate'`); (2) look up target version, reject if missing/
  tombstoned; (3) create an implicit before-restore snapshot of the
  *current* document state (`kind: 'before_restore'`); (4) install the
  target version's state as the new `document_state`, recompute
  `state_vector` from it (not reuse the stored vector, since it may be stale
  relative to the installed bytes); (5) assign a new `restore_id`
  (`randomUUID()`) and bump `generation`; (6) append a restore event. Does
  **not** touch `workspaceRids` (no Rid is allocated). The existing Task 45
  fencing in `preparePageCollabUpdate` (`restoreId !== expectedRestoreId` →
  `RESTORE_GENERATION_MISMATCH`) is reused unmodified for stale-client
  rejection.

## Part B: PostgreSQL data model (additive)

New migration `migrations/005_document_version_history.sql`, following this
repo's existing conventions (uuid PKs, `timestamptz`, FK `ON DELETE CASCADE`,
`IF NOT EXISTS`, no destructive changes to tables from 001-004):

- `collab_versions(version uuid PK, workspace_id, page_id, parent uuid NULL,
  name text NULL, document_state bytea, kind text CHECK IN ('named',
  'before_restore'), created_at, created_by bigint NULL, deleted_at
  timestamptz NULL, editors bigint[])`. Tombstone is `deleted_at`; rows are
  never deleted. Index on `(workspace_id, page_id, created_at)` for listing.
- `restore_events(id uuid PK, workspace_id, page_id, digest text,
  restored_version_id uuid FK → collab_versions, before_restore_snapshot_version_id
  uuid FK → collab_versions, resulting_restore_id uuid, actor bigint NULL,
  created_at)`. Doubles as the restore audit log and the idempotency source
  (most recent row per page, by `created_at`). Index on
  `(workspace_id, page_id, created_at DESC)`.

`collab_updates` (the raw-update dedup log) is untouched and not reused as
history, per the Task 47 finding. No existing table/column was altered or
dropped.

## Part C: the 5 endpoints — Postgres implementation

Implemented entirely in `postgres-collab-repository.js` (new methods added to
`PostgresPageCollabRepository` via `Object.assign` on the prototype:
`listVersions`, `getVersion`, `createVersion`, `tombstoneVersion`,
`restoreVersion`) and wired into `postgres-storage.js`'s repository object
under the exact same method names JSON uses
(`listPageCollabVersions`, `getPageCollabVersion`, `createPageCollabVersion`,
`tombstonePageCollabVersion`, `restorePageCollabVersion`). Because `server.js`
already only calls these generic names, **no server.js or frontend changes
were made or needed** — Task 48's confirmed contract carries over unchanged.

## Part D: transactional restore

`restoreVersion` in `postgres-collab-repository.js` runs as a single
`BEGIN`/`COMMIT`/`ROLLBACK` transaction:

1. `SELECT ... FROM collab_documents ... FOR UPDATE` row-locks the document
   row, serializing concurrent restores/updates for this page (Postgres's
   native row lock plays the role JSON's single-writer queue plays).
2. Idempotency check against the latest `restore_events` row (same digest +
   `resulting_restore_id` still equals the document's current `restore_id`).
   On a match, commits (no-op) and returns `status: 'duplicate'`.
3. Validates the target version exists and is not tombstoned (throws
   `VERSION_NOT_FOUND` / `VERSION_DELETED` — transaction rolls back, no
   partial state).
4. Inserts the before-restore snapshot row.
5. `UPDATE collab_documents ... WHERE generation=$current` (optimistic
   concurrency belt-and-suspenders on top of the row lock) installs the
   target state, a freshly recomputed state vector, a new `restore_id`, and
   bumps `generation`. If `UPDATE` affects 0 rows (lost the race somehow),
   throws `CONCURRENT_UPDATE` and rolls back.
6. Inserts the `restore_events` row.
7. `COMMIT`.

Any thrown error triggers `ROLLBACK` before the error propagates, so a
failure leaves no advanced generation without installed state, no orphaned
restore event, and no missing before-restore snapshot — verified directly
(see Testing Evidence, item 9 analytically; Postgres's transactional
guarantees were not separately fault-injected at the driver level, see
Limitations). No workspace Rid is allocated anywhere in this path. The
existing WebSocket stale-generation fencing (`RESTORE_GENERATION_MISMATCH` →
close 1008) is untouched and reused as-is through `preparePageCollabUpdate`.

## Part E: JSON/Postgres parity

No shared parameterized test harness file was added (time-boxed); instead,
JSON's existing `test/backend.test.js` "version-history:" fixtures were left
untouched (reference behavior, must keep passing), and an equivalent,
independent check suite was run directly against a real Postgres instance
(see Testing Evidence) covering the same behaviors: history listing, preview
byte-for-byte match, named snapshot creation, tombstone deletion (and
rejection of restoring a tombstoned version), restore, before-restore
snapshot, generation advancement, RID non-consumption, idempotent duplicate
restore requests, competing concurrent restores (exactly one applied + one
duplicate, exactly one before-restore snapshot — no race duplication), stale
WebSocket-equivalent fencing (`RESTORE_GENERATION_MISMATCH`), and
workspace/page ownership isolation (cross-workspace listing returns `null`).

## Testing Evidence

### Baseline (before this task's changes, confirmed via Task 49A report)
`npm test` 32/32, `npm run test:offline-collab` 5/5, `npm run test:collab-conformance`
6 passed / 0 failed / 2 pending / 5 resolved.

### Tests added/modified
- Added: `migrations/005_document_version_history.sql`,
  `postgres-collab-repository.js` additions (5 new repository methods),
  `postgres-storage.js` wiring (5 new store methods, migration file list
  updated).
- Modified: none of the existing test files in `test/`. No existing JSON
  test was weakened, removed, or had its expected result changed.
- No shared/parameterized acceptance test file was committed to the repo
  (the independent Postgres verification script used below was run from a
  scratch directory outside the repo and was not added to `test/`, to avoid
  depending on the pre-existing broken fixture helper — see Limitations).

### JSON regression results (after this task's changes)
- `npm test`: **32/32 pass** (unchanged from baseline; includes all three
  Task 49A "version-history:" fixtures).
- `npm run test:offline-collab`: **5/5 pass**.
- `npm run test:collab-conformance`: **6 passed, 0 failed, 2 pending
  (compaction-retention, cross-instance-replay), 5 resolved** — identical to
  baseline.

### PostgreSQL runtime verification — ACTUALLY PERFORMED, real database, not mocked
A dedicated, fully disposable PostgreSQL 16 instance was provisioned via
Docker specifically for this task: `docker run -d --name
task49b-disposable-pg -e POSTGRES_PASSWORD=task49b -e POSTGRES_DB=task49b -p
55432:5432 postgres:16-alpine`. This is distinct from, and was never used to
touch, the pre-existing `appflowy-selfhost-commercial-postgres-1` container
already running on this machine (part of an unrelated, running commercial
AppFlowy self-host stack) — that container and its 7 sibling containers were
left completely untouched throughout. The disposable container held no data
other than what this task's verification created, was never exposed beyond
`127.0.0.1:55432`, and was deleted (`docker rm -f`) at the end of this task.

Using `openPostgresStore` directly against this disposable instance, a
standalone verification script (not committed to the repo) exercised the
real store methods end-to-end and confirmed, against a live Postgres
database:
- Schema init/migration ran cleanly (including the new `005_...sql` file)
  via the existing `openPostgresStore` migration-apply path.
- History starts empty; named snapshot creation; snapshot appears in
  listing; preview returns byte-identical stored state.
- An ordinary collaboration update applies normally (`acceptPageCollabUpdate`),
  and the workspace RID counter advances for it.
- Restore to the named snapshot applies; restored bytes match the target
  version exactly; **the workspace RID counter is provably unchanged**
  across the restore (compared before/after via direct SQL against
  `collab_workspace_rids`).
- The before-restore snapshot is present in history afterward (2 versions
  total: 1 named + 1 before_restore).
- A stale update carrying the pre-restore `restoreId` (`null`) is rejected
  with `RESTORE_GENERATION_MISMATCH`; a subsequent update carrying the
  correct post-restore `restoreId` is accepted.
- A duplicate restore request (same page, same target version, no
  intervening mutation) is detected as an idempotent retry (`status:
  'duplicate'`) and does **not** create a second before-restore snapshot or
  restore event.
- Two concurrently issued (`Promise.all`) competing restores to the same
  version on a fresh page resolve to **exactly one `applied` and one
  `duplicate`**, and exactly one before-restore snapshot exists afterward —
  confirming the `FOR UPDATE` row lock + idempotency digest together give
  first-durable-write-wins semantics under real concurrency, not just in
  theory.
- Tombstone deletion removes a version from listing; attempting to restore a
  tombstoned version is rejected with `VERSION_DELETED`.
- Listing versions for a real page under the *wrong* workspace id returns
  `null` (ownership/isolation check), confirming cross-workspace access is
  denied.
- **Restart/persistence**: after `docker restart task49b-disposable-pg`, a
  fresh `openPostgresStore` connection against the same (now-restarted)
  container showed `collab_versions` and `restore_events` row counts
  unchanged from before the restart (10 and 4 rows respectively, matching
  everything created by the verification run), confirming durability across
  a backend/database process restart.

All of the above are **real queries against a live PostgreSQL server**, not
mocked `pg` calls — this is runtime-verified, not merely unit- or
integration-tested in the abstract.

### PostgreSQL mocked-test results
None were produced or relied upon. No test in this task fakes/mocks the `pg`
driver or Postgres responses.

### Transaction rollback / failure injection
Rollback-on-error was exercised functionally (restoring a nonexistent or
tombstoned version throws inside the transaction and the subsequent catch
block issues `ROLLBACK`, confirmed by the version/restore-event counts
staying correct afterward — e.g. restoring the tombstoned version did not
leave a partial restore event or bump `generation`). A deliberate low-level
fault injection (e.g. killing the connection mid-transaction, as Task 49A did
for JSON via the `store.persist` hook) was **not** performed for Postgres in
this task — there is no equivalent injection seam in the `pg` driver path
without adding test-only instrumentation, and this was judged out of scope
given the time budget. This is a real but narrow gap: Postgres's own ACID
guarantees make a mid-transaction crash safe by construction (nothing
commits until `COMMIT` runs), but that guarantee itself was not independently
fault-injected and observed in this task, only reasoned about.

### Tests not executed, and why
- `npm run test:postgres` (the repo's own existing `test/postgres.test.js` +
  `test/postgres-collab.test.js` harness) was attempted against the
  disposable instance and **failed with a pre-existing bug unrelated to this
  task**: `test/postgres-collab.test.js`'s `context()` helper constructs a
  synthetic user object missing the required `uid` field
  (`{ id, email, password_hash, created_at }`, no `uid`), which violates the
  `users.uid NOT NULL` constraint added for Task-era user-id allocation. This
  is a latent bug in a test fixture that had apparently never been run
  against a real Postgres instance before (Postgres was previously
  unavailable in prior task environments). Per instructions, this
  pre-existing test file was **not modified** as part of 49B (out of scope;
  preserving existing tests, not fixing unrelated latent bugs under this
  task). Independent runtime verification (above) was performed instead,
  using a corrected synthetic-user fixture in a standalone, non-committed
  script, to get real Postgres coverage for the Task 49B feature itself.
  **Risk/action item for a future task**: fix `test/postgres-collab.test.js`'s
  `context()` to include a valid `uid`, and `test/postgres.test.js`'s
  reliance on an external fixture path
  (`APPFLOWY_FIXTURE_ROOT`/`/Volumes/.../AppFlowy/contracts/...`) that may
  not exist in all environments, so this harness can be run as part of
  normal regression going forward.
- A shared, parameterized JSON+Postgres acceptance test file (Part E) was
  not added to the committed test suite, for the same reason: it would most
  naturally extend `test/postgres-collab.test.js`, which is currently broken
  independent of this task. Adding a parallel ad hoc file risked duplicating
  fixture logic that should really be fixed once, not forked.

### Remaining risks
- The pre-existing `test/postgres-collab.test.js` / `test/postgres.test.js`
  harness bug (above) means there is currently no *committed, repeatable*
  automated Postgres regression test for this feature in the repo's own
  `npm run test:postgres` script — only the one-off verification performed
  and reported here. A follow-up should fix the fixture and add committed
  Postgres version-history/restore test cases mirroring the JSON ones in
  `test/backend.test.js`.
- No low-level transaction-abort fault injection against the `pg` driver was
  performed (see above) — rollback correctness rests on exercised error
  paths plus reasoning about Postgres's transactional guarantees, not an
  injected mid-transaction crash.
- Cross-instance replay and compaction/retention remain pending from prior
  tasks (unchanged, unrelated to this task).
- The `editors` column stores `bigint[]`; large-scale multi-editor semantics
  beyond what Task 49A already defined were not re-derived or extended.

## Claim

**PostgreSQL version-history/restore parity for Task 49A is: implemented,
unit-level-reasoned, and runtime-verified** against a real, disposable
PostgreSQL 16 instance (schema init, all 5 operations, restore transaction
atomicity under real concurrency, idempotency, RID non-consumption,
ownership isolation, and restart persistence were all directly observed
against a live database). It is **not** "integration-tested" in the sense
of being wired into this repo's own committed, repeatable `npm run
test:postgres` suite — that harness currently fails for an unrelated
pre-existing reason (see above) and was not fixed as part of this task.
Browser-level verification was explicitly out of scope and was not
attempted.
