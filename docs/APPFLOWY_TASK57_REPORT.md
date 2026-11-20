# Task 57: Document History UI Controls (Snapshot Creation + Tombstone-Delete) — AppFlowy-Web

## Scope

AppFlowy-Web's `DocumentHistoryModal.tsx` already exposed listing, preview,
and restore for document version history, and the backend already
implemented and had committed test coverage for named snapshot creation,
version-history listing, preview, tombstone-deletion, and restore (Tasks
49A/49B/56). But the frontend had no UI control to actually *create* a named
snapshot or *tombstone-delete* a version, even though the client methods
(`createCollabVersion`, `deleteCollabVersion` in `collab-api.ts`) already
existed. This task closed that UI gap — **frontend changes only**, reusing
the existing backend contract. No backend defect was found; none was fixed.

Repos: `AppFlowy-Web` (all production code/test changes) and
`AppFlowy-Independent-Backend` (regression verification only, no code
changes).

## Frontend changes made

- `src/components/app/hooks/useViewOperations.ts` — added
  `createCollabVersion(viewId, name, ySnapshot)` and
  `deleteCollabVersion(viewId, versionId)`, both thin wrappers calling the
  **pre-existing** `CollabService.createVersion` / `CollabService.deleteVersion`
  (`src/application/services/domains/collab.ts`, which already re-exported
  `collab-api.ts`'s `createCollabVersion`/`deleteCollabVersion` — those HTTP
  client functions were already written and tested before this task; they
  were simply never wired into the UI).
- `src/components/app/contexts/AppOperationsContext.ts` — added
  `createCollabVersion?` / `deleteCollabVersion?` to the context type.
- `src/components/app/layers/AppBusinessLayer.tsx` — wired the two new
  operations into the provided context value (both the value object and its
  `useMemo` dependency array).
- `src/components/app/app.hooks.tsx` — `useCollabHistory()` now also returns
  `createCollabVersion` / `deleteCollabVersion` alongside the existing
  `getCollabHistory` / `previewCollabVersion` / `revertCollabVersion`.
- `src/components/document/history/DocumentHistoryVersionList.tsx`:
  - Added a **"Create snapshot"** button above the version list, opening an
    `AlertDialog` (reusing the existing `alert-dialog.tsx` primitives, the
    same pattern as `RemoveAccessConfirmDialog.tsx`) with a name `Input`.
    Validates empty names and a 200-char max (matching the backend's own
    `name.trim().slice(0, 200)` contract in `server.js`), shows the error
    inline, keeps the dialog open on validation or API failure, disables the
    confirm button and shows a spinner while in-flight, and guards duplicate
    submission with both the parent's `isCreatingSnapshot` prop and a local
    ref (so a second click landing before the parent re-renders can't double
    fire).
  - Added a per-version **delete icon-button** (visible on row hover/focus,
    `delete.svg`), opening a second `AlertDialog` confirmation
    ("Delete this version?" / cannot be undone) before calling
    `onDeleteVersion`. Cancel makes no API call. Delete buttons disable while
    a deletion is in flight.
  - Added an empty-history message (`versionHistory.noVersions`) when the
    list has zero entries.
  - No client-side "protected version" concept was added. I checked the
    backend's DELETE handler (`server.js`, the `DELETE .../history` route)
    and found no server-side concept of a non-deletable/current/HEAD version
    either — every listed snapshot is an independent row, and the tombstone
    endpoint will delete any of them by id. Inventing a client-side
    restriction here would only diverge from the server's own authorization,
    which the task instructions explicitly warned against.
- `src/components/document/history/DocumentHistoryModal.tsx`:
  - `handleCreateSnapshot(name)`: loads the **current live document** via the
    already-existing `loadView(viewId)` (not the historical preview doc),
    encodes it with `Y.encodeStateAsUpdate`, calls `createCollabVersion`,
    shows a success/error toast via the existing `notify` util, and calls the
    existing `refreshVersions()` so the new snapshot appears in the list in
    the correct order (newest-first, matching the existing list contract).
  - `handleDeleteVersion(versionId)`: calls `deleteCollabVersion`, toasts,
    and refreshes history so the tombstoned version disappears from the
    normal list.
  - Existing preview/restore logic is untouched.
- `src/@types/translations/en.json` — added
  `versionHistory.createSnapshot*`, `versionHistory.deleteVersion*`, and
  `versionHistory.noVersions` keys (no hardcoded English strings).

**No new backend endpoint was invented.** The only HTTP calls made by the new
UI are the pre-existing `POST .../collab/{objectId}/history` (create),
`DELETE .../collab/{objectId}/history` (tombstone), plus the already-wired
`GET .../history` (list), `GET .../history/{version}` (preview), and
`POST .../collab/{objectId}/revert` (restore). Confirmed directly in the real
browser's network log (see Part F below) — exact methods/URLs/status codes.

## Part E — Frontend automated tests

Added to the existing Jest/RTL test setup (same conventions as the pre-existing
`DocumentHistoryModal.test.tsx` / `DocumentHistoryVersionList.test.tsx`):

