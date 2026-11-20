# Task 56: Committed PostgreSQL Regression Tests for Document Version History / Restore

## A. Executive summary

Task 49B implemented PostgreSQL version-history/restore (named snapshots,
history listing, preview, tombstone-delete, restore) and verified it only via
an uncommitted, one-off standalone script against a disposable container.
Task 50 separately fixed an unrelated test-fixture bug (`uid`/`icon`/
`database_storage_id`) in `test/postgres-collab.test.js`, confirming by grep
that neither committed Postgres test file exercises any of the version-
history/restore code paths.

This task closes that gap: a new committed test file,
`test/postgres-version-history.test.js` (7 tests), was added to the repo's
own `npm run test:postgres` harness. It uses a real disposable
`postgres:16-alpine` container and the real `pg` driver (no mocking) to
exercise the actual production methods exposed on the store object
(`createPageCollabVersion`, `listPageCollabVersions`, `getPageCollabVersion`,
`tombstonePageCollabVersion`, `restorePageCollabVersion` — the same methods
`server.js`'s 5 HTTP routes call) against `postgres-collab-repository.js`'s
real implementation.

**Gap closed.** All 6 required scenarios (A-F) are covered by real-database
tests; all are committed, repeatable, and run automatically as part of
`npm run test:postgres`. No production code or schema was changed except a
one-line test-script-concurrency fix (see Section F) needed to make the
*existing* multi-file Postgres test harness itself reliable — this is a test
invocation flag, not application logic.

## B. Coverage matrix

| # | Test name | Production path exercised | Real-Postgres verification | Result |
|---|---|---|---|---|
| A | "named version creation is durably persisted with correct state and metadata" | `store.createPageCollabVersion` → `PostgresPageCollabRepository.createVersion` | Return value checked, **and** a separate direct `SELECT` against `collab_versions` confirms the row exists with correct `kind`, `name`, byte-identical `document_state` | PASS |
| B | "history listing returns correct ordering/metadata and excludes other documents/workspaces" | `store.listPageCollabVersions` | Two versions created in order, ascending `created_at`/`parent` chaining verified; a second, independent page/workspace's version is confirmed absent; wrong-workspace-id lookup confirmed to return `null` (ownership check, maps to 404 upstream) | PASS |
| C | "restoring an earlier version installs its exact content and persists metadata/restore audit row" | `store.restorePageCollabVersion` → `restoreVersion` | Live document content before/after restore round-tripped through real Yjs decode; `generation`/`restoreId` changes verified against `store.collab.load`; `restore_events` row directly queried and matched | PASS |
| D | "restore preserves prior history (tombstone-not-delete) and a before-restore snapshot is added" | `restoreVersion` + `tombstoneVersion` + `listVersions`/`getVersion` | After restore, history length grows to include the implicit `before_restore` snapshot (content verified to match pre-restore live state, not the target version); explicit tombstone confirmed to exclude from listing but the row is directly confirmed still present in `collab_versions` via SQL (not physically deleted); restoring a tombstoned version rejected with `VERSION_DELETED` | PASS |
| E | "failed restore (missing/tombstoned target) rolls back with no partial writes" | `restoreVersion`'s transaction/rollback path | `VERSION_NOT_FOUND` and `VERSION_DELETED` failures both confirmed, via direct `COUNT(*)` on `restore_events` and `collab_versions` before/after, to leave zero partial writes and an unchanged `generation`/`restoreId` | PASS |
| F | "separate documents maintain fully independent version histories" | `restoreVersion`, `listPageCollabVersions`, `getPageCollabVersion` across two independent pages | Restoring document A does not affect document B's `generation` (remains 0) or history (unchanged); a cross-page `getPageCollabVersion` lookup using A's version id scoped to B's page returns `null` | PASS |
| (bonus) | "duplicate restore requests are idempotent and concurrent competing restores resolve to exactly one applied result" | `restoreVersion`'s idempotency-digest and `FOR UPDATE` row-lock path | A duplicate restore request returns `status: 'duplicate'` and is confirmed (via `COUNT(*) WHERE kind='before_restore'`) not to create a second snapshot; two genuinely concurrent (`Promise.all`, two separate `openPostgresStore` connections) competing restores to a fresh target resolve to exactly one `applied` and one `duplicate` | PASS |

All 6 required scenarios are applicable and covered; none were skipped or
faked. A 7th test was added beyond the minimum to directly cover the
idempotency/concurrency guarantee Task 49B's own report called out as a key
property.

## C. Files changed

- **Created** `test/postgres-version-history.test.js` — the 7 new tests
  described above. Follows `test/postgres-collab.test.js`'s existing
  conventions (same fixture-construction pattern, same `fixtureRoot`/
  `RUN_POSTGRES_TESTS` gating, same `skip: !configured` pattern).
- **Modified** `package.json` — two changes to the `test:postgres` script:
  (1) added `test/postgres-version-history.test.js` to the file list so the
  new tests run as part of `npm run test:postgres`; (2) added
  `--test-concurrency=1` (see Section F for why — this is a test-invocation
  flag, not a production code or schema change).
- No other file was modified. `postgres-collab-repository.js`,
  `postgres-storage.js`, and all migrations are unchanged.

## D. Test results

All four required suites were run against this task's own disposable
`postgres:16-alpine` container, after the fix described in Section F:

```
npm run test:postgres
  tests 10, pass 10, fail 0
  (3 pre-existing tests in postgres.test.js + postgres-collab.test.js,
   unchanged and still passing, plus 7 new tests in
   postgres-version-history.test.js)

npm test
  tests 38, pass 38, fail 0   (unchanged from baseline)

npm run test:offline-collab
  tests 5, pass 5, fail 0   (unchanged from baseline)

npm run test:collab-conformance
  passed=6, failed=0, pending=2 (compaction-retention, cross-instance-replay
  — untouched, as instructed), resolved=5   (unchanged from baseline)
```

Every number above was actually executed and observed in this session's
terminal output, not assumed.

**Real-Postgres, not-mocked confirmation**: all new tests connect via
`openPostgresStore(process.env.DATABASE_URL)` to the real disposable
container, and several tests additionally issue direct `pool.query(...)`
`SELECT`/`COUNT` statements against `collab_versions`/`restore_events` to
independently verify what the repository methods report — this is the same
"verify against the table directly" pattern already used in
`postgres.test.js`'s existing FK/rollback assertions.

**Sanity check (deliberate break, then revert)**: `postgres-collab-
repository.js`'s `restoreVersion` was temporarily edited so `restoredState`
used the *current* document bytes instead of the *target version's* bytes
(a one-line change, reverted immediately after). Running the new suite
against the broken code failed exactly 1 of 7 tests (`pass 6, fail 1`) with
the expected error. The code was restored to its original state immediately
after (confirmed via `git`-equivalent diff review — this repo has no `.git`,
see Section G) and the full suite re-verified green afterward.

**Test-order dependency / fixture leakage check**: ran the new file alone,
ran it together with the two pre-existing files in several different orders
and repeat counts; no fixture leakage was found — every test creates its own
fresh user/workspace/page via `randomUUID()`, so no test observes another
test's data. The only cross-test interaction found was an environmental one,
described next.

## E. Database isolation

- Disposable container: `postgres:16-alpine`, named `task56-disposable-pg`,
  published only on `127.0.0.1:55433` (distinct name and port from Task
  49B's/Task 50's own prior disposable containers, and from anything else
  running).
- The pre-existing commercial stack (`appflowy-selfhost-commercial-postgres-1`
  and its 7 siblings) was **never queried, connected to, or referenced** by
  any command in this task. Verified via `docker inspect
  appflowy-selfhost-commercial-postgres-1 --format '{{.State.StartedAt}}'`
  before and after this task's work: unchanged (`2026-11-04T15:17:04Z`,
  "Up 19 hours (healthy)" at the end) — confirming it was untouched.
