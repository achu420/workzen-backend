# Task 39 — Real Browser Verification Report

**Date:** 2026-10-29
**Outcome: Core workflow PASSED.** This supersedes an earlier same-day attempt at this task, which was BLOCKED because that execution environment had no browser-automation tool (see "Prior attempt" below). This run used a human operator (the project owner) driving a real Chrome browser against an isolated instance, guided step-by-step by the agent, with DevTools Network/Console evidence relayed back verbatim and verified where possible against direct backend requests.

### Prior attempt

An earlier Task 39 run in a different session found no browser-automation tool available (`ToolSearch` for browser/Chrome/computer-use tooling returned only `WebFetch`, which cannot reach loopback hosts or capture WebSocket/console traffic) and correctly stopped without starting any processes or fabricating evidence. That result is superseded by this report, which used manual browser operation instead.

## A. Environment

- Isolated backend: `127.0.0.1:45260`, `STORAGE=json`, `DATA_FILE=/tmp/appflowy-task39.json` (disposable, newly created for this test).
- Isolated Vite/AppFlowy-Web: `127.0.0.1:45261`, launched with `--config vite.config.task39.ts` (a temporary, untracked copy of the checked-out `vite.config.ts`, deleted after the test; the real `vite.config.ts` was never modified).
- Disposable test account: `task39-browser@example.test`, created via `POST /api/auth/register` directly against the isolated backend.
- Browser: the operator's real Chrome, with DevTools Network/Console, manually driven by the operator — no Claude-side browser-automation tool was available or used in this session.
- No commercial service was intentionally contacted. One configuration defect (below) initially pointed the frontend's WebSocket at `ws://localhost:8000`, an unrelated, already-running local service (OrbStack-managed; ports 8000/9999 were observed listening before this test started). This was caught from the operator's first Network-tab report, before any document edit was attempted, and corrected before continuing. No data beyond a WebSocket upgrade attempt reached port 8000 ("msg is empty" per the operator); the commercial/Docker stack was not started, stopped, or reconfigured by this task.
- Two stray `node server.js` processes from earlier, unrelated sessions were found listening before this test began (ports 3000 and 45250); neither was used, reconfigured, or relied upon. The one on port 45250 could not be stopped from this session (tool permission denial) and was simply avoided by picking fresh ports (45260/45261).

### Setup correction (recorded for future tasks)

The temporary Vite config initially set `APPFLOWY_DEV_WS_PROXY_TARGET` (a Vite-dev-server-side proxy target for the `/ws` path) but not `APPFLOWY_WS_BASE_URL` (the client-side runtime config value read by `src/components/ws/useAppflowyWebSocket.ts:11`, which defaults to `ws://localhost:8000/ws/v2` via `getConfigValue('APPFLOWY_WS_BASE_URL', 'ws://localhost:8000/ws/v2')`). These are two different variables; only the second actually controls where the browser's WebSocket connects. Any future isolated-browser test must set `APPFLOWY_WS_BASE_URL=ws://<vite-host>:<vite-port>/ws/v2` explicitly — relying on `APPFLOWY_DEV_WS_PROXY_TARGET` alone silently leaves the client pointed at the hardcoded default. After the fix, the browser's upgrade request to `ws://127.0.0.1:45261/ws/v2/{workspaceId}/?...` returned **101 Switching Protocols** from the isolated backend.

## B. Workflow results

| Step | Result |
|---|---|
| Authentication | PASS — login succeeded, browser landed on `/app/{workspaceId}` |
| Workspace loading | PASS — `GET /api/workspace/{id}/view/{id}?depth=6` → 200; `GET /api/workspace/v1/{id}/collab/{databaseStorageId}?collab_type=2` → 200 |
| WebSocket initialization | PASS (after setup correction above) — `ws://127.0.0.1:45261/ws/v2/{id}/?...` → 101, "WebSocket connection opened" logged by the client |
| Document opening | PASS — operator created a space and a Document through the normal UI and reopened it after reload/restart |
| Editor becomes editable | PASS — operator confirmed the document body is clickable and editable |
| Text marker entered | PASS — `TASK39-PERSISTENCE-20261029-7f3k2` entered in the document body |
| Marker survives browser reload | PASS — confirmed present after a hard reload |
| Marker survives backend restart | PASS — isolated backend process was stopped and restarted against the same disposable `/tmp/appflowy-task39.json`; marker was present after reopening the document |
| Existing regression tests | PASS — see below |

Regression suite results (run after the browser test, against the same working tree):

- `npm test`: **15/15 pass** (unchanged from Task 38 baseline).
- `npm run test:offline-collab`: **5/5 pass**.
- `npm run test:collab-conformance`: **6 pass / 0 fail / 7 pending** (unchanged pending set, same as all prior tasks).
- PostgreSQL tests: **not run** — no isolated test database was configured, consistent with every prior task's policy.

## C. Network evidence

### Confirmed non-blocking (auxiliary) 404s

Observed in Console/Network after login and after space/page creation, all **404 Not Found**, none of which prevented login, workspace load, WebSocket init, or document editing:

