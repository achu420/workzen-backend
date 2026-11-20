# Task 64: real workspace Database catalog, and the fresh-session navigation gap — FINAL REPORT

**Status: Complete.**

## 1. Executive summary

Task 63 found that `GET /api/workspace/{workspaceId}/database` unconditionally returned a hardcoded `{ databases: [], has_more: false }` in both JSON and PostgreSQL storage modes, and traced this as the root cause of a 404 when a user who did not personally just create a Database in their own browser session (a fresh login, or a second real workspace member's first visit) tries to open it. Task 64 replaced the stub with a real, read-only, storage-mode-agnostic derivation from existing `pages` records, exactly as Task 63 recommended.

**Fixing the catalog alone was confirmed, by actually running the real two-browser-context test Task 63 could not, to be necessary but NOT sufficient.** A second, previously-masked gap in the exact same cold-open path — `GET /api/workspace/{id}/page-view/{viewId}`, AppFlowy-Web's generic "cold-fetch this view's collab bytes" route, used for ANY view layout whenever no local cache exists — required a Document collab object that a Database page never has, producing a fatal "Page not found" even after the catalog fix. This was invisible in every prior single-session test (Task 61/62/63's own, and this task's own creator-session Scenario A) because the creating client always already had the Database cached locally from its own atomic-creation response, and never needed to cold-fetch it. Both fixes together, not either alone, make the primary acceptance outcome true: a user who did not create a Database can discover and open it through the real UI.

Both fixes are implemented, tested (33 new automated tests across JSON/Postgres/parity, all passing, zero regressions), and real-browser-verified end to end in BOTH storage modes, including a completely independent second browser context as a genuinely separate workspace member, a real backend-process restart, and regression checks. All required automated test suites pass. All 4 real-browser scenarios pass in both storage modes (8/8).

## 2. Initial repo/environment state

- Backend (`AppFlowy-Independent-Backend`) is not a git repository (filesystem boundary at `/Volumes`); no git status to record. File timestamps before this task: `server.js` (last modified by Task 63, 2026-11-06 00:40/00:41), `storage.js`/`postgres-storage.js` (Task 63), `package.json` (Task 63).
- Frontend (`AppFlowy-Web`) git status at task start: on `main`, up to date with `origin/main`, pre-existing uncommitted changes to 12 tracked files and several untracked files (test scaffolding, `.env.local`, `package-lock.json`, etc.) — all pre-existing, none touched by this task, none in this task's diff.
- `.env.local` MD5 at task start: `c85de40fc13dc3b2379325c6ecc3471d`. Backed up before every temporary edit and restored byte-for-byte (MD5-verified) after every browser-verification run — confirmed in evidence logs.
- Disposable PostgreSQL: `appflowy_independent_test` (owner `achal`, same OS user, 189 user rows at task start — consistent with "shared disposable test database" reused across many prior tasks, re-verified via `pg_get_userbyid`, not touched destructively). A second, newly created disposable database `appflowy_task64_browser` was used exclusively for PostgreSQL-mode real-browser verification and dropped at the end of this task. The commercial AppFlowy Postgres stack was never touched or connected to.
- Ports verified free before use: 8910/5310 (JSON-mode browser run), 8920/5320 (Postgres-mode browser run). No pre-existing process was stopped; no port was reused without a fresh `lsof` check.

## 3. Route and frontend contract findings (inspected directly, not assumed)

### 3a. The hardcoded stub

`server.js` (before this task), the `GET /api/workspace/{workspaceId}/database` handler:

```js
return send(res, 200, appFlowyResponse({ databases: [], has_more: false }), { 'cache-control': 'private, no-store' });
```

Identical in JSON and PostgreSQL storage modes (both paths reach the same `server.js` route; only `store` differs).

### 3b. The real frontend contract (traced from source, not guessed)

- `src/application/services/js-services/http/view-api.ts`: `getWorkspaceDatabaseListPage(workspaceId, offset, limit=200)` calls `GET /api/workspace/{id}/database?offset=&limit=`, and `listWorkspaceDatabases` loops it until an empty page or `has_more` is false.
- `src/application/services/services.type.ts`: the exact response shape is `{ databases: WorkspaceDatabaseWithViews[], has_more: boolean }`, where `WorkspaceDatabaseWithViews = { database_id, views: WorkspaceDatabaseViewItem[] }` and `WorkspaceDatabaseViewItem = { view_id, layout, is_container, embedded, name, icon, parent_view_id }`.
- `src/application/services/js-services/workspace-database-catalog.ts`: a full client-side cache/catalog layer (`refreshWorkspaceDatabaseCatalog`, `getDatabaseIdFromWorkspaceCatalog`, `getViewIdFromWorkspaceCatalog`, `getDatabaseContainerEntries`) already exists and is fully wired to this exact endpoint, with an IndexedDB positive-cache fallback — confirming the frontend expects this endpoint to be real and server-authoritative, not optional.
- `src/components/app/hooks/useDatabaseIdentity.ts`: `getDatabaseIdForViewId`/`getViewIdFromDatabaseId` call the catalog as their fallback whenever a Database's identity cannot be resolved from an already-synced Yjs doc or from the Folder tree's own `extra.database_id` — exactly the situation a fresh session is in.
- `src/components/app/layers/AppBusinessLayer.tsx` (comment, verified in context): "The catalog is PostgreSQL-first on the server and uses legacy metadata only as its compatibility fallback" — confirming the real app's own expectation that the server catalog is authoritative.

### 3c. The second gap (found by tracing the actual cold-open path, not guessed)

- `src/application/view-loader/index.ts`, `fetchAndApply`: calls `fetchPageCollab(workspaceId, viewId)` (→ `GET /api/workspace/{id}/page-view/{viewId}`) for ANY view with no cache, UNLESS `options.databaseMetadataOnly && options.databaseId` — a flag only ever set by secondary relation/rollup/form lookups (`useRelationData.ts`, `rollup/cache.ts`, `formula/materialize.ts`, `FormBuilderView.tsx`, etc.), never by a view's own primary/cold load (`useViewOperations.ts` lines ~260-271).
- `src/application/services/js-services/http/collab-api.ts`, `getPageCollab`: expects `{ view: View, data: { encoded_collab: number[], row_data: {...} } }` — a generic "this view's collab bytes" contract, not Document-specific by name.
- `server.js`'s `page-view` route (before this task) always called `store.getPageCollab(...)` (Document collab only) and 404'd with `COLLAB_NOT_FOUND` for any page with no Document collab — which every Database container/primary-view page is, by design (Task 61: they only ever have a `databaseCollabDocuments`/`database_collab_documents` entry).

## 4. Root cause (confirmed, not assumed)

1. The catalog stub (`GET .../database`) always empty → `getDatabaseIdFromWorkspaceCatalog`/`getViewIdFromWorkspaceCatalog` always miss for any session without a locally cached Yjs doc already carrying the identity.
2. Even once (1) is fixed and the Database is discoverable and its identity resolvable, the SAME cold-open path still calls `GET .../page-view/{viewId}` to fetch the content, and that route, independently of (1), never served Database content — only Document content.

Both (1) and (2) are storage-mode-agnostic (identical bug in JSON and PostgreSQL mode before this task).

## 5. Implementation

### 5a. Catalog (fix for root cause 1)

- New file `database-catalog.js`: pure function `buildDatabaseCatalogFromPages(pages)`. Rule: a container is any page with `extra.is_database_container === true` and a validly-UUID-shaped `extra.database_id`; its primary view is the (first, by `created_at`/`id`) Folder-child page (`parent_view_id === container.id`) whose own `extra.database_id` matches. Returns `[{ database_id, views: [...] }]` sorted by container `(created_at, id)`.
  - **Malformed-metadata handling (deliberate choice)**: a container with an invalid/missing `database_id` is excluded — it cannot be a usable entry — but this never affects any other container (each is evaluated independently). A container with no matching primary view is still INCLUDED, with just its one `is_container: true` view, rather than silently dropped — `getDatabaseContainerEntries` on the frontend already excludes an entry with no primary view from the "openable" list without needing the raw catalog to hide it. A candidate child page whose `extra.database_id` does not match its parent container's is never selected as that container's primary view.
- `storage.js`: `store.listWorkspaceDatabaseCatalog = async (workspaceId) => buildDatabaseCatalogFromPages(await store.listPages(workspaceId))`.
- `postgres-storage.js`: `listWorkspaceDatabaseCatalog: (wid) => withClient(...)` — same SQL `SELECT`/columns as the existing `listPages`, fed through the same shared `buildDatabaseCatalogFromPages`. No new migration (migration 007's `pages.extra`/`pages.layout` already fully support this read, confirmed by direct query, not assumed).
- `server.js`'s `GET .../database` route: calls `store.listWorkspaceDatabaseCatalog(access.workspace.id)`, then applies real `offset`/`limit` pagination (defaults `offset=0`, `limit=200`, matching the frontend's own default; validated as integers, `limit` capped at 1000, invalid values → `400 INVALID_PAGINATION`), with a real `has_more`.

### 5b. `page-view` cold-fetch fix (fix for root cause 2)

`server.js`'s `GET .../page-view/{viewId}` route: when the page carries a string `extra.database_id`, serves `store.getDatabaseCollab(workspaceId, databaseId)`'s bytes instead of requiring `store.getPageCollab(...)` (a Document collab). No new storage method — `getDatabaseCollab` already existed from Task 61. Also fixed `view.layout`, previously hardcoded to `0` regardless of the page's real Folder layout (harmless for Documents, wrong for a Database's Grid layout `1`) — now `page.layout ?? 0`, matching the convention already used elsewhere in this file.

