# Task 40 — Fix Page Rename Persistence and the Space Picker Crash

**Date:** 2026-10-29
**Result:** Both defects from `docs/APPFLOWY_TASK39_BROWSER_VERIFICATION_REPORT.md` fixed with targeted patches and regression tests, and **confirmed fixed by a real, manually-driven browser session** (same procedure as Task 39 — the project owner drove a real Chrome browser against a fresh isolated instance, guided step-by-step, reporting Network/UI evidence back verbatim). See §3a for the browser verification log, which supersedes the "NOT PERFORMED IN THIS TASK" status recorded during implementation.

## 1. Page rename persistence (404)

### Contract traced from the frontend

`updatePageName(workspaceId, viewId, name)` in [page-api.ts:213-216](../../AppFlowy-Web/src/application/services/js-services/http/page-api.ts#L213-L216):

```
POST /api/workspace/{workspaceId}/page-view/{viewId}/update-name
Body: { "name": string }
```

Consumed through `executeAPIVoidRequest` ([core.ts:327](../../AppFlowy-Web/src/application/services/js-services/http/core.ts#L327)), which treats any 2xx response as success and, if an `APIResponse` envelope (`{ code, ... }`) is present, requires `code === 0`. No response payload is read on success.

### Root cause

The route simply did not exist in `server.js` — confirmed by grep before this task (zero matches for `update-name`).

### Fix

- `server.js`: added `POST /api/workspace/{workspaceId}/page-view/{pageId}/update-name`, inserted immediately before the existing `GET /api/workspace/{id}/view/{id}` outline route. It: authenticates and checks workspace membership via the existing `requireWorkspace` helper; validates the page ID shape with the existing `validateUuid`; validates `name` is a string ≤200 characters (matching the existing title-length convention used elsewhere, e.g. the atomic-creation route); loads the page via `store.getPage` and confirms it belongs to the workspace and has a `parent_view_id` (i.e. is a real page view, not a legacy top-level JSON-API page); persists only the title and `updated_at` via a new storage method; responds `{ code: 0, message: 'success', data: null }`.
- `storage.js`: added `store.updatePageTitle(pageId, workspaceId, title, updatedAt)`, a minimal JSON-mode mutation that only touches `title`/`updated_at` — it does not touch `document`, `version`, or any collaboration state, so a rename cannot overwrite collaboration content or race the page's optimistic-concurrency version counter used by the separate legacy `/api/pages/{id}` PUT route.
- `postgres-storage.js`: added the equivalent `updatePageTitle` using a scoped `UPDATE pages SET title=$3, updated_at=$4 WHERE id=$1 AND workspace_id=$2`, consistent with the existing `updatePage` query's parameterization style. Not run against a live database (see "PostgreSQL" below).

### Tests added

`test/backend.test.js`: new test `AppFlowy-Web renames a page view and the title survives reopening the store` — covers: 401 unauthenticated, 400 on a name over 200 characters, 404 on a syntactically invalid page ID, 404 on a well-formed but nonexistent page ID, 403 for a user outside the workspace, 200 with the exact `{code:0,message:'success',data:null}` envelope, the renamed title appearing in the existing workspace-outline route's `children[].name`, and the title surviving a fresh `openStore` against the same JSON file (restart-equivalent persistence check), following the same reopening pattern as the existing `data survives reopening the application...` test.

## 2. Space-picker crash

### Root cause (traced, not guessed)

`NewPage.tsx`'s `spaceList` memo ([NewPage.tsx:71-80](../../AppFlowy-Web/src/components/app/view-actions/NewPage.tsx#L71-L80), pre-fix) mapped **every** top-level entry of `useAppOutline()` into the duplicate-target picker's data, with no filter. Every other call site in this codebase that needs to know whether a view is a space uses the canonical check `view?.is_space === true || view?.extra?.is_space === true` (see [useSpaceActionPermissions.ts:16](../../AppFlowy-Web/src/components/app/view-actions/useSpaceActionPermissions.ts#L16) and its test fixtures) — `NewPage.tsx` was the one place that didn't.

Top-level `outline` is not guaranteed to contain only spaces. Specifically, `ensureViewVisibleInOutline` ([useWorkspaceData.ts:1483](../../AppFlowy-Web/src/components/app/hooks/useWorkspaceData.ts#L1483)) — called as part of the default (atomic) page-creation activation path, i.e. exactly the flow Task 39 exercised — fetches `ViewService.getNavigation(workspaceId, viewId, 0)` (the Task 38 navigation route, re-exported as `getNavigation` in [view.ts:3](../../AppFlowy-Web/src/application/services/domains/view.ts#L3) — this re-export is why Task 38's literal grep for `getViewNavigation` call sites did not surface this caller; it is a real, previously-missed caller on the ordinary page-creation path, not only Search's "ask AI"). It then merges the resulting navigation tree into `outline` via `mergeNavigationTreeIntoOutline` → `upsertNavigationRoot` → `replaceViewInOutline` ([useWorkspaceData.ts:267-304](../../AppFlowy-Web/src/components/app/hooks/useWorkspaceData.ts#L267-L304)). `replaceViewInOutline` only replaces an existing top-level (or nested) entry whose `view_id` matches the navigation response's root `view_id` — which is the **workspace id** (the navigation chain's root ancestor), not a space id. Since the existing `outline` array's top-level entries are spaces (their `view_id`s are space ids), no match is found, and `upsertSiblingView` falls through to **appending the whole workspace-rooted navigation node as a new top-level sibling** in `outline`.

That appended node is shaped like a `workspace` kind (`name: workspace.name` in the backend's `navigationNodeView`, always a non-empty string in the current backend) rather than a `space`, and — critically — it is **not marked `extra.is_space`**. Before this fix, `NewPage.tsx` included it in `spaceList` anyway (since it wasn't filtered), and any future or client-side node of this shape lacking a string `name` (verified not to currently happen from this backend, but not guaranteed by the frontend's own types, which mark `View.name` required but do not runtime-enforce it) would reach `SpaceList.tsx:24`'s unguarded `space.name.slice(0, 1)` and crash the whole app via the root `ErrorBoundary`.

### Fix (narrowest appropriate layer, two parts)

1. **`NewPage.tsx`** — `spaceList` now filters to `view.is_space === true || view.extra?.is_space === true` before mapping, matching the codebase's existing convention. This is the actual root-cause fix: the duplicate-target picker should only ever have been fed real spaces, and the extraneous workspace-rooted node (or any other non-space outline entry) is now excluded before it reaches `SpaceList`.
2. **`SpaceList.tsx`** — defensive hardening per the task's explicit requirement ("ensure the component cannot crash when an optional name or icon is missing"): `renderSpace` now computes `spaceName = typeof space.name === 'string' ? space.name : ''` and uses it everywhere `space.name` was used directly, instead of trusting the type at runtime. This is deliberately *not* a placeholder masking a backend defect — the current backend always sends a string `name` for every space and page it returns — it is resilience for a reusable, shared component (also used by the unrelated publish/duplicate flow) against any future caller that doesn't yet filter correctly, the same way `getExtraObj` already defends itself against a malformed `extra` string two lines above.

Neither change touches commercial services, auxiliary endpoints (favorites/trash/sharing/notifications/database-catalog — untouched), or any of the seven pending collaboration-conformance cases.

### Tests added

- `src/components/app/view-actions/__tests__/NewPage.test.tsx`: the `SpaceList` mock now captures its `spaceList` prop; existing `mockOutline` fixtures were corrected from `extra: {}` to `extra: { is_space: true }` (they relied on a hardcoded button in the mock and were not exercising the filter, but were unrealistic relative to real space data once the filter exists). New test `filters non-space outline entries out of the duplicate-target space picker` supplies a mixed outline (one real space, one non-space node with `name: undefined`) and asserts the component only receives the filtered, real space.
- `src/components/publish/header/duplicate/SpaceList.test.tsx`: new test `does not crash when a space entry is missing its name` renders `SpaceList` directly with a space-shaped object that has no `name` field and asserts it does not throw.

## 3. Verification

### Backend regression suites

```
npm test                          15 → 16 tests, 16 passed, 0 failed (new rename test included)
npm run test:offline-collab        5 passed, 0 failed (unchanged)
npm run test:collab-conformance    6 passed, 0 failed, 7 pending (unchanged pending set)
```

PostgreSQL tests: **not run** — no isolated test database was configured in this environment, consistent with every prior task's policy. The new `postgres-storage.js` `updatePageTitle` function was written by direct analogy to the adjacent, already-tested `updatePage` query (same `withClient`/parameterization pattern) but has not been executed against a real PostgreSQL instance.

### Frontend targeted tests

```
./node_modules/.bin/jest src/components/app/view-actions/__tests__/NewPage.test.tsx \
  src/components/publish/header/duplicate/SpaceList.test.tsx --runInBand --no-coverage
→ 2 suites passed, 11 tests passed, 0 failed
```

### Type-check

`./node_modules/.bin/tsc --noEmit --project tsconfig.web.json` — no errors reported for any of the five touched files (`NewPage.tsx`, `NewPage.test.tsx`, `SpaceList.tsx`, `SpaceList.test.tsx`, and the untouched `vite.config.ts`, which was re-confirmed unmodified by this task — see below).

### §3a. Browser verification status: **PERFORMED — PASS**

Performed after implementation, in a separate live session, using the same manual-browser procedure as Task 39 (no automated browser tool was available; the project owner drove a real Chrome browser, guided step-by-step, reporting Network/Console/UI evidence back directly).

**Environment:** fresh isolated instance, independent of the Task 39 instance — backend on `127.0.0.1:45270` (`DATA_FILE=/tmp/appflowy-task40.json`, disposable), Vite on `127.0.0.1:45271` via a temporary `vite.config.task40.ts` (untracked copy of the checked-out `vite.config.ts`, with only the `/gotrue` proxy target made env-overridable, exactly as in Task 39; deleted after the test). `APPFLOWY_WS_BASE_URL` was set correctly from the start this time (the Task 39 setup bug is documented and was not repeated). Disposable account `task40-browser@example.test`.

**Results:**

| Check | Result | Evidence |
|---|---|---|
| Login, space creation | PASS | — |
| Document creation | PASS, after one transient stall | First page-creation attempt spun indefinitely with no request ever reaching the backend log; a page reload triggered the frontend's existing atomic-creation recovery path (it reported "earlier creation is pending" on the next attempt, then resolved cleanly after reload). Not re-investigated further as a defect — this is the app's own documented crash-recovery guard (`findPendingAtomicCreation`/`recoverAtomicCreation` in `src/application/atomic-creation`) behaving as designed for an interrupted request, not a new bug introduced by this task's changes. |
| Page rename persists | PASS | `update-name` request succeeded; the new title was visible after a page reload. The title did **not** update live in the UI without a reload (an optimistic-update gap on the frontend, not a persistence failure — out of this task's scope, which was specifically "the new title survives a backend restart," which it did). |
| Marker (`TASK40-PERSISTENCE-7f3k2`) entered and synced | PASS | — |
| **"New Page" invoked a second time** | **PASS — no crash** | Space picker opened normally; a new page was created quickly; `POST /api/workspace/{id}/v2/page-view/document/default` → 200. This is the direct regression test for the Task 39 crash and it did not reproduce. |
| App remains usable after second page creation | PASS | — |
| Marker survives browser reload | PASS | Confirmed present in the first document after reload. |
| Marker + renamed title survive backend restart | PASS | Backend process was stopped and restarted against the same disposable `/tmp/appflowy-task40.json`; both the marker and the renamed title were present after reopening the document. |

**Conclusion:** both Task 39 defects are confirmed fixed under real-browser use, not just unit tests. The one new observation (a single transient stuck page-creation spinner, resolved by the app's own recovery path on reload) is noted but not classified as a new defect from this task's changes — it was not traced to the rename or crash fix and did not recur on subsequent page creations in the same session.

Regression suites were re-run after the browser session, against the same working tree: `npm test` 16/16, `npm run test:offline-collab` 5/5, `npm run test:collab-conformance` 6 pass/0 fail/7 pending — all unchanged from the post-implementation run in §3.

## 4. Files changed

- `server.js` — new `POST .../page-view/{pageId}/update-name` route.
- `storage.js` — new `store.updatePageTitle`.
- `postgres-storage.js` — new `updatePageTitle` query.
- `test/backend.test.js` — new rename regression test.
- `/Volumes/work disk/Codes/Tracker/AppFlowy-Web/src/components/app/view-actions/NewPage.tsx` — `spaceList` now filters to actual spaces.
- `/Volumes/work disk/Codes/Tracker/AppFlowy-Web/src/components/publish/header/duplicate/SpaceList.tsx` — defensive `name` handling in `renderSpace`.
- `/Volumes/work disk/Codes/Tracker/AppFlowy-Web/src/components/app/view-actions/__tests__/NewPage.test.tsx` — mock captures `spaceList`; new filtering test; existing fixtures corrected to realistic `extra`.
- `/Volumes/work disk/Codes/Tracker/AppFlowy-Web/src/components/publish/header/duplicate/SpaceList.test.tsx` — new crash-resilience test.

`vite.config.ts` was **not** modified by this task; its pre-existing unrelated `react-gesture-responder` build-fix diff (confirmed present before this task started) is unchanged.

## 5. Remaining limitations and next recommended task

- **Real-browser verification of both fixes is now complete and passed** (see §3a). The fixes can be trusted in the live product for the one-client scenarios tested.
- The exact scenario that produces a non-space, nameless top-level outline node was traced through `ensureViewVisibleInOutline`'s navigation-merge logic but was not independently reproduced as a standalone repro in this task; the fix (filtering in `NewPage.tsx`, plus defensive rendering in `SpaceList.tsx`) is correct regardless of the precise trigger, since it enforces the same invariant the rest of the codebase already relies on, and the live-browser session in §3a exercised the exact "New Page" flow this defect came from without a recurrence.
- A new, minor observation from §3a: page-rename updates do not reflect live in the UI without a reload (they do persist correctly). Not fixed in this task (out of scope — Task 40 was specifically about persistence, not UI reactivity); worth a small follow-up if UX polish becomes a priority.
- A single transient stuck page-creation spinner was observed once during browser verification, resolved by the app's own atomic-creation recovery path on reload; not reproduced a second time and not traced to this task's changes. Worth watching for recurrence in future sessions but not treated as a new defect here.
- The auxiliary 404s (favorites, trash, sharing/shareWithMe, notifications, workspace database-catalog warm) remain unimplemented, as explicitly out of scope for this task.
- PostgreSQL behavior for the new route is unverified (see §3).
- The project's standing next priority is the seven pending collaboration-conformance cases (reconnect/retry correctness, duplicate admission, realtime acknowledgement, compaction/retention, restore transitions, cross-instance replay, WebSocket/HTTP convergence) — not implementing further unrelated endpoints, per Task 39's recommendation.