- Extended `DocumentHistoryVersionList.test.tsx` with 10 new tests: create-snapshot
  control visible but disabled without a handler; empty-name validation blocks
  the API call and keeps the dialog open; a valid name calls the API once,
  blocks a second click while in-flight, and closes the dialog only on
  success; API failure keeps the dialog open and usable (cancel still works);
  delete control visible only when a handler is provided; cancel on the
  delete confirm makes no API call; confirm invokes the API with the correct
  version id; delete buttons disabled while `isDeletingVersion`.
- New `DocumentHistoryModal.snapshotAndDelete.test.tsx` (5 tests): asserts
  `createCollabVersion` is called with `(viewId, name, Uint8Array)` built from
  the *live* doc returned by `loadView` (not the preview doc); success shows
  a toast and re-fetches history; failure shows a toast and leaves the modal
  usable; `deleteCollabVersion` is called with `(viewId, versionId)`; success
  refreshes history and a tombstoned version's row disappears from the next
  fetch.

Result: `npx jest src/components/document/history` → **20/20 passed**.

Broader regression (hooks/layers/collab-api/app context, to catch anything the
new context plumbing broke): `npx jest src/components/app/hooks/__tests__
src/components/app/layers src/application/services/js-services/http/__tests__/collab-api.test.ts
src/components/app/__tests__` → **37 suites / 441 tests passed**, nothing
skipped or weakened.

## Part F — Real browser verification (Playwright + Chromium)

### Setup

- Backend started fresh in JSON mode, isolated data file, disposable: `PORT=8787
  STORAGE=json DATA_FILE=/tmp/task57-backend-data.json NODE_ENV=test
  DEV_TEST_KEY=task57-key CORS_ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
  node server.js`. (The backend's default dev CORS allowlist is only
  `5173`/`5183`; port `3000` — AppFlowy-Web's actual default dev port, and the
  one its own `vite.config.ts` and `.env.local` are configured for — had to be
  added explicitly or every `/api` and `/token` request was blocked by CORS.
  This is an environment/invocation detail, not a backend code defect, since
  the allowlist is intentionally configurable via `CORS_ALLOWED_ORIGINS`.)
- AppFlowy-Web dev server: `npx vite --port 3000` (its existing `.env.local`
  already points `APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL`/
  `APPFLOWY_WS_BASE_URL` at `localhost:8787`, unmodified).
- Test account created via the real `POST /api/auth/register` endpoint
  (which writes into the same user store `/token` reads from).
- Browser automation used the Playwright + Chromium already installed in
  `AppFlowy-Web/node_modules` (no new install). A standalone script
  (`task57-e2e.mjs`, run from the repo root so Node's ESM resolver could find
  `node_modules/playwright`) drove the real UI: typed into the email/password
  fields using their existing `data-testid`s (`login-email-input`,
  `login-password-button`, `password-input`, `password-submit-button`),
  created a space via the real "New page" → "Create a new space" dialog (a
  fresh workspace has no space yet), typed real content into the document
  body (the second `[contenteditable="true"]` element — the first is the page
  title), and exercised the new `version-history-create-snapshot-*` /
  `version-history-delete-button-*` / `version-history-delete-confirm`
  controls exactly as a user would click them. No step of the core flow
  bypassed the UI with a direct API call.
