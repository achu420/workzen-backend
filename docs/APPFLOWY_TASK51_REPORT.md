# Task 51: CORS support and real `enable_page_history` capability flag

## 1. Scope

Task 49C-R's real Chromium testing found two production-code defects in `server.js`:

1. No `Access-Control-Allow-*` headers on any route, and no OPTIONS preflight handling — blocking the browser whenever the frontend and backend run on separate origins (the normal dev/test topology).
2. `GET /api/server-info` hardcoded `enable_page_history: false`, even though Tasks 49A/49B implemented 5 real version-history/restore HTTP endpoints in both JSON and PostgreSQL storage — hiding the Document History UI entry point (`AppFlowy-Web/src/components/app/layers/AppAuthLayer.tsx`) even once CORS is fixed.

This task fixes both, narrowly, in `server.js` only. No collaboration/restore behavior, RID allocation, or storage schema was touched.

## 2. Changes

### 2.1 CORS (`server.js`)

- New config: `CORS_ALLOWED_ORIGINS` (comma-separated env var). Default when unset: `http://localhost:5183, http://127.0.0.1:5183, http://localhost:5173, http://127.0.0.1:5173` (AppFlowy-Web's actual Vite dev ports — `5183` per its `.env.local`/`PORT`, `5173` as Vite's own common default).
- `applyCorsHeaders(req, res, allowedOrigins)`: reflects the request's `Origin` header only when it is a literal match in the allowlist, setting `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. No match → no CORS headers at all (the browser then blocks the cross-origin read client-side, which is the correct secure default). Requests with no `Origin` header (curl, server-to-server) are left untouched and continue to work exactly as before.
- OPTIONS requests are intercepted before the main routing `try` block (and therefore before any auth middleware runs, since preflights carry no auth) and answered with `204`, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization, If-Match, X-Development-Key, X-Platform, X-Device-Id, Client-Version`, and `Access-Control-Max-Age: 600`.
- The header allowlist was derived from actually reading AppFlowy-Web's HTTP client (`src/application/services/js-services/http/core.ts`, `auth-api.ts`, `collab-api.ts`): it sends `Content-Type`, `Authorization`, `X-Platform`, and `Client-Version` on real requests. `If-Match` and `X-Development-Key` are this backend's own existing headers (optimistic-concurrency page updates, the dev test-membership helper).
- **No `Access-Control-Allow-Credentials` header is ever sent.** This backend's auth is Bearer-token-based (`bearer()` reads `Authorization: Bearer <token>`, not a cookie), so credentialed CORS mode is unnecessary. Because credentials are never enabled, there was never a risk of pairing them with a wildcard origin — the allowlist-reflection approach was chosen specifically to make that pairing structurally impossible even if credentials were added later (it only ever reflects a validated, non-wildcard origin).
- WebSocket upgrades are handled by a completely separate function (`handleUpgrade`, bound to the `'upgrade'` server event, not routed through `handler`); nothing in the CORS change touches it. A smoke test confirms a real WebSocket connection still completes after the CORS middleware runs ahead of the HTTP handler.
- `CORS_ALLOWED_ORIGINS` and `ENABLE_PAGE_HISTORY` are also accepted as `createApp`/`startServer` options (`corsAllowedOrigins`, `enablePageHistory`) for tests, consistent with how other config (`devKey`, `databaseUrl`) is already threaded through.

### 2.2 Capability flag (`server.js`)

- `enable_page_history` in `/api/server-info` now reports `options.enablePageHistory ?? config.enablePageHistory`, where `config.enablePageHistory` defaults to `true` and can be forced off with `ENABLE_PAGE_HISTORY=false`.
- Both JSON (`storage.js`) and PostgreSQL (`postgres-storage.js`/`postgres-collab-repository.js`) modes implement the same 5 history/restore routes against the same `store` interface used by `server.js`, so the flag is storage-mode-agnostic by construction — there is no code path where one storage mode has the routes and the other reports the flag differently.
- No licensing/`isPro` gate exists anywhere in this backend for history/restore (confirmed by grep across `server.js`, `storage.js`, `postgres-storage.js`, `postgres-collab-repository.js`); the `isPro` gate Task 48 found is purely a frontend chart-feature concept (`AppFlowy-Web/src/components/database/components/settings/chart/...`), unrelated to page history. Nothing was bypassed — there was simply no backend gate to respect.

## 3. Testing evidence

### 3.1 Automated tests added (`test/backend.test.js`)

Three new tests, all against real HTTP responses (no source-string checks):

1. **`CORS: allowed origin receives CORS headers, disallowed origin does not, and OPTIONS preflight is answered`** — asserts: an allowed origin gets the correct `Access-Control-Allow-Origin` and no `Access-Control-Allow-Credentials`; a disallowed origin gets neither CORS header (though the request still succeeds server-side — the browser is what blocks it); a request with no `Origin` header still works and gets no CORS headers; an OPTIONS preflight to a real protected route (`/api/workspaces`) returns 204/200 with the correct `Allow-Methods`/`Allow-Headers` (including `x-platform` and `client-version`, matching the real frontend client); a disallowed-origin preflight gets no CORS authorization; and existing register/login/`/api/auth/me` auth flows still work unaffected by the new CORS layer.
2. **`CORS: WebSocket upgrades are unaffected by CORS middleware`** — opens a real `ws://` connection through the same server and confirms it completes without the CORS middleware interfering (the full WebSocket test suite elsewhere in the same file — 20+ tests — independently re-verifies this at a deeper protocol level and all still pass).
3. **`capability flag: enable_page_history reports true by default and can be overridden via ENABLE_PAGE_HISTORY=false`** — asserts the default is `true`, and that a second server instance started with `enablePageHistory: false` reports `false`, proving the override path is respected rather than silently bypassed.

