# Task 53: Resolve backend API incompatibilities blocking the AppFlowy-Web sidebar

## Summary

Four routes 404'd against the independent backend: `GET .../favorite`, `GET
.../trash`, `GET /api/sharing/workspace/{id}/view/{id}`, and `GET
.../database`. All four were implemented, backed by real storage (JSON and
PostgreSQL), tested, and verified end to end in a real browser session. The
sidebar now loads completely with no 404s on these paths, a workspace space
can be created, and favorites/trash are genuinely functional (not just
non-erroring placeholders).

## Part A — Frontend contract findings

Read from `AppFlowy-Web/src/application/services/js-services/http/view-api.ts`,
`page-api.ts`, `access-api.ts`, and `services.type.ts`.

| Endpoint | Method | Response shape | Blocking? |
|---|---|---|---|
| `/api/workspace/{id}/favorite` | GET | `{ views: View[] }` | `Favorite.tsx` calls `loadFavoriteViews()` unawaited in a `useEffect` on mount; a 404 leaves favorites permanently empty/erroring but does not itself hang the outline. |
| `/api/workspace/{id}/trash` | GET | `{ views: View[] }` | Drives `trashList`, which `AppBusinessLayer.tsx` uses to detect "has this page been deleted" routing; a 404 leaves trash permanently empty. |
| `/api/sharing/workspace/{id}/view/{id}?depth=50` | GET | `View` (full tree) | `useWorkspaceData.ts` `loadOutline()` already wraps this call in `.catch(() => null)` — confirmed **already non-blocking**; it only degrades the "shared with me" hidden space. |
| `/api/workspace/{id}/database` | GET | `{ databases: WorkspaceDatabaseWithViews[], has_more: boolean }` (`services.type.ts`) | Paginated catalog consumed by `workspace-database-catalog.ts`; failure propagates as a rejected promise to callers, but is not on the critical outline-load path either. |

Related write endpoints the frontend already expects at matching paths (found
in `page-api.ts`): `POST .../page-view/{id}/favorite`, `POST
.../page-view/{id}/move-to-trash`, `POST .../page-view/{id}/restore-from-trash`,
`DELETE .../trash/{id}`. These were not in the original confirmed-404 list but
without them `GET .../favorite` and `GET .../trash` would be permanent dead
ends (nothing could ever populate them), so they were added using the same
`is_favorite` column that migration 002 had already added to `pages` but that
no route ever read or wrote.

## Part B — Backend capability matrix

| Endpoint | Existing route elsewhere? | Storage support already present? | Minimal implementation feasible? | Action taken |
|---|---|---|---|---|
| Favorite | No | Partial — Postgres `pages.is_favorite` column existed (migration 002) but unused by any route; JSON store had no equivalent field | Yes | Implemented: `GET/POST` routes, JSON (`storage.js`) and Postgres (`postgres-storage.js` + new migration 006) backing. |
| Trash | No | No — no soft-delete concept on pages in either backend | Yes, additive | Implemented: `GET/DELETE/move-to-trash/restore-from-trash`, backed by new `is_trashed`/`trashed_at` fields (JSON + migration 006). |
| Sharing/shared-with-me view | No (`/api/sharing/...` prefix did not exist at all) | No — no per-view grant/invitation data model exists anywhere in this backend | Partial — client already degrades gracefully; a real sharing feature (grants, invitations) is a separate substantial feature, not implemented | Implemented a **minimal honest stub**: an authenticated, workspace-scoped empty view tree ("nothing has been shared with you yet"), not a fabricated sharing capability. Actual share-granting (`sharePageTo`, `getSharedGroups`, etc.) remains unimplemented and is a separate blocker (see below). |
| Database catalog | No | No — only a per-workspace placeholder `WorkspaceDatabase` Yjs doc used for the collab-type check; no rows/fields/database-view data model | Honest minimal response only: `{ databases: [], has_more: false }` | Implemented as an honest empty catalog. Creating/reading actual database-type pages is unimplemented and reported as a separate blocker (see below). |

## Part C — Implementation

**Backend (`AppFlowy-Independent-Backend`):**
- `storage.js`: added `setPageFavorite`, `listFavoritePages`, `setPageTrashed`, `listTrashedPages`, `deletePagePermanently` (JSON store), additive fields on the existing page record (`is_favorite`, `is_pinned`, `favorited_at`, `is_trashed`, `trashed_at`) — same pattern as the Task 49A version-history additions, no new top-level collections.
- `postgres-storage.js`: mirrored the same five methods against real SQL; extended `rowPage`/`PAGE_COLUMNS` to read/write the new columns; **fixed a preexisting migration-list omission** — new migration files were never picked up because `postgres-storage.js` lists migration filenames explicitly rather than globbing the directory; added `006_favorites_trash.sql` to that list.
- `migrations/006_favorites_trash.sql` (new, additive): adds `is_pinned`, `favorited_at`, `is_trashed`, `trashed_at` columns and two partial indexes.
- `server.js`: added routes (all workspace-authorized via the existing `requireWorkspace` helper, matching the project's standard 401/403/404 behavior):
  - `GET /api/workspace/{id}/favorite`
  - `POST /api/workspace/{id}/page-view/{id}/favorite`
  - `GET /api/workspace/{id}/trash`
  - `DELETE /api/workspace/{id}/trash/{id}` (permanent delete; rejects with 409 if the view isn't actually in the trash — no fabricated success)
  - `POST /api/workspace/{id}/page-view/{id}/move-to-trash`
  - `POST /api/workspace/{id}/page-view/{id}/restore-from-trash`
  - `GET /api/sharing/workspace/{id}/view/{id}` (honest empty tree)
  - `GET /api/workspace/{id}/database` (honest empty catalog)

**Deliberately not implemented** (reported as separate blockers rather than faked):
- Bulk `delete-all-pages-from-trash` / `restore-all-pages-from-trash` — minor, not required to unblock the sidebar; single-item trash operations cover the verified contract.
- Any real sharing/collaborator-invitation feature (`sharePageTo`, `getSharedGroups`, access-level grants) — would require a new per-view-grant data model; out of scope for "unblock the sidebar."
- Any real database-type page (rows/fields/database views) — would require a substantial new collaborative data model (AppFlowy's Grid/Board/Calendar), not a 404 fix; out of scope.

## Part D — Automated tests

Added one test to `test/backend.test.js`: *"Task 53: favorites, trash,
shared-with-me and database catalog unblock the AppFlowy-Web sidebar"*,
covering per the required matrix:
- Unauthenticated → 401 on all four GETs.
- Unauthorized workspace (a registered outsider with no membership) → 403 on all four, not leaking another workspace's data.
- Successful request → each returns real, correctly-shaped data (empty initially).
- Favorite toggle makes a page appear/disappear from the favorite list with `favorited_at`/`is_pinned` populated.
- Invalid resource: favoriting/trashing a nonexistent view-id → 404; permanently deleting a view not currently in trash → 409 (not silently accepted).
- Trash → restore → re-trash → permanent delete lifecycle, verified via the list endpoint at each step.
- Persistence: favorite state on a page survives a full server restart against the same JSON file (same pattern as the existing "data survives reopening the application" test).

JSON-storage coverage: the new backend test (37 tests total, was 36; all pass).
PostgreSQL coverage: **structurally exercised directly against a real,
disposable PostgreSQL 15 container** (`task53-pg`, port 55433 — distinct from
Task 50's `task50-pg:55432`, which was never touched), calling
`openPostgresStore` and running `setPageFavorite`/`listFavoritePages`/
`setPageTrashed`/`listTrashedPages`/`deletePagePermanently` directly against
real SQL; confirmed correct round-tripping of `is_favorite`, `favorited_at`,
`is_trashed`, `trashed_at`, and correct deletion. The container was torn down
after verification (`docker rm -f task53-pg`); this was ad hoc verification,
not added as a permanent CI suite (this project's existing Postgres parity
convention, per Task 49A, is "code-reviewed/structurally verified," which this
exceeds by actually running it).

## Part E — Real browser verification (Playwright + Chromium, JSON backend)

Ran backend (`STORAGE=json`, isolated data file, `CORS_ALLOWED_ORIGINS` set for
the dev frontend origin) and AppFlowy-Web's real Vite dev server
(`APPFLOWY_BASE_URL`/`APPFLOWY_WS_BASE_URL`/`APPFLOWY_DEV_API_PROXY_TARGET`/
`APPFLOWY_DEV_WS_PROXY_TARGET` all pointed at the isolated backend — the two
env-var families Task 39's report already identified as both required).
Registered a fresh dedicated test account via the real `/api/auth/register`
API, then logged in through the real UI.

| Step | Result |
|---|---|
| Login | PASS — real UI login completed, landed on workspace. |
| Workspace loading | PASS — "My Workspace" sidebar header rendered. |
| Favorites/sidebar loading | PASS — `GET .../favorite` returned real `200` (confirmed via network capture), no console error for this route. |
| Trash loading | PASS — `GET .../trash` returned real `200`. |
| Sharing-view behavior | PASS — `GET /api/sharing/workspace/.../view/...` returned real `200` (previously 404). |
| Database catalog loading | PASS — `GET .../database` returned real `200` with the honest empty-catalog shape. |
| Sidebar/page outline genuinely usable | PASS — "Search", "New page", and a functioning space-creation modal are present and interactive, not just non-erroring; a real space ("Task53 Space") was created and persisted server-side (confirmed in the JSON data file) and appeared in the sidebar after reload. |
| Open an existing document | **Not reached** — no pre-existing document existed to open in a fresh account; see below. |
| Create a document | **Blocked by an unrelated, pre-existing issue**, not a Task 53 regression — see below. |
| Edit and reload content | **Not reached**, same reason. |

**Unrelated issue observed (not caused by this task, not fixed by this task):**
clicking a newly created space triggers `GET
/api/workspace/{id}/view/{spaceViewId}?depth=1`, which the browser reports as
`net::ERR_FAILED`. Verified by hand with `curl` using the exact same URL,
method, and `Origin` header immediately after creating an equivalent space:
the backend returns a correct `200` with full CORS headers. This means the
failure is a client-side request cancellation (consistent with
`useWorkspaceData.ts`'s extensive stale-request-abort bookkeeping reacting to
the rapid click/hover sequence from a scripted test), not a backend contract
gap, and not one of the four endpoints in scope for this task. It is reported
here as an observation, not fixed, per the instruction to stop and report
rather than chase unrelated scope. A slower, human-paced interaction would
likely not trigger it; this should be revisited if it reproduces outside
scripted automation.

Screenshots and console/network logs were captured locally during the run
(sidebar fully rendered with the created space, confirmed via
`/tmp/task53-02d-after-reload-with-space.png`) but were not committed as
repository artifacts.

## Part F — Regression

- `npm test`: **37/37 pass** (36 pre-existing + 1 new Task 53 test). No existing test was weakened.
- `npm run test:offline-collab`: **5/5 pass**, unchanged.
- `npm run test:collab-conformance`: **6 passed, 0 failed, 2 pending (compaction-retention, cross-instance-replay), 5 resolved** — identical to the pre-Task-53 baseline; not touched.
- `task50-pg` was never started, stopped, or queried. The commercial AppFlowy self-host Docker stack was never touched.

## Remaining blockers / unimplemented scope (explicitly deferred, not faked)

1. **Real sharing/collaborator feature** (invite by email, access-level grants, revoke) — `access-api.ts`'s `sharePageTo`, `getSharedGroups`, `sharePageToGroup`, `revokeAccess`, etc. all target `/api/sharing/...` or `/api/workspace/.../views/{id}/group` routes that still don't exist. Only the read-only "shared with me" tree got a (honestly empty) minimal implementation. A real implementation needs a new per-view grant data model — a separate task.
2. **Real database-type pages** (Grid/Board/Calendar collaborative views) — no rows/fields/views data model exists; `GET .../database` is honestly empty because no database can exist in this backend yet, not because of a response-shape bug.
3. **Bulk trash operations** (`delete-all-pages-from-trash`, `restore-all-pages-from-trash`) — not implemented; only single-item operations, which were sufficient to satisfy the verified frontend contract for unblocking the sidebar.
4. **Observed but out of scope**: the `net::ERR_FAILED` on a space's `view?depth=1` request during rapid scripted interaction (see Part E) — confirmed not a backend bug via direct `curl` reproduction; flagged for whoever owns frontend request-cancellation logic, not fixed here.
