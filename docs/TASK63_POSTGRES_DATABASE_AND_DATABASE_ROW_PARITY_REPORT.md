# Task 63 — PostgreSQL storage parity for Database and DatabaseRow collaboration

## Executive summary

Task 63 ported the Database (Task 61) and DatabaseRow (Task 62) collaboration capabilities — previously JSON-storage-only — to PostgreSQL, so the same frontend operations produce equivalent behavior under either storage mode, including under concurrent writes, transaction failure, and backend restart.

**Status: Complete** for the storage-parity scope defined in the brief (Postgres persistence for all four object/update types, atomic Database and DatabaseRow creation, idempotency/RID/dedup/cross-workspace isolation, row-document+parent-mutation atomicity, fault-injection rollback at every checkpoint, true concurrent-creation correctness, restart reconstruction, JSON/Postgres logical parity, full regression including migration-lock, real two-row browser verification with cell-edit persistence across reload and a real backend-process restart). Two things are reported as discovered limitations rather than claimed fixes, per the brief's own instruction to document rather than invent workarounds: (1) a **pre-existing, storage-mode-agnostic** Folder/UI routing gap that blocks opening a Database view from a browser session that did not itself just create it (affects JSON mode identically; out of this task's storage-parity scope); (2) a corrected understanding of the real-time broadcast model — **no content update of any kind (Document, Database, or DatabaseRow) is pushed to other already-connected peers**, only `awarenessUpdate` is relayed; the brief's assumption that ordinary WS updates broadcast was tested and found false, with evidence.

## Initial repo state

- Backend has no `.git` (confirmed again). No uncommitted "modified" state to track; untracked files before this task's additions: `test-collab-chunk{1,2,3}.js`, `test_minimal.js`, `docs/task62-evidence/`, and the rest of the existing tree.
- AppFlowy-Web: pre-existing modified/untracked files (`git status`) were identical before and after this task — see "Files changed" below; `.env.local` is untracked by git and was backed up/restored byte-for-byte (MD5 `c85de40fc13dc3b2379325c6ecc3471d` before and after).
- Disposable Postgres database `appflowy_independent_test` (owner `achal`, same OS user running this session) pre-existed from prior tasks; re-verified ownership and re-used it for automated Postgres tests (167 user rows accumulated across many prior task runs — consistent with "shared disposable test database", not a stray/foreign database). A second, newly created disposable database `appflowy_task63_browser` was used exclusively for the real-browser verification and dropped at the end of this task. The commercial AppFlowy Postgres stack was never touched (not even connected to).
- Pre-existing, unrelated `node server.js` processes (PIDs 73970/74530, ports 8791/8792, started ~2 hours before this session) and any other already-listening ports were identified and left completely untouched throughout.
- Baseline test results (re-run fresh before any change): `npm test` 38/38, `npm run test:offline-collab` 5/5, `npm run test:collab-conformance` 6 passed/0 failed/2 pending/5 resolved, `npm run test:database-collab` 13/13, `npm run test:database-row-collab` 11/11, `npm run test:postgres` 20/20 (the then-current 4-file suite). No baseline failures.
- Migration state at start: `schema_migrations` had 6 rows (`001`–`006`).

## Existing Postgres architecture (as inspected)