The pre-existing `AppFlowy-Web server info and workspace bootstrap...` test's assertion was updated from `enable_page_history === false` to `=== true` to match the corrected default (this is the only pre-existing assertion changed anywhere in the test suite; nothing was weakened).

### 3.2 `npm test` result

```
tests 35
pass 35
fail 0
```
(32 pre-existing + 3 new; baseline was 32/32.)

### 3.3 `npm run test:offline-collab`

```
tests 5
pass 5
fail 0
```
Unchanged from baseline.

### 3.4 `npm run test:collab-conformance`

```
passed=6
failed=0
pending=2
skipped=0
resolved=5
```
Identical to the documented baseline (compaction-retention and cross-instance-replay still correctly pending; nothing regressed).

### 3.5 Real `curl` evidence

```
$ curl -s -i -H "Origin: http://localhost:5183" http://127.0.0.1:8787/api/server-info
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://localhost:5183
Vary: Origin
content-type: application/json; charset=utf-8
...
{"code":0,"message":"success","data":{"version":"0.1.0","enable_page_history":true,"enable_atomic_creation":true,"enable_atomic_creation_defaults":true,"self_hosted":true,"ai_enabled":false}}

$ curl -s -i -H "Origin: http://evil.example.test" http://127.0.0.1:8787/api/server-info
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
(no Access-Control-Allow-Origin header)

$ curl -s -i -X OPTIONS -H "Origin: http://localhost:5183" -H "Access-Control-Request-Method: POST" http://127.0.0.1:8787/api/workspaces
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:5183
Vary: Origin
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, If-Match, X-Development-Key, X-Platform, X-Device-Id, Client-Version
Access-Control-Max-Age: 600
```

### 3.6 Real browser evidence (Part E)

