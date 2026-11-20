# AppFlowy-Web workspace bootstrap: implementation and browser evidence

**Date:** 2026-10-28  
**Status:** Implemented and browser-verified through workspace selection; subsequent workspace view loading remains blocked.

## Contract evidence

The checked-out frontend source was inspected directly. The requested `docs/APPFLOWY_AUTH_COMPATIBILITY_REPORT.md` was not present in the independent-backend checkout; the prior integration boundary was reviewed in `docs/PAGE_SYNC_PATH_DESIGN.md` and the current code was checked against the Web source.

### Server information

- `GET /api/server-info` is called by `getServerInfo` in `AppFlowy-Web/src/application/services/js-services/http/auth-api.ts`.
- The request includes `x-platform: web` and `client-version: WEB_CLIENT_VERSION`; if `version` is absent, the client makes a compatibility retry with `x-platform: app`.
- The response uses the standard `{ code, data, message }` envelope. `enable_page_history` is required by the frontend `ServerInfo` interface; `version`, `self_hosted`, and `ai_enabled` are consumed by version and capability/hosting decisions.
- The backend returns only implemented capability information: `version: "0.1.0"`, `enable_page_history: false`, `self_hosted: true`, and `ai_enabled: false`. It does not advertise atomic creation, page history, or sync limits.

### Workspace bootstrap

- `GET /api/user/workspace` is called by `getUserWorkspaceInfo` in `AppFlowy-Web/src/application/services/js-services/http/user-api.ts`; the AppAuthLayer invokes this on authenticated startup.
- The client expects `{ code, message, data: { user_profile: { uuid }, visiting_workspace, workspaces } }`.
- Each workspace is mapped from fields `workspace_id`, `owner_uid`, `owner_name`, `workspace_name`, `icon`, `created_at`, `member_count`, `database_storage_id`, and optional `role` by `workspace-api.ts`.
- Both routes use GET and return the AppFlowy API response envelope on success. Workspace bootstrap requires a valid bearer session; no membership-scoped rows produces an explicit `404 NO_WORKSPACE` rather than an invented workspace.
- `POST /api/auth/register` is the explicit provisioning path. It atomically persists the new user, a named initial workspace, and its owner membership. The JSON store uses one atomic file mutation; PostgreSQL uses one transaction. Each workspace and storage namespace gets a persisted ID. Workspace responses are built from the authenticated user's actual membership rows.

## Implementation

Changed files:

- `server.js` — implements `/api/server-info` and authenticated `/api/user/workspace`; registration provisions a persisted starter workspace with the owner membership; profiles expose the stable numeric user UID used by workspace owner data.
- `storage.js` — atomically provisions user/workspace/membership together and returns workspace rows scoped to memberships with real member counts.
- `postgres-storage.js` and `migrations/001_initial.sql` — persist numeric UIDs and workspace display/storage identifiers; add transactional user/workspace/owner-membership provisioning and membership-scoped bootstrap queries.
- `test/backend.test.js` — covers capability response, authenticated workspace bootstrap, provisioned workspace fields, workspace membership isolation, missing/invalid token, no-workspace response, and prior auth/page behavior.
- `openapi.yaml` — documents server-info and workspace bootstrap routes and registration provisioning.
- `README.md` — describes the partial frontend adapter and unsupported outline/collaboration behavior.
- `docs/AGENT_HANDOVER.md` — records Task 27 behavior and current browser blocker.

No AppFlowy-Web files were changed. No shared database, Redis, Docker resource, or commercial service was accessed.

## Verification

`npm test` in the independent backend: **passed**, 7 tests, 0 failures. The tests use isolated temporary JSON data and an ephemeral loopback port. JavaScript syntax checks for `server.js`, `postgres-storage.js`, and `storage.js` passed. PostgreSQL was not started; the PostgreSQL migration/transaction implementation was not runtime-tested in this task.

The actual checked-out AppFlowy-Web frontend was started with isolated API configuration and used a disposable local account created through the backend registration route. The browser:

1. completed password login;
2. loaded `/api/server-info` successfully;
3. loaded the authenticated profile;
4. loaded `/api/user/workspace` successfully, receiving the registered user's persisted `My Workspace` with `role: "owner"` and `member_count: 1`; and
5. navigated to `/app/4289419a-e09f-4df4-83f6-54ad10577ee3`, the actual selected workspace ID from that response.

The frontend then remained at **“Connecting...”**. A direct browser request to the source-required outline route returned `404 { "error": { "code": "NOT_FOUND", "message": "Route not found" } }`:

```text
GET /api/workspace/4289419a-e09f-4df4-83f6-54ad10577ee3/view/4289419a-e09f-4df4-83f6-54ad10577ee3?depth=50
```

The browser also logged a failed WebSocket handshake (`404`) for `/ws/v2/{workspaceId}/?...`; collaboration was not implemented or tested.

The browser showed the existing compatibility warning **“Requires server 0.18.10 or later. Some features may be unavailable.”** because the honest server-info version reported by this prototype is `0.1.0`. This task did not misrepresent the prototype as a newer server release.

## Result and next blocker

The objective of retrieving and selecting a legitimate workspace was met: the browser selected a workspace backed by persisted user, workspace, and owner-membership records. The workspace shell did not fully render because the first page-navigation requirement, the authenticated folder/outline route, is not implemented. The server-version warning and missing WebSocket are also visible limitations; no page content, editor, or synchronization compatibility is claimed.

**One next action:** implement and test the authenticated workspace folder/outline read contract used by AppFlowy-Web, without adding page-content or collaboration behavior in that step.
