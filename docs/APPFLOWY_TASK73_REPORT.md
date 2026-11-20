# Task 73 — Implementation report (row-detail-page backend + browser verification)

This report covers both implementation passes for Task 73. See `docs/APPFLOWY_TASK73_DISCOVERY.md` for the original discovery phase (unmodified, not overwritten) and `docs/APPFLOWY_TASK73_BROWSER_VERIFICATION.md` for the full real-browser acceptance evidence this report summarizes.

## Scope approved

1. `POST /api/workspace/{workspaceId}/orphaned-view` — register a row-detail Document's Folder-tree page.
2. `GET /api/workspace/{workspaceId}/collab/{objectId}/collab-exists` — existence probe for the frontend's trash-vs-remove decision.
3. Document WebSocket admission for a registered row-detail page, without weakening ordinary-Document authorization.
4. Trash-vs-remove correction — the normal Delete-row action must choose soft-delete when a row has a registered detail page.
5. Favorites and persistence verification.
6. JSON/PostgreSQL parity.

Explicitly excluded: relation-specific backend logic, rollup/formula engine, hard-delete of row collabs, row duplication, cross-object atomic transactions, "remove from one view only".

## Pass 1 — Backend implementation (routes 1–3, favorite/trash reuse)

- `POST /orphaned-view`: creates/returns the row-detail Document's Folder-tree page, reusing the existing atomic-document-page storage method. Idempotent against repeated/concurrent calls. Validates the client-supplied document id against the server's own `uuidv5('document_id', rowId)` derivation.
- `GET /collab/{objectId}/collab-exists`: returns `false` for anything unregistered or outside the workspace, never a false positive.
- Document WS admission: narrowly admits only pages created via route 1 (no parent view, `extra.row_document` set) by workspace membership alone; every other Document still requires the original parent-Space check.
- Favorite/trash/restore needed no new code — the generic page-view routes already operate on any page by id.
- Tests added: `test/row-document.test.js` + `test/postgres-row-document.test.js` (4 tests each). All existing suites stayed green; Postgres went 52→56/56.

## Pass 2 — Real-browser verification (this task)

Real-browser testing surfaced that Pass 1's three routes gate the **Favorite-button-initiated** creation path only. The row-page body editor's actual open/create path is a **different, pre-existing generic route** — `GET /api/workspace/v1/{workspaceId}/collab/{objectId}?collab_type=0&database_id=...&row_id=...&row_document_id=...` (AppFlowy-Web's `fetchRowDocumentCollab`/`getCollab`) — which had no lazy-creation behavior at all and 404'd on every first-open, rendering a real "Failed to open page" error in the browser.

**Fix (this task, within approved scope — Document-read route only, no new contract)**: extended the existing `collabType === '0'` branch of the generic collab-read route with a lazy-creation branch, sharing a refactored `ensureRowDocumentPage()` helper with the Pass-1 `/orphaned-view` route (same identity check, same `createInitialPageCollab`/`createAtomicDocumentPage` calls, same `extra.row_document` shape — not a new API contract).

**Found, not fixed (frontend defect, documented, out of backend scope)**: after the above fix, the editor opens and accepts input, but a client-side IndexedDB "outbox" enqueue (`src/application/sync-outbox/index.ts`) throws `NotFoundError` on the first edit to a lazily-created row-document, silently dropping every keystroke after the first from ever reaching the server. Confirmed not a general regression (an ordinary Document persists full content correctly in the same run). See the browser-verification report §D.3 for full detail and recommended follow-up.

## Current status

**Implemented, pending browser verification.** Task 73 does **not** meet its own acceptance criterion for row-detail content surviving a reload (criteria 2–3 in the verification report), so it is intentionally not marked Complete. Everything else in the approved scope — row-document creation/registration (now genuinely reachable from the real UI), favorite + persistence, the trash-vs-remove dispatch decision, ordinary-Document authorization, invalid-identity rejection, JSON/Postgres parity, and relation-regression safety (confirmed via existing tests, zero new relation-aware backend code) — passed real-browser and/or real-backend verification this task.
