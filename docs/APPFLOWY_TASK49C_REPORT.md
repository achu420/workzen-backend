# Task 49C-R — Real Browser Verification of Document Version History/Restore

## Outcome summary

This re-run used **real Playwright browser automation** (not a repeat of "no browser
available"). A real Chromium instance (Playwright 1.58.2, Chromium 156.0.8078.4) was
launched, navigated the real AppFlowy-Web login UI, filled real form fields using the
project's own `playwright/support/selectors.ts` test-ids, and clicked real buttons.

The run hit a **real, reproducible infrastructure defect** at the very first UI step
(login) that blocks every subsequent step in Parts C, D and E: AppFlowy-Independent-Backend
sends **no CORS headers at all**, so the browser refuses every cross-origin request
AppFlowy-Web's `AFConfigContext` issues to it (including the login `POST /token?grant_type=password`).
Per the task's failure-handling instructions, this defect is reported here and **not
patched**; `server.js` was left unmodified.

A second, compounding defect was found by source inspection (Part A) that would have
blocked the Document History UI specifically even if CORS were fixed: the backend
hardcodes `enable_page_history: false` in `GET /api/server-info` with no override, which
the real frontend (`AppAuthLayer.tsx:75`) treats as an explicit disable (not "unknown"),
hiding the Document History entry point.

## Part A — Inspection (completed)

Read/confirmed:
- `AppFlowy-Web/playwright.config.ts`, `playwright/e2e/`, `playwright/support/auth-utils.ts`,
  `playwright/support/auth-flow-helpers.ts`, `playwright/support/selectors.ts`
  (`AuthSelectors.emailInput` → `getByTestId('login-email-input')`,
  `passwordInput` → `getByTestId('password-input')`,
  `passwordSubmitButton` → `getByTestId('password-submit-button')`).
- `AppFlowy-Web/src/application/services/js-services/http/cloud-config.ts` and
  `src/utils/runtime-config.ts` — confirmed `defaultConfig.baseURL`/`gotrueURL` are read from
  `import.meta.env.APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL` (Vite `envPrefix: ['APPFLOWY']`),
  which Vite loads from `.env` + `.env.local` (not `dev.env`, which is not auto-loaded by any
  npm script or `vite.config.ts`). `.env.local` already present in the repo pointed at
  `http://localhost:8787` for all three vars — this is why the backend was run on port 8787.
- `AppFlowy-Web/src/components/app/layers/AppAuthLayer.tsx:75` — `enablePageHistory` derivation
  (see defect above).
- `AppFlowy-Web/src/components/app/app.hooks.tsx:74` — consumer default (`true` only when
  context value is `undefined`).
- `AppFlowy-Independent-Backend/server.js` — confirmed `/api/auth/register`, `/token`,
  `/api/server-info` routes and the hardcoded `enable_page_history: false` (no env var exists
  to override it — grepped the whole file).
- Re-read `docs/APPFLOWY_TASK49A_REPORT.md`, `docs/APPFLOWY_TASK49B_REPORT.md` — confirmed no
  WebSocket restore-notification frame exists; staleness is only caught by restore-generation
  fencing, as stated in this task's own ground truth.
- `DocumentHistoryModal.tsx`, `useCollabVersionRevert.ts` located at
  `src/components/document/history/DocumentHistoryModal.tsx` and
  `src/components/ws/sync/useCollabVersionRevert.ts` (read, not exercised live — see below).

## Part B — Test environment setup (completed, with the defect encountered)

- Verified ports 8787 and 5183 were free (`lsof`), then:
  - Started AppFlowy-Independent-Backend: `PORT=8787 HOST=127.0.0.1 STORAGE=json
    DATA_FILE=<scratchpad>/t49cr/data.json node server.js`. Verified health:
    `GET /health` → `{"ok":true,"storage_schema":1}`.
  - Created a real test account via `POST /api/auth/register`
    (`t49cr-tester@example.com`) — real HTTP call, 200/409 (idempotent on rerun), matching
    the task's allowance to use HTTP only for setup.
  - Started AppFlowy-Web's real Vite dev server on port 5183 (`node_modules/.bin/vite --port
    5183`), picking up the repo's existing `.env`/`.env.local`. Verified readiness: `GET
    http://127.0.0.1:5183/` → 200, and confirmed the dev-server's own `/api/server-info` proxy
    returns the backend's real JSON (including `enable_page_history: false`).
- No commercial/self-host stack, `appflowy-selfhost-commercial-postgres-1`, or any other
  pre-existing process was touched. Only two processes started by this task were killed by PID
  at the end (`kill <pid>` for the backend and the Vite dev server, verified gone via `lsof`).

## Part C — Single-client real-browser workflow

| Step | Status | Notes |
|---|---|---|
| 1. Log in (real UI form) | **Failed** | Real Chromium opened `/login`, filled `login-email-input` via `getByTestId`, clicked the password sign-in option, reached `/login?...&action=enterPassword`, filled `password-input`, clicked `password-submit-button`. The POST to `http://localhost:8787/token?grant_type=password` was blocked by the browser's CORS policy before it reached the backend (`No 'Access-Control-Allow-Origin' header is present`). Confirmed independently with `curl -i ... -H "Origin: http://127.0.0.1:5183"` — the backend returns zero `Access-Control-Allow-*` headers on any response. UI shows "There was a network connection problem." |
| 2. Confirm workspace loads | **Blocked** | Cannot proceed past unauthenticated state. |
| 3. Open/create disposable document | **Blocked** | — |
| 4. Edit + save marker text | **Blocked** | — |
| 5. Open Document History (real UI entry point) | **Blocked** (and would be a second, independent **Failed** once reachable — see `enable_page_history` defect in Part A) | — |
| 6. Create named snapshot via UI | **Not tested** | — |
| 7. Verify snapshot in history list DOM | **Not tested** | — |
| 8. Preview snapshot content | **Not tested** | — |
| 9. Modify document further | **Not tested** | — |
| 10. Create second snapshot | **Not tested** | — |
| 11. Restore earlier snapshot via UI | **Not tested** | — |
| 12. Verify restored content in live editor DOM | **Not tested** | — |
| 13. Reload page, verify persistence | **Not tested** | — |
| 14. Tombstone-delete a version via UI | **Not tested** | — |
| 15. Verify deleted version unlisted/rejected | **Not tested** | — |

All "Not tested" steps are blocked transitively by Step 1's failure; none were skipped by
choice.

## Part D — Two-browser concurrency

**Not tested.** Depends on Part C succeeding past login; not attempted once the Part C
blocker was confirmed and documented, per the instruction to stop and report rather than
patch around a found defect.

## Part E — PostgreSQL browser verification

**Not tested.** Same transitive dependency on a working real-browser login, which the CORS
defect prevents regardless of storage backend (the defect is in the HTTP layer of
`server.js`, independent of `STORAGE=json` vs `STORAGE=postgres`). No disposable Postgres
container was provisioned, since there was nothing a browser session could exercise against
it that single-client JSON testing hadn't already been blocked on.

## Part F — Evidence collected

All under the task scratchpad (not committed to either repo):
`/private/tmp/claude-501/-Volumes-work-disk-Codes-Tracker/4b89062d-6752-4f90-b9cf-02a3355ce209/scratchpad/t49cr/`
- `run.js` — the real Playwright script used (plain `playwright` package, Chromium,
  `page.goto`/`getByTestId`/`.fill`/`.click` against the real login UI).
- `shots/01-login.png`, `02-password-page.png`, `03-after-login.png`, `04-workspace.png` —
  real screenshots of the login flow, including the failed-login state.
- `console-errors.txt` — captured `page.on('console')`/`page.on('requestfailed')` output
  (the exact CORS error strings) plus the independent `curl -i` confirmation and the
  `enable_page_history` source citation.
- `backend8787.log`, `frontend.log` — stdout/stderr of the real backend and Vite dev server
  processes for this run.
- `data.json` — the disposable JSON store used (contains only the one test account;
  no secrets).

No WebSocket connection/close/reconnect evidence, no two-client evidence, and no
persistence-after-reload evidence exist, because none of those steps were reached.

## API/WebSocket evidence

- `POST /api/auth/register` → `201`-equivalent success JSON with a real user id (first run);
  `409 EMAIL_EXISTS` on rerun against the same data file (expected, confirms persistence).
- `GET /health` → `{"ok":true,"storage_schema":1}`.
- `GET /api/server-info` (direct, with `Origin` header set) → `200` with the full JSON body
  but **no CORS response headers of any kind**.
- `OPTIONS` preflight to `/token?grant_type=password` → never produces an
  `Access-Control-Allow-Origin`; browser aborts the real request before it is sent, so no
  WebSocket upgrade was ever attempted in this run.

## Console errors (browser)

See `console-errors.txt`. Representative lines:
```
Access to XMLHttpRequest at 'http://localhost:8787/token?grant_type=password' from origin
'http://127.0.0.1:5183' has been blocked by CORS policy: Response to preflight request
doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on
the requested resource.
[Auth] signInWithPassword: failed {status: undefined, code: -1, message: There was a
network connection problem.}
```

## Regression results (Part G)

Run in `AppFlowy-Independent-Backend`, same baseline as the task's ground truth, no change:
- `npm test` → **32 passed, 0 failed** (identical to stated 32/32 baseline).
- `npm run test:offline-collab` → **5 passed, 0 failed** (identical to stated 5/5 baseline).
- `npm run test:collab-conformance` → **6 passed, 0 failed, 2 pending**
  (`compaction-retention`, `cross-instance-replay`), 5 resolved — identical to stated baseline.

AppFlowy-Web's own Playwright E2E suite was **not run**: given the CORS defect above,
anything in that suite that depends on reaching a locally-run non-cloud backend over HTTP
would hit the identical blocker, and the suite's existing specs are written against a
mocked/cloud (`test.appflowy.cloud`) or Cypress-style intercepted backend, not this
Independent Backend; running the full suite would not have exercised the code under test for
this task and was skipped as "excessive" per the task's own guidance to use judgment.

## Known limitations / defects found (not fixed, per instructions)

1. **CORS defect (blocking, confirmed in a real browser):** `AppFlowy-Independent-Backend/server.js`
   never sets `Access-Control-Allow-Origin` (or answers an `OPTIONS` preflight) on any route.
   Any deployment that serves AppFlowy-Web and this backend on different origins — including
   the exact dev setup this task specifies (`pnpm`/`vite` dev server + a locally-run disposable
   backend on a different port) — is unusable from a real browser. In the project's own
   intended production topology (nginx serving both under one domain) this would not surface,
   but it does surface, immediately and completely, under the real-browser dev/test topology
   this task required, and it is the reason no deeper UI step could be exercised.
2. **`enable_page_history: false` hardcoded, no override (found by source inspection, not yet
   observed live in a browser because of defect 1):** blocks the Document History UI entry
   point entirely for any client of this backend, which is a direct contradiction of Task
   49A/49B's purpose (those endpoints exist and pass HTTP-level tests, but the real frontend's
   gate for showing the UI that calls them is off).