- To make the restore step verify something real (not just "the editor
  already showed the right text"), the script edited the document body
  *after* snapshot two was taken ("EDIT-AFTER-SNAPSHOT-TWO-should-not-survive-restore"),
  then restored snapshot two and asserted that edit was gone and the
  snapshot's original content was back.

### Per-step results

| # | Step | Status | Evidence |
|---|------|--------|----------|
| 1 | Login | **Passed** | Real email/password UI login; landed on `/app/{workspaceId}` |
| 2 | Open a document | **Passed** | Created a space + page via the real "New page" UI flow (fresh workspace had no space) |
| 3 | Open Document History | **Passed** | Page "More" menu → "Version history" opened `version-history-modal` |
| 4 | Create a named snapshot via new UI control | **Passed** | Filled `version-history-create-snapshot-name-input`, clicked confirm; `POST .../history` → 201; "Task57 Snapshot One" appeared |
| 5 | Verify it appears in the UI | **Passed** | Visible inside `version-history-list` immediately after creation |
| 6 | Reload history and verify persistence | **Passed** | Full page reload, reopened Document History, snapshot still listed (`GET .../history` → 200, same version id) |
| 7 | Preview the snapshot | **Passed** | Clicked the version row; preview editor rendered (`GET .../history/{id}?collab_type=0` → 200) |
| 8 | Create another snapshot | **Passed** | "Task57 Snapshot Two" created (`POST .../history` → 201) |
| 9 | Delete an eligible snapshot via new UI control | **Passed** | Hovered the row, clicked its `version-history-delete-button-{id}` |
| 10 | Confirm deletion (via confirmation dialog) | **Passed** | Clicked `version-history-delete-confirm`; `DELETE .../history` → 200 |
| 11 | Verify it disappears from normal history listing | **Passed** | "Task57 Snapshot One" no longer visible in the list after refresh |
| 12 | Reload and verify the tombstone remains effective | **Passed** | Full page reload, reopened history, deleted version still absent (`GET .../history` → 200, tombstoned row excluded) |
| 13 | Restore a remaining version | **Passed** | Selected "Task57 Snapshot Two", clicked Restore; `POST .../revert` → 200 |
| 14 | Verify restored content in the live editor | **Passed** | Live editor body contains the pre-snapshot-two marker text and does **not** contain the post-snapshot-two edit, proving restore actually reverted content (not a coincidental match) |

**14/14 Passed. 0 Failed. 0 Blocked. 0 Not tested.**

### Network evidence (captured from the real browser session)

```
POST http://localhost:8787/token?grant_type=password -> 200
POST http://localhost:8787/token?grant_type=refresh_token -> 200
GET  .../collab/{objectId}/history -> 200   (list)
POST .../collab/{objectId}/history -> 201   (create snapshot one)
GET  .../collab/{objectId}/history/{id}?collab_type=0 -> 200   (preview)
POST .../collab/{objectId}/history -> 201   (create snapshot two)
DELETE .../collab/{objectId}/history -> 200   (tombstone snapshot one)
POST .../collab/{objectId}/revert -> 200   (restore snapshot two)
GET  .../collab/{objectId}/history -> 200   (final refresh)
```

No other `/api` surface was touched by the new controls — confirming no new
endpoint was invented and the exact existing contract (from `collab-api.ts`)
was reused end to end.

### Console / defects observed

- Benign, pre-existing, unrelated-to-this-task console noise: a
  `Requires server 0.18.10 or later. Some features may be unavailable.`
  banner (version-capability check against this minimal prototype backend)
  and a few `404 We couldn't find this content` toasts from workspace-member
  profile hydration calls this prototype backend doesn't implement. Neither
  affected any of the 14 steps; both are pre-existing backend-completeness
  gaps unrelated to Task 57's scope, not defects introduced by this task, and
  are not being fixed here (out of scope).
- No defect was found in the new frontend code or in the backend's
  history/revert contract during this verification.

### Screenshots / evidence location

All 14 full-page screenshots and the raw `results.json` (per-step status,
full console log, full network log) are committed at:
`docs/task57-evidence/screenshots/01-login-filled.png` through
`14-live-editor-after-restore.png`, and `docs/task57-evidence/results.json`.

### Teardown

Backend process, Vite dev server, and the disposable `/tmp/task57-backend-data.json`
data file were all stopped/removed after the run. Ports 3000 and 8787
confirmed free afterward. The pre-existing commercial self-host Docker stack
(`appflowy-selfhost-commercial-*`) and the local Postgres service on 5432 were
never touched.

## Part G — Backend regression

All four suites run against this task's changes (frontend-only; backend code
untouched), to confirm nothing regressed:

| Suite | Command | Result | Baseline |
|---|---|---|---|
| Core backend | `npm test` | **38/38 passed** | 38/38 (unchanged) |
| Offline collab | `npm run test:offline-collab` | **5/5 passed** | 5/5 (unchanged) |
| Collab conformance | `npm run test:collab-conformance` | **passed=6, failed=0, pending=2, resolved=5** | identical (unchanged) |
| Postgres | `npm run test:postgres` | **10/10 passed** | 10/10 (unchanged) |

Postgres run used a fresh, disposable `postgres:16-alpine` container
(`task57-pg`, port `55432`, distinct from the pre-existing commercial stack's
unpublished `appflowy-selfhost-commercial-postgres-1` and from the local
host's own `postgresql` service on `5432`). Removed (`docker rm -f task57-pg`)
immediately after the run. `docker ps` was checked before starting; no
container this task didn't create was touched.

No backend code, schema, or migration was changed in this task.

## Tests not executed / limitations

- Cross-browser (Firefox/WebKit) verification was not performed; only
  Chromium (the browser confirmed already installed and working in prior
  tasks) was used, per the task's own instruction to use "the existing
  installed Playwright+Chromium."
- The real-browser run exercises one document, one user, one workspace; it
  does not repeat the flow under concurrent users or multi-tab scenarios.
  Concurrency/authorization correctness for history operations is covered by
  the backend's own existing committed tests (Tasks 49A/49B/56), not
  re-verified here since no backend code changed.
- No load/performance testing of snapshot creation on very large documents
  was performed.

## Summary

Task 57 is complete: the previously-missing "Create snapshot" and version
"Delete" UI controls are implemented in `DocumentHistoryVersionList.tsx` /
`DocumentHistoryModal.tsx`, wired to the pre-existing backend contract with no
new endpoints, covered by 15 new component/unit tests (20/20 in the touched
suite, 441/441 in the broader regression sweep), and verified end-to-end in a
real Chromium browser against a live disposable backend across all 14
requested steps (14/14 Passed). All four backend regression suites remain
green and unchanged. No backend defect was found or needed fixing.
