# Task 59 — PostgreSQL migration advisory-lock fix (P0 concurrency defect)

## 0. Scope and repo-state safety check (before any change)

This backend repository has **no `.git`** (confirmed again this task: `git status` inside the repo fails with "not a git repository"). "Current state" below means files on disk, inspected directly, not assumed from a prior report. No commit/push is applicable.

Files touched this task (all in-scope per the task brief):
- **Created**: `postgres-migration-lock.js` (new, focused lock helper), `test/postgres-migration-lock.test.js` (new regression suite).
- **Modified**: `postgres-storage.js` (migration execution path + `openPostgresStore`), `package.json` (`test:postgres` script — added the new test file, removed `--test-concurrency=1`).
- **Documentation**: this file, plus append-only updates to `docs/AGENT_HANDOVER.md`, `docs/ARCHITECTURE_OVERVIEW.md`, `docs/TESTING_AND_ACCEPTANCE_STRATEGY.md`.

`server.js`, `storage.js` (JSON mode), `collab-protocol.js`, `postgres-collab-repository.js`, the frontend, and existing `migrations/*.sql` files were **not** touched — no demonstrated defect required it. No new external dependency was added (`postgres-migration-lock.js` uses only Node's built-in `node:crypto`).

No pre-existing uncommitted/untracked state in this repo was reset, cleaned, or overwritten; nothing was committed or pushed (no `.git` exists to do so).

## 1. Executive summary

Task 56 found, and Task 58 re-confirmed still present in live code, that `postgres-storage.js`'s `openPostgresStore()` reapplied its entire migration DDL text on **every** call with **no coordination** between independent processes — a genuine production concurrency defect, only worked around at the test level (`--test-concurrency=1` in `test:postgres`), which Task 56 explicitly flagged as not protecting production.

Task 59 reproduced the defect with two real, independent OS processes against a real, disposable Postgres database (no mocks), designed and implemented a Postgres **session-level advisory lock** around the full migration critical section (acquire → recheck → run pending migrations → release), added a minimal `schema_migrations` tracking table to make the recheck step real, added focused regression tests (10 new tests, all against real Postgres), verified the fix with a **real two-OS-process** harness (including a crash-mid-lock recovery scenario), removed the `--test-concurrency=1` workaround (verified safe with 5 repeated full-suite runs), and ran a full regression across all 4 existing suites with no change from baseline.

A second, closely related defect was found and fixed in the same function during this work: the original failure path called `pool.end()` from inside a `catch` block while the dedicated migration client was still checked out and only released in a `finally` that had not yet run — since `pg-pool`'s `end()` waits for all checked-out clients to be released before resolving, this ordering could itself deadlock on any migration failure. This is fixed as part of the same restructuring (lock and client are now released, in order, before `pool.end()` is ever called on a failure path).

## 2. Root cause (confirmed against current code, not assumed from prior reports)

`postgres-storage.js` (pre-Task-59):
```js
const migration = (await Promise.all([...6 files...].map((file) => readFile(...)))).join('\n');
...
export async function openPostgresStore(databaseUrl = process.env.DATABASE_URL) {
  ...
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const client = await pool.connect();
  try { await client.query(migration); return {...}; }
  catch (error) { await pool.end(); throw new Error(...); }
  finally { client.release(); }
}
```
- All 6 migration files were concatenated into one string and sent as **one multi-statement query** on a single dedicated client (`pool.connect()`), every single call — not just on first run.
- No migration-tracking table existed anywhere. There was no way to know what was "already applied"; the only strategy was "the DDL is idempotent, so reapplying it is safe" — true for a *single* process, not proven safe for *concurrent* processes.
- No lock, advisory or otherwise, existed anywhere in the file.
- All migration statements (checked file by file: `migrations/001_initial.sql` through `006_favorites_trash.sql`) are plain `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` / `DO $$ ... EXCEPTION ... END $$` blocks — fully transaction-compatible, nothing like `CREATE INDEX CONCURRENTLY` or `VACUUM`. This matters for the lock-type decision in §4.
- The full multi-statement string, sent via `pg`'s simple-query protocol with no explicit `BEGIN` in the text, is implicitly wrapped by Postgres as one transaction — so a single process's own migration run was already atomic with respect to itself. The gap was purely **inter-process**: two processes each opening their own connection and running this unprotected text concurrently against the same database.

## 3. Reproduction (real evidence, not fabricated)

### 3.1 Environment
A dedicated, disposable Postgres container was created for this task only: `appflowy-task59-pg` (`postgres:16-alpine`, port `55459`, database `appflowy_task59_test`, user `task59_user`). The pre-existing commercial AppFlowy SelfHost stack (`appflowy-selfhost-commercial-postgres-1` and its sibling containers) was identified first and never touched, confirmed untouched again at the end (§10).

### 3.2 Two-OS-process reproduction against pre-Task-59 code
Using the real `pg` driver (no mocks) and the **unmodified, pre-Task-59** `openPostgresStore`, a worker script (`repro-init-worker.mjs`) was launched twice as two genuinely separate OS processes against a freshly created, empty database, concurrently (not sequentially):

```json
{"label":"A","pid":9926,"event":"start","startedAt":"2026-11-05T10:54:58.745Z"}
{"label":"B","pid":9927,"event":"start","startedAt":"2026-11-05T10:54:58.745Z"}
{"label":"B","pid":9927,"event":"success","backendPid":85,"finishedAt":"2026-11-05T10:54:58.885Z"}
```
Process B (OS pid 9927, Postgres backend pid 85) completed its full migration in 140ms. Process A (OS pid 9926) never printed a result. Polling `pg_stat_activity` showed Postgres backend pid 84 (process A's connection) already in state `idle` with `wait_event_type=Client`/`wait_event=ClientRead` — i.e. **Postgres itself had finished executing A's entire migration batch** (the log confirms the connection's last statement was the very last line of migration `006_favorites_trash.sql`) and was waiting for the client to send its next command — but process A's Node client never returned, resolved, or errored. It was still alive and unresponsive after 3+ minutes and had to be force-killed (`kill -9`); the lingering Postgres session then had to be terminated with `pg_terminate_backend` before the throwaway database could be dropped.

This is a genuine, reproducible hang under concurrent, unprotected initialization by two independent processes — the exact class of defect Task 56/58 flagged, manifesting here as a client-side hang rather than a server-side `deadlock_detected` (40P01), but equally fatal to a production startup (a process that never finishes starting and never errors is strictly worse than one that errors and can be retried/alerted on).

### 3.3 Fix verification (same harness, same database freshness, Task-59 code)
The identical two-process harness, re-run against the fixed code on fresh databases, completed in ~250ms with no hang:
```json
{"label":"B","pid":13072,"event":"start","startedAt":"2026-11-05T11:00:51.245Z"}
{"label":"A","pid":13071,"event":"start","startedAt":"2026-11-05T11:00:51.245Z"}
{"label":"A","pid":13071,"event":"success","backendPid":152,"finishedAt":"2026-11-05T11:00:51.452Z"}
{"label":"B","pid":13072,"event":"success","backendPid":153,"finishedAt":"2026-11-05T11:00:51.498Z"}
```
A 3-concurrent-process variant was additionally run 5 times against 5 fresh databases; all 15 process invocations succeeded, no hangs, no errors.

## 4. Advisory-lock design

### 4.1 Lock type: session-level (`pg_advisory_lock`/`pg_advisory_unlock`), not transaction-level
The migration critical section needs to span **multiple independently committed transactions** — one per still-pending migration file, specifically so that a failure in file N does not roll back files before it that already committed and were correctly recorded as applied (see §4.4). A transaction-level advisory lock (`pg_advisory_xact_lock`) auto-releases at the next `COMMIT`/`ROLLBACK`, so it cannot span more than one commit — it would release after the first migration file and let a second process into the still-in-progress critical section. A session-level lock, explicitly acquired and released on one dedicated client held for the whole critical section, is the only option that actually covers "acquire → recheck → run all pending migrations (each its own transaction) → release" as one unit with respect to other processes.

All migration SQL was independently re-verified (§2) to be fully transaction-compatible (no `CREATE INDEX CONCURRENTLY` or similar), so this was a design choice driven by the multi-commit shape of the critical section, not a technical requirement forced by the SQL content — documented so a future migration author knows session-level locking is **required** by the current multi-file-transaction design, not incidental.

### 4.2 Lock key derivation (`postgres-migration-lock.js: deriveMigrationLockKey`)
```js
const digest = createHash('sha256').update(`appflowy-backend-migration:${databaseName}`).digest();
let value = digest.readBigUInt64BE(0);
if (value > SIGNED_64_BIT_MAX) value -= SIGNED_64_BIT_MODULUS; // reinterpret as Postgres's signed int8
return value;
```
- `databaseName` comes from `SELECT current_database()` run on the connection actually being initialized — not parsed from the connection string, so it is robust to any URL form and never logs credentials.
- SHA-256 is a real deterministic hash (unlike V8's object/string hashing, which is not guaranteed stable across process restarts or Node versions) — same database name always yields the same key, across process restarts, across machines.
- The first 8 bytes are folded into a signed 64-bit `BigInt`, exactly the range `pg_advisory_lock(bigint)` accepts; different database names produce different keys (SHA-256 collision probability negligible) — verified directly in tests (same name twice → identical key; two different names → distinct keys; within `[-2^63, 2^63-1]`).
- Postgres advisory locks are already scoped to the connected database internally (a key taken by a session connected to database A never conflicts with the same key taken by a session connected to database B), so folding the database name into the key is not strictly required for correctness — it is kept anyway purely for defense-in-depth and for legibility in `pg_locks`/logs during diagnosis. Server/cluster identity was deliberately **not** added to the key: two different physical Postgres clusters never share lock state in the first place (locks live in one cluster's shared memory), so there is no scenario where that would change behavior, and adding it would only make the key non-reconstructable from `current_database()` alone.

### 4.3 Lock acquisition: bounded `pg_try_advisory_lock` retry loop, not blocking `pg_advisory_lock`
`acquireAdvisoryLock(client, lockKey, { timeoutMs = 30000, pollIntervalMs = 100 })` polls `pg_try_advisory_lock` and sleeps between attempts until either it succeeds or `timeoutMs` elapses, in which case it throws a specific, actionable error naming the key and timeout. The blocking `pg_advisory_lock` was deliberately **not** used: it has no way to report progress or give up, so a wedged or abnormally slow peer would hang every other process's startup silently and indefinitely, with no diagnostic signal. The timeout is overridable per call (`options.migrationLockTimeoutMs`) and via `POSTGRES_MIGRATION_LOCK_TIMEOUT_MS`, defaulting to 30 seconds. Verified directly: a holder acquires and keeps the lock; a second client's `acquireAdvisoryLock({ timeoutMs: 300 })` throws `Timed out after 300ms...` in 280–2000ms (bounded, not instant, not unbounded).

### 4.4 Migration state recheck + minimal tracking table
Before Task 59 there was no way to know what had already run — the only strategy was "the DDL is idempotent, so blind reapplication is safe," which is exactly the premise that broke under concurrency (§3). A minimal `schema_migrations(filename text PRIMARY KEY, applied_at timestamptz)` table is created (idempotently) **inside the lock**, then queried to build the real "already applied" set — this is the literal recheck step the design requires: never trust any state read before the lock was held, because another process could have changed it while this one was waiting. Only files absent from that set are executed, each in its own `BEGIN`/run-SQL/`INSERT INTO schema_migrations`/`COMMIT`, with `ROLLBACK` + a wrapped, re-thrown error on any failure. This is why a failed file's partial DDL is undone and never recorded as applied, while files before it that already committed stay correctly recorded — proven by a real-Postgres test (§6) that forces a genuine `23505` unique-violation inside migration `001_initial.sql`'s own `CREATE UNIQUE INDEX` statement (by dropping the index and seeding real duplicate data) and confirms the post-failure row set.

### 4.5 Failure handling, connection lifecycle
`openPostgresStore` now explicitly: acquires the lock on the dedicated migration client → runs migrations → releases the lock → releases the client → returns the repository, in that exact order, with every failure path releasing the lock (if held) before releasing the client, and releasing the client before ending the pool. This fixes the related ordering defect found while implementing this (§1): the pre-Task-59 code called `pool.end()` from a `catch` block while still awaiting a `finally` that had not yet run `client.release()` — and `pg-pool`'s `end()` (confirmed by reading `node_modules/pg-pool/index.js`) does not resolve until every checked-out client, including the one still awaiting release in that unreached `finally`, is released. That is a second, real deadlock risk on any migration failure, independent of the advisory-lock gap, fixed by the same restructuring.

Session-level advisory locks are also released automatically by Postgres when the owning session terminates for any reason (crash, `kill -9`, network loss) — verified directly (§6, §7) by destroying a lock-holder's socket and by hard-killing a lock-holding OS process, in both cases confirming a second client/process could immediately acquire the lock afterward with no permanent-lock leak. Normal operation still releases explicitly and promptly so a live, well-behaved process doesn't make its peers wait out a full session lifetime.

## 5. Production code changes

- **`postgres-migration-lock.js`** (new, 102 lines) — `deriveMigrationLockKey`, `acquireAdvisoryLock`, `releaseAdvisoryLock`. Heavily commented with the WHY (lock-type choice, key-derivation reasoning, timeout reasoning), not just restating the code.
- **`postgres-storage.js`** — migration files are now kept as an ordered `(filename, sql)` map instead of one concatenated string; `runMigrations(client)` bootstraps `schema_migrations`, rechecks it, and runs only pending files each in its own transaction; `openPostgresStore` acquires/releases the advisory lock around the whole critical section and fixes the `pool.end()`/`client.release()` ordering described in §4.5. A documented, env-gated, zero-cost-when-unset test-only hook (`POSTGRES_MIGRATION_TEST_DELAY_MS`) was added inside `runMigrations`, read fresh per call, solely so tests and the Part G multi-process harness can force an observable overlap window — natural migration timing (tens of ms) is too fast to reliably observe otherwise. It is never set in production and defaults to a no-op.
- **`package.json`** — `test:postgres` now includes the new `test/postgres-migration-lock.test.js` and no longer passes `--test-concurrency=1` (see §8).
- No changes to `server.js`, `storage.js`, `postgres-collab-repository.js`, or any `migrations/*.sql` file.

## 6. New regression tests (`test/postgres-migration-lock.test.js`, 10 tests, all against real Postgres via the real `pg` driver)

1. Lock key derivation: deterministic, distinct per database, within bigint range, and actually accepted by real `pg_try_advisory_lock`/`pg_advisory_unlock`.
2. Two concurrent **real, distinct Postgres sessions** (verified via `pg_backend_pid()`) contend for the same key; the second only acquires after the first explicitly releases, with timing assertions proving genuine waiting, not a race.
3. Two independent `openPostgresStore()` calls against the same fresh database both succeed; migrations recorded exactly once.
4. Three concurrent `openPostgresStore()` calls against a fresh database; each of the 6 migrations recorded exactly once (not 3×).
5. A slow first initializer (using the `POSTGRES_MIGRATION_TEST_DELAY_MS` hook) forces a second, genuinely concurrent initializer to measurably wait before completing, then recheck — migrations still applied exactly once.
6. Lock-acquisition timeout produces a bounded, actionable error without blocking the holder.
7. Releasing a lock not held by the session reports an error rather than silently succeeding.
8. Terminating a session (real abrupt socket destroy, not a mock) that holds the lock releases it; a second session acquires it immediately afterward — no permanent lock.
9. A **genuine** migration SQL failure — a real Postgres `23505` unique-violation forced by dropping migration 001's own unique index and seeding real duplicate `sessions` rows, then making migration 001 "pending" again — rolls back, releases the lock (verified with a fresh connection to the same disposable database, not the shared base database — an early version of this test had exactly that mix-up and was caught and fixed before being counted as passing), leaves no misleading success row, and a corrected retry (after removing the real duplicate data) succeeds.
10. Reopening an already-fully-migrated database is a fast no-op recheck and leaves zero advisory locks held afterward.

Nothing in this file mocks Postgres or the `pg` driver, including the failure-path tests — every failure is a genuine server-raised error.

Result: **10/10 passed.**

## 7. Real multi-OS-process verification (Part G — the primary acceptance evidence)

A disposable database (`appflowy_task59_partg`) and two **genuinely separate OS processes** (not two promises in one process) were used, calling the actual production `openPostgresStore()` via a small harness script (`partg-process.mjs`) that does not reimplement any logic.

- Process A: launched with `POSTGRES_MIGRATION_TEST_DELAY_MS=2000` (the documented test-only hook, used here exactly as intended — to force an observable overlap window; natural migration timing is sub-100ms) — OS pid `16407`, started `11:12:43.773Z`, Postgres backend pid `608`, succeeded `11:12:45.956Z` (6/6 migrations).
- Process B: launched 395ms later (no delay) — OS pid `16410`, started `11:12:44.168Z` (confirmed overlapping with A, which was still inside its 2s hold), Postgres backend pid `609` (**distinct backend PID, confirming a genuinely separate session**), succeeded `11:12:45.961Z` — i.e. essentially the instant A released, after waiting out virtually the entire gap. 6/6 migrations reported, not 12 — no duplicate execution.
- An independent, external lock-state monitor (`partg-monitor.sh`, polling `pg_locks` every 100ms from a third connection, not trusting either process's self-report) recorded backend pid `608` holding the advisory lock (`objid=862030518`, `granted=t`) continuously across the whole overlap window.
- Final state after both exited: `schema_migrations` has exactly one row per file (6 total, confirmed by `GROUP BY`/count query); 14 tables present (13 application tables + `schema_migrations`); 0 remaining advisory locks.

**Crash-mid-lock recovery (extended Part G scenario, also run, also real OS processes):** a third process was launched with a 10-second delay, confirmed via `pg_locks` to be genuinely holding the lock (backend pid `655`), then hard-killed (`kill -9`) while still holding it. Advisory locks on that database dropped to 0 within ~1.5s (Postgres's own session-termination cleanup, not anything this code does). A fourth process launched immediately afterward acquired the lock with no wait, completed in ~227ms, and the database ended with the correct 6/6 migrations and 14 tables — the database remained fully recoverable after a real crash while holding the lock.

This satisfies the task's bar: two (and more) **real OS processes**, **real, distinct Postgres backend sessions**, **genuine timing overlap**, **external lock-state confirmation**, and a **real crash scenario**, all against the actual production `openPostgresStore` code path.

## 8. Test-level workaround decision: **removed**

`--test-concurrency=1` was removed from `test:postgres` in `package.json`. This is safe now because the production fix genuinely protects concurrent store initialization against the same database — which is exactly the condition that made the workaround necessary in the first place (Task 56's own stated rationale). Verified: the now-4-file, 20-test suite (previously 3 files/10 tests) was run **5 times in a row** at normal `node --test` concurrency (no flag at all, so Node's default per-file parallelism applies) against the same shared disposable database the other 3 test files also use — 20/20 every time, no flakiness, no migration deadlocks/hangs. No other, unrelated fixture-level constraint was found that would require re-adding any serialization — the existing test files already use `randomUUID()`-based unique identifiers throughout and never `TRUNCATE`/`DROP` shared tables, so they were already safe to interleave data-wise; only the migration race (now fixed) ever required serialization.

## 9. Full regression (Part H)

All 4 commands below were run fresh this task (not assumed unchanged), against the disposable database for the Postgres suite:

| Command | Result | Duration |
|---|---|---|
| `npm test` | 38/38 pass | ~7.3s |
| `npm run test:offline-collab` | 5/5 pass | ~0.2–0.4s |
| `npm run test:collab-conformance` | passed=6, failed=0, pending=2 (`compaction-retention`, `cross-instance-replay`, unchanged/genuinely still open), resolved=5 | ~0.2–0.4s |
| `npm run test:postgres` (normal concurrency, no flag) | 20/20 pass | ~3.2–3.5s, run **5 times**, identical result each time |

No regression versus the stated baseline (backend 38/38, offline-collab 5/5, collab-conformance 6/0/2/5, postgres 10/10 pre-Task-59 → 20/20 post-Task-59 with the new test file and restored concurrency). No unrelated pre-existing failure was found.

## 10. Disposable database/container cleanup (Part I)

- Container used: `appflowy-task59-pg` (`postgres:16-alpine`, port 55459) — created solely for this task.
- Disposable databases created during the task (`appflowy_task59_test` plus several per-test/per-scenario databases such as `appflowy_task59_repro*`, `appflowy_task59_concurrent*`, `appflowy_task59_partg*`, `appflowy_task59_failure*`, etc.) were all dropped as each scenario completed; a final sweep (`SELECT datname FROM pg_database WHERE datname LIKE 'appflowy_task59%'`) confirmed only the base `appflowy_task59_test` remained before final container teardown.
- `docker stop appflowy-task59-pg && docker rm appflowy-task59-pg` — confirmed removed (`docker ps -a --filter name=appflowy-task59-pg` returns nothing). No named volume was created for this container, so none was left behind (`docker volume ls` shows no Task 59 volume).
- No stray Task 59 Node process remained at any point checked (`ps aux | grep -E "repro-init-worker|partg-process|node --test"` empty after each phase).
- Commercial stack verified untouched, both before and after: `appflowy-selfhost-commercial-{postgres,appflowy_cloud,appflowy_worker,appflowy_search,gotrue,nginx,redis,minio}-1` all still `Up` in the same states as at task start. Other pre-existing, already-exited containers (`postgres` standalone, `chroma`, `n8n`) were left exactly as found — not started, not removed.

## 11. Remaining limitations / risks

- The `POSTGRES_MIGRATION_TEST_DELAY_MS` hook, while a no-op by default and clearly documented as test-only, is still live code reachable via an environment variable in production. It is intentionally harmless (adds a delay, never changes correctness), but a future task adding stricter production env-var hygiene could consider gating it behind `NODE_ENV!=='production'` if that becomes a concern; not done here to keep the change minimal and because it introduces no actual risk as written.
- The lock-acquisition timeout (default 30s) is a judgment call, not a value derived from measured production load; it is configurable (`POSTGRES_MIGRATION_LOCK_TIMEOUT_MS` or `options.migrationLockTimeoutMs`) if a future deployment needs a different bound.
- This fix addresses migration-time concurrency specifically. It does not change or re-verify anything about steady-state multi-process behavior after initialization (e.g. connection pool sizing, concurrent writes) — that was already out of scope and unaffected by this task.
- As with every other task in this repo, there is no `.git`, so this report (and the code diffs it describes) cannot be verified by `git diff`/`git log` — only by direct file inspection, which is how this task itself verified Task 56/58's prior claims.

## 12. Mandatory Testing Evidence

| Verification | Result | Evidence |
|---|---|---|
| Baseline backend tests | Passed | `npm test` → 38/38, re-run fresh this task before any change (§9 shows the identical post-change result) |
| Baseline PostgreSQL tests | Passed | `npm run test:postgres` (pre-change, `--test-concurrency=1`, 3 files) → 10/10 against disposable `appflowy_task59_pg`/`appflowy_task59_test` |
| Original concurrency defect reproduced | Passed | §3.2: two real OS processes against a fresh database on pre-Task-59 code; Process B succeeded in 140ms (backend pid 85), Process A hung indefinitely (backend pid 84, confirmed `idle` server-side while the Node client never returned), force-killed after 3+ minutes |
| Advisory lock acquisition | Passed | §6 test 2 (two real sessions, `pg_backend_pid()`-verified distinct, second blocked until first releases, timing-asserted) and §7 (external `pg_locks` monitor confirming backend pid 608 held `objid=862030518` throughout the real two-process overlap window) |
| Advisory lock release | Passed | §6 tests 2, 6, 8, 9, 10 (explicit release verified by a subsequent client immediately acquiring); §7 (0 remaining advisory locks after both processes finished, and after the crash-recovery scenario) |
| Concurrent separate connections | Passed | §6 test 2 confirms two `pg.Client` instances are genuinely distinct Postgres backend sessions via `pg_backend_pid()`; §7 confirms the same for two real OS processes (backend pids 608 vs 609) |
| Independent multi-process startup | Passed | §7: two real OS processes (`partg-process.mjs`, pids 16407/16410) calling the actual production `openPostgresStore()`, confirmed overlapping by timestamp and by an independent `pg_locks` monitor; extended to a real crash-mid-lock scenario (pid 16762 hard-killed while holding the lock; a fourth process recovered cleanly) |
| Migration state recheck | Passed | §6 tests 3/4/5/10: `schema_migrations` queried fresh under the lock on every call; concurrent/repeated/fresh/already-migrated scenarios all show each migration recorded exactly once, never duplicated, never skipped when genuinely pending (§6 test 9's forced-pending scenario) |
| Failure recovery | Passed | §6 tests 6 (timeout), 7 (release-without-holding), 8 (real socket destruction/connection loss), 9 (real `23505` unique-violation migration failure, rollback, no misleading success row, lock released, corrected retry succeeds); §7 (real `kill -9` of a lock-holding OS process, Postgres auto-released the session lock, a fourth process recovered and completed cleanly) |
| Connection cleanup | Passed | §4.5 (ordering fix verified by the full suite completing without any hang); §6 test 9 and §7 (fresh connections immediately obtainable to the same disposable database after every failure/crash scenario, no leaked checked-out clients observed) |
| PostgreSQL tests under concurrency | Passed | §8: `test:postgres` (4 files, 20 tests) run 5× at normal `node --test` concurrency (no `--test-concurrency` flag) — 20/20 every run, no flakiness |
| Backend regression | Passed | §9: `npm test` → 38/38, unchanged from baseline |
| Offline collaboration regression | Passed | §9: `npm run test:offline-collab` → 5/5, unchanged from baseline |
| Collaboration conformance | Passed | §9: `npm run test:collab-conformance` → passed=6/failed=0/pending=2/resolved=5, unchanged from baseline |
| Disposable resource cleanup | Passed | §10: container stopped/removed, all disposable databases dropped, no stray processes, commercial stack and other pre-existing containers confirmed untouched before and after |