3. Two-browser concurrency behavior (does a stale client detect a restore immediately, stay
   stale until reconnect, or get rejected on write) remains **unverified in a real browser** —
   Task 49A/49B's own analysis (no WebSocket restore-notification frame; staleness caught only
   by generation fencing) is unchanged ground truth, but this task could not independently
   confirm it visually.
4. PostgreSQL real-browser verification: **Not tested**, correctly reported as such rather than
   silently substituting JSON results.
5. Both defects above are reported, not fixed, per this task's explicit instruction not to
   silently patch production code when a real UI workflow fails.

## Stop condition

Per the task's failure-handling instructions, real-browser work stopped after confirming and
documenting the Step 1 CORS blocker (and the compounding `enable_page_history` source-level
blocker). No fix was attempted in `server.js` or anywhere else. No work was done on the
Postgres `uid` fixture bug, compaction-retention, or cross-instance-replay.

---

## Task 49C-R2 (second resumed run, post-Task 51) — real browser history/restore attempt

### Outcome summary

Task 51 fixed the CORS and `enable_page_history` defects that blocked Task 49C-R at
login. This run confirmed login/workspace-shell load again (quick sanity check, not
belabored, per instructions), then attempted to drive deeper into the real Document
History UI. It got further than any prior run, but hit a **new, previously
undocumented, real-browser-reproducible blocker** before any editor/history UI step
could be exercised: **a WebSocket URL path mismatch between AppFlowy-Web's real
client and this backend's WS route**, plus (even after working around that one
defect for diagnostic purposes) the workspace sidebar/outline never finishes loading
real page data, so no document could be opened and none of the 13 single-client
steps, Part C (two-client), or Part D (Postgres) could be executed. Per the task's
own instructions, this defect is **reported, not fixed**, and no further UI driving
was attempted once the second blocker was confirmed.

