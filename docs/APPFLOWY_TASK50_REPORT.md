# Task 50 — PostgreSQL test-fixture `uid`/`icon` bug fix (test-only)

## Summary

Task 49B discovered that `npm run test:postgres` fails for reasons unrelated to its own
PostgreSQL version-history/restore parity work, and deferred to a standalone, uncommitted
verification script instead. This task root-caused and fixed the actual bug(s), which turned
out to be **two** incomplete synthetic-user/workspace fixture objects in
`test/postgres-collab.test.js` — not a schema or production-code defect — and re-ran the full
committed suite against a real, disposable PostgreSQL container.

## Part A — Investigation

### A1/A2 — the failing tests and the schema

`test/postgres.test.js` registers users exclusively through the real HTTP API
(`POST /api/auth/register`), which goes through `server.js`'s real registration handler
(`server.js:949`): `{ id: id(), uid: createNumericUserId(), email, password_hash: ..., created_at: now() }`,
where `createNumericUserId()` (`server.js:203`) is `randomInt(1, 2 ** 48)` from `node:crypto`.
That path was already correct and not the bug.

`test/postgres-collab.test.js` instead talks to `postgres-storage.js`/`postgres-collab-repository.js`
directly (bypassing `server.js`) via a local `context()` helper that builds synthetic
`user`/`workspace` objects and inserts them with `store.saveUser(user)` / `store.createWorkspace(...)`.

The schema (`migrations/001_initial.sql`) is correct and was not changed:

```sql
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  uid bigint NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);
...
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  icon text NOT NULL DEFAULT '',
  database_storage_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id)
);
```

`postgres-storage.js`'s `saveUser`/`createWorkspace` both do explicit, fully-parameterized
`INSERT ... VALUES(...)` statements naming every column (`uid`; `icon`, `database_storage_id`),
so a caller-supplied `undefined` for any of those fields is sent to Postgres as `NULL`,
bypassing the column's `DEFAULT ''` (a DEFAULT only applies when the column is omitted from the
INSERT list, not when it is explicitly set to NULL) and violating the `NOT NULL` constraint.

### A3 — exactly why the fixture didn't provide it

`test/postgres-collab.test.js`'s `context()` helper (original code):

