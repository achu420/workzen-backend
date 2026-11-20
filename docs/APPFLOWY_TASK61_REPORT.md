# Task 61 — Grid database Phase 1 foundation (create / configure / reopen)

## 0. Scope and repo-state safety check (before any change)

The backend repository has **no `.git`** (confirmed again this task). "Current state" means files on disk, inspected directly. No commit/push is applicable here.

The frontend repository (`AppFlowy-Web`) **has** `.git`, with pre-existing tracked modifications and untracked files already present before this task started (`git status` at task start showed modified files such as `src/components/app/layers/AppBusinessLayer.tsx`, `src/components/app/view-actions/NewPage.tsx`, `vite.config.ts`, and untracked files such as `README_TESTING.md`, `dummy_user_credentials.js`, `tests/`, etc.). **None of these were touched.** The only frontend-repo file this task created was a temporary Playwright verification script (`task61-browser-verify.mjs`, repo root) and a temporary edit to `.env.local` (not tracked by git), both used only for Stage E browser verification and **removed/restored before finishing** (see §9, §13). No frontend production source file was modified.

Before starting, running processes/ports were inventoried: two pre-existing `node server.js` instances (ports 8791/8792) and a pre-existing Vite dev server (port 5190) were found already running, left over from outside this task. **None were touched, inspected beyond `lsof`, or stopped.** All new processes this task started used distinct, freshly-verified-free ports (backend 8799, Vite 5199) and were stopped by exact PID at the end (verified via `lsof -iTCP:<port>` immediately before and after each `kill`). Postgres: a pre-existing disposable database `appflowy_independent_test` (superuser-owned, already containing only this project's own tables) was reused for the Postgres regression suite; the commercial self-host stack and the host's other Postgres databases were never touched.

Files touched this task:
- **Created**: `database-document.js` (new Database collab-doc initializer, mirrors `page-document.js`), `test/database-collab.test.js` (new regression suite, 13 tests).
- **Modified**: `server.js` (new Database WS admission branch, new `v2/page-view/database/default` route, new `database/{id}/restore-state` route, extended the single-object collab-read route and the collab-permission route to recognize collab_type=1, extended the `view` route to surface real `layout`/`extra`/children for non-Document pages, extended `navigationNodeView`), `storage.js` (new `databaseCollabDocuments`/`databaseCollabUpdates` state, new `createAtomicDatabasePage`/`getDatabaseCollab`/`acceptDatabaseCollabUpdate` store methods), `test/backend.test.js` (one existing assertion updated — see §8), `package.json` (new `test:database-collab` script).
- **Not touched**: `postgres-storage.js`, `postgres-collab-repository.js`, `postgres-migration-lock.js`, any `migrations/*.sql`, `page-document.js`, `collab-protocol.js`, `workspace-database.js`, `auth.js`. No new external dependency was added.
- **Documentation**: this file, plus append-only updates to `docs/AGENT_HANDOVER.md`, `docs/MASTER_FEATURE_ROADMAP.md`, `docs/FEATURE_REGISTRY.md`, `docs/ARCHITECTURE_OVERVIEW.md`, `docs/TESTING_AND_ACCEPTANCE_STRATEGY.md`. New evidence directory `docs/task61-evidence/` (screenshots, console/network/websocket logs, the verification script itself, as run).

## 1. Executive summary

Task 61 implements the minimum Phase 1 foundation for a real AppFlowy Grid database through the **existing, unmodified** AppFlowy-Web frontend's actual Yjs/WebSocket contract, with durable JSON persistence. All mandatory acceptance criteria (A1–A14) pass with evidence. **Final status: Complete.**

The real frontend/upstream Yjs contract for a Database collab object (fields/views/metas shape, FieldType/DatabaseViewLayout/ViewLayout enum values, the atomic-creation REST request/response shape, the restore-state contract, and the exact Yjs mutations the existing "add property"/"rename property" UI performs) was independently re-verified against the actual checked-out `AppFlowy-Web` source (not assumed from Task 60's report) — see §2. Two genuine gaps were found and fixed beyond the originally-anticipated scope (collabType admission + atomic creation): the backend's existing single-object collaboration-**permission** endpoint only ever recognized Document pages, which silently hid the sidebar's only UI entry point for picking a non-Document layout (the inline "+" button next to a space, gated on a permission probe against the *space's own id*) and separately gated the Grid view's own field-menu UI (gated on a permission probe against the *database's own id*, collab_type=1). Without these two additive fixes, creating a Grid database through the real UI was unreachable — this was discovered by actually driving the real browser, not inferred, and is the clearest demonstration of why "REST contract looks right" is not sufficient evidence for this kind of task.