### Setup (same approach as Task 51, reused)

- Backend: `STORAGE=json`, `PORT=8787`, `HOST=127.0.0.1`, disposable data file under
  the task scratchpad.
- Frontend: AppFlowy-Web's real Vite dev server on `127.0.0.1:5183`, using the
  repo's existing `.env.local` (`APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL`/
  `APPFLOWY_WS_BASE_URL` all pointed at `localhost:8787`).
- Two dedicated test accounts registered via real `POST /api/auth/register`
  (`t49cr2a@example.test`, `t49cr2b@example.test`), for the planned single- and
  two-client parts.
- Real Chromium via Playwright, driving the actual login UI (`login-email-input` →
  `login-password-button` → `password-input` → `password-submit-button`), exactly as
  Task 51 did. **Confirmed again**: login succeeds, lands on `/app/<workspaceId>`,
  `My Workspace` / `Search` / `New page` render. No CORS console errors observed.

### Defect found: WebSocket path mismatch (blocking)

- AppFlowy-Web's real WS client (`src/components/ws/useAppflowyWebSocket.ts:221`)
  builds its connection URL as `` `${wsUrl}/${workspaceId}/?clientId=...&token=...` ``,
  where `wsUrl` comes directly from `APPFLOWY_WS_BASE_URL` (`ws://localhost:8787/ws`
  in the repo's `.env.local`). The real browser was observed opening exactly:
  `ws://localhost:8787/ws/<workspaceId>/?clientId=...&deviceId=...&token=...&cv=0.10.0&cp=web`.
- This backend's `handleUpgrade` (`server.js:1013-1037`) requires the path to be
  `/ws/v2/<workspaceId>` (`pathParts[0] !== 'ws' || pathParts[1] !== 'v2'` → reject
  404; `pathParts.length !== 3` → reject 404). The frontend's actual path has only 2
  segments (`ws`, `<workspaceId>`) — no `v2` segment — so every connection attempt is
  rejected with HTTP 404 during the WebSocket handshake. Playwright's
  `page.on('websocket')`/`socketerror` events captured this directly:
  `Error during WebSocket handshake: Unexpected response code: 404`, repeating on
  every reconnect attempt. The UI shows a permanent "Connecting..." banner.
- Confirmed root cause (not guessed) by reading both sides: `server.js:1029-1037`
  (route requirement) and `AppFlowy-Web/src/components/ws/useAppflowyWebSocket.ts:221`
  (actual URL construction) plus the repo's own `.env.local`
  (`APPFLOWY_WS_BASE_URL=ws://localhost:8787/ws`, no `/v2`).
- **Diagnostic-only workaround used to see if testing could continue** (not a
  production fix, and reverted before finishing): temporarily edited the gitignored,
  local-only `.env.local` to `APPFLOWY_WS_BASE_URL=ws://localhost:8787/ws/v2` and
  restarted the Vite dev server. This did make the WebSocket handshake succeed (no
  more 404/close loop, "Connecting..." banner disappeared) — confirming the path
  mismatch is the sole cause of the WS failure. `.env.local` was restored to its
  original committed-default content immediately after this diagnostic, and no
  repository file was left modified.

### Second blocker found even with the WS path mismatch worked around

With the WebSocket successfully connected, the workspace shell still never finished
loading: the sidebar remained permanently in its loading-skeleton state (no real
`page-item` elements ever appeared, "New page" clicks did not navigate to a new
document), and the browser console showed repeated `404` responses for several
workspace-shell HTTP endpoints (auth-providers, current-user/timezone init, app
trash, favorite views, notifications, "shareWithMe" outline data). Some of these
(trash/favorites/auth-providers/notifications) were already noted as pre-existing,
non-blocking 404 gaps in Task 51's report §5 ("frontend degrades gracefully: login
and workspace load still succeed"); what's new here is that, with the WS layer now
actually working, the **page/outline tree itself never resolves to a usable state in
a real browser**, so no document could be opened and none of steps 1–13 could be
attempted. This was not root-caused further (out of scope for this task — "report
and stop" applies here too), only observed and documented with evidence.

### Single-client 13-step workflow — results

| # | Step | Status |
|---|---|---|
| 1 | Open/create a document via UI | **Blocked** — WS path mismatch (and, after a diagnostic-only workaround, the sidebar/outline-loading issue) prevented any document from ever becoming reachable; `new-page-button` clicks produced no navigation |
| 2 | Edit + save unique marker text | **Not tested** (blocked transitively) |
| 3 | Open Document History via UI | **Not tested** |
| 4 | Create named snapshot via UI | **Not tested** — also note: by source inspection, `DocumentHistoryModal.tsx`'s `useCollabHistory()` (`app.hooks.tsx:457-471`) only exposes `getCollabHistory`, `previewCollabVersion`, `revertCollabVersion` to the modal. `createCollabVersion`/`deleteCollabVersion` exist in the HTTP client (`collab-api.ts:642,661`) but **no UI control in `DocumentHistoryModal.tsx`/`DocumentHistoryVersionList.tsx` calls them** — there is no "create snapshot" or "delete version" button anywhere in the real UI. AppFlowy-Web's own (skipped) `playwright/e2e/editor/version-history.spec.ts` confirms this independently: it creates versions by POSTing directly to the history API, not through any UI control. This is a standing UI-completeness gap, found by source reading, not fixed (out of scope) |
| 5 | Verify snapshot appears in history list DOM | **Not tested** |
| 6 | Preview saved version content | **Not tested** |
| 7 | Modify document further | **Not tested** |
| 8 | Create second snapshot | **Not tested** |
| 9 | Restore earlier snapshot via UI | **Not tested** |
| 10 | Verify restored content in live editor DOM | **Not tested** |
| 11 | Reload page, verify persistence | **Not tested** |
| 12 | Tombstone-delete a version via UI | **Not tested** — same UI-gap caveat as step 4 applies in reverse (delete) |
| 13 | Verify deleted version unlisted/rejected | **Not tested** |

All "Not tested" rows are transitively blocked by step 1, exactly as in the first
49C-R run (which was blocked at login instead). This is a different root cause than
the first run (not CORS — Task 51 fixed that, confirmed again here), but the same
practical outcome: the real Document History UI workflow remains unexercised.

### Part C — two-client concurrency

**Not tested.** Depends on a working single-client document open, which the WS/
outline-loading defects above prevent. No automatic-propagation vs.
recovery-after-reject/reconnect behavior could be observed live in this run. The
underlying ground truth from Task 49A/49B (no WebSocket restore-notification frame;
staleness caught only by existing restore-generation fencing) is unchanged and was
not contradicted by anything observed here — it simply was not independently
re-confirmed live.

### Part D — PostgreSQL browser verification

**Deferred**, not attempted. `docker ps` at the start of this task showed a
`task50-pg` container (`postgres:16-alpine`, port `55432`) already running and
`Up 29 minutes`, consistent with a concurrent Task 50 session actively using
Postgres resources for its own fixture work. Per this task's explicit instruction
("if Task 50 appears to be actively using Postgres resources, DEFER"), no new
disposable Postgres container was provisioned and Part D was not attempted, even
though in principle a container on a different port/name would not have collided.
This is a conservative deferral, not a technical blocker — the actual blocker (WS
path mismatch / outline loading) applies identically regardless of storage backend,
so Postgres verification would not have gotten further than JSON-mode did.

### Evidence collected

Under the task scratchpad (not committed to either repo):
`/private/tmp/claude-501/-Volumes-work-disk-Codes-Tracker/4b89062d-6752-4f90-b9cf-02a3355ce209/scratchpad/t49cr2/`
- `run.js` — the real Playwright script (plain `playwright` package, real Chromium,
  real `getByTestId`/`.fill`/`.click` against the real UI, plus `page.on('websocket')`
  instrumentation).
- `shots/00-sidebar-before-click.png` (and `evidence-stuck-sidebar-after-ws-fix.png`,
  the same stuck-skeleton state captured again after the WS diagnostic workaround was
  applied), `shots/00-bodytext.txt`, `shots/00-wslog.txt` (the WS open/error/close
  sequence, both before and after the diagnostic `.env.local` change).
- `console-errors.txt` — the real browser console 404s for trash/favorites/
  auth-providers/notifications/outline shareWithMe/current-user-timezone.
- `backend.log`, `frontend.log`/`frontend2.log`/`frontend3.log` — stdout/stderr of
  the real backend and the three Vite dev server restarts (default WS URL, one with
  a shell-env override that Vite did not actually pick up, one with the diagnostic
  `.env.local` edit).
- `results.json` — the structured per-step result object the script wrote (mostly
  `"Failed"`/blocked at step 1, as expected given the blockers above).
- `env.local.orig` — the original `.env.local` content, used to restore it exactly
  after the diagnostic workaround.

### Defects found (not fixed, per instructions)

1. **New: WebSocket URL path mismatch (blocking, confirmed live).**
   AppFlowy-Web's real WS client connects to `/ws/<workspaceId>/...` (no `v2`
   segment); `AppFlowy-Independent-Backend/server.js`'s `handleUpgrade` requires
   `/ws/v2/<workspaceId>`. Every real-browser WebSocket handshake against this
   backend therefore fails with 404, and the app is stuck showing "Connecting..."
   forever. This is either a backend route that needs to accept the path the real
   frontend actually sends, or a `.env.local`/deployment configuration default that
   needs correcting (both are plausible fixes; this task does not pick one, per
   instructions not to patch found defects). Confirmed via real Playwright
   `websocket`/`socketerror` events and by reading both the frontend's URL-building
   code and the backend's route-matching code.
2. **New: workspace sidebar/outline never resolves in a real browser even once the
   WebSocket connects** (diagnostically worked around for the WS layer only, not for
   this). The sidebar stays in its loading-skeleton state indefinitely and no page
   can be opened. Root cause not investigated further (out of scope for this task);
   several HTTP 404s were observed in the same session (auth-providers, current-user/
   timezone init, trash, favorites, notifications, outline shareWithMe) that may or
   may not be contributing causes — this is reported as an open question, not a
   diagnosed root cause.
3. **Standing gap, found by source reading (not newly broken, not fixed):** the real
   Document History UI (`DocumentHistoryModal.tsx`) has no control to create a named
   snapshot or tombstone-delete a version — only list/preview/restore are wired to
   UI actions. `createCollabVersion`/`deleteCollabVersion` exist in the HTTP client
   layer and in both backend storage modes (Task 49A/49B) but are unreachable from
   the real UI. Confirmed by reading `app.hooks.tsx:457-471`,
   `DocumentHistoryModal.tsx`, `DocumentHistoryVersionList.tsx`, and cross-checked
   against AppFlowy-Web's own (`test.describe.skip`'d) `version-history.spec.ts`,
   which itself only creates versions via direct API calls.