### 5c. A genuine JSON/Postgres parity gap found and fixed (in scope, narrowly)

While writing malformed/orphan/decoy test fixtures directly against both storage backends, found that `postgres-storage.js`'s generic `createPage` only ever persisted 9 of the `pages` table's columns, silently dropping `parent_view_id`/`icon`/`extra`/`is_favorite`/`position`/`layout` — invisible before now because its only production caller (`POST /api/workspaces/{id}/pages`) never sets those fields. Fixed to persist the same fields JSON mode's `createPage` already kept verbatim (a plain JS object). This was necessary to write equivalent test fixtures in both modes for the catalog's defensive-handling tests; it is in-scope because it directly serves this task's JSON/Postgres parity requirement, not an unrelated expansion.

## 6. JSON/Postgres parity evidence

- `test/json-postgres-parity.test.js`: new test runs a fixed sequence (2 well-formed databases created out of chronological order, 1 malformed container, 1 orphan container, 1 decoy mismatched child) against a disposable JSON store and a disposable Postgres store with identical client-supplied ids, and asserts the derived catalogs are byte-for-byte identical (`assert.deepEqual`) — confirmed passing, diagnostic output shows identical JSON for both.
- `test/postgres-database-catalog.test.js` mirrors every JSON-mode scenario in `test/database-catalog.test.js` at the HTTP layer against a real PostgreSQL-backed server.
- Both storage modes pass identical real-browser scenarios (see §9).

