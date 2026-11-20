# Task 38 — selected-view navigation hydration

**Result:** Implemented and backend-tested the authenticated `GET /api/workspace/{workspaceId}/view/{viewId}/navigation?depth=N` route. Real-browser verification was **not performed** because this checkout has no browser-automation tool available; this is an environment limitation, not an application failure. The route's necessity for the main page-load path is also narrower than Task 37 described — see "Contract evidence" below.

## Contract evidence

- The checked-out AppFlowy-Web revision is `57bdf395a17a0837baae18435b9653b619dd54ab` (same as Task 37; working tree still carries its pre-existing modified `vite.config.ts` and untracked files, unchanged by this task).
- `getViewNavigation` in [view-api.ts](../../AppFlowy-Web/src/application/services/js-services/http/view-api.ts#L29) issues `GET /api/workspace/{workspaceId}/view/{viewId}/navigation?depth=${depth}` (default `depth=0`) and expects the same `APIResponse<View>` envelope (`{ code, message, data }`) as the existing `getView`/`getAppOutline` routes.
- A second, duplicate client implementation exists in [chat-request.ts](../../AppFlowy-Web/src/components/chat/request/chat-request.ts#L601) (`ChatRequest.getViewNavigation`), used only by `fetchCurrentChatParentScope` ([chat-request.ts:616](../../AppFlowy-Web/src/components/chat/request/chat-request.ts#L616)).
- **The only caller found in the source tree** is `Search.tsx`'s `handleAskAI` ([Search.tsx:74](../../AppFlowy-Web/src/components/app/search/Search.tsx#L74)), which calls `getViewNavigation(currentViewId)` to resolve the current view's ancestor chain before attaching a newly created AI chat beneath the right space/page. The result is consumed by `findAncestors` ([views.ts:21](../../AppFlowy-Web/src/components/chat/lib/views.ts#L21)), which treats the response as a single root `View` node and walks `children` arrays to find the path down to the target `view_id`.
- No caller in `AppPage.tsx`, `useWorkspaceData.ts`, `AppBusinessLayer.tsx`, or any other main page-load/hydration path was found. Grepping `getViewNavigation` across `src` (including `.test.tsx` files) only surfaces the AI-chat scoping path and its tests.
- **Implication:** Task 37's characterization of this route as a general "selected-view navigation hydration" blocker on the ordinary page-load/reload path is not supported by the frontend source. The route exists and the 404 was real, but it is only exercised when the user explicitly asks the in-app AI assistant a question from Search — it does not gate opening, editing, or reloading an ordinary Document. This correction is recorded here and in the handover below.
- `depth` semantics: because the only consumer (`findAncestors`) only needs the ancestor path, `depth=0` is sufficient for that caller; the route's `depth` parameter is otherwise defined identically to the existing `/view/{viewId}?depth=N` route (bounded 0–50, expands the *target* node's own children by that many additional levels), for forward compatibility with a caller that might want the target's children.
- Response shape required: the exact `View` node shape already used by `GET /api/workspace/{workspaceId}/view/{viewId}` (`view_id`, `name`, `icon`, `layout`, `extra`, `children`, `has_children`, `is_published`, `is_private`, `created_at`, `last_edited_time`, `parent_view_id`, `workspace_id`), but nested only along the ancestor chain to the requested view rather than the full breadth of the tree.
- Authentication/authorization: identical to the existing `/view/{viewId}` route — `requireWorkspace` (bearer token + workspace membership), returning 403 for an inaccessible workspace and 404 for a view that does not exist or does not belong to the workspace.
- Data availability: all required data (workspace, space, page records and `parent_view_id` links) is already persisted by the existing JSON/PostgreSQL storage abstraction; no schema change was needed.

## Implementation

- [server.js](../server.js#L83): added `resolveNavigationAncestorChain` (walks `parent_view_id` links from a target space/page view up to the workspace root, with a 64-hop cycle guard), `navigationNodeView` (builds one `View` node for a workspace/space/page, reusing the same field shape as the existing `/view` route), and `buildNavigationTargetChildren` (expands the target node's own children when `depth>0`, same pagination/sort order as the existing route).
- [server.js](../server.js#L716) (new route, added directly after the existing `/view/{viewId}` handler): `GET /api/workspace/{workspaceId}/view/{viewId}/navigation?depth=N`. Validates `depth` (integer 0–50, else 400 `INVALID_DEPTH`), calls `requireWorkspace` (401/403 on auth/membership failure), resolves the ancestor chain (404 `VIEW_NOT_FOUND` if the view is absent or not in this workspace), and returns `appFlowyResponse(navigation)` with the nested `View` tree, root first.
- No changes to `storage.js`, `postgres-storage.js`, migrations, or `collab-protocol.js` — the route only reads existing persisted workspace/space/page records.
- [test/backend.test.js](../test/backend.test.js): added `AppFlowy-Web selected-view navigation returns the authorized ancestor chain`, covering: unauthenticated request (401); a three-level chain (workspace → space → parent page → child page) returned exactly, matching the frontend's expected nested shape; `depth=1` expanding the target page's own children; an unknown view (404); an over-range `depth` (400); and cross-workspace/membership denial (403).

## Verification

| Check | Result |
|---|---|
| `npm test` | **PASS** — 15 passed, 0 failed (14 pre-existing + 1 new navigation test) |
| `npm run test:offline-collab` | **PASS** — 5 passed, 0 failed (unchanged) |
| `npm run test:collab-conformance` | **PASS** — 6 passed, 0 failed, 7 pending (unchanged; same seven pending protocol-semantics vectors as Task 37) |
| PostgreSQL runtime tests | **NOT RUN** — no explicitly configured isolated test database was available in this task, consistent with prior tasks |
| Real browser verification | **BLOCKED** — no browser-automation tool (Chrome extension, built-in browser pane, or computer-use) was available in this execution environment. This is an environment-configuration limitation, not evidence the route fails against a real browser. |

Because browser verification was blocked, the claim that AppFlowy-Web accepts this response shape rests on static contract tracing (above) and the backend regression test's exact match of the `View` shape already proven correct for the sibling `/view/{viewId}` route in Task 27/28/37 browser runs, not on a fresh end-to-end observation.

## Acceptance status

1. **PASS** — Contract established from source: method, path, query parameter, response envelope, and consumption pattern (ancestor-path walk via `findAncestors`) are all traced to exact frontend source lines.
2. **PASS** — Smallest correct change implemented: one new route, three small helper functions, reusing persisted workspace/space/page data; no schema or storage changes.
3. **PASS** — Targeted regression tests added and passing (401/200 nested-chain shape/depth expansion/404/400/403).
4. **BLOCKED** — Real-browser confirmation that the frontend accepts the response and that this was in fact the next blocker on a critical path could not be performed: no browser-automation tool is available in this environment. Separately, source tracing shows this endpoint is reached only from the AI-chat "ask from search" flow, not from ordinary page open/reload — so even a successful browser check here would not, by itself, move the ordinary editing/reload path further than Task 37 already established.
5. **N/A** — No PostgreSQL-specific behavior was touched by this task (reads use the existing in-memory/JSON `store.getSpace`/`store.getPage`/`store.listPages`, same abstraction the PostgreSQL backend already implements; still unverified at runtime per prior tasks).
6. **PASS** — No unrelated endpoints added; no commercial/production services touched; no temporary processes were started in this task (no browser session was opened), so no cleanup was required.

## Document editing and reload recovery

Not independently re-verified in this task (no browser session was run). Nothing in this change touches the Document WebSocket, HTTP full-sync batch, or storage paths exercised by Tasks 36/37; those code paths are untouched here.

## Next blocker

Source tracing (not browser evidence) indicates the ordinary Document open/reload path has **no remaining 404 dependency on `/navigation`** — that endpoint is reachable only from Search's "ask AI" action. The actual next blocker for the ordinary page-load path, if any, was not re-observed in this task because browser verification was blocked; re-running the Task 32/35/36/37-style isolated browser check (with a working browser-automation tool) is the concrete next step to find it.

## Required final response

1. **What changed and why:** Added a navigation-ancestor-chain endpoint to satisfy the exact contract the checked-out frontend's `getViewNavigation`/`ChatRequest.getViewNavigation` clients use, reusing persisted workspace/space/page data with no schema change.
2. **Exact files modified:**
   - `server.js` (new route + three helper functions)
   - `test/backend.test.js` (new regression test)
   - `docs/AGENT_HANDOVER.md` (updated)
   - `docs/APPFLOWY_TASK38_NAVIGATION_HYDRATION_REPORT.md` (new, this file)
3. **Tests run and results:** `npm test` 15/15 PASS; `npm run test:offline-collab` 5/5 PASS; `npm run test:collab-conformance` 6 PASS/0 FAIL/7 PENDING; PostgreSQL runtime tests NOT RUN (no isolated database configured).
4. **Real browser outcome:** BLOCKED — no browser-automation tool available in this environment; not attempted.
5. **Document editing and reload recovery:** Not re-verified this task (no browser session run); code paths for WebSocket/HTTP-batch sync are unmodified.
6. **Next single blocker:** Unknown with browser evidence; source tracing shows `/navigation` is not on the ordinary page-load critical path, so the real next blocker needs a fresh isolated-browser trace once a browser tool is available.
7. **PostgreSQL behavior remaining unverified:** All of it, as in every prior task — no isolated PostgreSQL test database was configured in this environment.