4. Both defects #1 and #2 are reported here, not fixed, per this task's explicit
   instruction to stop and report rather than patch production code when discovered
   mid-verification.

### Regression (Part E)

Run in `AppFlowy-Independent-Backend`, no changes made to any production file in
this task (the one file temporarily edited, `AppFlowy-Web/.env.local`, is
gitignored/local-only and was restored to its original content before this task
ended):

- `npm test` → **35 passed, 0 failed** (identical to the Task 51 baseline of 35/35).
- `npm run test:offline-collab` → **5 passed, 0 failed** (baseline unchanged).
- `npm run test:collab-conformance` → **passed=6, failed=0, pending=2**
  (`compaction-retention`, `cross-instance-replay`), resolved=5 (identical to
  baseline).

AppFlowy-Web's own Playwright suite was not run broadly; the one directly relevant
existing spec, `playwright/e2e/editor/version-history.spec.ts`, is itself
`test.describe.skip`'d in the repo (comment: requires `window.__TEST_DOC__`/
`window.Y`, dev-build-only globals) and was not un-skipped or run, since doing so
would have hit the same WS/outline blockers documented above and would not have
produced new information beyond what this task already found directly.

### Stop condition

Per the task's failure-handling instructions, UI-driving work stopped after
confirming and documenting the WebSocket path-mismatch defect and the subsequent
sidebar/outline-loading defect. The diagnostic `.env.local` edit used to confirm the
WS defect's root cause was reverted immediately; no `server.js`, no other backend
file, and no other frontend file was modified. No work was done on compaction-
retention, cross-instance-replay, or the Postgres `uid` fixture bug. Part D
(Postgres) was deferred, not attempted, because a concurrent Task 50 session
appeared to be actively using Postgres resources at the time this task ran.