Backend test results: `npm test` 38/38 (baseline unchanged), `npm run test:offline-collab` 5/5 (unchanged), `npm run test:collab-conformance` 6 passed/0 failed/2 pending/5 resolved (unchanged), `npm run test:database-collab` **13/13 (new)**, `npm run test:postgres` 20/20 (unchanged; Postgres code was not touched at all).

Real browser verification: the full 17-step workflow (register → login via UI → open workspace → create space via UI → create Grid database via UI → confirm it appears → open it → confirm default Grid view → confirm initial field → add a field via UI → rename it via UI → wait for persistence → reload → reopen → verify database/view/original field/renamed field all survive) **passed end-to-end** against the real AppFlowy-Web dev server and a disposable real backend instance, with screenshots, console log, network log, and WebSocket-frame log captured at `docs/task61-evidence/`.

## 2. Contract verification (Stage A)

Verified directly against the checked-out `AppFlowy-Web` source (git HEAD at task start) rather than trusted from Task 60's report, which itself had flagged the Database Yjs shape as its single most load-bearing *unverified* item.

### 2.1 CollabType / enum values (confirmed, not assumed)
- `CollabType` (`src/application/types.ts`): `Document=0, Database=1, WorkspaceDatabase=2, Folder=3, DatabaseRow=4, UserAwareness=5`.
- `DatabaseViewLayout` (database-internal view layout, `types.ts:935`): `Grid=0, Board=1, Calendar=2, Chart=3, List=4, Gallery=5, Feed=6, Form=7, Timeline=8`.
- `ViewLayout` (Folder-side layout, `types.ts:509`): `Document=0, Grid=1, Board=2, Calendar=3, AIChat=4, Chart=5, List=6, Gallery=7, Feed=8, Form=9, Timeline=10`. **These are two distinct enums with different numeric values for the same concept** — a real hazard the frontend's own code comments flag explicitly; mixing them up makes `validateDatabase()`'s folder/database layout cross-check fail with a misleading error.
- `FieldType` (`database.type.ts`): 0–14 match upstream exactly (`RichText=0 … Media=14`); 15–19 (`Person, Rollup, CreatedBy, LastEditedBy, Formula`) are frontend-only, no upstream Rust counterpart. **Not resolved** (per task brief) — Phase 1 only ever creates/edits `RichText` (0) fields, matching exactly what the existing "default Grid" and "add basic property" UI actions use (confirmed in `dispatch.ts`, see below). This divergence is recorded as an open compatibility question for a later phase, not silently remapped.

### 2.2 Default Grid database creation — REST contract (confirmed from source, not a guess)
`src/application/services/js-services/http/page-default-creation.ts` (`prepareDefaultPage`) builds, and `atomic-creation-api.ts`/`atomic-creation/journal.ts` send:
```
POST /api/workspace/{workspaceId}/v2/page-view/database/default
{
  schema_version: "v1", request_id: "<uuid>", parent_view_id: "<uuid>",
  name: "", position: {kind:"start"|"end"},
  container_id: "<uuid>",
  database: {
    database_id: "<uuid>", view_id: "<uuid>", name: "Grid", layout: 0,
    embedded: false, responses_view_id: null,
    initial_row_ids: ["<uuid>","<uuid>","<uuid>"], timezone_id: null
  }
}
```
The frontend **never sends field or view definitions** — the server alone owns the initial Database shape. Response (validated by `atomic-creation/receipt.ts`): `{request_id, outcome:'applied'|'already_applied', result:{view_id: command.container_id, database_id: command.database.database_id}}` — identical envelope shape to the pre-existing Document atomic-creation route.

