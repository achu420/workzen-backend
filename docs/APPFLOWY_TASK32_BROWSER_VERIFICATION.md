# Task 32 — Isolated browser verification

**Date:** 2026-10-28  
**Result:** WorkspaceDatabase read verified in the checked-out AppFlowy-Web browser; workspace startup still stops at the unsupported WebSocket route.

## Safe test setup

- Used the existing AppFlowy-Web checkout without changing its pre-existing modified `vite.config.ts` or untracked files.
- Started only an isolated backend on `127.0.0.1:45210` with `/tmp/appflowy-task32.json`.
- Started Vite on `127.0.0.1:45211`. A process-only Vite plugin injected runtime URLs: AppFlowy API base `http://127.0.0.1:8000` (to activate the existing explicit local API proxy), GoTrue base `http://127.0.0.1:45211/gotrue`, and WebSocket base `ws://127.0.0.1:45211/ws`. A test-only proxy sent `/gotrue/*` to the isolated backend and stripped the `/gotrue` prefix. The Vite API and WebSocket proxy overrides both targeted port 45210.
- Created and used only a disposable account, `task32-browser@example.test`, in the isolated JSON store. No real credentials or user data were used.
- The prior setup's `/gotrue` path proxied to `localhost:9999`; this test did not use that service. The commercial service was neither modified nor stopped.

## Browser network evidence

The actual checked-out Web app completed password login through the test-only `/gotrue` proxy, then made these successful requests to the independent backend:

| Request | Status |
|---|---:|
| `POST /gotrue/token?grant_type=password` (proxied to backend `/token`) | 200; browser proceeded into authenticated workspace |
| `GET /api/user/verify/{accessToken}` | 200 |
| `POST /gotrue/token?grant_type=refresh_token` (proxied to backend `/token`) | 200; token refresh completed as part of login |
| `GET /api/server-info` | 200 |
| `GET /api/user/profile` | 200 |
| `GET /api/user/workspace` | 200 |
| `GET /api/workspace/{workspaceId}/view/{workspaceId}?depth=6` | 200 |
| `GET /api/workspace/v1/{workspaceId}/collab/{databaseStorageId}?collab_type=2` | 200 |

The actual collaboration response was:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "object_id": "f96b2bc4-5a83-4de8-ba25-808fe813831f",
    "doc_state": [1, 1, 142, 206, 200, 139, 7, 0, 39, 1, 4, 100, 97, 116, 97, 9, 100, 97, 116, 97, 98, 97, 115, 101, 115, 0, 0]
  }
}
```

The object ID matched the `database_storage_id` from the authenticated workspace response. The checked-out Web client consumed the response and proceeded to establish its collaboration WebSocket; no Yjs decode/application error was observed for `doc_state`.

## Remaining browser blocker

The next required request was the actual browser's:

```text
GET ws://127.0.0.1:45211/ws/eb0ecf08-4763-4009-920f-d249462d25f5/?clientId=...&deviceId=...&token=...&cv=0.10.0&cp=web
```

It failed its WebSocket handshake with **HTTP 404**. The app remained at **“Connecting...”**. Other unsupported auxiliary requests also returned 404 (sharing outline, favorites, trash, error messages, and user metadata/timezone); none is claimed implemented. This task did not add or simulate any WebSocket behavior.

## Cleanup and verification

- Stopped only the Task 32 backend and Vite processes on ports 45210 and 45211.
- Removed `/tmp/appflowy-task32.json`.
- Left all pre-existing/manual-test and commercial service processes untouched.
- `npm test` — **PASS**, 9 tests, 0 failures.
- `npm run test:offline-collab` — **PASS**, 5 tests, 0 failures.
- `npm run test:collab-conformance` — **PASS for confirmed vectors**, 6 passed, 0 failed, 7 pending.

## Acceptance status

1. Isolated authentication without commercial GoTrue — **PASS**.
2. Browser reaches the independent backend through workspace bootstrap — **PASS**.
3. Actual WorkspaceDatabase request succeeds and its state is accepted by the frontend — **PASS**.
4. Next browser blocker identified from network evidence — **PASS**: WebSocket handshake 404 at `/ws/{workspaceId}/`.
5. Backend regression tests still pass — **PASS**.
6. Task-created processes and temporary data cleaned — **PASS**.

The browser confirmed this one collaboration read, not successful editor startup or full AppFlowy-Web compatibility.