---

## 2026-11-05 — Resume (Task 49C-R3): real-browser verification of document editing and version-history restore, two-client behavior, and a newly identified CORS defect

### Setup

Reused the established Task 51/52/53 pattern, fresh disposable resources:

- Backend: `STORAGE=json`, isolated `DATA_FILE`, `HOST=127.0.0.1 PORT=8790`,
  `CORS_ALLOWED_ORIGINS=http://localhost:5190`, `ENABLE_PAGE_HISTORY=true`.
- AppFlowy-Web: Vite dev server on port 5190 (`node_modules/.bin/vite --port 5190
  --strictPort`), `APPFLOWY_BASE_URL=http://localhost:8790`,
  `APPFLOWY_WS_BASE_URL=ws://localhost:8790/ws/v2`,
  `APPFLOWY_DEV_API_PROXY_TARGET`/`APPFLOWY_DEV_WS_PROXY_TARGET` both pointed at
  the isolated backend.
- A dedicated test account was registered via the real `/api/auth/register` API
  and logged in through the real UI login flow
  (`login-email-input`/`login-password-button`/`password-input`/
  `password-submit-button`).
- `docker ps` was checked before starting: `task50-pg` (port 55432) was present
  and was never touched, started, stopped, or queried. No new Postgres container
  was started for this resumption (JSON-mode only; Postgres parity for the
  version-history endpoints was already covered in Task 49A/49B and not
  re-verified here).
