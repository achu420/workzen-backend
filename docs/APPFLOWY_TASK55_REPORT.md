# Task 55: CORS header allowlist fix (Cache-Control / Device-Id)

## Summary

Task 49C-R3/54 found that AppFlowy-Web's post-document-creation read-back request
(`atomicRead()` and related collab/history read calls) sends a `Cache-Control: no-cache`
header, which was not in `server.js`'s `CORS_ALLOWED_HEADERS`, causing the browser's CORS
preflight to reject the request and leaving the UI unable to navigate to a newly created
document even though the server created it successfully.

## Part A — Investigation

- `server.js` `CORS_ALLOWED_HEADERS` (before fix, line 20):
  `Content-Type, Authorization, If-Match, X-Development-Key, X-Platform, X-Device-Id, Client-Version`
  — missing `Cache-Control`.
- Searched AppFlowy-Web (`src/`) for actual request-header usage:
  - `src/application/services/js-services/http/collab-api.ts:81` — `headers: { 'Cache-Control': 'no-cache' }`
  - `src/application/services/js-services/http/atomic-creation-api.ts:160` — same, on the post-creation read-back
  - `src/application/services/js-services/http/database-history-api.ts:116` — same, on a GET with `signal`
  - `src/application/services/js-services/http/__tests__/collab-state-reads.test.ts:49` — test fixture confirms the contract
