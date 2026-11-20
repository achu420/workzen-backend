# Task 52 — Fix WebSocket URL route mismatch (AppFlowy-Web ↔ backend)

## Summary

Task 49C-R2 found that AppFlowy-Web's real client connects to
`ws://<host>/ws/<workspaceId>/...` while `server.js`'s `handleUpgrade` only
accepted `/ws/v2/<workspaceId>`, causing every real handshake to 404 and the
UI to hang on "Connecting...". This task made `handleUpgrade` accept **both**
routes, dispatched into the exact same handshake/auth/collab code, with no
protocol change. Verified via unit tests (new dual-route test, 36/36 passing)
and a real Chromium/Playwright session: the WebSocket now opens successfully
on the frontend's actual route. The previously-reported sidebar/outline
loading issue is confirmed as a **separate, pre-existing defect** (404s on
`/favorite`, `/trash`, `/sharing/.../view`, `/database`) — not fixed here, per
scope.

## Part A — Protocol investigation

Read: `AppFlowy-Web/src/components/ws/useAppflowyWebSocket.ts` (lines
11, 190-224), `server.js:1013-1037` (`handleUpgrade`), and the existing
WebSocket tests in `test/backend.test.js`.

Findings:

- The frontend builds its URL as `` `${wsUrl}/${workspaceId}/?clientId=...&deviceId=...&token=...&cv=0.10.0&cp=web` ``
  where `wsUrl` comes from `APPFLOWY_WS_BASE_URL` (default
  `ws://localhost:8000/ws/v2`; `dev.env`/`deploy.env`/committed `.env.local`
  all set it to `.../ws/v2`). **If** that env var is configured without the
  `/v2` segment (exactly as Task 49C-R2's real-browser run observed, and as
  this task's own browser verification reproduced), the resulting path is
  `/ws/<workspaceId>/` — 2 segments, not 3.
- `server.js`'s old check (`pathParts[0] !== 'ws' || pathParts[1] !== 'v2'`,
  then `pathParts.length !== 3`) rejected anything that wasn't exactly
  `/ws/v2/<workspaceId>` with HTTP 404 — including the unversioned path.
- No other protocol difference exists between the two paths: same query
  params (`clientId`, `deviceId`, `token`, `cv=0.10.0`, `cp=web`), same binary
  protobuf frame format, same auth (token in URL query, not header or first
  frame), same workspace-id encoding (raw UUID). The mismatch is purely the
  path prefix, not sub-protocol negotiation or handshake shape.