- All Playwright driver scripts used for this verification were written to
  temporary `.mjs` files inside the backend's working directory (for Playwright's
  module resolution) and deleted after use; no permanent test files were added.

### New finding: a real, reproducible backend CORS-allowlist defect — not the "client-side cancellation artifact" Task 53 suspected

Task 53 observed `net::ERR_FAILED` on `GET .../view/{id}?depth=1` after creating a
space, hand-verified with `curl` that the identical request succeeded, and
concluded (tentatively) it was a client-side request-cancellation artifact from
rapid scripted clicks. **That hypothesis was wrong.** Reproducing the same flow
here with full request/response console logging (not just a `requestfailed`
listener) surfaced the real cause:

```
Access to XMLHttpRequest at 'http://localhost:8790/api/workspace/<ws>/view/<id>?depth=1'
from origin 'http://localhost:5190' has been blocked by CORS policy: Request header
field cache-control is not allowed by Access-Control-Allow-Headers in preflight response.
```

Confirmed definitively with a raw preflight `curl`:

```
curl -i -X OPTIONS ".../view/<id>?depth=1" -H "Origin: http://localhost:5190" \
  -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: cache-control"
→ 204, Access-Control-Allow-Headers: Content-Type, Authorization, If-Match,
  X-Development-Key, X-Platform, X-Device-Id, Client-Version   (no cache-control)
```

Root cause: `server.js`'s `CORS_ALLOWED_HEADERS` constant (line 20) is a fixed
allowlist that does not include `Cache-Control`. AppFlowy-Web's
`atomic-creation-api.ts` (`atomicRead`, ~line 160) and two other call sites
(`collab-api.ts:81`, `database-history-api.ts:116`) deliberately send
`Cache-Control: no-cache` on uncached reads — specifically the read-back that
happens immediately after creating a new page/space/document via the "atomic
creation" flow. Because the browser's CORS preflight rejects that header, the
actual GET is never sent, the frontend never learns the ID of the thing it just
created, and `openPageModal()`/`ensureViewVisibleInOutline()` never navigate to
it — this is **why clicking "New page" → select space → Add never opened the new
document in Task 53's and this task's scripted runs**, not request
cancellation. `curl` (which never sends a CORS preflight) was always going to
succeed regardless, which is why that verification method could not detect this
root cause.

A second instance of the same defect class was found in Part 3 below (see
below): the `device-id` header sent on `POST
.../collab/full-sync/batch` is also not in `CORS_ALLOWED_HEADERS` (which only
lists `X-Device-Id`, a different header name, not a casing variant). Confirmed
the same way:

```
curl -i -X OPTIONS ".../collab/full-sync/batch" -H "Origin: http://localhost:5190" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: device-id,content-type"
→ 204, Access-Control-Allow-Headers: ... X-Device-Id ...   (no device-id)
```