```js
const user = { id: randomUUID(), email: `collab-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
await store.saveUser(user);
const workspace = { id: randomUUID(), name: 'durable-collab-test', owner_id: user.id, created_at: now };
await store.createWorkspace(workspace, { ... });
```

Neither object sets `uid` (users) nor `icon`/`database_storage_id` (workspaces) — these were
simply omitted when the fixture was originally written, most likely because migration
001 originally let `database_storage_id`/`icon` be nullable/defaulted and `uid` was added by
an `ALTER TABLE` later in the same migration file; the fixture was never updated to match the
column list `saveUser`/`createWorkspace` actually insert.

### A4 — fixture vs. schema vs. production

Confirmed the schema is correct (uid `NOT NULL UNIQUE` is intentional — it's the AppFlowy-compatible
numeric user id used throughout `server.js`'s response shaping, e.g. `user.uid?.toString()` at
`server.js:320`) and production's real registration path already supplies it correctly. The bug is
entirely in the test fixture, which talks to the repository layer directly and never supplies the
required columns. This is the expected, "fixture is the bug" outcome.

### A5 — confirm Task 49B didn't introduce this

This backend checkout has no `.git` directory (confirmed in Task 42 and re-confirmed here —
`git status` fails with "not a git repository"), so no `git blame` is available. By direct code
inspection: Task 49B's own report (`docs/APPFLOWY_TASK49B_REPORT.md`) and the migration it added
(`migrations/005_document_version_history.sql`) only add `collab_versions`/`collab_restore_events`
tables and new repository methods (`createVersion`, `listVersions`, `getVersion`,
`deleteVersion`, `restoreVersion`, etc. in `postgres-collab-repository.js`). None of Task 49B's
diffs touch `test/postgres-collab.test.js`'s `context()` helper, `saveUser`, or `createWorkspace` —
those are pre-existing Task 18-era code. The bug predates Task 49B, as described.

## Part B — Fix (test-file-only)

`test/postgres-collab.test.js`:

1. Added `randomInt` to the existing `node:crypto` import.
2. `user` object: added `uid: randomInt(1, 2 ** 48)` — the exact same generation method
   production uses (`server.js:203`'s `createNumericUserId`), not an invented/hardcoded value.
3. `workspace` object: added `icon: ''` (the schema's own default value, made explicit since an
   explicit INSERT bypasses column defaults) and `database_storage_id: workspaceId` (self-referencing
   the workspace's own id, mirroring migration 001's own backfill: `UPDATE workspaces SET
   database_storage_id = id WHERE database_storage_id IS NULL`, and matching how
   `createWorkspaceAndBootstrap` in `server.js` actually assigns it for a real workspace).

No changes to `migrations/*.sql`, `postgres-storage.js`, `postgres-collab-repository.js`, or
`server.js`. This is a pure test-fixture fix, per the expected outcome — production behavior is
unchanged.

Diff summary (`test/postgres-collab.test.js`):
```diff
-import { randomUUID } from 'node:crypto';
+import { randomUUID, randomInt } from 'node:crypto';
...
-  const now = new Date(); const user = { id: randomUUID(), email: `collab-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
+  const now = new Date(); const user = { id: randomUUID(), uid: randomInt(1, 2 ** 48), email: `collab-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
   await store.saveUser(user);
-  const workspace = { id: randomUUID(), name: 'durable-collab-test', owner_id: user.id, created_at: now };
+  const workspaceId = randomUUID();
+  const workspace = { id: workspaceId, name: 'durable-collab-test', icon: '', database_storage_id: workspaceId, owner_id: user.id, created_at: now };
```

## Part C — Testing evidence

### Baseline (before the fix)

Running `npm run test:postgres` against a fresh, isolated `postgres:16-alpine` container failed with:

```
test at test/postgres-collab.test.js:32:1
✖ durable PostgreSQL collaboration state survives reload, deduplicates, and isolates invalid references
  error: null value in column "icon" of relation "workspaces" violates not-null constraint
  ...
  at async context (test/postgres-collab.test.js:18:3)
```

(After fixing the `uid` NULL violation first, the *next* NULL violation — on `workspaces.icon` —
surfaced in the same `context()` helper; it was fixed in the same pass since it is the identical
bug pattern in the identical fixture function.)

### Disposable PostgreSQL provisioning

```sh
docker run -d --name task50-pg -e POSTGRES_PASSWORD=task50pw -e POSTGRES_DB=task50 -p 55432:5432 postgres:16-alpine
```

A brand-new container, distinct host port (55432), distinct container name, never touching the
pre-existing, unrelated `appflowy-selfhost-commercial-postgres-1` container (confirmed present and
left running and untouched throughout — verified via `docker ps` before and after this task).
Migrations run automatically on `openPostgresStore()`/`startServer({storage: 'postgres', ...})`,
so no manual migration step was needed. Container was torn down after testing (`docker rm -f task50-pg`).

### 1. `npm run test:postgres` (fixed)

```
RUN_POSTGRES_TESTS=1 DATABASE_URL=postgres://postgres:task50pw@127.0.0.1:55432/task50 npm run test:postgres

✔ durable PostgreSQL collaboration state survives reload, deduplicates, and isolates invalid references (185.995208ms)
✔ independent PostgreSQL repositories serialize concurrent updates without overwrite (49.676333ms)
✔ PostgreSQL end-to-end isolated persistence and concurrency (339.217833ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

This is a **real PostgreSQL connection**, not mocked: `postgres-storage.js`/`postgres-collab-repository.js`
use the `pg` driver against the container above; `test/postgres.test.js` additionally asserts
real `information_schema.tables`, a real foreign-key-violation rollback (`error code 23503`), and a
real transaction rollback-and-verify (`workspaces` row absent after `ROLLBACK`).

### 2. `npm test`

```
ℹ tests 38
ℹ pass 38
ℹ fail 0
```

### 3. `npm run test:offline-collab`

```
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

### 4. `npm run test:collab-conformance`

```
COLLAB_CONFORMANCE_SUMMARY
passed=6
failed=0
pending=2
skipped=0
resolved=5
```
(Unchanged from the documented baseline: `compaction-retention` and `cross-instance-replay` remain
pending, as expected — this task did not touch them.)

### Version-history/restore coverage check — important limitation

**Neither `test/postgres.test.js` nor `test/postgres-collab.test.js` exercises the Task 49B
PostgreSQL version-history/restore code paths** (`createVersion`, `listVersions`, `getVersion`,
`deleteVersion`, `restoreVersion` in `postgres-collab-repository.js`, or the HTTP
`.../collab/{objectId}/history` / `.../revert` routes against Postgres storage). Grepping both
files for `history|revert|restore|Version` returns no matches. Fixing the fixture makes the suite
runnable and green, but it does **not** by itself prove PostgreSQL version-history/restore parity —
that remains verified only by Task 49B's own standalone, uncommitted verification script (per its
report), not by this now-passing committed suite. This is a real, pre-existing gap in test
coverage, not something this task was scoped to close (Task 50 was fixture-bug-fix only), and it
is called out here rather than silently left implied as "now covered."

## Remaining limitations

1. **Version-history/restore is still not covered by the committed `npm run test:postgres`
   suite.** A future task should add a `test/postgres-collab.test.js` (or new file) fixture that
   exercises `createVersion`/`listVersions`/`getVersion`/`deleteVersion`/`restoreVersion` against a
   real Postgres instance, mirroring the JSON-mode coverage already in `test/backend.test.js`'s
   `version-history:` fixtures.
2. This backend checkout has no `.git` directory, so the "confirm Task 49B didn't introduce this"
   check in Part A5 relied on direct code-diff inspection against Task 49B's own report rather than
   `git blame`.
3. `compaction-retention` and `cross-instance-replay` remain pending in the conformance harness, as
   before — out of scope for this task per explicit instruction.