- **Connection/pool**: `openPostgresStore()` (`postgres-storage.js`) creates a single `pg.Pool({ max: 5 })` per store instance. One dedicated `pool.connect()`'d client is used only for migration bootstrap (acquires Task 59's session-level advisory lock, runs pending migration files each in its own transaction, releases the lock, returns the client to the pool) — never a pool-wide query, since the lock must be held by one consistent session.
- **Workspace-scoped records**: `users`, `workspaces`, `memberships`, `spaces`, `pages` — plain relational tables, workspace-scoped via `workspace_id` foreign keys (`ON DELETE CASCADE` from `workspaces`).
- **Collab documents/updates (Document, pre-existing)**: `collab_documents` (one row per `(workspace_id, page_id)`, full current Yjs state + state vector + generation + last RID) and `collab_updates` (append-only, one row per accepted update, `payload_digest`/`message_key` unique constraints for dedup, RID columns). `collab_workspace_rids` holds one monotonic `(timestamp, counter)` pair per workspace, atomically advanced by `allocateMessageId()` inside the same transaction as the update it RIDs.
- **State reconstruction**: always "replay the one current full-state blob" (`document_state`), never "replay N updates" — `collab_updates`/`database_collab_updates`/`database_row_collab_updates` rows exist purely for dedup/audit, not reconstruction.
- **Transactions**: every multi-statement write path (`createAtomicDocumentPage`, `acceptUpdate`, restore, and now `createAtomicDatabasePage`/`createAtomicDatabaseRow`) is `BEGIN` → work → `COMMIT`, with `ROLLBACK` in the `catch`. Optimistic concurrency fencing (`WHERE generation=$current`) backs up explicit row locks (`FOR UPDATE`) as defense in depth.
- **Idempotency**: `atomic_creation_requests` (Document +, after this task, Database page creation) keyed by `request_id` (PK), storing a `request_digest` to detect a reused id with a different body. The "claim the request_id first inside the transaction" pattern is the mutex: Postgres's own unique-index conflict resolution serializes two genuinely concurrent identical requests (the second waits for the first's commit/rollback before it can tell whether it conflicts).
- **RID coordination**: one allocator (`allocateMessageId`, exported from `postgres-collab-repository.js`), one table (`collab_workspace_rids`), shared by every collab-object kind — there was never a second RID system to avoid creating.
- **Failure/rollback**: proven by `test/postgres.test.js`'s FK-violation/rollback checks and Task 59's migration-failure tests; this task extends the same proof to the new atomic row-creation transaction (see "Rollback/fault-injection results").
- **Storage-mode selection**: `openStore(file, { storage })` in `storage.js` is the single switch point; every other file (`server.js`, route handlers) calls the same named methods (`getDatabaseCollab`, `acceptDatabaseRowCollabUpdate`, etc.) regardless of mode — no mode conditionals were added anywhere outside `storage.js`/`postgres-storage.js`/`postgres-collab-repository.js`.
- **Disposable test data**: real Postgres tests (`RUN_POSTGRES_TESTS=1`) either reuse one shared disposable database (`appflowy_independent_test`, via `DATABASE_URL`) with randomly-generated per-test workspace/user ids (no cleanup needed, no collision), or (migration-lock tests only) create/drop a fresh disposable database per test via `createDisposableDatabase()`/`dropDisposableDatabase()`.

## Existing JSON architecture (as inspected)

`storage.js`'s JSON mode keeps one big `state` object matching Postgres's tables as plain JS collections (e.g. `databaseCollabDocuments[databaseId]`, `databaseRowCollabUpdates[rowId]`). All multi-step writes go through `mutate(store, fn)`, which snapshots `structuredClone(store.state)` before running `fn` synchronously, persists via `store.persist(state)` (the fault-injection seam reused by Task 44/61/62 and, for Postgres-mode's equivalent, by this task's `postgresAtomicRowCreationTestHooks`), and restores the snapshot on any thrown error — this is JSON's transaction equivalent. A set of named promise queues (`atomicCreationQueue`, `pageCollabUpdateQueue`, `databaseCollabUpdateQueue`, `atomicRowCreationQueue`, `databaseRowCollabUpdateQueue`) serializes same-kind operations without making unrelated operations contend. `createAtomicDatabasePage` reuses the **same** `atomicCreationRequests` collection as Document page creation (adding a `database_id` field to the record) — not a second idempotency namespace. `createAtomicDatabaseRow` uses its own, separate `atomicRowCreationRequests` collection. `preparePageCollabUpdate` (in `postgres-collab-repository.js`, despite the filename) is fully object-agnostic Yjs update validation/application logic reused unmodified by Document, Database, and DatabaseRow update admission in both storage modes — this was Task 61's finding, re-confirmed and leaned on here.

## Schema design and rationale

All changes are in one new migration file, `migrations/007_database_and_database_row_collab.sql`, registered in `postgres-storage.js`'s `MIGRATION_FILES` list. Additive only; no existing table's semantics changed for existing rows.