**This is reported as a real, newly clarified production defect, not fixed.**
Per the task's stop-on-new-defect instruction, no change was made to
`CORS_ALLOWED_HEADERS`, `server.js`, or any other production file. The practical
effect: the real browser UI's own "create a new page" flow cannot reliably open
the page it just created (the page IS created server-side — confirmed via direct
`GET .../view/{spaceId}` showing the new document as a child — but the client
never discovers this because its own read-back request is blocked). This is a
superset of, and the real explanation for, Task 53's "unrelated issue observed."
Whoever owns the CORS allowlist should add `Cache-Control` and `Device-Id` (and
audit for other headers the frontend actually sends vs. what is allowlisted,
since this defect class could recur for any header added to a future frontend
request).

### Part 1 — Document open and edit (unknown #1)

Because the defect above blocks the browser-driven "New page" creation flow from
ever landing on the new document, a document was created via one direct,
clearly-labeled API call (`POST /api/workspace/{id}/v2/page-view/document/default`,
the same contract the frontend itself uses, exercised directly instead of via a
UI click that cannot complete) so that the **opening, editing, and persistence**
questions — the actual subject of unknown #1 — could still be verified end to
end through genuine UI interaction:

| Step | Result |
|---|---|
| Create a space via real UI (`new-page-button` → `Create a new space` → fill name → `Create`) | PASS — space created and persisted (visible after reload). |
| Create a document inside that space | **Blocked by the CORS defect above when driven via the "New page" UI flow.** Worked around via one direct API call to the same creation endpoint the frontend uses, clearly labeled as a workaround, not a UI click. |
| Open the document via real UI (navigating to its URL, as a user clicking it in the sidebar would) | PASS — editor rendered, title and empty body visible. |
| Edit with a real UI interaction (click into body, type a unique marker string via `page.keyboard.type`) | PASS — `TASK54-BODY-MARKER-ABC123` appeared in the live editor DOM immediately. |
| Reload the page | PASS — marker persisted in the DOM after a full page reload (fresh Yjs sync from server, not local cache). |

**Conclusion for unknown #1: yes, a document can be opened, edited, and the edit
persists, through real UI interaction — but document *creation* through the UI's
own "New page" flow is currently broken by the CORS defect above and had to be
worked around with one direct API call to reach a document to test with.**

### Part 2 — Document History restore correctness (unknown #2)

`DocumentHistoryModal.tsx` was re-read and confirmed unchanged from the Task
49C-R2 finding: list (`getCollabHistory`), preview (`previewCollabVersion`), and
restore (`revertCollabVersion`) are wired to real UI controls; creating a named
snapshot and tombstone-deleting a version have no UI entry point anywhere in the
component tree. Those two steps were done via direct, clearly-labeled API calls
to the same Task 49A/49B endpoints; every other step was driven through the real
UI (opening history via the page's `...` menu → "Version history", per
`MoreActions.tsx`).

| Step | Method | Result |
|---|---|---|
| 1. Edit document, create a snapshot ("Milestone A") | Edit: UI. Snapshot-create: **direct API** (no UI control exists) | PASS |
| 2. Snapshot appears in history list | UI (`version-history-modal`) | PASS — "Milestone A" visible in the sidebar list. |
| 3. Preview snapshot content matches what was saved | UI (clicking the version renders it read-only in the modal's editor pane) | PASS — preview pane showed exactly `TASK54-BODY-MARKER-ABC123`. |
| 4. Edit again, create a second snapshot ("Milestone B") | Edit: UI. Snapshot-create: **direct API** | PASS |
| 5. Restore the first (earlier) snapshot | UI (`Restore` button in the history modal) | PASS |
| 6. Restored content appears in the live editor DOM | UI/DOM inspection | PASS — DOM showed `ABC123` content and no longer showed the second edit's `XYZ789` marker, immediately after clicking Restore, with the modal closed. |
| 7. Reload the page, verify restore persists | UI | PASS — same content present after a full reload. |
| 8. Tombstone-delete a version, verify it disappears from normal history listing | Delete: **direct API** (no UI control). Verify: UI | PASS — "Milestone B" no longer listed in the history modal; "Milestone A" still listed. |

**Conclusion for unknown #2: yes, the existing Document History UI restores
versions correctly** — list, preview, and restore are genuinely wired and
functionally correct end to end, confirmed via real DOM state (not just a
successful API response), across an edit → snapshot → edit → snapshot → restore
→ reload cycle. Snapshot-creation and tombstone-delete remain UI gaps (as found
in 49C-R2), not restore-correctness defects.

### Part 3 — Two-client restore behavior (unknown #3)

Two independent Playwright browser contexts (`ctxA`, `ctxB`), same test account
(sharing/collaborator grants remain unimplemented per Task 53), both opened the
same document and both stayed connected over their own WebSocket the entire
time (neither was reloaded or disconnected before the restore).

| Step | Observation |
|---|---|
| Both contexts load the same initial content | PASS — both showed `ABC123`. |
| Context A edits the doc, a new snapshot is created ("Milestone C", direct API) | PASS |
| Context A restores "Milestone A" via the real UI | PASS — A's own DOM reflects the restored content immediately. |
| Context B, **without reloading or reconnecting**, observed 3s later | B's DOM **already showed the restored (`ABC123`) content**, not A's edit and not the content B itself never typed. |
| Context B then types a new edit (`CLIENT-B-STALE-WRITE`) while still on its original connection | The edit was accepted and appeared in B's DOM; after reloading B, the edit was still present (not rejected, not lost). |

**This is an important, precise distinction from the architecture notes supplied
for this task.** Those notes described the mechanism as "no WebSocket
restore-notification frame exists; stale clients are caught only by
restore-generation fencing (reject + must reconnect/resync to recover)" — i.e.
the expectation was that a connected-but-not-reloaded client would *not* see the
change automatically. What was actually observed here is that because Context
B's WebSocket connection **remained open and live** throughout (it was never
disconnected, never went offline, never had its connection interrupted), the
server-side revert — which is applied as an ordinary durable document-state
change, the same way any edit is — propagated to B automatically through the
**existing, ordinary Yjs/WebSocket sync channel that was already carrying normal
collaborative updates**, not through any dedicated "restore" notification frame
(none was observed on the wire; B's own edit succeeded immediately afterward
with no rejection, which would not have happened had B still been holding a
stale generation). In other words: **for a client that stays connected the whole
time, propagation of a restore is effectively automatic** (via the ordinary live
sync path), **not** limited to "must reject-then-reconnect to recover" — that
reject/reconnect path (Task 49A's restore-generation fencing, already covered by
existing automated tests) is specifically for a client that was genuinely
offline/disconnected across the restore and is catching up afterward, a scenario
this task's two-live-connected-contexts setup did not actually exercise. This
task did not attempt to force a genuinely offline/stale-generation scenario in
the browser (e.g. intercepting and dropping the WebSocket mid-session) — doing
so robustly in Playwright would be a separate, larger piece of work, and the
reject/stale-generation path is already covered by Task 49A's direct backend
tests (`test/backend.test.js`, "rejects stale-generation updates").

