# Task 34 — AppFlowy-Web space bootstrap

## Result

The checked-out frontend's empty-space blocker is resolved for its default public-space flow. A space is created as persisted workspace data, appears in the workspace outline and New Page chooser, and is not fabricated in the response. Page creation remains unsupported.

## Verified frontend contract

- `NewPage.tsx:21,247` opens `CreateSpaceModal` with an initial Document page when the user chooses **Create a new space** from the empty New Page chooser.
- `CreateSpaceModal.tsx:39,170,521-558` defaults new spaces to Public and sends `name`, `space_icon`, `space_icon_color`, `view_id`, and structured `permission` settings.
- `page-api.ts:322-380` uses `POST /api/workspace/{workspaceId}/spaces` when `permission` is present. It expects `APIResponse<{ view_id: string }>` and strips the client-only retry marker. `POST /api/workspace/{workspaceId}/space` is only a legacy fallback after the structured route is reported unsupported, and only when the permission can be represented losslessly.
- `workspace-api.ts:244-247` defines a separate `GET /api/workspace/{workspaceId}/spaces` returning `Spaces`, whose shape is `{ spaces: SpaceListItem[] }` (`types.ts:1744-1756`). No production call site uses that list API in this flow; `NewPage` derives selectable spaces from the workspace outline.
- The default Public permission uses `owner_access_level: 50`, `member_default_access_level: 30`, `invite_policy: "owners_only"`, `sidebar_edit_policy: "owners_only"`, and the default false security flags (`spaceVisibilityOptions.ts`, `types.ts:2745-2749`).
- Default page creation is separately guarded: `owner.ts:51-60` requires both `enable_atomic_creation` and `enable_atomic_creation_defaults`.

The `GET /spaces` listing contract is not needed for this browser path. The current checked-out flow needs the structured `POST /spaces`; the legacy `POST /space` fallback is not used after that route succeeds.

## Implementation

- Added authenticated `POST /api/workspace/{workspaceId}/spaces`. It verifies workspace membership, validates the requested ID/name and the frontend's default Public permission, persists the space, and returns `{ code: 0, message: "success", data: { view_id } }`.
- Added JSON and PostgreSQL storage for spaces, including idempotent same-request retries and a new `002_spaces.sql` migration.
- Included persisted spaces in root outline responses as `extra.is_space: true` and support for reading the space outline view.
- Private and Custom permission settings are explicitly rejected. Their membership/access-control behavior is not implemented, so accepting them would misrepresent authorization.
- Did not add the legacy `/space` route: the checked-out flow does not call it once structured creation succeeds.

## Browser verification

The isolated test used backend `127.0.0.1:45210` with disposable JSON data and AppFlowy-Web at `localhost:45211`. A temporary process-only Vite config routed `/api`, `/ws`, and `/gotrue` to the isolated backend. Port `9999` was already occupied by OrbStack and was not used. No frontend files or commercial services were changed.

1. The real browser's `POST /api/workspace/{workspaceId}/spaces` returned HTTP 200 with the expected AppFlowy envelope and persisted `view_id`.
2. After refreshing the workspace, the created space appeared in the sidebar and New Page chooser; **“No spaces available”** was gone.
3. Selecting the space and clicking **Add** displayed **“Update the server to use this creation feature.”** No atomic page-creation request was sent. The source gate requires `enable_atomic_creation` and `enable_atomic_creation_defaults`; `/api/server-info` does not advertise them. The backend version/capabilities were not changed to bypass that gate.
4. No page was created, loaded, edited, or collaboratively persisted.

## Validation

| Command/check | Result |
|---|---|
| `npm test` | PASS — 11 tests |
| `npm run test:offline-collab` | PASS — 5 tests |
| `npm run test:collab-conformance` | PASS — 6 passed; 7 unrelated server-semantics cases remain pending |
| `env -u DATABASE_URL RUN_POSTGRES_TESTS=1 npm run test:postgres` | 3 skipped — no database configured or contacted |
| `node --check server.js && node --check storage.js && node --check postgres-storage.js` | PASS |
| `./node_modules/.bin/jest src/application/services/js-services/http/__tests__/page-api.test.ts --runInBand --no-coverage` (from AppFlowy-Web) | PASS — 45 tests |
| Browser space creation/outline | PASS — HTTP 200; persisted space visible and selectable |
| Browser page creation | BLOCKED — frontend atomic-creation capability gate; no page-create request sent |
| Temporary processes and data | PASS — isolated backend, Vite process, JSON data, and temporary Vite config removed |

The backend directory did not contain Git metadata, so a backend Git status/diff was unavailable. The frontend's pre-existing modified `vite.config.ts` and untracked files were preserved.

## Acceptance status

1. **Space request returns the expected response:** PASS.
2. **Browser progresses beyond “No spaces available”:** PASS — a persisted space is shown in the outline and chooser.
3. **Next browser blocker is captured:** PASS — page creation is blocked client-side by the missing atomic-creation capability flags.
4. **Backend, offline-collaboration, and conformance tests run:** PASS, with the seven documented conformance cases still pending.
5. **Temporary resources are cleaned up:** PASS.

**Boundary:** this adds only public-space bootstrap and outline metadata. It does not implement page creation, page collaboration, editing, or persistence of edits.