### 2.3 Required Yjs shape (confirmed from `types.ts` + `created-page-hydration.ts`'s `validateDatabase`, the actual acceptance check the frontend runs on every creation)
`doc.getMap('data').get('database')` → `YDatabase` (`Y.Map`):
- `id` (string) = database_id.
- `fields` (`Y.Map<FieldId, YDatabaseField>`); at least one field must have `is_primary === true`.
- `views` (`Y.Map<ViewId, YDatabaseView>`); for the primary `view_id` (and `responses_view_id` if present), a view entry must exist whose `.layout` (number/bigint) maps via a fixed `FOLDER_LAYOUTS` table back to the matching Folder child's own `ViewLayout`.
- `metas` (`Y.Map`) with `iid` = the inline view's id; that view's `row_orders` must be a real `Y.Array` (**may be empty** — rows are out of scope for Phase 1 and the frontend's own validator explicitly tolerates this).

`YDatabaseView` required keys (all must be real Y types, not `undefined`): `database_id, name, created_at, modified_at, layout, layout_settings(Y.Map), filters(Y.Array), groups(Y.Array), sorts(Y.Array), field_settings(Y.Map), field_orders(Y.Array<{id}>), row_orders(Y.Array<{id,height,is_deleted?}>), calculations(Y.Array), is_inline(bool), embedded(bool)`.

`YDatabaseField` keys: `id, name, ty (field_type), icon, type_option (Y.Map keyed by String(field_type)), is_primary, created_at, last_modified`.

Folder side: the container page (sidebar entry, `container_id`) needs `extra.is_database_container=true, extra.database_id`; the primary/inline view additionally needs its own Folder-tree **child** entry (`view_id = database.view_id`, parent = container) with `extra.database_id` and Folder `layout = ViewLayout.Grid (1)`.

### 2.4 Restore-state contract (confirmed; this is the one piece Task 60 could not have found, since it only exists in the frontend's creation-verification path, not in any Rust/upstream source)
`verifyCreatedPage` (`created-page-hydration.ts`) calls `GET /api/workspace/{workspaceId}/database/{databaseId}/restore-state` **twice**, unconditionally, for every database creation, and requires `restore.version` (a string) to equal the `collab_version` string returned by the Database collab read. Database restore itself is out of scope for Phase 1, so this is implemented as a fixed, always-consistent `{database_restore_id: null, version: DATABASE_COLLAB_VERSION}` response (§4).

### 2.5 Field add/rename — existing frontend dispatch code, not backend-invented (confirmed from `database-yjs/dispatch.ts`)
"Add property" (`useAddPropertyRightDispatch`/`useAddPropertyLeftDispatch`): new field id via `nanoid(6)`, always `FieldType.RichText (0)`, mutation `database.get('fields').set(newId, field)` + `view.get('field_orders').insert(...)`, applied to **every** view via `executeOperationWithAllViews`. "Rename property" (`useUpdatePropertyNameDispatch`): `field.set('last_modified', ...)` then `field.set('name', name)`. **Both are ordinary Yjs CRDT mutations sent as a generic Update message over the existing WebSocket protocol** — the backend does not need (and does not implement) any field-specific server logic; it only needs to admit, persist, and acknowledge the opaque binary diff, exactly like it already does for Document edits. This is the single most consequential finding of Stage A: Task 61's "C. Field/property operations" requirement is satisfied by the *generic* Database WS admission path (§3), not by any bespoke add-field/rename-field server code.

### 2.6 Caveats Task 60 flagged as unverified, and their resolution here
Task 60 explicitly could not confirm the exact `FilterMap`/`SortMap` type names, the full `DatabaseView` field list beyond what upstream Rust exposed, or whether the frontend's own read path matched upstream's Rust struct names exactly. All of these are now **directly confirmed from the frontend's own TypeScript types and its own `validateDatabase()` acceptance check** (§2.3), which is the actual acceptance contract per the task brief — not upstream Rust struct layout. Items genuinely irrelevant to Phase 1 (filters/sorts/groups *content*, row objects, non-Grid layouts) are left as empty `Y.Array`/`Y.Map` placeholders of the correct *type*, never populated with invented content.

## 3. Architecture and implementation

### 3a. Database collab-object admission (WebSocket)
`server.js`: a new `if (collabMessage.collabType === 1) { ... }` branch was inserted **between** the end of the existing Document (`collabType === 0`) branch and the start of the existing WorkspaceDatabase (`collabType === 2`) gate — purely additive, touching neither. It mirrors the Document branch's `syncRequest`/`update`/`awarenessUpdate` handling exactly: same manifest/update frame shapes (with `collabType: 1`), same persist-before-ack ordering, same 1008-vs-1011 close-code split on admission errors, same per-workspace Rid allocator reuse. A Database id that doesn't resolve via `store.getDatabaseCollab(workspaceId, objectId)` (wrong workspace, unknown id) closes `1008 'Database collaboration object is not authorized'`, mirroring the Document path's equivalent rejection.

### 3b. Database initialization
New file `database-document.js`, `createInitialDatabaseCollab({databaseId, viewId, name, primaryFieldId, timestamp})`, builds the exact Yjs shape from §2.3: one seeded primary `RichText` field named `"Name"`, one inline Grid view (`layout: 0`, empty `row_orders`/`filters`/`sorts`/`groups`/`calculations`, `field_orders` containing the primary field), `metas.iid` = the view id. Returns `{documentState, stateVector, collabVersion: 'appflowy-database-v1'}` exactly like `createInitialPageCollab` does for Documents.

### 3c. Field/property operations
No dedicated server-side add-field/rename-field code was written — see §2.5. The generic Database WS admission path (§3a) is the entire implementation of "C."

### 3d. Persistence
`storage.js`: new `emptyState()` keys `databaseCollabDocuments`/`databaseCollabUpdates` (sibling to the existing `pageCollabDocuments`/`pageCollabUpdates`, same on-disk JSON shape: `document_state`, `state_vector`, `generation`, `last_message_id`). New store methods mirror the Document equivalents field-for-field:
- `createAtomicDatabasePage(containerPage, primaryViewPage, databaseId, collab, request)` mirrors `createAtomicDocumentPage` — same `atomicCreationRequests` idempotency table (request_id/request_digest dedupe, `REQUEST_ID_REUSED`/`PAGE_EXISTS`/new `DATABASE_EXISTS` error codes), same `structuredClone` rollback-on-throw pattern, same shared `atomicCreationQueue` serialization.
- `getDatabaseCollab(workspaceId, databaseId)` mirrors `getPageCollab`.
- `acceptDatabaseCollabUpdate(...)` mirrors `acceptPageCollabUpdate` exactly: same `preparePageCollabUpdate` generic Yjs validate/apply helper (object-agnostic, already shared with Postgres code — reused unmodified), same payload-digest/messageKey idempotency, same per-workspace Rid allocator (`s.workspaceRids`), same persist-before-return ordering via `mutate()`. A dedicated `databaseCollabUpdateQueue` (distinct from `pageCollabUpdateQueue`) serializes Database updates independently of Document updates, so neither path can contend with or delay the other.

No changes were made to `postgres-storage.js`/`postgres-collab-repository.js`; the only cross-module dependency (`preparePageCollabUpdate`) was already generic/object-agnostic and needed no change.

### 3e. Workspace catalog integration
Confirmed directly from source (§2.3/§2.5 discovery) that the frontend does **not** require the client to write to the WorkspaceDatabase Yjs array (collabType=2) to discover a newly created database — discoverability runs entirely through the pre-existing Folder-tree (`GET .../view/{id}?depth=`) mechanism Task 35 already built for Document pages. The existing WorkspaceDatabase write-block (`'Realtime update admission is not implemented'`) was therefore **left untouched**, consistent with "reuse existing WorkspaceDatabase support, don't redesign it."

What *was* needed: the container page (the database's sidebar entry) and the primary view page (its Folder-tree child, required by `validateDatabase()`) are both ordinary records in the existing `store.pages` collection, reusing the exact same Folder-tree listing machinery Document pages already use. This required two small, additive fixes to the shared `view` GET route (§3f), since it previously only ever surfaced real `layout`/`extra`/children for *spaces*, not for arbitrary non-Document pages.

### 3f. Shared Folder-tree route fixes (additive, Document-safe)
`server.js`'s `GET /api/workspace/{id}/view/{id}` route, in the "space or page" (`else`) branch, previously: (a) hardcoded `layout: 0` and `extra: (space ? {is_space:true} : null)` for the queried view itself, discarding a page's own `.layout`/`.extra` fields entirely; (b) hardcoded `children: []` whenever the target was a page (only a space's children were ever actually listed). Both are now additive: `layout: page?.layout ?? 0` / `extra: page?.extra ?? null` (Document pages never set `.layout`, so this is a no-op for them — confirmed unchanged by the full 38/38 regression), and children are now computed for *any* page target, not just spaces, using the exact same listing code already used for spaces. The three other hardcoded-`layout: 0` sites that feed the *workspace-root* outline listing (`navigationNodeView`, the root `view` branch's nested space/page mapping) received the identical, narrowly-scoped `?? 0` fix for the same reason — all verified safe against the existing regression suite (§8).

### 3g. Permission-probe fixes (discovered via real browser verification, §9)
Two additive branches were added to the existing `GET /api/workspace/{id}/collab/{id}/permission?collab_type=` route:
- `collab_type=0` against a **space** id (not a Document page) now resolves instead of 404ing. AppFlowy-Web's own permission-probe design (`permissionProbe.ts`) treats this one endpoint generically as "permission for workspace folder view X", defaulting every non-Database view (including spaces) to `collab_type=0` — it is not strictly "permission for a Document collab object." This is the sole gate for the sidebar's inline "+" (add-page) button, the only UI entry point for picking a non-Document layout.
- `collab_type=1` against a **Database** id now resolves (previously this collabType value was rejected outright with 400). This is the gate for the Grid view's own field-menu UI actions (add/rename/etc.).

Both branches require the caller to be an authorized workspace member (reusing `requireWorkspace`), require the target id to resolve to a real, workspace-owned space/database (an unrelated/unknown id still 404s — not a loosened "anything goes" fallback), and are proven not to affect the pre-existing Document branch via both the full 38/38 regression and dedicated new tests (§7).

## 4. Database behavior

- **Scope**: Grid layout only (`database.layout` must be `0`); non-Grid layouts (`embedded: true`, any `responses_view_id`, Board/Calendar/etc.) are rejected `400 INVALID_ATOMIC_REQUEST`, matching the explicit out-of-scope list.
- **Identity/validation**: `container_id`, `database.database_id`, `database.view_id` must be valid UUIDs; `database.initial_row_ids` must be an array of valid UUIDs (accepted for shape validation, **never used** — rows are out of scope, so `row_orders` is seeded empty regardless of how many ids the frontend sent); unsupported/extra top-level or nested fields are rejected, not silently dropped; `parent_view_id` must be a real, authorized public space in the caller's workspace.
- **Idempotency**: identical `request_id` + identical request body replays as `already_applied` with the original `{view_id, database_id}`; the same `request_id` with a *different* body is rejected `409 REQUEST_ID_REUSED` (identical convention to Document creation).
- **restore-state**: always `{database_restore_id: null, version: 'appflowy-database-v1'}` once the database exists; `404 COLLAB_NOT_FOUND` otherwise.

## 5. Testing evidence (Stage C/D)

Status vocabulary used below: Passed / Failed / Blocked / Not tested.

| Requirement | Test(s) | Command | Count | Evidence kind | Result |
|---|---|---|---|---|---|
| Database object initialization (fields/view/metas shape) | "valid request initializes fields, inline Grid view, and metas" | `npm run test:database-collab` | 1 | Real JSON persistence (disposable temp file, real `startServer`) | **Passed** |
| Valid admission through WS dispatch | "add a field and rename it over WebSocket updates" + the init test's own sync | `npm run test:database-collab` | 2 | Real JSON + real WebSocket frames | **Passed** |
| Invalid object-type rejection | "unsupported collabType values are rejected, not silently admitted" (collabType 3, 4, 99) | `npm run test:database-collab` | 1 (3 sub-cases) | Real WebSocket | **Passed** |
| Missing/invalid database identity | "invalid/malformed requests are rejected" (missing container_id, malformed database_id, unsupported layout, embedded=true, extra field) | `npm run test:database-collab` | 1 (6 sub-cases) | Real HTTP | **Passed** |
| Workspace authorization | same test (outsider/unauthenticated) + "a database id from another workspace is rejected" | `npm run test:database-collab` | 2 | Real HTTP + real WebSocket | **Passed** |
| Initial metadata persistence | "valid request initializes..." + "JSON store reconstructs..." | `npm run test:database-collab` | 2 | Real JSON persistence | **Passed** |
| Initial field persistence | "valid request initializes..." | `npm run test:database-collab` | 1 | Real JSON persistence | **Passed** |
| Default Grid view persistence | "valid request initializes..." | `npm run test:database-collab` | 1 | Real JSON persistence | **Passed** |
| Add field | "add a field and rename it..." | `npm run test:database-collab` | 1 | Real JSON + real WebSocket; **also** real-browser (§9) | **Passed** |
| Rename field | "add a field and rename it..." | `npm run test:database-collab` | 1 | Real JSON + real WebSocket; **also** real-browser (§9) | **Passed** |
| Duplicate/replayed update behavior | "duplicate/replayed update is admitted exactly once" | `npm run test:database-collab` | 1 | Real JSON + real WebSocket | **Passed** |
| Persistence-failure/ACK behavior (Task 44 pattern) | "no ack while persistence is pending..." (delayed) + "no ack and closes with 1011..." (failed) | `npm run test:database-collab` | 2 | Real JSON + fault-injected `store.persist` | **Passed** |
| Restart/reopen reconstruction | "JSON store reconstructs the latest accepted state after a simulated backend restart" | `npm run test:database-collab` | 1 | Real JSON persistence, fresh `openStore()` against the same on-disk file | **Passed** |
| Workspace catalog registration/lookup | "workspace catalog / Folder-tree discoverability" | `npm run test:database-collab` | 1 | Real HTTP | **Passed** |
| Space-permission-probe fix | "Space permission probe: ... resolves for a space" | `npm run test:database-collab` | 1 | Real HTTP | **Passed** |
| Database-permission-probe fix | "Database permission probe: ... resolves for a Database object" | `npm run test:database-collab` | 1 | Real HTTP | **Passed** |
| Existing Document collaboration regression | full `backend.test.js` suite | `npm test` | 38 | Real JSON + real WebSocket (mocks only where pre-existing, e.g. fault injection via `store.persist` override) | **Passed** (38/38, matches baseline) |
| Existing backend/offline regression | `offline-collab.test.js` | `npm run test:offline-collab` | 5 | Mixed (mock-protocol-level, pre-existing suite, unchanged) | **Passed** (5/5, matches baseline) |
| Existing conformance regression | `collab-conformance.js` | `npm run test:collab-conformance` | — | Mixed (pre-existing suite, unchanged) | **Passed** (6 passed/0 failed/2 pending/5 resolved, matches baseline) |
| Postgres regression (unaffected — no Postgres code touched) | `postgres.test.js`, `postgres-collab.test.js`, `postgres-version-history.test.js`, `postgres-migration-lock.test.js` | `npm run test:postgres` (`RUN_POSTGRES_TESTS=1 DATABASE_URL=postgresql://achal@127.0.0.1:5432/appflowy_independent_test`) | 20 | Real Postgres (disposable pre-existing local test database, superuser-owned, this project's own tables only) | **Passed** (20/20, matches baseline). Run **once** this task (not 5×, as Task 59's own run was) since zero Postgres-affecting code changed — the earlier 5-run confirmation stands undisturbed. |

Total new backend tests this task: **13** (`test/database-collab.test.js`), all passing, all against real JSON persistence / real WebSocket frames (no mocked collab-object persistence; the only mock anywhere is the pre-existing, intentional `store.persist` fault-injection hook, reused verbatim from Task 44's own pattern).

### 5a. Regression discovered and fixed mid-task (not a new defect introduced silently)
Extending the single-object collaboration-read endpoint to accept `collab_type=1` caused one **pre-existing** test assertion (`"AppFlowy-Web reads the persisted workspace database collaboration object"`, `test/backend.test.js`) to fail: it asserted `collab_type=1` against the WorkspaceDatabase object id returned `400` (the old "entirely unsupported type" behavior). Since Task 61's own in-scope change is "collabType=1 is now a generally supported type," the correct fix was to update that one assertion to expect the new, correct `404` ("right type, now-recognized, but this particular object isn't a Database") rather than `400`, and to **add** a replacement assertion using a still-genuinely-unsupported type (`collab_type=3`, Folder) to preserve the original test's actual intent (confirm unsupported types are rejected) without weakening coverage. This is the only change made to any pre-existing test's expected outcome, and it is a direct, documented consequence of an explicitly in-scope change — not a defect introduced by this task. See the diff in `test/backend.test.js` around the `"AppFlowy-Web reads the persisted workspace database collaboration object"` test.

## 6. Playwright evidence (Stage E)

Environment: disposable backend (JSON mode, port **8799**, isolated data file under this session's scratchpad, `CORS_ALLOWED_ORIGINS` set for the dev Vite port), AppFlowy-Web's real Vite dev server (port **5199**, `APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL`/`APPFLOWY_WS_BASE_URL` pointed at the disposable backend, both as `.env.local` and exported shell env vars per the established convention — `vite.config.ts` reads `process.env` directly), one dedicated test account registered via the real `/api/auth/register` endpoint. Headless Chromium via `@playwright/test`'s `chromium.launch()`. No mocked API, no fake Yjs server, no direct DB writes used to satisfy any step.

Full per-step result (script: `docs/task61-evidence/task61-browser-verify.mjs`; raw log: `docs/task61-evidence/browser-run/steps.log`; screenshots `01`–`15` in `docs/task61-evidence/browser-run/`):

1. Register dedicated test account (real API) — **Passed**
2. Login via real UI (email → password flow) — **Passed** (`01-login-filled.png`, `02-after-login.png`)
3. Open workspace — **Passed** (`03-workspace-loaded.png`)
4. Create a public space via real UI ("New Page" → "create new space" → name → submit) — **Passed** (`04-create-space-filled.png`, `05-after-space-step.png`)
5. **A1 — create a Grid database via existing UI** (hover space row → inline "+" → "Grid" in the layout-picker dropdown) — **Passed** (`07-add-page-menu-open.png`, `08-after-create-grid.png`)
6. **A2/A3 — database appears and opens** (URL navigates to the new view) — **Passed**
7. **A3 — default Grid view loads** (DOM: `[data-testid^="grid-field-header-"]` present) — **Passed**, field count=1 (`09-grid-view-loaded.png`)
8. **A4 — initial fields match the verified contract** (one primary field, matching §2.3/§3b) — **Passed** (DOM assertion on field ids)
9. **A5 — add a field via real UI** (click "+ New property") — **Passed**, new field id captured, total fields=2 (`10-after-add-field.png`)
10. **A6 — rename a field via real UI** (reopen the new field's header menu, retype its name) — **Passed**, renamed to `"Task 61 Status"` (`11-after-rename-field-typed.png`, `12-after-rename-field-committed.png`)
11. Wait for the real collab/persistence flow to finish — **Passed** (explicit wait + independent network/WS evidence, §6a)
12. Reload the page — **Passed** (`13-after-reload.png`)
13. Reopen the database — **Passed** (`14-after-reopen.png`)
14. **A7 — database/field state persists after reload** — **Passed**
15. **A8 — reconstructed state matches**: DOM assertion after reload shows both the original primary field (`"Name"`) and the renamed field (`"Task 61 Status"`), exactly two fields, nothing lost or duplicated — **Passed** (`15-final-state.png`, and `docs/task61-evidence/browser-run/steps.log`'s final line)

**All 17 steps (register, login, workspace, space, A1–A8 inclusive of their sub-steps, reload, reopen) Passed.** This is the actual, unmodified AppFlowy-Web UI — no custom/mock/demo UI was built or substituted at any step.

### 6a. Supporting evidence (console/network/WebSocket)
`docs/task61-evidence/browser-run/network.log` shows, among the already-documented pre-existing harmless 404s (`add-recent-pages`, `workspace-profile`, `inline-comment`, `/api/error-messages`, `auth-providers` — all previously documented in Task 55/56's reports, none new): `POST .../v2/page-view/database/default -> 200`, `GET .../database/{id}/restore-state -> 200` (×2, matching §2.4's two-call contract), `GET .../collab/{id}?collab_type=1 -> 200`, `GET .../collab/{id}/permission?collab_type=1 -> 200` (confirming §3g's fix is live and exercised, not just unit-tested). `docs/task61-evidence/browser-run/websocket.log` shows a real WebSocket connection opened to `ws://localhost:8799/ws/v2/{workspaceId}/...` during the add-field/rename-field steps (the actual live channel the field mutations traveled over). `docs/task61-evidence/browser-run/console-errors.log` contains only the already-documented pre-existing harmless 404s; **no new, unexplained console error appeared**.

### 6b. One new, non-blocking gap found (documented, not fixed — out of scope)
`POST /api/workspace/{id}/database/{id}/blob/diff -> 404` appeared twice in the network log. Traced to `collab-api.ts`'s `databaseBlobDiff()` — a protobuf-based database blob-diff endpoint, unrelated to the core Yjs sync path, evidently used for an optional/secondary data-loading optimization (its 404 did not block or visibly degrade any of the 17 steps). Not implemented — it concerns row/cell content, which is explicitly out of scope for Phase 1. Recorded in the roadmap as a follow-up item.

## 7. Regression assessment

| Suite | Command | Baseline | This task | Result |
|---|---|---|---|---|
| Backend core | `npm test` | 38/38 | 38/38 | Unchanged (one assertion updated per §5a, net test count and pass rate identical) |
| Offline collab | `npm run test:offline-collab` | 5/5 | 5/5 | Unchanged |
| Collab conformance | `npm run test:collab-conformance` | 6 passed/0 failed/2 pending/5 resolved | 6/0/2/5 | Unchanged |
| Postgres | `npm run test:postgres` | 20/20 (5 runs, Task 59) | 20/20 (1 run; no Postgres code touched) | Unchanged |
| **Database (new)** | `npm run test:database-collab` | n/a | **13/13** | New |

No existing test was weakened, deleted, or skipped. The one pre-existing assertion that changed expected outcome is documented in §5a with its exact justification (a direct, intended consequence of this task's own in-scope contract expansion, with replacement coverage added in the same edit).

## 8. Known limitations

- Rows (DatabaseRow collab objects), row creation/ordering/content, and anything cell-related remain entirely out of scope and unimplemented, as directed. `row_orders` is a real but permanently-empty `Y.Array` for every database created by this task's code path.
- Only Grid (`DatabaseViewLayout.Grid = 0` / `ViewLayout.Grid = 1`) is supported; Board/Calendar/Gallery/Chart/List/Feed/Form/Timeline creation requests are rejected `400`.
- Multiple views per database, filters/sorts/groups *content*, field settings *content* beyond the correct empty container types, relations/rollups/formulas/Person/CreatedBy/LastEditedBy fields: not implemented (frontend-only FieldType values 15–19 remain an open, unresolved compatibility question, as directed — not silently remapped).
- `GET /api/workspace/{id}/database` (the workspace-wide database-listing stub) still returns `{databases: [], has_more: false}` unconditionally — confirmed not required for this task's workflow (discoverability runs through the Folder tree instead, §3e), but any future feature that actually reads this listing (e.g. a relation-field database picker) will need it implemented.
- `POST .../database/{id}/blob/diff` (§6b) is unimplemented; confirmed non-blocking for Phase 1's workflow, unknown whether later row/cell work will need it.
- Database restore/version-history is out of scope; `restore-state` always reports "no restore has ever happened."
- PostgreSQL storage parity for any of the above is explicitly out of scope for this task and not implemented; the JSON-mode storage additions (`databaseCollabDocuments`/`databaseCollabUpdates`) were structured as flat, generically-shaped sibling tables to the existing Document ones specifically so a future Postgres-parity task has an obvious, low-ambiguity schema to mirror (new tables analogous to `collab_documents`/`collab_updates`), but no Postgres schema or code was added.

## 9. Risks and follow-up

- The two permission-probe fixes (§3g) were discovered only by actually driving a real browser — a reminder that REST-contract-level testing alone would not have caught them, and that any future Database-adjacent feature (e.g. multi-view support) should budget time for an equivalent real-browser pass before declaring the REST/WS contract sufficient.
- The Folder-tree `view` route fixes (§3f) touch code shared with Document pages' outline rendering; although proven safe by the full regression suite and by direct reasoning about the `?? 0` fallback being a no-op for every existing Document page, any future task that further modifies this route should re-run the full `npm test` suite specifically watching the outline/navigation-related tests.
- `database_restore_id`/database version-history is a clearly-signposted gap for a later phase; the current always-`null` response is safe only because nothing in Phase 1 ever mutates it — a future restore feature must not assume the current restore-state contract's simplicity carries over unchanged.
- The frontend-only FieldType values (15–19) remain unresolved; a later phase introducing Person/Rollup/CreatedBy/LastEditedBy/Formula fields needs its own upstream-compatibility investigation before implementation, not an assumption that Phase 1's silence implies safety.

## 10. Final status

**Complete.** All mandatory acceptance criteria A1–A14 pass with evidence:
- A1–A8: real-browser Playwright evidence, §6, plus backend test evidence, §5.
- A9 (persist-before-ACK): automated fault-injection tests, §5 ("Persistence-failure/ACK behavior" row), both success and failure paths.
- A10 (invalid/unauthorized updates rejected): automated tests, §5 ("Missing/invalid database identity", "Workspace authorization" rows).
- A11 (existing Document collaboration regression): `npm test` 38/38, §7.
- A12 (existing backend/offline/conformance regressions): §7, all unchanged.
- A13 (no unrelated frontend/backend changes): §0 file-change review; the only frontend-repo artifacts this task created (`task61-browser-verify.mjs`, a temporary `.env.local` edit) were removed/restored before finishing, confirmed via `git status` showing only the same pre-existing modifications/untracked files that existed before this task started.
- A14 (documentation/handover updated): this report plus the five append-only updates listed in §0.