A genuine CORS defect (the `device-id` header gap described above) was also
observed firing during this flow, on `POST .../collab/full-sync/batch` — further
evidence for, and in the same defect class as, the `Cache-Control` finding
above; not separately chased or fixed.

**Conclusion for unknown #3:** automatic propagation of a restore to an
already-connected second client **does happen** in practice, through the
ordinary live sync channel — this differs from the "expected: no automatic
propagation" framing in the task's setup notes, which more precisely describes
the behavior for a client that was actually disconnected across the restore (a
scenario not exercised here). The reject-then-reconnect generation-fencing path
exists and is covered by existing automated tests, but was not the path observed
for a live-connected stale client in this real-browser run.

### Regression

- `npm test`: **37/37 pass** (unchanged from the Task 53 baseline; no test added
  or weakened this round — this was a verification-only task).
- `npm run test:offline-collab`: **5/5 pass**, unchanged.
- `npm run test:collab-conformance`: **6 passed, 0 failed, 2 pending
  (compaction-retention, cross-instance-replay), 5 resolved** — identical to
  baseline.
- `task50-pg` was never started, stopped, or queried. The commercial AppFlowy
  self-host Docker stack was never touched.

### Stop condition

Per the task's new-defect handling instructions, the CORS-allowlist defect
(`Cache-Control` on view reads, `device-id` on full-sync/batch) was documented
with reproduction evidence (browser console errors, raw `curl -X OPTIONS`
preflight reproduction showing the missing header in `Access-Control-Allow-Headers`,
and the exact source locations: `server.js` line 20 `CORS_ALLOWED_HEADERS`,
`AppFlowy-Web/src/application/services/js-services/http/atomic-creation-api.ts`
~line 160, `collab-api.ts:81`, `database-history-api.ts:116`) but was **not
fixed** — it is a separately scoped fix for whoever owns the CORS allowlist.
Screenshots and console/network logs were captured locally during the run in a
scratch directory (document-open, edit, history list/preview/restore, two-client
behavior) but were not committed as repository artifacts, consistent with prior
tasks' convention.

### Remaining limitations (explicitly deferred, not faked)

1. Snapshot-creation and tombstone-delete have no UI entry point (Task 49C-R2
   finding, reconfirmed unchanged).
2. The CORS-allowlist defect above blocks the UI's own document/space/page
   creation flow from completing its post-creation navigation; a real fix (not
   attempted here) would add the missing headers to `CORS_ALLOWED_HEADERS` and
   audit for any others the frontend sends that aren't yet allowlisted.
3. A genuinely offline/disconnected-then-reconnecting stale client was not
   exercised in the real browser (only a live-connected one); the
   reject-then-reconnect generation-fencing path remains verified only by
   existing direct backend tests, not by this real-browser session.
4. PostgreSQL storage parity for version-history was not re-verified in this
   session (out of scope for this resumption; already covered in Task 49A/49B).