Disposable JSON-mode backend started on `127.0.0.1:8787` (matching AppFlowy-Web's `.env.local` `APPFLOWY_BASE_URL`), disposable data file, a dedicated test account (`task51@example.test`) registered via `/api/auth/register`. AppFlowy-Web's real Vite dev server started on `127.0.0.1:5183` (its configured dev port). Real headless Chromium (Playwright, already installed) drove the actual login UI end to end — not a stub:

| Check | Status | Evidence |
|---|---|---|
| Frontend can communicate with backend | PASS | Real cross-origin XHR/fetch requests from `127.0.0.1:5183` to `localhost:8787` succeeded (confirmed via Playwright's `response` event log) |
| Login succeeds through the actual UI | PASS | Filled the real "Continue with password" email/password form, clicked submit, landed on `/app/<workspace-id>` |
| Workspace loads | PASS | Page body shows "My Workspace", "Search", "New page" (the real app shell) |
| Browser console has NO CORS failures | PASS (after one follow-up fix) | First pass surfaced two real CORS console errors — `x-platform` and later `client-version` were sent by AppFlowy-Web's real HTTP client but missing from the preflight allowlist. Both were added (not guessed: confirmed by reading `core.ts`/`auth-api.ts`/`collab-api.ts`) and a clean re-run showed `CORS_ERRORS: []` |
| `/api/server-info` returns expected capability | PASS | `enable_page_history: true` delivered with correct CORS headers over the real cross-origin request |
| Document History entry point becomes visible when enabled | NOT DIRECTLY EXERCISED (see limitations) | The flag itself was confirmed delivered correctly; navigating into a Document and opening its History menu was out of scope per the task instructions ("do not attempt the full version-history UI workflow") |

This real-browser run also incidentally confirmed why 49C-R hit the CORS bug in the first place: AppFlowy-Web's Vite dev config (`vite.config.ts`) only proxies `/api`/`/ws` to a local AppFlowy-Cloud-shaped backend on ports 8000/8100; against our backend's port (8787) the frontend's axios client uses the configured `APPFLOWY_BASE_URL` directly as an absolute cross-origin base URL, bypassing Vite's proxy entirely — exactly the real dev/test topology the task description describes.

### 3.7 Tests not executed, and why

- PostgreSQL-mode `enable_page_history` was not verified against a live PostgreSQL instance in this task (no disposable cluster was started). It is verified by code structure instead: `enable_page_history` is computed in `server.js` independently of `storage` mode (it reads `config.enablePageHistory`, not anything storage-specific), and the same 5 history/restore routes dispatch to whichever `store` was opened by `openStore(..., { storage })` — so there is no code path that could make PostgreSQL mode report a different value than JSON mode for the same config. `npm run test:postgres` was not run (out of scope; a possible concurrent Task 50 is touching Postgres fixtures and was explicitly not to be disturbed).
- The full AppFlowy-Web Playwright suite (hundreds of specs) was not run; only the targeted real-browser login/CORS/capability check described above was performed, per the task's explicit scope limit.
- The full Document version-history workflow (create/preview/restore from the UI) was intentionally not exercised — that is Task 49C-R's job to re-run separately.

## 4. Security considerations

- **Wildcard + credentials was never a risk here**: credentials are never enabled (Bearer-token auth only), and even so, the implementation never reflects `*` — it only ever echoes a literal, allowlisted `Origin` value back, which is safe regardless of credential mode.
- **Allowlist is explicit and configurable**: `CORS_ALLOWED_ORIGINS` env var, comma-separated, consistent with other env-driven config in this repo (`HOST`, `PORT`, `STORAGE`, `DATABASE_URL`). An unset env var falls back to a conservative local-dev-only default (common Vite ports), never to `*` and never to "allow everything."
- **Preflight is answered before authentication** so that legitimate preflights (which never carry credentials/tokens) are not rejected by `requireUser`/`requireWorkspace`, while non-preflight requests continue to go through the exact same, unmodified auth checks as before — CORS headers are purely additive response headers and do not bypass any `requireUser`/`requireWorkspace` call.
- **`Vary: Origin`** is set whenever an origin is reflected, so any caching layer in front of this server (none currently exists, but if one is added later) cannot serve one origin's CORS-approved response to a different, unapproved origin.

## 5. Remaining limitations

- CORS behavior for the production deployment topology (a real public frontend origin) is not yet configured — operators must set `CORS_ALLOWED_ORIGINS` explicitly for their deployment; the shipped defaults are dev-only.
- `/api/server-info/auth-providers`, `/api/error-messages`, `/api/user/update`, workspace `favorite`/`trash`/`database` listing, and workspace sharing routes returned 404 during the real browser run — these are pre-existing gaps unrelated to Task 51's two defects (the frontend degrades gracefully: login and workspace load still succeed) and were left untouched, in scope for other tasks.
- PostgreSQL-mode capability reporting is verified by code structure, not by a live-database run (see §3.7).
- Document History UI entry-point visibility itself (clicking into a page and seeing the History menu item) was not driven in the browser, per the task's explicit "do not attempt the full version-history UI workflow" instruction — only the underlying flag delivery was confirmed.