- `task56-disposable-pg` was removed at the end of this task via
  `docker rm -f task56-disposable-pg`; confirmed absent from `docker ps -a`
  output afterward.

## F. Remaining limitations / findings

- **Finding (documented, not fixed, per instructions): a pre-existing
  migration-reapplication race in `postgres-storage.js`'s
  `openPostgresStore`.** `openPostgresStore` reapplies its full migration
  file (including `ALTER TABLE` statements) every time it is called. Node's
  `node --test` runs each test *file* as a separate OS process by default
  (`--test-isolation=process`), and each file's own `openPostgresStore` calls
  therefore race independently against the same Postgres instance. With only
  2 Postgres test files this raced safely in every run observed in this
  session; adding a 3rd concurrently-migrating file (this task's new file)
  measurably increased how often a genuine Postgres deadlock (`40P01`,
  `AccessExclusiveLock` from a migration's `ALTER TABLE` vs. `RowShareLock`
  from a concurrent FK-referencing insert in a different already-migrated
  process) was observed — including, confirmed in this session's logs,
  against the two *pre-existing* tests in `postgres-collab.test.js`, not just
  the new ones. This is **not a defect in Task 49B's version-history/restore
  logic or in this task's new tests** — proven by running the exact same 10
  tests with `--test-concurrency=1` (forcing the 3 files to run sequentially
  instead of as 3 concurrent processes), which passed 10/10 cleanly and
  repeatably. Per this task's scope, **production code
  (`postgres-storage.js`) was not modified** to add a migration-guarding
  advisory lock, which would be the correct real fix; instead, the test
  *invocation* was made deterministic (`--test-concurrency=1` added to the
  `test:postgres` npm script only) so the committed suite is reliable without
  touching application code. **Action item for a future task**: guard
  `openPostgresStore`'s migration step with a Postgres advisory lock
  (`pg_advisory_lock`) so concurrent store-opens from multiple processes
  don't race on DDL; this would remove the need for the
  `--test-concurrency=1` workaround.
- No low-level transaction-abort fault injection against the raw `pg` driver
  connection (e.g. killing the socket mid-transaction) was performed — same
  limitation Task 49B's own report already flagged; rollback correctness is
  verified via real application-level error paths (`VERSION_NOT_FOUND`,
  `VERSION_DELETED`) rather than a simulated connection failure.
- Cross-instance replay and compaction/retention remain pending from prior
  tasks, untouched, as instructed.
- This repository (`AppFlowy-Independent-Backend`) has **no `.git` directory**
  at all — it is not a git repository on this machine (confirmed via `git
  status` failing with "not a git repository" at the start of this task).
  All "working-tree integrity" checks below were therefore done via
  filesystem inspection rather than `git status`/`git diff`.

## G. Working-tree integrity

- This project directory is not a git repository (no `.git` present at any
  level up to the filesystem boundary) — confirmed before any change was
  made. No git commit, push, reset, checkout, or restore was performed or
  was possible.
- No existing file was deleted. No unrelated file was modified. The only
  files touched are exactly those listed in Section C:
  `test/postgres-version-history.test.js` (new) and `package.json` (2-line
  change to the `test:postgres` script).
- `postgres-collab-repository.js` was temporarily edited for the one-line
  sanity-check (Section D) and immediately reverted to its exact original
  content before any further work; confirmed unchanged at the end of this
  task.
- No commit or push was made (not applicable — no git repository exists
  here).