- `GET /api/error-messages?schema_version=1&platform=web&client_version=0.18.6&locale=en-gb` (net::ERR_ABORTED)
- `POST /api/user/update` ("Failed to load the current user or initialize timezone", `user-api.ts:74`)
- `GET /api/workspace/{id}/favorite` ("Favorite views not found", `view-api.ts:175`)
- `GET /api/sharing/workspace/{id}/view/{id}?depth=50` ("[Outline] Failed to load shareWithMe data", `access-api.ts:420`)
- `GET /api/workspace/{id}/database?offset=0&limit=200` ("[WorkspaceDatabaseCatalog] failed to warm the workspace catalog", `view-api.ts:43`)
- `GET /api/workspace/{id}/trash` ("App trash not found", `view-api.ts:191`)
- `GET /api/workspace/{id}/notifications?offset=0&limit=200`, `?archived=true&offset=0&limit=200`, and `/notifications/unread-count` (`notification-api.ts:25,33`)

None of these routes exist in `server.js` (confirmed by direct grep — no `favorite`, `trash`, `database`, `sharing`, or `notifications`/`user/update` handlers), so all are genuinely unimplemented, not misconfigured. They match the auxiliary-feature classification from Tasks 32/33/37 and did not block the core document workflow in this run.

**Unresolved discrepancy (scoped out of this task by explicit decision):** the operator's first DevTools reading showed `303` for the `sharing` request and `400` for `database`/`trash`, while a direct curl reproduction using the operator's own workspace ID (with and without a valid bearer token) consistently returned `404` for all three. The cause was not identified — possibly a stale/cached Network-tab entry, a differently-shaped request (e.g. an `OPTIONS` preflight) than what was curled, or a client-side error-catalog/retry wrapper altering the displayed status. This is recorded as an open question but does not change the auxiliary classification of these endpoints, and was deliberately not investigated further to stay within this task's verification-only scope.

### Core-path defect found: missing page-rename route

```
POST /api/workspace/{workspaceId}/page-view/{pageId}/update-name
→ 404 Not Found
```

Confirmed absent from `server.js` (grep found zero matches for `update-name`). This is a genuine, previously undocumented gap: the frontend auto-focuses a page's title field immediately after creation, and saving that title has no backend route. User-visible symptom: "title is not being saved."

### Core-path defect found: frontend crash on second "New Page" action

After the rename 404, invoking "New Page" a second time (sidebar action, which opens a "duplicate to" space-picker dialog) crashed the entire React application. Console output:

```
The above error occurred in the <SpaceList> component:
  at SpaceList (src/components/publish/header/duplicate/SpaceList.tsx:24:22)
  ...
  at NewPage (src/components/app/view-actions/NewPage.tsx:99:17)
  ...
  at AppProvider ... at App
"React will try to recreate this component tree from scratch using the error boundary you provided, ErrorBoundary."
```

`SpaceList.tsx:24` computes `space.name.slice(0, 1)` as a fallback icon character when `extraObj.space_icon` is absent. This throws a `TypeError` when `space.name` is not a string — meaning at least one `SpaceView` object reaching this component (sourced from the backend's workspace outline or a derived cache) is missing the `name` field in the shape the frontend expects. The catching `ErrorBoundary` sits near the application root (wrapping `AppRouter`/`AppProvider`), so the **entire UI tree unmounted and remounted**, not just the dialog — more severe than a typical auxiliary 404, and it directly blocks creating additional pages through this path. The operator avoided retriggering it by not reopening "New Page" again; all further verification (marker entry, reload, restart) used the document created before the crash.

Not investigated further — Task 39 is verification-only and no backend change was made. Concrete repro: create one space + page, let the rename call 404, then invoke "New Page" again.

## D. Next recommendation

**Implement `POST /api/workspace/{workspaceId}/page-view/{pageId}/update-name`** (page rename), and as part of that work, trace why `SpaceView` objects reaching `SpaceList.tsx`'s space-picker are missing `name` — likely the backend's space/duplicate-target list (consumed by `NewPage.tsx`'s picker) uses a different, not-yet-traced call path or response shape than the already-implemented `GET /api/workspace/{id}/view/{id}` outline. This one task addresses two defects squarely on the core document-creation path (the non-persisting title and the page-creation crash), unlike the already-known, lower-priority 404s for favorites/trash/sharing/notifications/database-catalog.

After that, prioritize the seven pending collaboration-conformance cases (reconnect/retry correctness, duplicate admission, realtime acknowledgement, etc.) over implementing further unrelated endpoints, per standing project guidance.

## Cleanup

- Isolated backend (port 45260) and Vite (port 45261) processes for this task were stopped.
- `/tmp/appflowy-task39.json` and its backend/Vite logs were removed.
- The temporary `vite.config.task39.ts` was deleted; the checked-out `vite.config.ts` was never modified.
- Ports 45260 and 45261 were confirmed free after cleanup.
- No commercial services, Docker resources, or unrelated processes were stopped or reconfigured by this task.

## Rules compliance

- No feature implementation attempted (the two defects above are reported, not fixed).
- No speculative fixes made.
- No commercial services or unknown databases touched.
- No fabricated browser evidence — all network/console evidence above was relayed directly by the operator from their own DevTools, with the three-code discrepancy (303/400 vs 404) disclosed rather than smoothed over.
- No multi-user collaboration claims; this remains a one-client verification.
