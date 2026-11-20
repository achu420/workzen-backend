# AppFlowy-Web workspace folder/outline route

**Date:** 2026-10-28  
**Status:** Implemented and browser-verified through outline retrieval. Page content and collaboration remain unsupported.

## Frontend contract

The checked-out AppFlowy-Web source was inspected:

- `AppFlowy-Web/src/application/services/js-services/http/view-api.ts:14-19` implements `getAppOutline(workspaceId)`. It requests `GET /api/workspace/{workspaceId}/view/{workspaceId}?depth=6`, treats the response payload as a `View`, and exposes `data.children` as the outline. The requested root `viewId` is the workspace ID.
- `view-api.ts:23-25` implements `getView(workspaceId, viewId, depth)` using the same route shape and a depth query parameter.
- `AppFlowy-Web/src/application/types.ts:1941-1965` defines the `View` fields used here: `view_id`, `name`, nullable `icon`, numeric `layout`, nullable `extra`, recursive `children`, optional `has_children`, required `is_published` and `is_private`, and optional timestamps and parent/workspace IDs.
- `AppFlowy-Web/src/application/types.ts:509-522` defines `ViewLayout.Document` as numeric `0`.
- The existing AppFlowy API response wrapper is `{ code, message, data }`. An empty outline is supported by the client: `getAppOutline` maps absent or non-array children to `[]`; this implementation returns the explicit empty array.
- A `View` is folder/navigation metadata, not page content. The client must still retrieve collaboration data and establish its WebSocket sync path to render/edit a page.

## Implementation

Changed files:

- `server.js` — handles the authenticated `GET /api/workspace/{workspaceId}/view/{viewId}` route, validates depth, checks the session and workspace membership, and returns a root or page `View` built from persisted workspace/page records. Root children are deterministically ordered by creation time then page ID. Unknown views return 404; callers without workspace membership receive 403.
- `test/backend.test.js` — covers empty root schema, persisted page metadata and ordering, depth-zero behavior, single-page view lookup, missing/invalid token, unauthorized workspace access, unknown view/workspace IDs, and invalid depth.
- `openapi.yaml` — documents the authenticated outline route and response/error status.
- `README.md` — describes the supported metadata-only outline boundary.
- `docs/AGENT_HANDOVER.md` — records Task 28 behavior, tests, and the next browser blocker.

The route does not create IDs, synthesize page records, return a page document, or claim Yjs/synchronization support.

## Verification

- `npm test` — **passed**, 8 tests, 0 failures.
- `node --check server.js` — **passed**.
- `node --check test/backend.test.js` — **passed**.
- PostgreSQL was not started; this route's PostgreSQL storage path was not runtime-tested.

The real AppFlowy-Web frontend was tested against a second isolated JSON backend and disposable account on loopback ports 50711, 45125, and 45126. No existing manual-test service or data was reused. The browser's actual outline request returned **HTTP 200**:

```text
GET /api/workspace/8ff039e2-5448-4eab-ac20-9f49a22f539d/view/8ff039e2-5448-4eab-ac20-9f49a22f539d?depth=6
```

The response had the AppFlowy envelope and a persisted workspace root with `layout: 0`, `children: []`, `has_children: false`, `is_published: false`, `is_private: false`, and the actual workspace ID/name. The authenticated request `/api/user/workspace` also returned 200. A separate browser-shaped request using `depth=50` returned 200.

The browser advanced past the outline request, but the main view remained at **“Connecting...”**. Captured requests show the next substantive missing collaboration contract:

```text
GET /api/workspace/v1/8ff039e2-5448-4eab-ac20-9f49a22f539d/collab/0fb1e826-1f72-49e8-890f-26c95c2e70ba?collab_type=2  -> 404
WebSocket /ws/v2/8ff039e2-5448-4eab-ac20-9f49a22f539d/...?clientId=...&deviceId=...&token=...  -> handshake 404
```

The Web source for the collab-state read is `AppFlowy-Web/src/application/services/js-services/http/collab-api.ts:68-87`; it expects object identity, binary `doc_state`, `state_vector`, and encoding `version` (optional `collab_version`). The WebSocket consumer is in `src/components/ws/useAppflowyWebSocket.ts`. Neither route was implemented in this task.

Other browser 404s were observed for error-message catalog, favorites, share-with-me, workspace database catalog, trash, and `POST /api/user/update`. These are unsupported ancillary endpoints; this report does not claim their behavior is optional for every frontend flow.

## Result and next action

The authenticated workspace outline contract now passes tests and the actual browser receives its root outline successfully. It does not result in a rendered editable page because collaboration state and WebSocket synchronization are still absent.

**One next action:** define and validate the smallest evidence-backed collaboration-read and WebSocket milestone required by the current frontend before implementing either endpoint.