1. **`pages.layout` (new nullable column)**. `server.js` reads `page.layout ?? 0` directly off the stored page object for Folder-tree rendering (ViewLayout.Grid = 1 for a Database's container/primary-view pages). JSON-mode pages already carry this as a free JS field; Postgres's `rowPage()`/`PAGE_COLUMNS` never selected it, so every Postgres-mode page — including a freshly created Database's own Folder entries — would have rendered with the wrong layout. Fixed by selecting/returning it (omitted from the response object when `NULL`, matching JSON's "key simply absent" semantics exactly, so no Document-page test could be affected).
2. **`pages.parent_view_id` foreign key dropped** (`pages_parent_view_id_fkey`, previously `REFERENCES spaces(id)`). This is a **pre-existing defect discovered while implementing this task**, not introduced by it: a page's parent can legitimately be another page (ordinary nested sub-pages — JSON mode already supports this, see `test/backend.test.js`'s "Child page" fixture), but the migration-003 FK only ever allowed a space as parent. A Database's primary/inline view page is parented by the Database's own container page (a page, not a space) — so **Database creation could never have worked in Postgres mode at all** before this fix (confirmed by reproducing the exact `23503 pages_parent_view_id_fkey` violation while first writing this task's own tests). Postgres cannot express "references either table" as one FK; the fix drops the overly-narrow constraint and relies on the same application-level validation JSON storage already uses. No code path relies on `ON DELETE CASCADE` from a space to its pages (no space-deletion route exists), so nothing is weakened.
3. **`atomic_creation_requests.database_id`** (new nullable column) — mirrors JSON mode's single shared idempotency collection for Document + Database page creation exactly (one `request_id` namespace, not two).
4. **`database_collab_documents`** — one row per `(workspace_id, database_id)`: `collab_version` (NOT NULL, always `'appflowy-database-v1'`), `restore_id`, `document_state`/`state_vector` (bytea), `generation`, `last_message_id_timestamp`/`counter`, `updated_at`. Structurally identical to `collab_documents` minus the `pages` foreign key (a Database collab object and its container page are both inserted in the same atomic-creation transaction, but a Database is not itself a `pages` row).
5. **`database_collab_updates`** — append-only, identical shape to `collab_updates` (digest/message-key dedup, RID columns, FK to `database_collab_documents`).
6. **`database_row_collab_documents`** — one row per `(workspace_id, row_id)`, FK to `database_collab_documents(workspace_id, database_id)`. `collab_version`/`restore_id` are nullable and **always stored `NULL`** — the frontend contract requires `collab_version: null` on every DatabaseRow read (no independent row versioning), and this is enforced structurally, not just by convention in application code.
7. **`database_row_collab_updates`** — append-only, same shape, FK to `database_row_collab_documents`.
8. **`atomic_row_creation_requests`** — a dedicated table (mirroring JSON's separate `atomicRowCreationRequests` collection, a different namespace from Document/Database page creation): `request_id` PK, `workspace_id`, `database_id`, `request_digest`, `row_id`, `update_batch_id`, `database_update` (bytea, **nullable**, filled in by an `UPDATE` right before `COMMIT` — see transaction design below), `created_at`.

## Migration details

`007_database_and_database_row_collab.sql` runs through the unmodified Task 59 advisory-lock/`schema_migrations` framework: session-level advisory lock keyed off the database identity, migration-state recheck under the lock, per-file transaction (this file's own DDL either fully applies and is recorded, or fully rolls back and is not recorded), concurrent-startup-safe (two processes racing serialize on the lock; the second rechecks state and finds the file already applied), crash-mid-migration-safe (the `BEGIN`/`COMMIT` per file means a killed process never leaves a half-applied file recorded as done). All statements are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`), so the file is safe to run repeatedly. Task 59's lock implementation itself was **not** modified — no defect was found in it, and none was alleged.

Six existing hardcoded `assert.equal(..., 6, ...)` / `assert.deepEqual([...6 filenames...])` assertions in `test/postgres-migration-lock.test.js` were updated to `7`/`+1 filename` — this is the expected, mechanical bookkeeping update every new migration file requires (the assertions test "every known migration is tracked exactly once," not any specific count), not a weakening of the lock-correctness logic they verify. All ten migration-lock tests were re-run and pass (see Regression results).

## Database PostgreSQL implementation

`postgres-storage.js`'s `repository(pool)`:
- **`createAtomicDatabasePage`**: one transaction. Claims `(request_id, database_id)` in `atomic_creation_requests` first (same idempotency contract as `createAtomicDocumentPage`, including `REQUEST_ID_REUSED`/`ATOMIC_CREATION_INCOMPLETE` on a conflicting/partial replay); on a genuine new request, inserts both Folder-tree pages (container + primary view) and the `database_collab_documents` row, then records `database_id` on the claim row, all in the one transaction. `23505` is mapped to `PAGE_EXISTS` or `DATABASE_EXISTS` by inspecting `error.constraint`.
- **`getDatabaseCollab`**: delegates to a new generic repository (below); returns the same `{ object_id, doc_state, state_vector, version: 0, collab_version, last_message_id }` shape as JSON mode, scoped to `workspace_id`, `null` on any mismatch/missing row.
- **`acceptDatabaseCollabUpdate`**: delegates to the generic repository's `acceptUpdate`, reusing `preparePageCollabUpdate` and `allocateMessageId` unmodified. No Database-field-specific mutation code exists anywhere (field add/rename remain, as Task 61 found, ordinary generic Yjs diffs).

## DatabaseRow PostgreSQL implementation

- **`getDatabaseRowCollab`** / **`acceptDatabaseRowCollabUpdate`**: same generic-repository delegation, scoped by `row_id`; `collab_version` is always read back as `NULL` (column-level guarantee, see schema section).
- **`createAtomicDatabaseRow`**: the highest-risk piece — see transaction design below.

### The generic collab-object repository (`PostgresGenericObjectCollabRepository`, new, in `postgres-collab-repository.js`)

A deliberately narrow addition, not a new general abstraction layer: parameterized only by `{ documentsTable, updatesTable, idColumn }`, it implements `load()`/`acceptUpdate()` once and is instantiated twice (`createPostgresDatabaseCollabRepository` / `createPostgresDatabaseRowCollabRepository`). It reuses `preparePageCollabUpdate` and the exported `allocateMessageId` **verbatim** — no second implementation of update validation, state-vector fencing, or RID allocation exists. It is intentionally a *separate* class from `PostgresPageCollabRepository` (not a refactor of it): that class also carries Document-only version-history/restore methods with no Database/DatabaseRow equivalent, and generalizing its already-tested `load`/`acceptUpdate` methods in place would have risked exactly the kind of regression the task brief warns against for working code.

## Atomic row-creation transaction design

`createAtomicDatabaseRow` (`postgres-storage.js`) is one Postgres transaction, in this order:

1. **Claim** `(request_id, workspace_id, database_id, request_digest, row_id, update_batch_id, created_at)` into `atomic_row_creation_requests` with `database_update` left `NULL`, via `INSERT ... ON CONFLICT (request_id) DO NOTHING`. If the row already existed (claim `rowCount=0`): validate the existing record matches this request's `(workspace_id, database_id, request_digest)` (else `REQUEST_ID_REUSED`), confirm the row doc exists and `database_update` is non-`NULL` (else `ATOMIC_CREATION_INCOMPLETE`), and return `{ outcome: 'already_applied', row_id, database_update, update_batch_id }` **from the original record** — `COMMIT` and return immediately; no further steps run.
2. **Lock the parent**: `SELECT document_state, generation FROM database_collab_documents WHERE workspace_id=$1 AND database_id=$2 FOR UPDATE` (missing ⇒ `DATABASE_NOT_FOUND`). This row-level lock — on the specific Database, never a global lock — is what serializes two different concurrent row-creation requests against the *same* Database (the second waits for the first's commit before reading, so it computes its insertion index against the up-to-date `row_orders`), while leaving concurrent creation against a *different* Database completely unaffected.
3. **Mutate the in-memory Y.Doc**: decode `document_state`, validate `source_view_id` belongs to this Database (`VIEW_NOT_FOUND` otherwise), compute the insertion index for `start`/`end`/`before <row>`/`after <row>` (an unmatched anchor falls back to "end", identically to JSON mode), insert `{id: rowId, height}` into `row_orders`, and compute the Database's new full state, new state vector, and the client-facing diff (`encodeStateAsUpdate(doc, beforeStateVector)`).
4. **Insert the new DatabaseRow doc**: `INSERT INTO database_row_collab_documents(...) ON CONFLICT (workspace_id,row_id) DO NOTHING`; `rowCount=0` ⇒ `ROW_EXISTS` (a genuine row-id collision from a different request), which rolls back the whole transaction — the Database's `row_orders` mutation computed in step 3 has not been written yet, so nothing partial survives.
5. **Persist the parent Database's new state**: `UPDATE database_collab_documents SET document_state=...,generation=generation+1 WHERE ... AND generation=$lockedGeneration` — the `FOR UPDATE` lock from step 2 already prevents this from ever failing in practice, but the generation-equality check is kept as defense in depth (the same pattern every other update path in this codebase uses).
6. **Fill in the idempotency receipt**: `UPDATE atomic_row_creation_requests SET database_update=$diff WHERE request_id=$1`.
7. **`COMMIT`**. Any error anywhere in steps 1–6 rolls back the entire transaction, including the step-1 claim row — so a failed attempt can never leave a surviving idempotency receipt, a surviving `database_row_collab_documents` row, or a surviving `row_orders` mutation, in any combination.

## Concurrency/locking strategy

- **Per-request_id mutex**: Postgres's own unique-index conflict resolution on the step-1 claim insert (no advisory lock needed or added).
- **Per-database row lock**: `SELECT ... FOR UPDATE` on `database_collab_documents`, held for the transaction's duration — the same row is also locked by ordinary Database field-update admission (`acceptDatabaseCollabUpdate`'s generic repository, via the same table), so row creation and ordinary Database edits correctly serialize against each other too.
- **No global/table-wide lock anywhere** in the new code — deliberately, per the brief's guardrail.

## Idempotency/replay behavior

Identical contract to Document creation (Task 15/59) and Database creation, extended to row creation: identical replay (same `request_id` + same `request_digest`) returns the **original** `update_batch_id`, `row_id`, and `database_update` unchanged, never recomputing or re-mutating anything; the same `request_id` with a **different** `request_digest` is rejected with `REQUEST_ID_REUSED` and leaves no trace of having run.

## RID/dedup behavior

One allocator (`collab_workspace_rids`, `allocateMessageId`), shared by Document, Database, and DatabaseRow updates — confirmed no second RID system was introduced. Dedup for ordinary Yjs updates is payload-digest/message-key based, identical logic for Database and DatabaseRow (both via the new generic repository) and Document (unchanged, its own class). Row-*creation* idempotency is a structurally separate mechanism (`atomic_row_creation_requests`), as it already is in JSON mode — not folded into the RID/update-dedup machinery, matching the existing separation of concerns.

## Rollback/fault-injection results

A test-only hook, `postgresAtomicRowCreationTestHooks.throwAt` (exported from `postgres-storage.js`, no-op unless a test sets it — same convention as Task 59's `POSTGRES_MIGRATION_TEST_DELAY_MS`), injects a real thrown error at each of six checkpoints inside the transaction: `after_claim`, `after_parent_loaded`, `after_row_order_mutation`, `after_row_doc_inserted`, `before_receipt_insert`, `before_commit`. **Result: Passed** at all six checkpoints — full rollback, no row document, no `row_orders` mutation, no idempotency receipt of any kind, and (proven, not just asserted) a subsequent retry of the identical request succeeds cleanly afterward. See `test/postgres-database-collab.test.js`'s dedicated fault-injection test.

## JSON/Postgres parity results

`test/json-postgres-parity.test.js` runs one fixed sequence (create workspace → create Database → read → create a row → read Database + check `row_orders` → read DatabaseRow → apply a cell update → **reopen both stores** → re-read both objects → verify the persisted cell value → replay the original row-creation request → verify the stable `update_batch_id` → submit a duplicate update → verify dedup) against a disposable JSON store and a disposable Postgres store, using **identical client-supplied ids on both sides** so the two runs' "fingerprints" (API outcome shape, row-order membership, `collab_version` nullness, dedup/idempotency status, persisted values) are directly comparable. **Result: Passed** — the two fingerprints are byte-for-byte `deepEqual`. No unexplained parity gap; no intentional difference needed documenting beyond the two schema shims already covered above (`pages.layout`, the dropped `parent_view_id` FK — both pre-existing cross-mode gaps, not Database/DatabaseRow-specific).

## WS/HTTP integration results

`test/postgres-database-http-integration.test.js`: real `startServer({ storage: 'postgres' })`, real HTTP requests, real WebSocket frames, exercising the exact same routes/request shapes AppFlowy-Web sends (`POST .../v2/page-view/database/default`, `GET .../collab/{id}?collab_type=1|4`, `POST .../v2/database/{id}/row/default`, WS `syncRequest`/`update` for both `collabType=1` and `=4`), plus a full server/pool restart mid-test against the same disposable database. **Result: Passed** — Database creation, collab read, WS sync + a field-rename update, two REST row creations, a WS cell edit, and a restart all round-trip correctly; `row_orders` is in the correct order after restart and the WS cell edit survives the restart.

## Real browser verification (PostgreSQL mode)

Dedicated backend on port 8802 (verified unused before starting), `STORAGE=postgres`, `DATABASE_URL` pointed at a fresh disposable database (`appflowy_task63_browser`, created for this run, dropped afterward), `CORS_ALLOWED_ORIGINS` including the frontend's port. Dedicated Vite dev server on port 5202 (verified unused), `APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL`/`APPFLOWY_WS_BASE_URL` exported pointing at port 8802. `AppFlowy-Web/.env.local` backed up (MD5-verified) before being edited and restored byte-for-byte (MD5-verified) afterward.

Through the real UI (headless Chromium via Playwright, script and all evidence at `docs/task63-evidence/browser-run/` and `docs/task63-evidence/task63-browser-verify.mjs`): register → login → open workspace → create space → create Grid Database → confirmed the default Grid view, the primary "Name" field, and zero initial rows → created row 1 via the real "+ New row" button → typed a value into row 1's Name cell via the real rich-text cell editor → reloaded → confirmed row 1 and its value persisted → created a **second** row → typed a second value → reloaded → confirmed **both** rows and **both** values persisted → **restarted the real PostgreSQL-backed backend process** (killed the old PID, spawned a fresh one on the same port against the same disposable database, waited for `/health`) while the same already-authenticated browser tab stayed open → reloaded that tab against the restarted backend → confirmed both rows and both values survived the restart → independently confirmed via a direct backend collab-read call (bypassing the UI) that the Database object is correctly readable. **All steps Passed** — screenshots `01`–`14`, `console.log`/`console-errors.log`/`network.log`/`websocket.log`/`steps.log` all saved.

**Discovered limitation (documented, not fixed, out of scope)**: a *second*, independent attempt to open the same Database from a **fresh** login (new browser context, no prior session state) failed with "Page not found." Traced to its exact root cause: `GET /api/workspace/{id}/database` (the workspace's Database catalog, `server.js` ~line 1461) unconditionally returns `{ databases: [], has_more: false }` — a hardcoded stub, present identically in JSON mode, that never calls `store` at all. Without this catalog, the frontend's view-loader cannot discover that a given Folder-tree view is a Database on a cold open, and falls through to the Document-only `page-view/{id}` route, which 404s for a Database's primary-view page (it has no Document collab object). This is a **pre-existing, storage-mode-agnostic Folder/UI feature-completeness gap** — not a Database/DatabaseRow *storage*-parity defect, and fixing the catalog route is explicitly out of this task's scope ("no new frontend UI features"). Full evidence (screenshots, console/network logs, the exact 404 chain) is at `docs/task63-evidence/fresh-session-navigation-gap/`. It does **not** affect the mandatory restart-verification requirement above, which was satisfied via the realistic "same session survives a backend restart" scenario instead (the access token is itself durably stored in Postgres's `sessions` table and remains valid across a restart).

## Multi-client verification

Full two-independent-browser-context UI verification is blocked by the same discovered catalog-route gap above (a second user's *first* open of a shared Database, from their own fresh session, hits the identical 404 — this is not a Postgres-specific or Task-63-introduced limitation). Per the brief's explicit instruction ("if the existing system genuinely can't support it safely within scope, document the exact limitation... never claim it works"), multi-client verification was instead performed at the real WebSocket **protocol** level — two independent real WS connections against the real Postgres-backed server (`test/postgres-database-multiclient.test.js`), modeling two independent AppFlowy-Web clients, both synced to the same Database/DatabaseRow objects.

**Result, with evidence, correcting an assumption in this task's own brief**: tracing `server.js` directly shows that **no content update of any collab type broadcasts to other already-connected peers** — every `update`-admission branch's response (`sendDocumentFrame`/`sendDatabaseFrame`/`sendRowFrame`) writes back only to the sender's own socket; the *only* message kind relayed to other peers (`for (const peer of websocketPeers) if (peer !== websocket ...)`) is `awarenessUpdate` (cursor/presence pings). This test proves, with real traffic: (1) the atomic REST row-creation endpoint does not broadcast to a peer already connected and synced (confirmed, extending Task 62's JSON-mode finding to Postgres and to the general case) — the peer's connection receives nothing within a 2.5s window; (2) an **ordinary WS cell edit also does not broadcast** — the brief expected this to work "via the existing broadcast mechanism," but no such mechanism exists for content, only for awareness, in either storage mode; (3) in both cases, the peer **does** see the change the moment it issues a fresh `SyncRequest` — the "durable but pull-based" model is consistent across every collab type and every write path. No separate event system was invented; the limitation is documented with exact evidence (file/line-level trace plus a passing, reproducible automated test) rather than worked around.

## IndexedDB outbox observation

Reproduced in the real-browser single-client Postgres run: `[outbox] enqueue failed ... DexieError2 {name: "NotFoundError"}`, 2 occurrences (one per row creation), identical in nature and frequency to Task 62's JSON-mode finding. The frontend's own existing fallback handled it correctly both times — row and cell data were confirmed correct across every reload and the backend restart. **Not reproduced as "fixed," not classified as fixed** — this remains an unresolved, non-blocking, frontend-side observation; no frontend code was read for root-cause beyond what Task 62 already established, and none was modified.

## Regression results

| Suite | Result |
|---|---|
| `npm test` | 38/38 Passed |
| `npm run test:offline-collab` | 5/5 Passed |
| `npm run test:collab-conformance` | 6 passed / 0 failed / 2 pending / 5 resolved — unchanged from baseline, Passed |
| `npm run test:database-collab` | 13/13 Passed |
| `npm run test:database-row-collab` | 11/11 Passed |
| `npm run test:postgres` (now 7 files, 27 tests) | 27/27 Passed |
| Migration-lock tests specifically (within the above) | 10/10 Passed |
| New: `test/postgres-database-collab.test.js` (5 tests: creation/retrieval/update/idempotency/cross-workspace/restart for both objects, atomic-row idempotency+rejections, fault-injection rollback at 6 checkpoints, true-concurrency races) | 5/5 Passed |
| New: `test/postgres-database-http-integration.test.js` | 1/1 Passed |
| New: `test/postgres-database-multiclient.test.js` | 1/1 Passed |
| New: `test/json-postgres-parity.test.js` | 1/1 Passed |
| Real browser (single-client, two rows, restart) | Passed |
| Real browser (fresh-session second open) | **Blocked** — discovered pre-existing, out-of-scope limitation, documented with evidence |
| Multi-client (protocol-level) | Passed (with corrected, evidenced finding — see above) |

No baseline test was weakened, deleted, or had its assertions changed to force a pass; the only test-file edits were the mechanical migration-count bump (6→7) in `postgres-migration-lock.test.js`.

## Files changed

**Backend** (`AppFlowy-Independent-Backend`, no git — paths only):
- `migrations/007_database_and_database_row_collab.sql` (new)
- `postgres-collab-repository.js` (exported `allocateMessageId`; added `PostgresGenericObjectCollabRepository` + two factory functions)
- `postgres-storage.js` (registered migration 007; added `pages.layout` to `PAGE_COLUMNS`/`rowPage`; added `createAtomicDatabasePage`, `getDatabaseCollab`, `acceptDatabaseCollabUpdate`, `createAtomicDatabaseRow`, `getDatabaseRowCollab`, `acceptDatabaseRowCollabUpdate`; added `postgresAtomicRowCreationTestHooks` test-only export)
- `test/postgres-migration-lock.test.js` (migration count 6→7, filename lists updated)
- `test/postgres-database-collab.test.js` (new)
- `test/postgres-database-http-integration.test.js` (new)
- `test/postgres-database-multiclient.test.js` (new)
- `test/json-postgres-parity.test.js` (new)
- `package.json` (`test:postgres` script extended; new `test:parity` script)
- `docs/task63-evidence/` (new: browser-run screenshots/logs, fresh-session-navigation-gap evidence, verification scripts)
- `docs/TASK63_POSTGRES_DATABASE_AND_DATABASE_ROW_PARITY_REPORT.md` (this file)
- `docs/AGENT_HANDOVER.md`, `docs/MASTER_FEATURE_ROADMAP.md`, `docs/FEATURE_REGISTRY.md`, `docs/ARCHITECTURE_OVERVIEW.md`, `docs/TESTING_AND_ACCEPTANCE_STRATEGY.md`, `docs/DATABASE_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md` (appended)

**AppFlowy-Web**: no source files changed; `.env.local` edited temporarily for the browser run and restored byte-for-byte (not tracked by git; MD5-verified before/after).

**Database**: disposable `appflowy_task63_browser` created and dropped; `appflowy_independent_test` (shared disposable) gained migration 007's schema only — no data loss, no destructive operation against it or any other database.

## Known limitations

1. The pre-existing Folder/UI Database-catalog stub (`GET .../database` always `[]`) blocks opening any Database from a session that did not just create it — storage-mode-agnostic, out of this task's scope, documented with full evidence.
2. No content-update broadcast exists for any collab type in this backend (only awareness) — a corrected understanding, not a regression; documented with evidence.
3. `pages.parent_view_id`'s foreign key was removed rather than widened (Postgres cannot express a two-table FK) — referential integrity for page parentage is now enforced only at the application layer in Postgres mode, matching JSON mode exactly, but meaning a direct SQL `DELETE FROM pages` could leave a dangling `parent_view_id` reference where the old (overly narrow) constraint would at least have caught a space-parent case. No existing code path performs such a raw delete.

## Deferred capabilities

Everything the brief listed as explicitly out of scope remains out of scope and untouched: row templates/duplication, multiple Database views, multi-view row ordering, row-detail Document lifecycle, advanced field types beyond generic Yjs cell writes, formula/rollup/relation evaluation, filters/sorting/grouping engines, Calendar/Kanban layouts, blob storage/attachments, database history/restore for Database/DatabaseRow objects (Document-only version history from Task 49 is untouched and unaffected), new frontend UI, a new collaboration protocol/CRDT, a new auth system, a Postgres architecture rewrite, a migration-framework redesign.

## Security/data-integrity assessment

No new injection surface (all interpolated SQL identifiers are fixed internal constants, never user input; all values are parameterized). Cross-workspace isolation is enforced identically to Document (every read/write scopes by `workspace_id`, confirmed by a dedicated test for both Database and DatabaseRow). Persist-before-ack is absolute: no ack/success response is ever constructed before the transaction's `COMMIT` resolves, for every new code path, proven by the fault-injection tests (a thrown error before `COMMIT` always rolls back, and the calling REST/WS handler's existing error-mapping is unchanged). No secrets, tokens, or credentials appear in any new file.

## Performance considerations

No unnecessary re-encoding: `createAtomicDatabaseRow` builds exactly one `Y.Doc` from the already-loaded `document_state` and reuses it for both the row-orders mutation and the diff/new-state computation. No speculative caching was added. The per-database `FOR UPDATE` lock is held only for the duration of one row-creation transaction, not across requests; under the measured test load (dozens of concurrent creations in the automated suite) this added no observable serialization bottleneck beyond what correctness requires.

## Exact recommended next task

Fix the Database-catalog stub (`GET /api/workspace/{id}/database`) to return the workspace's real Database list (both storage modes), which is the actual blocker for (a) a user reopening a Database after a fresh login/new device and (b) genuine multi-client real-browser verification of Database/DatabaseRow collaboration. This is a Folder/UI-completeness fix, not a storage-parity task, and should be scoped and evidenced independently before any further Database feature work (e.g. Phase 2 views/Grid-settings) is built on top of it.