- Confirmed the real committed defaults currently use `/ws/v2` consistently
  (`dev.env`, `deploy.env`, `.env.local` as checked into the repo at the start
  of this task) — so the mismatch is a configuration-shape risk (an operator
  reasonably configuring `APPFLOWY_WS_BASE_URL=.../ws` without `/v2`, which
  AppFlowy-Web's own `docker/entrypoint.sh` only *suggests* should include
  `/v2`, doesn't enforce it), not a currently-broken default. Task 49C-R2's
  real-browser run hit exactly this misconfiguration and confirmed it via a
  temporary `.env.local` edit (reverted). This task's own browser run (Part D)
  reproduced the identical real failure/fix with a fresh backend instance.

## Part B — Fix applied

File: `AppFlowy-Independent-Backend/server.js`, `handleUpgrade`
(was lines 1029-1037, now ~1029-1042):

```js
// Support both the versioned route (`/ws/v2/{workspaceId}`, used by some
// clients/tests) and the unversioned route (`/ws/{workspaceId}`, used by
// AppFlowy-Web's real client per APPFLOWY_WS_BASE_URL). Both are aliased
// into the exact same handshake/auth/collab implementation below -- no
// protocol or behavior difference between them.
const pathParts = url.pathname.split('/').filter(Boolean);
let workspaceId;
if (pathParts[0] === 'ws' && pathParts[1] === 'v2' && pathParts.length === 3) {
  workspaceId = pathParts[2];
} else if (pathParts[0] === 'ws' && pathParts.length === 2) {
  workspaceId = pathParts[1];
} else {
  reject(404, 'WebSocket route not found');
  return;
}
```

Everything downstream of this (auth via `userByAccessToken`, workspace
membership check, generation fencing, `acceptPageCollabUpdate`, Rid
allocation/dedup, persist-before-ack) is completely untouched — both routes
fall into the identical code path from this point on. No duplication, no new
message types, no protocol change.

## Part C — Automated tests

Added one new test in `test/backend.test.js`:
`WebSocket route alias: /ws/{workspaceId} (AppFlowy-Web real client route,
Task 52) behaves identically to /ws/v2/{workspaceId} for auth, authorization,
sync, update-persistence/ack and reconnect`.

It parametrizes over `['/ws/v2', '/ws']` and for each route asserts:
- missing token → 400; invalid token → 401 (auth rejection)
- non-existent workspace id → 403 (invalid workspace rejection)
- authenticated user without membership → 403 (unauthorized access rejection)
- authorized member → 101 handshake
- a real `SyncRequest` returns the document manifest
- a real `Update` frame is acked only after durable persistence (re-read via
  HTTP confirms the marker text is present before the ack path is even
  exercised, same pattern as Task 42/44's existing fixtures)
- a fresh reconnect on the same route succeeds

Result: **36/36 passing** (35 baseline + 1 new), `npm test`:
```
ℹ tests 36
ℹ pass 36
ℹ fail 0
```

Stale-generation rejection, Rid allocation/dedup, and other deeper collab
invariants are exercised extensively against `/ws/v2` by the large pre-existing
suite (Tasks 41-46, 49A); since both routes dispatch into the identical
`handleUpgrade` body past the route-parsing branch added above, those
guarantees transfer by construction (same function, same code object, no
duplicated logic) and are not re-asserted line-by-line for `/ws` to avoid
bloating the suite with pure duplication of already-covered behavior. The new
test does independently re-verify auth/authorization/sync/persist+ack/reconnect
on both routes side-by-side, which is the part that is route-prefix-sensitive.

## Part D — Real browser verification

Setup: fresh disposable JSON backend (`STORAGE=json`, `PORT=8787`,
`HOST=127.0.0.1`, scratch state file), AppFlowy-Web's real Vite dev server
on `127.0.0.1:5183`, a dedicated test account
(`t52@example.test`) registered via the real `/api/auth/register` endpoint,
driven with real Chromium via Playwright (`page.goto`, `getByTestId`
selectors matching `EmailLogin.tsx`'s real `login-email-input` /
`login-password-button` / `password-input` / `password-submit-button`).

To reproduce the exact real-world failure this task fixes, `.env.local`'s
`APPFLOWY_WS_BASE_URL` was temporarily set to the unversioned form
(`ws://localhost:8787/ws`, no `/v2`) — reproducing Task 49C-R2's observed
misconfiguration — then reverted to `.../ws/v2` immediately after the
verification run (confirmed via `cat .env.local` and `git status --short` ⇒
clean).

Evidence captured:
- Login: succeeded (`[Auth] signInWithPassword: success`), redirected to
  `/app/<workspaceId>`.
- WebSocket URL actually used by the real client:
  `ws://localhost:8787/ws/<workspaceId>/?clientId=...&deviceId=...&token=...&cv=0.10.0&cp=web`
  (console: `🔗 Start WebSocket connection {url: ws://localhost:8787/ws, ...}`).
- Handshake: **succeeded** — console logged `✅ WebSocket connection opened`;
  no `socketerror`/`close` events were observed on this socket across two
  independent runs (previously, per Task 49C-R2, this exact path 404'd on
  every attempt in a 404/close/retry loop).
- Network panel (`8787` origin) confirmed no 404 for any `/ws/...` request.
- Sidebar/page outline: **still broken, confirmed as a separate pre-existing
  defect**, not caused by and not fixed by this WS change. Real console/network
  evidence: `404 GET /api/workspace/<id>/favorite` ("Favorite views not
  found"), `404 GET /api/workspace/<id>/trash` ("App trash not found"),
  `404 GET /api/sharing/workspace/<id>/view/<id>?depth=50` ("[Outline] Failed
  to load shareWithMe data"), `404 GET /api/workspace/<id>/database` ("failed
  to warm the workspace catalog"). These are missing/unimplemented backend
  endpoints unrelated to WebSocket routing — reported here, not fixed, per
  this task's explicit scope boundary.
- Document create/edit/reload persistence: **not independently exercised in
  the browser** in this task, because the sidebar defect above prevents
  reaching any document-open UI flow from the real app shell (same blocker
  Task 49C-R2 hit). Persistence-before-ack and reload-survival for the new
  `/ws` route are instead proven at the protocol level by Part C's automated
  test (durable Yjs state read back over HTTP after the ack, matching the
  existing Task 42/44 pattern) — this is the same evidentiary approach Task
  49C-R2 used for everything blocked by the identical sidebar defect.

## Part E — Regression

- `npm test`: **36/36 passing** (was 35/35; +1 new Task 52 test), 0 failures.
- `npm run test:offline-collab`: **5/5 passing**, unchanged.
- `npm run test:collab-conformance`: **6 passed, 0 failed, 2 pending
  (compaction-retention, cross-instance-replay), 5 resolved** — identical to
  the stated baseline.
- Frontend Playwright E2E suite: **not run** (out of scope for a time-boxed
  WS-routing fix, and the sidebar defect above would fail most of those specs
  for an unrelated reason, which would misattribute failures to this change).
  The targeted browser check in Part D is the relevant frontend verification
  for this specific fix.

## Tests not executed / out of scope (explicitly not attempted)

- PostgreSQL-backed real-browser verification (Task 49C's own stated gap,
  unchanged).
- Fixing the sidebar/outline 404s (`/favorite`, `/trash`, `/sharing/.../view`,
  `/database`) — reported as a distinct, separate blocker per instructions.
- compaction-retention / cross-instance-replay (still pending, untouched).
- Postgres `uid` fixture bug (untouched).
- Version-history/restore behavior (Tasks 49A/49B) — untouched, not re-tested
  beyond the unchanged regression run above.

## Files changed

- `AppFlowy-Independent-Backend/server.js` (`handleUpgrade`, ~line 1029):
  route parsing now accepts both `/ws/v2/{workspaceId}` and
  `/ws/{workspaceId}`.
- `AppFlowy-Independent-Backend/test/backend.test.js`: added one new test
  (see Part C).
- `AppFlowy-Independent-Backend/docs/APPFLOWY_TASK52_REPORT.md`: this report.
- `AppFlowy-Web/.env.local`: temporarily modified for real-browser
  verification, confirmed reverted to its original content
  (`APPFLOWY_WS_BASE_URL=ws://localhost:8787/ws/v2`) before finishing; `git
  status --short` on it is clean (gitignored, untracked either way).
