# Task 62 — Minimum viable DatabaseRow lifecycle (CollabType.DatabaseRow = 4)

## 0. Scope and repo-state safety check (before any change)

The backend repository has **no `.git`** (confirmed again this task). "Current state" means files on disk, inspected directly.

The frontend repository (`AppFlowy-Web`) **has** `.git`. `git status` at task start showed the exact same pre-existing modified/untracked files Task 61 found and left untouched (`src/@types/translations/en.json`, `src/components/app/app.hooks.tsx`, `src/components/app/contexts/AppOperationsContext.ts`, `src/components/app/hooks/useViewOperations.ts`, `src/components/app/layers/AppBusinessLayer.tsx`, `src/components/app/view-actions/NewPage.tsx` + its test, `src/components/document/history/*` (3 files), `src/components/publish/header/duplicate/SpaceList.tsx` + its test, `vite.config.ts`; untracked: `.vite.task40.config.ts`, `README_TESTING.md`, `TESTING_GUIDE.md`, `dummy_user_credentials.js`, `generate_test_credentials.mjs`, `package-lock.json`, a new `DocumentHistoryModal.snapshotAndDelete.test.tsx`, `test_api.mjs`, `test_login.html`, `tests/`). **None were touched.** `git status` at the end of this task is byte-for-byte identical to this list — confirmed. The only frontend-repo artifact this task touched was `.env.local` (gitignored, not tracked — Task 61's own precedent of editing it for a disposable browser run and restoring it afterward was followed exactly: original content backed up, overwritten for the run, restored verbatim afterward, diff-confirmed identical).

Before starting, running processes/ports were inventoried: pre-existing `node server.js` on ports 8791/8792 and a pre-existing Vite dev server on port 5190 (left over from outside this task). **None were touched, inspected beyond `lsof`, or stopped**, and were confirmed still running, unmodified, at the end of this task. All new processes this task started used freshly-verified-free ports (backend **8801**, Vite **5201**) and were stopped by exact PID at the end (verified via `lsof -iTCP:<port>` immediately before and after each `kill`). Postgres: the pre-existing disposable database `appflowy_independent_test` (superuser-owned, containing only this project's own tables) was reused once for a confirmatory Postgres regression run, since no Postgres code was touched at all this task (see §9).

Files touched this task:
- **Created**: `database-row-document.js` (DatabaseRow collab-doc initializer), `test/database-row-collab.test.js` (new regression suite, 11 tests), `docs/task62-evidence/` (this task's evidence directory, including the Playwright verification script and its output).
- **Modified**: `server.js` (new DatabaseRow WS admission branch for `collabType === 4`, new `POST /v2/database/{databaseId}/row/default` route, extended the single-object collab-read route and its allowed-type list to recognize `collab_type=4`, new row-request validation helpers), `storage.js` (new `databaseRowCollabDocuments`/`databaseRowCollabUpdates`/`atomicRowCreationRequests` state, new `createAtomicDatabaseRow`/`getDatabaseRowCollab`/`acceptDatabaseRowCollabUpdate` store methods, two new dedicated queues), `package.json` (new `test:database-row-collab` script).
- **Not touched**: `postgres-storage.js`, `postgres-collab-repository.js` (only its already-generic, already-exported `preparePageCollabUpdate` function was *called*, unmodified — exactly the same reuse pattern Task 61 used for the Database path), `postgres-migration-lock.js`, any `migrations/*.sql`, `page-document.js`, `database-document.js`, `collab-protocol.js`, `workspace-database.js`, `auth.js`, `test/backend.test.js`, `test/database-collab.test.js`. No new external dependency was added. No pre-existing test's expected outcome was changed (unlike Task 61, which had one documented, justified exception — this task needed none).

## 1. Executive summary

Task 62 implements the minimum viable DatabaseRow lifecycle through the **existing, unmodified** AppFlowy-Web frontend's real contract: row creation via a new atomic `POST .../v2/database/{databaseId}/row/default` endpoint (discovered, not guessed, by tracing `createCloudRow()`/`prepareDefaultRowRequest()` in `create-row.ts` and `postDefaultRowCreation()` in `atomic-row-creation-api.ts`), DatabaseRow Yjs-document initialization matching the frontend's own `initialDatabaseRow()` shape exactly, durable JSON persistence mirroring Task 61's Document/Database pattern field-for-field, generic WebSocket admission for `CollabType.DatabaseRow = 4` (reusing the exact same persist-before-ack/dedup/fault-tolerance machinery Task 61 built for Database, itself reused from Task 44/45's Document machinery), and row-order insertion into the parent Database's single Phase-1 inline Grid view, performed atomically with row creation in the same server-side operation. **Final status: Complete.**

The real frontend contract was independently traced from the checked-out `AppFlowy-Web` source (not assumed from the task brief's speculation about REST vs WebSocket) — see §2. The single most consequential finding: row creation is **not** a pure Yjs CRDT operation like field add/rename was (Task 61's biggest finding) — it requires a dedicated atomic REST endpoint, because the frontend's own `createCloudRow()` needs a single, server-adjudicated outcome that both creates the row *and* proves its membership in the parent Database's `row_orders` array before the client will treat the row as real (`assertMembership()`/`assertRow()`). Once the row exists, however, **cell edits are exactly the generic Yjs CRDT pattern Task 61 predicted** — no bespoke cell-update server code was written, confirming the hypothesis in the task brief.

Backend test results: `npm test` 38/38 (baseline unchanged), `npm run test:offline-collab` 5/5 (unchanged), `npm run test:collab-conformance` 6 passed/0 failed/2 pending/5 resolved (unchanged), `npm run test:database-collab` **13/13 (unchanged — regression-proven, not just untouched)**, `npm run test:database-row-collab` **11/11 (new)**, `npm run test:postgres` 20/20 (unchanged; Postgres code was not touched at all, run once for confirmation per Task 61's own convention).

Real browser verification: register → login via UI → open workspace → create space → create Grid database (Task 61's workflow, reused unmodified) → confirm zero rows → **create a new row via the real "+ New row" UI button** → **enter a value in the primary "Name" field via the real UI** (discovered mid-task: the primary field's editor is a Slate-based rich-text contenteditable, `data-testid="rich-text-cell-editor"`, not the plain `<textarea>` a static read of `TextCellEditing.tsx` alone would suggest — found only by actually driving the real browser and inspecting the live DOM) → wait for persistence → reload → reopen the database → **verify the row still exists and the cell value persisted** — **all steps Passed**, with screenshots, console/network/WebSocket logs at `docs/task62-evidence/browser-run/`. One new, non-blocking, frontend-side observation was found and is documented, not silently worked around (§9).

## 2. Contract investigation

### 2.1 How AppFlowy-Web identifies/creates a DatabaseRow object (confirmed from source)

`CollabType.DatabaseRow = 4` (`src/application/types.ts:1315`, re-confirmed this task, matches Task 61's finding).

Row creation is triggered by `useNewRowDispatch()` (`src/application/database-yjs/dispatch/row.ts:558-886`), which:
1. Generates `rowId = uuidv4()` client-side.
2. Builds a **private, local-only** `Y.Doc({ guid: rowId })` and populates it via `initialDatabaseRow(rowId, databaseId, rowDoc, actorUid)` (`src/application/database-yjs/row.ts:7-24`) + `populateNewRowCells()` (cell prefill from active filters/templates — empty for a plain "add row" with no filters) + `generateRowMeta()` (icon/cover/document-emptiness, written under per-row UUIDv5-obfuscated keys — see §3).
3. Calls `createCloudRow()` (`src/application/database-yjs/creation/create-row.ts:182-409`), which:
   a. Builds `DefaultRowRequest` via `prepareDefaultRowRequest()` (freezes `cells`/`height`/`visibility`/`presentation` from the local doc, **never** the detail-page/meta content).
   b. Waits for the live local Database doc's state to be provably reflected server-side (`waitForDatabaseViewSource`/`remoteDatabaseCoversSource`) — pure client-side consistency-polling against the **existing** `GET /api/workspace/v1/{workspaceId}/collab/{databaseId}?collab_type=1` read endpoint (already built in Task 61/60; **no new server code needed** for this step).
   c. POSTs the request to `postDefaultRowCreation()` (`src/application/services/js-services/http/atomic-row-creation-api.ts:79-86`): **`POST /api/workspace/{workspaceId}/v2/database/{databaseId}/row/default`**.
   d. Validates the response (`validateReceipt()`), then either applies an optional `activation.row_encoded_collab_v1` hint directly, **or** falls back to reading the new Database + DatabaseRow state back via the **same** generic multi-object reader (`readCollabStates()`, one `GET /collab/{id}?collab_type=` call per object) already used in step (b) — this task implements the fallback path only (the hint is genuinely optional in the frontend's own contract type, `CreatedRowReceipt.activation?`).
   e. Applies the resulting row state into a **separate**, freshly-opened local row doc (`openCachedRow()`/IndexedDB-backed cache — not `rowDoc` from step 2, which is discarded) and the resulting Database diff into the live Database doc, both via `Y.applyUpdate(..., CollabOrigin.Local)`.
   f. Calls `intent.registerRow()` → `useRowOperations.createRow()` (`src/components/app/hooks/useRowOperations.ts:12-71`) → `RowService.create()` → **registers the row doc for ongoing WebSocket sync** with `collabType: Types.DatabaseRow` via `registerSyncContext()`.

This is **REST for creation, WebSocket for everything after** — confirmed directly from the above trace, not inferred from endpoint naming.

### 2.2 The exact REST contract (confirmed from source, not guessed)

```
POST /api/workspace/{workspaceId}/v2/database/{databaseId}/row/default
{
  schema_version: "v1",
  request_id: "<uuid>",
  row_id: "<uuid>",
  database_restore_id: "00000000-0000-0000-0000-000000000000",  // ORIGINAL_DATABASE_RESTORE_ID sentinel — the only
                                                                   // valid value while Database restore (out of scope,
                                                                   // Task 61) is never exercised
  source_view_id: "<uuid>",   // the view the row is being created into
  cells: { "<field_id>": { ...plain JSON... }, ... },  // flat map, frozen from the row's local Y.Map cells at submit time
  height: 36,                 // positive integer
  visibility: true,
  presentation: { icon_url: string|null, cover: {...}|null },
  position: { kind: "start" } | { kind: "end" } | { kind: "before"|"after", row_id: "<uuid>" }
}
```
Response (`CreatedRowReceipt`, validated by `validateReceipt()`):
```
{
  request_id, outcome: "applied"|"already_applied",
  result: {
    row_id, database_id, database_restore_id, database_version: string|null,
    database_update_v1: "<base64 Yjs update>",   // REQUIRED — the diff the client merges into its own live Database doc
    update_batch_id: "<any truthy string>",
  },
  activation?: { row_encoded_collab_v1: "<base64, Rust-EncodedCollab-shaped>" },  // OPTIONAL — not implemented, see §6
}
```
Source: `src/application/database-yjs/creation/row-creation-types.ts` (`DefaultRowRequest`, `CreatedRowReceipt`), `src/application/database-yjs/creation/create-row.ts` (`prepareDefaultRowRequest`, `validateReceipt`), `src/application/services/js-services/http/atomic-row-creation-api.ts` (`postDefaultRowCreation` → path `database/${databaseId}/row/default` under the shared `v2/` prefix, same envelope/retry machinery as Document/Database atomic creation).

**Critical, easy-to-miss distinction found during investigation**: a *different*, more advanced endpoint — `POST .../v2/database/{databaseId}/row` (**no** `/default` suffix) — handles **row templates and row duplication** (`submit-template-row.ts:53`, `useDuplicateRowDispatch`). This is a separate, more complex contract (full creation graphs, embedded documents, template decorations) and is **explicitly out of scope** for Task 62 (per the brief's own exclusion of advanced field types/templates) — **not implemented**, and never invoked by the minimum "create an empty row" workflow this task targets.

### 2.3 DatabaseRow Yjs structure (confirmed from `types.ts` + `row.ts` + `const.ts`)

```
doc.getMap('data')                      // root shared map, Y.Doc-level name "data"
  .get('data')                           // YDatabaseRow (Y.Map) — NOTE: YjsEditorKey.database_row
                                          // is a second enum alias for the SAME raw string 'data' as
                                          // YjsEditorKey.data_section (types.ts:533/539, upstream-
                                          // intentional, not a bug). The row object lives at key
                                          // 'data' INSIDE the root map named 'data'.
    .get('id')              -> row_id (string)
    .get('database_id')     -> parent database_id (string)
    .get('visibility')      -> boolean (default true)
    .get('height')          -> number (default 36; the YDatabaseRow TS interface annotates this as
                                string, which is simply inaccurate relative to initialDatabaseRow()'s
                                actual runtime behavior — confirmed by prepareDefaultRowRequest()
                                wrapping every read in Number(...) for safety)
    .get('created_at')/.get('last_modified') -> ISO/unix-string timestamp
    .get('created_by')/.get('last_edited_by') -> actor uid (string, optional — initializeRowAttribution
                                                   only sets these if a real actor uid is known)
    .get('cells')            -> Y.Map<FieldId, Y.Map>   // one Y.Map per field with a written cell;
                                                           fields with no cell data have NO entry at all
  .get('meta')               -> Y.Map (row "page" metadata: icon/cover/document-emptiness/attachment
                                 count, keyed by uuidv5(RowMetaKey.X, rowId) — a per-row-obfuscated key,
                                 NOT a literal string like "icon_id"; see const.ts metaIdFromRowId())
```
Confirmed required: `id`, `database_id`, `cells` (a real `Y.Map`, possibly empty) — `assertRow()` (create-row.ts:125-138) checks exactly these three plus doc causal-completeness, nothing else. `meta` is **not** checked by `assertRow()`, but **is** read unconditionally (no defensive guard) by at least one consumer (`useUpdateRowMetaDispatch`, dispatch/row.ts:1074-1116) — an absent `meta` key would throw on first icon/cover edit. This task's initializer therefore **always** creates an empty `meta` Y.Map (§4), even though Phase 1 never writes real content into it.

Cells are confirmed flat per-field `Y.Map` entries (not one giant map) — `writeCellToRow`/`useUpdateCellDispatch` (`dispatch/cell.ts`, exercised directly in this task's real-time test) mutate an **individual** field's cell Y.Map in place (`cell.set('data', value)`), never replace the whole `cells` map. Updates are therefore incremental Yjs diffs on existing structure, identical in character to Task 61's field-rename finding.

### 2.4 Row ordering (confirmed; answers brief §C)

- `row_orders` lives on **the Database's own Y.Doc**, per-view (`YDatabaseView.row_orders`, a `Y.Array<{id, height, is_deleted?}>`) — **not** on the DatabaseRow doc itself, confirmed directly: the DatabaseRow doc has no ordering concept at all.
- In Phase 1 there is exactly **one** view per database (the inline Grid view seeded by Task 61), so "per-view ordering" collapses to "the one array" — multi-view position fan-out (`positionViewIds` in `createCloudRow`) was traced but is **not implemented**, since it is unreachable with a single-view database (the frontend's own `positionViewIds` computation always resolves to exactly `[sourceViewId]` when only one view exists).
- Row insertion and row-doc creation **are atomic from the frontend's perspective** — `assertMembership()` (create-row.ts:140-156) requires the row's id to already be present in the parent Database's `row_orders` for the given view before `createCloudRow()` returns successfully, and the REST response's `database_update_v1` is the *only* mechanism by which the client learns of this membership without a second round trip. This task's server implementation performs both operations inside a single `mutate()` transaction (storage.js `createAtomicDatabaseRow`), so they can never be observed independently (persist-before-ack for both, or neither).
- A row existing but missing from the order array: not a state the frontend's own creation path can produce (atomicity above), and this task's server never produces it either (same transaction). The *frontend's own* deletion/unlink code **does** produce this state deliberately for "remove from view without deleting the document" (§2.5) — a different, already-supported mechanism.
- Insertion position: `start`/`end`/`after <row_id>`/`before <row_id>`, matching `CreationRowPosition` (`row-creation-types.ts:4`). Implemented and regression-tested (`test/database-row-collab.test.js`, "row ordering respects start/end/after position").

### 2.5 Row deletion/unlink semantics (confirmed; answers brief §D — resolved, not left uncertain)

Traced via `src/application/database-yjs/dispatch/row-lifecycle.ts` and `dispatch/row.ts`'s delete dispatch hooks:
- **Soft delete / trash** (`softDeleteRowsInDatabase`): sets `is_deleted: true` on the row's `row_orders` entry in **every** view (`executeOperationWithAllViews`) — an ordinary Yjs mutation of the existing array entry (delete+reinsert, since entries are plain JS objects, not nested Y.Maps). The row stays in the DatabaseRow collab object untouched; only its visibility flag in the order array changes. **Restorable** via `restoreSoftDeletedRowsInDatabase` (clears the flag), same mechanism.
- **Remove from view** (`removeRowsFromDatabase`, used by `useDeleteRowDispatch`/`useBulkDeleteRowDispatch`/the hard-delete branch of `useTrashAwareDeleteRowsDispatch`): deletes the row's entry from `row_orders` entirely (again, every view) **and** cleans up the row's *local* IndexedDB cache/outbox (`deleteCollabDB`, `deleteOutboxByObjectId`) — but **never issues any server call to delete the DatabaseRow collab object itself**. The row's durable server-side collab object is left to exist forever, simply unreferenced by any view's order array.
- **Conclusion, confirmed not inferred**: the frontend's own code **never** hard-deletes a DatabaseRow collab object server-side, in any code path. "Unlink" (remove from `row_orders`) and "hard delete of the collab object" are therefore not just separate operations — the latter **does not exist** anywhere in the real frontend contract. This resolves the brief's uncertainty explicitly, not by assumption.
- Both soft-delete and remove-from-view are **ordinary Yjs CRDT mutations of the Database doc**, synced over the **already-existing** generic Database WS admission path (`collabType === 1`, built unmodified by Task 61) — **zero new backend code was needed or written** for row deletion/unlink. This is additional confirmation of the brief's prediction that update-style operations reuse the generic pipeline; only *creation* (because of its atomicity/membership requirement) needed a dedicated endpoint.
- Hard deletion of the DatabaseRow collab object itself remains **explicitly out of scope** and **unimplemented**, per the brief's own instruction, and is now backed by positive evidence (not just caution) that the real frontend never requires it.

### 2.6 Row detail page relationship (confirmed; answers brief §E)

- A row's detail/"peek" page, when it has one, is a **separate `CollabType.Document`** object (confirmed: `rowDocumentIdFromRowId`/`ensureRowDocumentView` in `src/application/row-document/lifecycle.ts`, and the row-template graph builder).
- Its id is **deterministic**: `documentId = uuidv5('document_id', rowId)` (`row-template-graph.ts:76`, `uuid` package's `v5(name, namespace)` signature — `name = 'document_id'`, `namespace = rowId`'s own UUID bytes). Confirmed by the matching reverse-derivation helper `metaIdFromRowId(rowId)` (`const.ts:23-33`), which derives the row's own **meta-map key obfuscation** (icon/cover/document-id/is-document-empty) the same way, from the same per-row namespace.
- **Creation is lazy, not eager**: the `DefaultRowRequest` sent by this task's target workflow (plain "add row", no template) carries **no** document-content/document-id field at all — only `presentation: {icon_url, cover}`. The detail Document object is never created, referenced, or required by a plain row creation. It is only materialized when the user actually opens/edits the row's detail page (a separate, `CollabType.Document`-typed creation flow entirely, reusing the **existing**, Task-35-built atomic Document-creation machinery) or when trash-flow code (`useTrashAwareDeleteRowsDispatch`) probes `rowDocumentExists()` to decide soft- vs. hard-delete.
- A row created without ever opening its detail page (this task's entire real-browser verification workflow) functions completely normally: its `meta.isEmptyDocument` effectively reads as "empty" (an absent key defaults safely — see §4), and every downstream consumer (`getMetaJSON`, trash dispatch) treats that the same as an explicit `true`.
- **Not implemented, and not needed to be**: this task's row-creation endpoint never creates, reserves, or references a row-detail Document object. The existing Document implementation (Task 35/36 and later) was **not modified** — it did not need to be, and this is proven, not merely asserted, by the full `npm test` 38/38 regression plus the real-browser verification completing the entire mandatory workflow without ever touching a row's detail page.

### 2.7 Blob-diff endpoint (confirmed; answers brief §F — same conclusion as Task 61, re-verified)

`POST /api/workspace/{id}/database/{id}/blob/diff` appeared **twice** in this task's own fresh network log (`docs/task62-evidence/browser-run/network.log`), both still `404`, in the exact same places Task 61 already documented: once right after opening the database, once right after creating the row. Traced again to `collab-api.ts`'s `databaseBlobDiff()` (protobuf-based, `src/proto/database_blob`) — confirmed this task, via direct inspection of its call sites, that it is invoked as a best-effort secondary data-load optimization and its 404 **did not block, degrade, or alter** any step of this task's full create-row/edit-cell/reload/verify workflow. **Not implemented** — it concerns row/cell *blob* content (attachments), explicitly out of scope, consistent with Task 61's own conclusion. Recorded again here as a confirmed-still-deferred item, not a new finding.

### 2.8 Authorization (confirmed; answers brief §G)

- Row creation, reads, and WS admission all reuse the **existing** `requireWorkspace()` pattern unchanged (session-cookie/token-based workspace membership check), exactly like Document/Database.
- The permission-probe endpoint (`GET .../collab/{id}/permission?collab_type=`) was traced (`permissionProbe.ts`, `resolvePermissionProbeTarget()`) and confirmed to **never** target a DatabaseRow object directly — it only ever resolves to a Folder-tree view's own id with `collabType` either `Document` or `Database` (`src/components/app/layers/permissionProbe.ts:52-65`). Rows are not Folder-tree views and are never probed. **No new permission-probe branch was needed or added** — Task 61's two existing branches (`collab_type=0` for spaces, `collab_type=1` for Database objects) remain the complete, correct set; this was verified by source inspection, not assumed from "no errors in testing."
- Row-ordering updates (Database-doc mutations) are gated by the **existing** `collabType===1` WS admission branch's authorization (`store.getDatabaseCollab` workspace-scoped lookup), unchanged by this task.
- Row creation's own authorization: `requireWorkspace` + the parent Database must resolve via `store.getDatabaseCollab(workspace.id, databaseId)` (workspace-scoped, same as the existing Database read/WS paths) — an outsider or an unknown/foreign-workspace `databaseId` is rejected (403/404 respectively), tested explicitly (`test/database-row-collab.test.js`).

## 3. Architecture and implementation

### 3a. DatabaseRow initialization
New file `database-row-document.js`, `createInitialDatabaseRowCollab({rowId, databaseId, cells, height, visibility, timestamp, actorUid})` builds the exact Yjs shape from §2.3 using the real `yjs` package: root map `data` → key `data` (the row, aliasing `YjsEditorKey.database_row`) with `id`/`database_id`/`visibility`/`height`/`created_at`/`last_modified`/optional `created_by`/`last_edited_by`/`cells` (one `Y.Map` per provided field, scalar values copied verbatim from the request), plus an always-present but empty `meta` `Y.Map` (§2.3's "every consumer expects a real Y.Map" finding). Presentation (`icon_url`/`cover`) is validated by the server but **intentionally not persisted** into `meta` (documented limitation, §8) — implementing the exact UUIDv5 meta-key derivation server-side for a cosmetic, explicitly-secondary field was judged not worth the added surface for Phase 1's minimum workflow, especially since the frontend's own creation request never includes the row's actual document-emptiness flag either (§2.6) and the row functions correctly either way (an absent `meta` key is the frontend's own documented-safe default).

### 3b. DatabaseRow persistence
`storage.js`: new `emptyState()` keys `databaseRowCollabDocuments`/`databaseRowCollabUpdates`/`atomicRowCreationRequests` (sibling to Task 61's `databaseCollabDocuments` family, identical on-disk JSON shape). New store methods:
- `createAtomicDatabaseRow({workspaceId, databaseId, rowId, sourceViewId, position, rowCollab, request})` — the one genuinely new piece of logic this task required beyond Task 61's pattern: inside a **single** `mutate()` call (so persist-before-ack covers both halves atomically), it (a) checks a dedicated `atomicRowCreationRequests` idempotency table (`request_id`/`request_digest` dedupe, distinct from the Document/Database `atomicCreationRequests` table so the two concerns never cross-contaminate), (b) loads the parent Database's current persisted Y.Doc, validates `source_view_id` actually belongs to it, computes the row_orders insertion at the requested position, captures the resulting diff via `Y.encodeStateAsUpdate(doc, beforeStateVector)`, and writes the mutated Database state back, (c) creates the new `databaseRowCollabDocuments[rowId]` entry from the caller-supplied `rowCollab` (built by `createInitialDatabaseRowCollab`), (d) records the idempotency entry (including the stable `update_batch_id`, so a replay returns byte-identical results, not just an equivalent outcome). Uses its own dedicated `atomicRowCreationQueue`, distinct from `atomicCreationQueue` (Document/Database creation) and `databaseCollabUpdateQueue` (ordinary Database Yjs updates, e.g. field rename), so none of the three contend — same reasoning as Task 61's own queue-splitting.
- `getDatabaseRowCollab(workspaceId, rowId)` mirrors `getDatabaseCollab`, except its `collab_version` is always `null` (not a real version string) — see §3c for why.
- `acceptDatabaseRowCollabUpdate(...)` mirrors `acceptDatabaseCollabUpdate` exactly (same `preparePageCollabUpdate` generic Yjs validate/apply helper, reused unmodified from `postgres-collab-repository.js`; same payload-digest/messageKey idempotency; same per-workspace Rid allocator; same persist-before-return ordering via `mutate()`). Uses its own `databaseRowCollabUpdateQueue`.

No changes were made to `postgres-storage.js`/`postgres-collab-repository.js`.

### 3c. Why DatabaseRow reads carry no `collab_version`
`readCollabStates()` (collab-api.ts) maps a response's `collab_version` field through `?? undefined`, and `create-row.ts`'s fallback-read `decode()` function **requires** `result.collabVersion` to equal `undefined` for a `Types.DatabaseRow` read (`result.collabVersion !== (type === Types.Database ? version : undefined)`) — i.e. the frontend's own contract treats rows as **not having** an independent version-tracking concept the way Database objects do (which track a schema/collab version for restore verification, per Task 61). This task's `GET .../collab/{id}?collab_type=4` route therefore always returns `collab_version: null` (which `?? undefined` resolves to `undefined` client-side) — confirmed correct by this task's own passing tests and by the real browser's fallback-read code path actually executing during row creation (visible in `docs/task62-evidence/browser-run/network.log`: `GET .../collab/{rowId}?collab_type=4 -> 200` immediately follows the row-creation POST).

### 3d. Row creation integration (REST)
`server.js`, new route `POST /api/workspace/{id}/v2/database/{databaseId}/row/default`, placed immediately before Task 61's restore-state route. Validates: `schema_version`, `request_id`/`row_id` as UUIDs, `database_restore_id` must equal the fixed sentinel `00000000-0000-0000-0000-000000000000` (restore is out of scope — any other value is rejected, not silently accepted), `source_view_id` as a UUID (existence against the actual Database doc is checked inside the atomic storage operation, returning `VIEW_NOT_FOUND` → `400`), `cells` (a plain object whose keys must all be real field ids of the target Database — rejecting an unknown field id — and whose values must be JSON-safe, recursively checked up to depth 16, mirroring the frontend's own `check()` guard in `prepareDefaultRowRequest`), `height` (positive integer, capped at 100,000 — an invented-but-reasonable bound, not a verified upstream constant, documented as this task's own design choice), `visibility` (boolean), `position` (`start`/`end`/`before`+`row_id`/`after`+`row_id`, nothing else), `presentation` (shape-validated, content not persisted — §3a), and rejects any unsupported top-level field. The parent Database must exist and belong to the caller's workspace (`store.getDatabaseCollab`) before any row is created. On success, returns the exact `CreatedRowReceipt` shape from §2.2, with `database_update_v1` always present (the `activation` hint is never included — see §6) and `database_version` echoed from the Database object's own stored `collab_version` (not a separately-hardcoded constant, for correctness if that value ever changes).

### 3e. WebSocket admission for collabType=4
`server.js`: a new `if (collabMessage.collabType === 4) { ... }` branch, inserted **between** the end of the Database (`collabType === 1`) branch and the start of the WorkspaceDatabase (`collabType === 2`) gate — purely additive, touching neither. Mirrors the Database branch's `syncRequest`/`update`/`awarenessUpdate` handling exactly (same manifest/update frame shapes with `collabType: 4`, same persist-before-ack ordering via `store.acceptDatabaseRowCollabUpdate`, same 1008-vs-1011 close-code split, same per-workspace Rid allocator reuse). A row id that doesn't resolve via `store.getDatabaseRowCollab(workspaceId, objectId)` closes `1008 'DatabaseRow collaboration object is not authorized'`. This is the channel real cell edits travel over after a row is created — confirmed both by a dedicated backend test (ordinary `cells.set(fieldId, cellMap)` mutation, admitted generically) and by the real browser's own WebSocket log (`docs/task62-evidence/browser-run/websocket.log`: a live `ws://.../ws/v2/{workspaceId}/...` connection opens during the create-row step).

### 3f. Cell updates — confirmed generic, zero bespoke code
As predicted in the task brief and confirmed in §2.3/§2.5: `writeCellToRow`/`useUpdateCellDispatch` (`dispatch/cell.ts`) perform ordinary `Y.Map` mutations on an **existing** field's cell entry (or create a fresh per-field `Y.Map` the first time a cell gets a value), sent as a generic Yjs update over the `collabType=4` WS channel built in §3e. **No dedicated server-side cell-update code was written** — the generic admission path (§3e) is the entire implementation of "F." in the task brief, exactly mirroring Task 61's field-rename finding for the Database path. This was proven both by a dedicated backend test and by the real-browser workflow's own "enter a value in the Name field" step.

### 3g. Workspace catalog / discoverability
Confirmed (re-verified this task, not assumed from Task 61): rows are **not** discovered through the WorkspaceDatabase catalog (`collabType=2`) at all — a row is only ever reached by first opening its parent Database (via the existing Folder-tree mechanism, unchanged) and then reading its `row_orders` membership (§2.4). The WorkspaceDatabase write-block (`'Realtime update admission is not implemented'`) remains untouched, consistent with "reuse existing WorkspaceDatabase support, don't redesign it," same as Task 61's own conclusion.

## 4. DatabaseRow behavior

- **Identity/validation**: `row_id`, `request_id` must be valid UUIDs; `source_view_id` must be a valid UUID **and** must resolve to a real view inside the target Database's current Yjs state; `database_restore_id` must be the fixed sentinel (restore is out of scope, so no other value is ever valid); cell field ids must all belong to the target Database's own fields; unsupported/extra top-level request fields are rejected, not silently dropped.
- **Idempotency**: identical `request_id` + identical request body replays as `already_applied` with the **exact same** `{row_id, database_id, database_restore_id, database_version, database_update_v1, update_batch_id}` (including a stable `update_batch_id` — a bug caught and fixed during this task's own test-writing, see §5a); the same `request_id` with a different body is rejected `409 REQUEST_ID_REUSED`, identical convention to Document/Database creation.
- **Atomicity**: row creation and row_orders insertion are a single durable transaction — a persistence failure (fault-injection tested) produces neither effect; a partial state (row exists but not in any order, or vice versa) is structurally unreachable through this endpoint.
- **Ordering**: `start`/`end`/`before`/`after <row_id>` all implemented and tested; an `after`/`before` anchor not found in the single Phase-1 view falls back to append-at-end (a safe default; Phase 1 never exercises this case through the real frontend, since the frontend only ever targets the view it's currently showing, which always contains every row it already created).
- **Reads**: `GET /api/workspace/v1/{workspaceId}/collab/{rowId}?collab_type=4` mirrors Document/Database reads exactly, except `collab_version` is always `null` (§3c).

## 5. Testing evidence

Status vocabulary: Passed / Failed / Blocked / Not tested.

| Requirement | Test(s) | Command | Count | Evidence kind | Result |
|---|---|---|---|---|---|
| DatabaseRow doc initialization / correct Yjs shape / row identity / cell-map init | "valid request creates the row doc and inserts it into the parent Database row_orders" | `npm run test:database-row-collab` | 1 | Real JSON persistence, real `startServer` | **Passed** |
| Authenticated row creation | same test | `npm run test:database-row-collab` | 1 | Real HTTP | **Passed** |
| Unauthorized row creation rejection | "invalid/malformed requests and unauthorized/unknown identities are rejected" (no token, bad token, outsider) | `npm run test:database-row-collab` | 1 (3 sub-cases) | Real HTTP | **Passed** |
| Invalid parent-Database rejection | same test (unknown `databaseId` route) | `npm run test:database-row-collab` | 1 | Real HTTP | **Passed** |
| Invalid identifiers rejection | same test (bad `row_id`, bad/unknown `source_view_id`, bad `database_restore_id`, bad `height`, bad `visibility`, bad `position`, unknown field in `cells`, extra top-level field; plus a positive nested-but-safe-cell-value case) | `npm run test:database-row-collab` | 1 (9 sub-cases) | Real HTTP | **Passed** |
| DatabaseRow initial sync | "writing a cell over WebSocket updates..." (SyncRequest/manifest exchange) | `npm run test:database-row-collab` | 1 | Real WebSocket | **Passed** |
| DatabaseRow update persistence (generic Yjs cell write, no bespoke server code) | same test | `npm run test:database-row-collab` | 1 | Real JSON + real WebSocket | **Passed** |
| Duplicate/replayed update behavior | "duplicate/replayed update is admitted exactly once" | `npm run test:database-row-collab` | 1 | Real JSON + real WebSocket | **Passed** |
| Persistence failure without success ack (Task 44/61 pattern) | "no ack while persistence is pending..." (delayed) + "no ack and closes with 1011..." (failed) | `npm run test:database-row-collab` | 2 | Real JSON + fault-injected `store.persist` | **Passed** |
| Backend restart + row retrieval | "JSON store reconstructs the latest accepted state after a simulated backend restart, including row_orders membership" | `npm run test:database-row-collab` | 1 | Real JSON persistence, fresh `openStore()` | **Passed** |
| Row creation retry/idempotency | "duplicate request_id (retry) is idempotent" | `npm run test:database-row-collab` | 1 | Real HTTP | **Passed** |
| Row-order insertion | "row ordering respects start/end/after position" | `npm run test:database-row-collab` | 1 | Real HTTP + real JSON | **Passed** |
| Row id from another workspace rejected (WS) | "a row id from another workspace is rejected" | `npm run test:database-row-collab` | 1 | Real WebSocket | **Passed** |
| Unsupported collabType rejected (WS) | "unsupported collabType values are rejected, not silently admitted" | `npm run test:database-row-collab` | 1 (3 sub-cases) | Real WebSocket | **Passed** |
| Regression: existing Document collaboration | full `backend.test.js` suite | `npm test` | 38 | Real JSON + real WebSocket | **Passed** (38/38, matches baseline, unchanged) |
| Regression: existing Database collaboration (Task 61) | full `database-collab.test.js` suite | `npm run test:database-collab` | 13 | Real JSON + real WebSocket | **Passed** (13/13, matches baseline, unchanged — proves this task's additive WS/route changes did not disturb Task 61's path) |
| Regression: offline/collab | `offline-collab.test.js` | `npm run test:offline-collab` | 5 | Mixed, pre-existing, unchanged | **Passed** (5/5) |
| Regression: conformance | `collab-conformance.js` | `npm run test:collab-conformance` | — | Mixed, pre-existing, unchanged | **Passed** (6 passed/0 failed/2 pending/5 resolved) |
| Regression: Postgres (unaffected — no Postgres code touched) | `postgres.test.js` + 3 others | `npm run test:postgres` | 20 | Real Postgres (disposable local test DB) | **Passed** (20/20, run once since zero Postgres-affecting code changed) |

Total new backend tests this task: **11** (`test/database-row-collab.test.js`), all passing, all against real JSON persistence / real WebSocket frames (the only mock anywhere is the pre-existing, intentional `store.persist` fault-injection hook, reused verbatim from Task 44/61's pattern).

### 5a. Bugs found and fixed during this task's own test-writing (not pre-existing defects, not silently patched over)
1. **Test-helper bug** (not a production bug): the first draft of `createRow()` test helper spread an `overrides` object containing a camelCase `sourceViewId` key directly onto the wire request body, producing an extra unsupported top-level field and tripping the server's own (correct) "reject unsupported fields" validation. Fixed by destructuring `sourceViewId` out before spreading the rest. Evidence: initial test run failures (9/11 failing with `400`), root-caused via a standalone debug script reproducing the exact same request shape successfully, fixed, re-run clean (11/11).
2. **Real production bug, found by the idempotency test**: the route handler originally generated a **fresh** `update_batch_id` on every response, including `already_applied` replays — so a duplicate `request_id` request would return a *different* `update_batch_id` than the original, violating the "identical replay" contract (`validateReceipt()` on the frontend compares the whole result; while it doesn't currently assert `update_batch_id` equality byte-for-byte across replays, returning an inconsistent value for what should be the same committed operation is a real correctness defect, not just a cosmetic one). Fixed by generating `update_batch_id` once (passed into `createAtomicDatabaseRow`'s `request` parameter) and storing/returning it from the `atomicRowCreationRequests` idempotency record on replay, exactly like every other field in the result. Caught by this task's own `deepEqual` idempotency assertion before any code outside this task's own new test file was affected; re-run clean afterward. No pre-existing test's expectation was touched.

## 6. Real browser verification evidence

Environment: disposable backend (JSON mode, port **8801**, isolated data file under this session's scratchpad, `CORS_ALLOWED_ORIGINS` set for the dev Vite port), AppFlowy-Web's real Vite dev server (port **5201**, `APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL`/`APPFLOWY_WS_BASE_URL` pointed at the disposable backend, via `.env.local` — backed up before the run, restored byte-for-byte after), one dedicated test account registered via the real `/api/auth/register` endpoint. Headless Chromium via `@playwright/test`'s `chromium.launch()`. No mocked API, no fake Yjs server, no direct DB writes used to satisfy any step.

Script: `docs/task62-evidence/task62-browser-verify.mjs`; raw log: `docs/task62-evidence/browser-run/steps.log`; screenshots `01`–`12` in `docs/task62-evidence/browser-run/`.

Full per-step result (final successful run):
1. Register dedicated test account (real API) — **Passed**
2. Login via real UI — **Passed** (`01-login-filled.png`, `02-after-login.png`)
3. Open workspace — **Passed**
4. Create a public space via real UI — **Passed** (`03-after-space-step.png`)
5. Create a Grid database via the existing (Task 61) UI workflow — **Passed** (`04-after-closing-overlay.png`, `05-after-create-grid.png`)
6. Grid Database opens with its default Grid view and exactly one (primary) field — **Passed** (`06-grid-view-loaded.png`)
7. **Grid starts with zero rows** — **Passed** (explicit DOM assertion before row creation)
8. **Create a new row via the real "+ New row" UI button** — **Passed**, new row id captured by diffing the DOM before/after (`07-after-create-row.png`)
9. **Enter a value in the primary "Name" field's cell for the new row via the real UI** — **Passed** (`08-after-cell-value-typed.png`, `09-after-cell-value-committed.png`). **Mid-task discovery**: the primary field's editor is a Slate-based rich-text contenteditable (`data-testid="rich-text-cell-editor"`), not the plain `<textarea>` a static read of `TextCellEditing.tsx` in isolation would suggest (that component exists but is not what renders for this field in this build) — found only by driving the real browser and dumping the live DOM (`cell-debug-after-click.html`), not by guessing from source. The interaction was adjusted to click the editor and type via `page.keyboard.type()`.
10. Wait for the real collab/persistence flow to finish — **Passed**
11. Reload the page — **Passed** (`10-after-reload.png`)
12. Reopen the database — **Passed** (`11-after-reopen.png`)
13. **The created row still exists after reload+reopen** — **Passed**
14. **The entered cell value persisted after reload+reopen** — **Passed**, exact string match (`12-final-state.png` shows "Task 62 row value" in the Name column)

**All steps Passed.** This is the actual, unmodified AppFlowy-Web UI — no custom/mock/demo UI was built or substituted at any step. Row ordering with a single row is trivially correct by construction; the dedicated backend test (§5) covers multi-row ordering, which the mandatory browser workflow (a single new row) does not itself exercise — this is recorded as the honest scope of the browser evidence, not overstated.

### 6a. Supporting evidence (console/network/WebSocket)
`docs/task62-evidence/browser-run/network.log` shows, among the already-documented pre-existing harmless 404s (`add-recent-pages`, `workspace-profile`, `inline-comment`, `/api/error-messages`, `auth-providers`, `user/update`, `views?...` batch, `spaces/{id}/permission` — all previously documented in Task 55/56/61's reports, none new): `POST .../v2/database/{databaseId}/row/default -> 200`, `GET .../collab/{rowId}?collab_type=4 -> 200` (the fallback read, confirming it's genuinely exercised, not just unit-tested), `GET .../collab/{databaseId}?collab_type=1 -> 200` re-read after row creation (confirming the row_orders diff is visible server-side immediately). `docs/task62-evidence/browser-run/websocket.log` shows a live `ws://localhost:8801/ws/v2/{workspaceId}/...` connection opened during the row-creation/cell-edit steps. `POST .../database/{id}/blob/diff -> 404` reappears, consistent with §2.7 (confirmed-still-deferred, non-blocking).

### 6b. One new, non-blocking gap found during browser verification (documented, not silently worked around)
`console.log` shows `[error] [outbox] enqueue failed {objectId: <databaseId>, error: DexieError2}` with detail `{"name":"NotFoundError"}` (captured via an added verbose console-arg handler, confirmed reproducible on a second independent run with a fresh account/database/row). This did **not** appear anywhere in Task 61's evidence and was not present for any other object type exercised previously. Traced to `src/application/sync-outbox/index.ts`'s `enqueue()` function, reached from `createCloudRow()`'s `Y.applyUpdate(databaseDoc, databaseUpdate, CollabOrigin.Local)` step (create-row.ts:388-390) — applying the server-returned Database diff with a **local** Yjs origin triggers the frontend's own change-listener to durably queue the delta into IndexedDB (`db.sync_outbox`) before/alongside sending it over the already-open Database WebSocket channel, as a client-side durability safety net independent of this task's own server-side persistence. The IndexedDB write itself failed with Dexie's `NotFoundError` in this headless-Chromium test environment. **This is pre-existing, unmodified frontend code** (`sync-outbox/index.ts` was not touched by Task 61 or this task) — not a defect in this task's backend implementation. The frontend's own code already has a designed fallback for exactly this failure mode (`.catch()` branch: "IDB write failed (quota exhausted, upgrade blocked, etc.). Fall back through the CURRENT drain config's best-effort send"), and this task's real-browser verification confirms the fallback worked correctly: the row and its cell value were durably correct and persisted across reload in every run. **Not fixed** (modifying frontend production code is out of scope per the task's own safety rules, and this is pre-existing sync-outbox internals, not something Task 62 introduced); **not silently worked around** — recorded here with full reproduction evidence (`docs/task62-evidence/browser-run/console.log`) as a genuine, if non-blocking, observation for a future task to investigate if it ever proves user-visible (e.g. under real network/IndexedDB contention rather than this test harness's specific headless-Chromium IndexedDB behavior).

## 7. Regression assessment

| Suite | Command | Baseline | This task | Result |
|---|---|---|---|---|
| Backend core | `npm test` | 38/38 | 38/38 | Unchanged |
| Offline collab | `npm run test:offline-collab` | 5/5 | 5/5 | Unchanged |
| Collab conformance | `npm run test:collab-conformance` | 6/0/2/5 | 6/0/2/5 | Unchanged |
| Database (Task 61) | `npm run test:database-collab` | 13/13 | 13/13 | Unchanged — proves this task's additive WS branch/route/GET-type changes left the Database path fully intact |
| Postgres | `npm run test:postgres` | 20/20 | 20/20 (1 run; no Postgres code touched) | Unchanged |
| **DatabaseRow (new)** | `npm run test:database-row-collab` | n/a | **11/11** | New |

No existing test was weakened, deleted, or skipped, and (unlike Task 61) no pre-existing test's expected outcome needed to change at all this task.

## 8. Known limitations

- Row templates and row duplication (`POST .../v2/database/{databaseId}/row`, no `/default` suffix — `submit-template-row.ts`) are a separate, more advanced contract and are **not implemented**, as directed (out of scope).
- Row-detail Document pages (uuidv5-derived, lazy) are **not created or managed** by this task — a row created and edited through this task's workflow never has one, which is the correct, verified-safe default (§2.6); opening a row's detail page through the real UI was **not** exercised this task (not required by the minimum workflow, and the brief directs against implementing full row-detail editing unless essential — it isn't).
- Hard deletion of a DatabaseRow collab object is **not implemented** — confirmed (§2.5), not just deferred-out-of-caution, that the real frontend never requires it. Soft-delete/restore and remove-from-view are already fully functional today via the **existing**, Task-61-built generic Database WS admission path; no Task 62 code was needed for either.
- `presentation` (icon_url/cover) sent at row-creation time is validated but **not persisted** into the row's `meta` map (§3a) — a deliberately deferred, documented simplification; the row and its primary-field cell content are unaffected.
- `database_update_v1`'s optional sibling, `activation.row_encoded_collab_v1` (a Rust-`EncodedCollab`-shaped optimization avoiding a second round trip), is **not implemented** — the frontend's own fully-specified fallback (a second `GET .../collab/{id}?collab_type=` read) is used instead, and is exercised/tested in both the automated suite and the real browser run. A future task could add this as a pure optimization with no contract change.
- No WebSocket broadcast to *other* already-connected peers is sent when a row is created via REST — the creating client's own tab sees the new row immediately because it applies the REST response's diff directly into its own live Database doc (no WS round trip needed for that), but a second already-open tab/peer watching the same Database would only see the new row on its next reconnect/resync. This mirrors Task 61's own documented restore-broadcast limitation exactly, and is equally out of scope for a Phase-1 single-session verification workflow.
- Multi-view row ordering (`positionViewIds` fan-out) is unreachable and unimplemented, since Phase 1 databases always have exactly one view (Task 61's scope). A future multi-view task must implement this explicitly, not assume Task 62's single-view logic generalizes.
- PostgreSQL storage parity for any of the above is out of scope and not implemented — the JSON-mode additions (`databaseRowCollabDocuments`/`databaseRowCollabUpdates`/`atomicRowCreationRequests`) are structured as flat, generically-shaped sibling tables to the existing Document/Database ones specifically so a future Postgres-parity task has an obvious schema to mirror, but no Postgres schema or code was added.
- §6b's sync-outbox `NotFoundError` observation (frontend-only, pre-existing code, non-blocking, documented with reproduction evidence) remains unresolved; it is not this task's code and not this task's responsibility to fix, but is flagged for whichever future task next touches `sync-outbox/index.ts` or does broader IndexedDB-durability work.

## 9. Risks and follow-up

- The row-creation endpoint's atomicity (row + row_orders insertion in one `mutate()` call) is the one piece of genuinely new concurrency-sensitive logic this task added; it was fault-injection-tested (delayed and failed persistence) exactly like every other mutation path in this codebase, and proven not to produce a partial (row-without-membership or membership-without-row) state under those conditions. A future task adding concurrent-row-creation-under-load testing (many simultaneous creates on the same database) would add further confidence but was not required by this task's acceptance criteria and was not performed.
- §6b (sync-outbox `NotFoundError`) is worth a focused look by whichever future task next does real-browser verification of any row/database write path, to confirm whether it's specific to this headless-Chromium harness or a genuine environment-independent frontend defect — this task's evidence narrows it down (first observed on the row-creation `CollabOrigin.Local` apply path specifically) but does not conclusively diagnose the IndexedDB-level root cause.
- The `height` upper bound (100,000) and the depth-16 cap on nested JSON-safe cell values are this task's own invented, reasonable defensive limits, not verified upstream constants — a future task with access to real upstream Rust validation code should confirm or correct these.
- Row templates/duplication, row-detail Document management, and multi-view ordering are all clearly-signposted gaps for later phases, each requiring its own upstream-compatibility investigation before implementation — not an assumption that Task 62's silence implies safety for any of them.

## 10. Final status

**Complete.** All mandatory acceptance criteria pass with evidence:
- DatabaseRow contract documented (§2, source-traced, not guessed).
- Yjs structure verified (§2.3, §3a, backed by dedicated tests).
- Creation workflow matches the real frontend contract (§2.2, §3d, backed by both automated tests and real-browser network evidence).
- Retrieval/initial sync work (§3e, §5, §6).
- Updates persist, including the generic cell-edit path requiring zero bespoke server code (§3f, §5, §6).
- JSON persistence survives restart (§5, "JSON store reconstructs... after a simulated backend restart").
- Authorization verified (§2.8, §5).
- Row ordering implemented for the single-view case Phase 1 actually requires, with its scope explicitly and honestly bounded (§2.4, §8).
- Existing Database/Document functionality intact (§7 — all regression suites unchanged, including Task 61's own 13/13).
- All regression tests pass (§7); all new tests pass (§5, 11/11).
- Real-browser workflow verified end-to-end, including one honestly-documented non-blocking frontend-side observation rather than a silent workaround (§6, §6b).
- Documentation updated (this report plus the five append-only updates listed in §0's file list, applied immediately after this report).
- No pre-existing user changes/data lost (§0, confirmed via `git status` before/after comparison).