- Initial pass missed it, but a second, targeted search (`getOrCreateDeviceId`) confirmed AppFlowy-Web genuinely sends a literal lowercase `device-id` header (no `X-` prefix — distinct from the pre-existing `X-Device-Id` allowlist entry, which some other, defensive code path may use but which is not what's actually sent here):
  - `src/application/services/js-services/http/collab-api.ts:267` and `:365` — `'device-id': deviceId` on the full-sync/batch POST and a GET, via `getOrCreateDeviceId()`
  - `src/application/services/js-services/http/inline-comment-api.ts:76` — same, via the same helper
  So the originally reported "missing Device-Id" is a real, distinct gap from `X-Device-Id`, confirmed against actual frontend source, not assumed.
- No other missing headers were found across collab-api.ts, atomic-creation-api.ts, auth-api.ts, core.ts, database-history-api.ts, or inline-comment-api.ts beyond what Task 51 already allowed plus these two. No speculative headers were added.

## Part B — Fix

`server.js` line 20 (now with explanatory comment at lines 17-19 extended):

```js
const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, If-Match, X-Development-Key, X-Platform, X-Device-Id, Client-Version, Cache-Control, Device-Id';
```

`Cache-Control` and `Device-Id` (the literal lowercase header AppFlowy-Web sends, distinct from the pre-existing `X-Device-Id` entry) were added. All other Task 51 CORS properties preserved unchanged:
exact-origin allowlist (no wildcard), no `Access-Control-Allow-Credentials` ever set,
OPTIONS answered with 204 before auth routing, WebSocket upgrade path untouched,
`CORS_ALLOWED_ORIGINS` env var configuration untouched.

## Part C — Automated regression tests

Added one new test in `test/backend.test.js`: `CORS (Task 55): preflight allows
Cache-Control and Device-Id, and real requests using them succeed`, covering:
- OPTIONS preflight with `Cache-Control` alone — **Passed**
- OPTIONS preflight with literal `device-id` alone (and confirms `X-Device-Id` remains allowed too) — **Passed**
- OPTIONS preflight with both `Cache-Control` and `device-id` together (plus `content-type`/`authorization`) — **Passed**
- Real GET with `Cache-Control` + `device-id` headers — **Passed**
- Real POST (register) with those headers — **Passed**
- Disallowed origin still gets no `Access-Control-Allow-Origin` even with the new headers (Task 51 regression check) — **Passed**
- Disallowed-origin preflight with the new headers still unauthorized — **Passed**
- Existing auth (register/login/me) still works — **Passed**
- No-Origin request still works — covered by pre-existing Task 51 test, unchanged — **Passed**
- WebSocket unaffected — covered by pre-existing Task 51 test, unchanged — **Passed**

`npm test` result: **38/38 passed** (37 baseline + 1 new Task 55 test), 0 failed.

## Part D — Real browser verification

**Blocked/Not tested** at full-UI depth due to session time constraints during this run.
What was verified directly, with real HTTP:

- Started two isolated instances in turn (`PORT=8791`/`PORT=8792`, disposable JSON data
  files, removed after) and sent real `curl -X OPTIONS` preflights with
  `Access-Control-Request-Headers: cache-control, x-device-id, authorization, content-type`
  and (after the `device-id` finding below) `cache-control, device-id`, from
  `Origin: http://localhost:5183`. **Result both times: 204 No Content**, with
  `Access-Control-Allow-Headers` echoing back `Content-Type, Authorization, If-Match,
  X-Development-Key, X-Platform, X-Device-Id, Client-Version, Cache-Control, Device-Id` —
  **Passed**. This directly reproduces, and confirms the fix for, the exact preflight shape
  the post-creation read-back and full-sync/batch calls send.

Full 12-step Playwright real-browser document-creation walkthrough (login → new page →
read-back → navigation → typing → reload → persistence) was **not executed** in this run
because of session/time constraints (this run was interrupted mid-task by a rate limit and
resumed with a reduced budget). The curl-level preflight evidence above, combined with the
automated test suite exercising real HTTP request/response objects (not source-string
checks), gives high confidence the fix resolves the reported defect, but it is not a
substitute for the full real-browser walkthrough requested in Part D. This should be
re-run by a follow-up task before being considered fully closed per the original Task 55
acceptance bar.

Per-step status:
1. Login — Not tested (Playwright run not executed)
2. Load workspace — Not tested
3. Open/create space — Not tested
4. Click "New Page" — Not tested
5. Select document type — Not tested
6. Backend document creation — Not tested via UI (previously confirmed in Task 49C-R3/54 as working server-side)
7. Post-creation read-back succeeds (no CORS failure) — Passed at the HTTP/curl level (see above); not confirmed via actual browser console/network panel
8. Navigation to new document — Not tested
9. Editor usable — Not tested
10. Type marker content — Not tested
11. Reload — Not tested
12. Content persists — Not tested

## Part E — Regression

- `npm test`: **38/38 passed**, 0 failed (baseline was 37/37; +1 new Task 55 test).
- `npm run test:offline-collab`: **5/5 passed**, 0 failed (unchanged from baseline).
- `npm run test:collab-conformance`: **6 passed, 0 failed, 2 pending** (compaction-retention, cross-instance-replay — untouched, as required), 5 resolved (unchanged from baseline).
- Frontend Playwright tests: Not executed in this run (time constraints).

## Part F — Process cleanup (PID 52789 / port 8790)

1. `ps -p 52789` → confirmed alive, `COMMAND: node server.js`.
2. Full command/cwd via `lsof -p 52789`: `cwd` = `/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend` (this project); stdout/stderr (fd 1/2) redirected to
   `/private/tmp/claude-501/-Volumes-work-disk-Codes-Tracker/4b89062d-6752-4f90-b9cf-02a3355ce209/scratchpad/t54/backend.log`, confirming disposable/isolated test data/logging from the prior Task 49C-R3 run, not production data.
3. `lsof -i :8790` confirmed PID 52789 listening on `localhost:8790`, matching the reported port.
4. All checks consistent with the task description (genuine `node server.js` for this project, isolated data, correct port) — terminated with `kill 52789` (not a broad pkill).
5. `ps -p 52789` after kill returned no process (exit status 1 / empty output) — confirmed stopped.

Task 50's `task50-pg` Postgres container and the unrelated commercial AppFlowy Docker stack were not touched.

## Remaining limitations / follow-ups

- Full real-browser Playwright walkthrough (Part D, steps 1-6 and 8-12) was not executed in this run and should be completed by a follow-up task to fully close the original acceptance bar.
- No new defects were found beyond the two this task was scoped to fix (`Cache-Control` and the literal `device-id` header).
- `npm run test:offline-collab` / `test:collab-conformance` pending items (compaction-retention, cross-instance-replay) intentionally left untouched per scope.

## Task 56 — Real-Browser Verification of the Full Document-Creation Workflow

This follow-up closes the gap left above: the full 12-step real-browser
document-creation workflow, driven through genuine UI interaction (no
direct-API bypass for the core flow), executed end to end.

### Setup

- Backend: `node server.js` in JSON mode, disposable data file, fresh port
  `PORT=8793`, `CORS_ALLOWED_ORIGINS=http://localhost:5185,http://127.0.0.1:5185`.
  Verified `8793`/`5185` were free before starting (`lsof`), and left Task 50's
  `task50-pg` container and the commercial AppFlowy self-host Docker stack
  untouched (confirmed via `docker ps` before and after).
- Dedicated test accounts registered via real `POST /api/auth/register`:
  `task56@example.test` (used for selector discovery / exploratory runs) and
  `task56b@example.test` (used for the final clean end-to-end run, to avoid
  state left over from earlier exploratory runs).
- Frontend: AppFlowy-Web's real Vite dev server, `APPFLOWY_BASE_URL`,
  `APPFLOWY_GOTRUE_BASE_URL`, `APPFLOWY_WS_BASE_URL` exported as shell env vars
  (not just written to `.env.local`, since `vite.config.ts` reads
  `process.env` directly for its namespace-redirect/proxy logic) pointed at
  `http://localhost:8793` / `ws://localhost:8793/ws/v2`, `--port 5185
  --strictPort`. `.env.local` was temporarily overwritten and restored to its
  original content (`env.local.orig`) at the end.
- Driver: real headless Chromium via Playwright (`playwright` package already
  present in the backend's `node_modules`), not a stub — `page.goto`,
  `getByTestId`, `.fill`, `.click`, `page.keyboard.type` against the real UI.
- Selectors discovered this run (not previously documented): login flow uses
  `login-email-input` → `login-password-button` → `password-input` →
  `password-submit-button` (no generic "continue" button exists). The "New
  page" flow's space picker (`SpaceList.tsx`) uses `data-testid="space-item"`
  on a MUI `Button`, which collides with an unrelated sidebar outline
  component (`SpaceItem.tsx`) using the exact same testid — the locator had to
  be scoped to `getByTestId('new-page-modal').getByTestId('space-item')` to
  avoid resolving to the wrong (hidden, pointer-event-blocking) element. The
  "Create a new space" flow uses `space-name-input` and `create-space-submit`;
  the space-picker's submit button is `modal-ok-button`.

### Per-step results

| # | Step | Status | Evidence |
|---|---|---|---|
| 1 | Login (real UI form) | **Passed** | `task56-01-login-page.png`..`04-password-filled.png`; reached `/app/{workspaceId}` after `password-submit-button` click. |
| 2 | Load the workspace | **Passed** | `task56-05-workspace-loaded.png`; network log shows 200s for `/api/user/workspace`, `/api/workspace/{id}/view...`, `/favorite`, `/database`, `/trash`. |
| 3 | Open an existing space (created via UI since the test account starts with none) | **Passed** | `task56-07-create-space-modal.png`, `09-space-created.png`; `POST /api/workspace/{id}/spaces` → 200; space "Task56 Space" visible in sidebar. On a later run reusing an account with a space, the existing-space path (`new-page-modal` → scoped `space-item` → `modal-ok-button`) was also exercised and passed. |
| 4 | Click "New Page" | **Passed** | `new-page-button` click opens `new-page-modal` (`task56-06-new-page-modal.png`). |
| 5 | Select the document type | **Passed (implicit)** | The real "New page" UI flow (`NewPage.tsx`) hard-codes `ViewLayout.Document` for both the "create space + initial page" path and the "add to existing space" path — there is no separate type-picker control to click. This matches source (`NewPage.tsx:21,124`), not a defect; "Document" is simply the only type this entry point offers. |
| 6 | Let the frontend create the document | **Passed** | Network log: `POST /api/workspace/{id}/v2/page-view/document/default` → 200, immediately followed by `GET /api/workspace/{id}/view/{newViewId}?depth=1` → 200. |
| 7 | Verify the post-creation read-back request succeeds (no CORS failure) | **Passed** | Full network log for the run contains zero CORS-blocked requests and zero `Access-Control-Allow-Origin` console errors. All `8793` requests resolved to real HTTP responses (200s for the read-back GETs; a handful of pre-existing, unrelated 404s for `workspace-profile`, `add-recent-pages`, `inline-comment`, `error-messages`, auth-providers — see "New findings" below). Independently re-confirmed via `curl -i -X OPTIONS -H "Origin: http://localhost:5185" -H "Access-Control-Request-Headers: device-id,cache-control,content-type" http://127.0.0.1:8793/api/workspace/.../view/...` → `204`, `Access-Control-Allow-Headers` includes both `Cache-Control` and `Device-Id`. **The Task 55 CORS fix holds in a real browser.** |
| 8 | Verify navigation to the newly created document actually happens | **Passed** | The new document opens in `ViewModal` (an overlay, not a full route change) immediately after creation — confirmed via DOM (`new-page-modal` closes, document title/editor render in its place, `task56-11-after-create-page.png`). The browser's address bar does not change path immediately (the modal is an overlay on the current route), but the URL does include the new view ID once state settles (confirmed after reload, see step 11/12); this is normal AppFlowy-Web modal-routing behavior, not a navigation failure. |
| 9 | Verify the document editor becomes usable (can type into it) | **Passed** | Two `[contenteditable="true"]` elements found (title + body); clicking the body block and typing succeeded immediately — `task56-12-marker-typed.png` shows the marker rendered as a real block under the title. |
| 10 | Type identifiable test content (unique marker string) | **Passed** | Typed `TASK56-DOC-MARKER-QW9912` into the document body via `page.keyboard.type`; present in the live DOM immediately (`MARKER_PRESENT_BEFORE_RELOAD: true`). |
| 11 | Reload the browser | **Passed** | `page.reload({ waitUntil: 'networkidle' })` completed cleanly; URL after reload: `http://localhost:5185/app/{workspaceId}/{viewId}` (full path now resolved). |
| 12 | Verify content persists after reload | **Passed** | `task56-13-after-reload.png` shows `TASK56-DOC-MARKER-QW9912` present in the document body after a full reload (fresh Yjs sync from the server, not local cache) — `MARKER_PRESENT_AFTER_RELOAD: true`. |

**Conclusion: the full real-browser workflow (login → load workspace → create
space → create document via "New Page" → read-back → navigate/open → edit →
reload → persist) now works end to end through genuine UI interaction, with
zero CORS errors anywhere in the run.** This directly confirms Task 55's fix
in the environment Task 49C-R3 originally found broken.

### A caution from an earlier (non-final) run in this same task

An initial exploratory run, on an account that already had a pre-existing
document open from a previous session, typed the marker into the document
**title** field (an easy mistake: the title is also `contenteditable=true`
and was matched first by a naive `[contenteditable="true"]` locator) and
reloaded after only a 1.5s wait. That run showed the title reverting to
"Untitled" after reload. This was **not** treated as a defect finding: once
the script was corrected to (a) type into the actual document body, and (b)
allow a few seconds for the Yjs update to reach the server before reloading,
content persisted correctly and reproducibly on a clean account (see the
Passed step 12 above). It is recorded here only so a future run does not
rediscover the same test-script pitfall and mistake it for a product defect.

### New findings (not fixed, per task instructions)

1. **Minor, pre-existing, out-of-scope 404s**: `POST
   .../add-recent-pages`, `GET .../workspace-profile`, `GET
   .../document/{id}/inline-comment`, `GET
   .../document/{id}/inline-comment/reaction`, `GET /api/error-messages`, and
   an auth-providers lookup all 404 during the normal course of this
   workflow. None of these are CORS-related (all get real, non-blocked HTTP
   responses) and none prevented any of the 12 steps from passing. They
   surface in the UI as a transient "We couldn't find this content." toast
   that does not block interaction. This is an existing backend-route gap
   (unrelated features never implemented in this independent backend), not a
   regression from Task 55, and is reported here only for completeness since
   it was directly observed during this run. Not fixed — out of scope.
2. **Testid collision**: `data-testid="space-item"` is used by two unrelated
   AppFlowy-Web components (`components/publish/header/duplicate/SpaceList.tsx`,
   the "New Page" space picker, and `components/app/outline/SpaceItem.tsx`,
   the sidebar outline). This did not block the workflow (a scoped locator
   worked around it) but is a latent test-automation hazard and a minor code
   hygiene issue worth flagging to whoever owns the frontend testids. Not
   fixed — out of scope (frontend-only, cosmetic/test-infra, not a functional
   defect).

### Regression re-confirmation

Run from `AppFlowy-Independent-Backend` after the browser workflow:
- `npm test` → 38/38 pass (includes the Task 55 `CORS (Task 55): preflight
  allows Cache-Control and Device-Id...` fixture).
- `npm run test:offline-collab` → 5/5 pass.
- `npm run test:collab-conformance` → 6 passed, 0 failed, 2 pending
  (compaction-retention, cross-instance-replay), 5 resolved — identical to the
  Task 55 baseline.

### Cleanup

Backend (port 8793, PID in this run) and Vite dev server (port 5185) were both
stopped; `AppFlowy-Web/.env.local` was restored to its original content.
Verified via `lsof` that 8793/5185 are free and via `docker ps` that
`task50-pg` and the commercial self-host stack were untouched. Two unrelated,
pre-existing `node server.js` processes (not started by this task) and an
unrelated Vite dev server on port 5190 were observed running throughout and
were deliberately left alone.

### Remaining limitations

- The document-type-selection step (5) has no dedicated UI control to
  exercise in the real "New Page" entry point — Document is the only type it
  creates. A type picker may exist elsewhere in the UI (e.g. a "+" hover menu
  with multiple icons) but was out of scope to hunt for given the task's
  specific 12-step script.
- Two-client/multi-tab propagation of the newly created document was not
  re-verified in this task (that was already covered for *existing* documents
  by Task 49C-R3); this task's scope was the creation workflow specifically.
- The minor pre-existing 404s and the testid collision above are reported,
  not fixed, per the task's stop-on-new-defect instruction.