## 7. Authorization/isolation findings

- The catalog route reuses `requireWorkspace` unchanged (bearer-token auth → membership lookup → 403 `WORKSPACE_FORBIDDEN` if absent/nonmember), exactly like every other workspace-scoped route in this file. No new authorization code was added; none was needed.
- Workspace scoping is enforced twice: once at `requireWorkspace` (membership check before any data is touched) and again structurally (`listWorkspaceDatabaseCatalog`/`listPages` only ever query rows for the resolved `access.workspace.id`, never the caller-supplied raw path segment after that resolution).
- Verified with automated tests: unauthenticated (no token) → 401; authenticated but not a member of the target workspace → 403; a Database created in workspace A never appears in workspace B's catalog (cross-workspace isolation); a caller-supplied database id is never trusted without the containing page's own `workspace_id` match (inherent in the derivation — it only ever reads pages already scoped to the resolved workspace).
- **Discovered, deliberately NOT fixed, pre-existing, unrelated to this task**: a non-UUID-formatted workspace id in the URL path returns `500 INTERNAL_ERROR` in PostgreSQL mode (native `uuid` column cast failure inside `requireWorkspace`'s `getWorkspace` lookup) instead of JSON mode's `403`. Reproduced directly (see §12). This affects `requireWorkspace`, used by nearly every route in `server.js`, not specifically the catalog route — fixing it would mean auditing every caller file-wide, well outside this task's scope. Flagged here and in the docs updates, not silently worked around or quietly avoided in tests (the JSON-mode test suite does exercise this exact case; the Postgres-mode suite deliberately only exercises a well-formed-but-nonexistent workspace id, to avoid conflating this pre-existing, unrelated gap with the feature under test).

## 8. Pagination behavior

The frontend's real, actual contract (`getWorkspaceDatabaseListPage`) sends `offset`/`limit` query parameters and loops until an empty page or `has_more: false`, with a default `limit` of 200 — this is a real, used contract, not an invented one. Implemented exactly that: `offset` (default 0) and `limit` (default 200, max 1000) as query parameters, validated as non-negative/positive integers (invalid → `400 INVALID_PAGINATION`), windowing over the DATABASE list (not the view list), with `has_more` computed from the real remaining count and stable `(created_at, id)` ordering verified to be identical across repeated identical requests.

## 9. Automated test results

| Suite | Command | Result |
|---|---|---|
| JSON backend regression | `npm test` | **38/38 Passed** (baseline unchanged) |
| Offline collab prototype | `npm run test:offline-collab` | **5/5 Passed** (unchanged) |
| Database collab (JSON) | `npm run test:database-collab` | **13/13 Passed** (unchanged) |
| DatabaseRow collab (JSON) | `npm run test:database-row-collab` | **11/11 Passed** (unchanged) |
| Conformance harness | `npm run test:collab-conformance` | **6 passed / 0 failed / 2 pending / 5 resolved** (unchanged) |
| **Database catalog (JSON, new)** | `npm run test:database-catalog` | **17/17 Passed** (new) |
| Real-Postgres integration | `npm run test:postgres` (8 files; `appflowy_independent_test`) | **43/43 Passed** (prior 27 + new 12 catalog/page-view tests, within which migration-lock is **10/10 Passed**, unchanged) |
| JSON/Postgres parity | `npm run test:parity` | **2/2 Passed** (prior Database/DatabaseRow sequence + new catalog-derivation parity test) |

No existing assertion was weakened, rewritten, or deleted to force a pass. No regression in any pre-existing suite.

## 10. Real-browser verification — all 4 scenarios × 2 storage modes

Shared Playwright script: `docs/task64-evidence/task64-browser-verify.mjs` (parameterized by `MODE`/`BACKEND_PORT`/`FRONTEND_PORT`/`DATA_FILE`|`DATABASE_URL`/`EVIDENCE_DIR`). Headless Chromium (`chrome-headless-shell`). Evidence (steps log, screenshots, per-session console/network logs, `results.json`, catalog response JSON) under `docs/task64-evidence/json-mode/` and `docs/task64-evidence/postgres-mode/`.

| Scenario | JSON mode | PostgreSQL mode |
|---|---|---|
| A — creator's own session (register, space, Grid Database, 2 rows, reload persists) | **Passed** | **Passed** |
| B — fresh/independent second browser context, second real member, discovers via real catalog endpoint, opens via real sidebar UI, sees both rows + values, reload remains discoverable/openable (**the critical scenario**) | **Passed** | **Passed** |
| C — real backend-process restart (same disposable storage), re-authenticate, catalog still returns the Database, opens with both rows intact | **Passed** | **Passed** |
| D — regression: Space still renders, pre-existing Database still opens, a brand-new Document can be created and opens, a brand-new second Grid Database can be created and opens | **Passed** | **Passed** |

**8/8 scenario/mode combinations passed.** Scenario B specifically: a second user, registered independently, added to the first user's workspace via the existing supported test-membership helper (not a bypass of authorization), in a Playwright `BrowserContext` sharing no cookies/localStorage/IndexedDB with the creator's context, successfully: (1) confirmed via a direct API call that `GET /api/workspace/{id}/database` returns the real Database to them; (2) saw the Database's sidebar entry render in the real Folder tree; (3) clicked it and the real Grid view loaded with both of the creator's rows and their exact text values (`"Task64 {mode} row one"`/`"Task64 {mode} row two"`); (4) reloaded their own browser context and it remained discoverable and opened successfully again.

Backup/restore discipline followed exactly as Task 61-63: `.env.local` backed up (MD5-verified) before each temporary edit and restored byte-for-byte (MD5-verified) after; disposable backend processes started/killed by exact PID via `lsof -tiTCP:{port} -sTCP:LISTEN`; disposable PostgreSQL database (`appflowy_task64_browser`) created fresh and dropped at the end; no pre-existing process, port, or service was touched.

One real debugging note worth recording for the next agent: three browser-script FAILURES encountered while iterating were test-script artifacts, not product regressions, each confirmed by cross-checking the exact screenshot the failing assertion was taken from — (1) a fresh login lands a user in their OWN default workspace, requiring an explicit navigation to the shared workspace under test; (2) a Space's child pages only render in the DOM once expanded (clicking the Space row itself, not just hovering for the "add page" button); (3) Playwright's `isVisible({timeout})` does not itself wait/retry (only `waitFor`/action methods do) — a check immediately after a fixed `waitForTimeout()` can read `false` moments before a modal settles. All three were script fixes, confirmed with zero backend code change required for them.

## 11. Screenshot/log locations

- `docs/task64-evidence/task64-browser-verify.mjs` — the shared Playwright script (both modes).
- `docs/task64-evidence/json-mode/` — 13 screenshots (`01-...png` through `13-...png`), `steps.log`, `results.json`, per-session `console-errors-*.log`/`network-*.log`, `scenario-b-catalog-response.json`.
- `docs/task64-evidence/postgres-mode/` — same set, PostgreSQL mode.

## 12. Files changed

- `database-catalog.js` — **new**. Shared catalog-derivation logic (`buildDatabaseCatalogFromPages`).
- `storage.js` — added `store.listWorkspaceDatabaseCatalog`.
- `postgres-storage.js` — added `listWorkspaceDatabaseCatalog`; extended `createPage` to persist `parent_view_id`/`icon`/`extra`/`is_favorite`/`position`/`layout` (parity fix, §5c).
- `server.js` — replaced the hardcoded `GET .../database` stub with the real route (pagination included); fixed `GET .../page-view/{viewId}` to serve Database collab content for Database pages and to report the page's real `layout` instead of a hardcoded `0`.
- `package.json` — added `test:database-catalog` script; added `test/postgres-database-catalog.test.js` to `test:postgres`.
- `test/database-catalog.test.js` — **new**, 17 tests (JSON mode, HTTP-level).
- `test/postgres-database-catalog.test.js` — **new**, 12 tests (PostgreSQL mode, HTTP-level).
- `test/json-postgres-parity.test.js` — added one new parity test (catalog derivation).
- `docs/task64-evidence/` — **new** directory (Playwright script, screenshots, logs, both storage modes).
- `docs/TASK64_DATABASE_CATALOG_AND_FRESH_SESSION_NAVIGATION_REPORT.md` — this file.
- `docs/AGENT_HANDOVER.md`, `docs/MASTER_FEATURE_ROADMAP.md`, `docs/FEATURE_REGISTRY.md`, `docs/ARCHITECTURE_OVERVIEW.md`, `docs/TESTING_AND_ACCEPTANCE_STRATEGY.md`, `docs/DATABASE_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md` — appended Task 64 sections, all prior content preserved.

No file was deleted. No pre-existing test was weakened. No migration was added (none was needed — proven by this task's own tests running successfully against the existing migration 007 schema). Task 59's migration-lock implementation was not touched.

## 13. Known limitations

- **Real-time content broadcast still does not exist for ANY collab type** (Task 63's finding, re-confirmed by this task, unchanged, explicitly out of scope per this task's own brief). A second client that is ALREADY connected while a change happens will only observe it on its own next reconnect/`SyncRequest`, never live. This task only fixes DISCOVERY and OPENING of an existing Database from a fresh/second session — it does not add live propagation to an already-open second session.
- **PostgreSQL mode returns 500 instead of 403 for a syntactically-invalid (non-UUID) workspace id** in the URL path — pre-existing, `requireWorkspace`-wide (not specific to the catalog route), deliberately not fixed (§7).
- Multiple Database views, row-detail Document lifecycle, advanced field types, filters/sorts/groups/formulas/relations, Database history/restore, and blob/attachment support (`POST .../database/{id}/blob/diff` 404s, confirmed via network log, pre-existing, unimplemented) all remain out of scope and unimplemented, exactly as the brief specifies.
- The "We couldn't find this content" toast occasionally visible in browser screenshots is caused by separate, pre-existing, unimplemented routes (`/api/user/update`, `/api/workspace/{id}/workspace-profile` — both 404, confirmed via console/network logs) used for member-profile/timezone hydration — unrelated to the Database catalog or page-view fixes, cosmetic only (confirmed the Grid itself renders real data correctly despite it), not fixed (out of scope).

## 14. Security / data-integrity assessment

- No new authentication or authorization code was written; the catalog route reuses the exact same `requireWorkspace` pattern as every other workspace-scoped route, with automated tests proving unauthenticated/non-member access is rejected and cross-workspace data never leaks.
- The catalog derivation is strictly read-only — it creates no new pages, no new collab objects, and mutates no state. Verified by code inspection (no `mutate()`/`withClient` write call anywhere in `database-catalog.js` or the new `listWorkspaceDatabaseCatalog` methods) and by the fact that every new test that inspects the catalog after injecting fixtures observes exactly the fixtures it wrote, nothing more or less.
- The `page-view` fix only ever reads an already-existing Database collab's bytes for a page that already legitimately carries that `database_id` in its own `extra` field (written only by the existing, authorization-checked atomic-creation route) — it introduces no new way to read a Database's content that wasn't already reachable via the pre-existing `GET /collab/{id}?collab_type=1` route for an authorized workspace member.
- No secrets, credentials, or PII are involved in or exposed by either fix.

## 15. Explicitly deferred work (per the brief, unchanged)

Real-time content broadcasting/WebSocket redesign, DatabaseRow sync changes, multiple database views, row-detail Document lifecycle, advanced field types, filters/sorting/grouping/formulas/rollups/relations, database history/restore, blob/attachment implementation, a new auth system, a new CRDT/protocol, general Folder-tree redesign, unrelated frontend UI redesign.

## 16. Final status and recommendation

**Status: Complete.** All completion criteria from the task brief are met: the catalog is no longer hardcoded-empty; Databases are discoverable in both JSON and Postgres modes with equivalent logical results (proven byte-for-byte via the parity test); container-to-primary-view association is correct (tested, including malformed/orphan/decoy-mismatch defensive cases); workspace authorization/isolation is verified; existing Document/Folder-tree behavior is intact (regression tests pass in both automated suites and both browser-verification runs); a fresh browser session can open an existing Database through the real UI (Scenario B, both modes); a second authorized user can open the same Database through the real UI (Scenario B, both modes); the Database remains discoverable after a real backend restart (Scenario C, both modes); all regression suites pass with no unexplained regression; documentation and evidence are complete; no pre-existing data, service, or unrelated file was damaged.

**Recommended next task**: Phase 2 of the Database architecture plan (additional database views / Grid-specific per-view settings) is the natural next step now that creation, discovery, and cold-open are all proven working in both storage modes. Alternatively, if a future task's brief specifically calls for it, beginning the real-time content-broadcast work this and Task 63 both found is entirely absent for every collab type — but that is a larger, separate undertaking and should be scoped as its own task, not folded into Phase 2.
