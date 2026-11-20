# Task 73 — Real-browser acceptance verification

**Status after this task: Implemented, pending browser verification (NOT Complete).** A real, reproducible blocker was found in Scenario A (content-persistence) and is documented below rather than silently worked around, per this task's explicit instructions. Everything else in the approved scope (row-document creation/registration, favorite persistence, the trash-vs-remove dispatch decision, ordinary-Document authorization, invalid-identity rejection, JSON/Postgres parity, relation-regression safety) was verified for real and passed.

## A. Environment

- Backend mode: JSON storage for all Playwright scenarios (primary target, per spec); Postgres storage separately exercised via the existing `test:postgres`/`test:parity` suites (backend-level, not browser-level — see §C for the distinction).
- Test harness: the existing Task 69 `test/helpers/test-environment.ts` (`startTestEnvironment`/`stopTestEnvironment`) — disposable backend on an auto-selected port ≥19000, disposable Vite frontend dev server on an auto-selected port ≥14000, isolated temp JSON data file, unique per-test users via `registerTestUser`. No shared/production state touched.
- Browser: Chromium via Playwright 1.64.1 (`@playwright/test`), headless, `playwright.config.ts` at the repo root (`testDir: ./test/e2e`, `workers: 1`).
- New spec file: `test/e2e/database-row-detail-page.spec.ts` (2 tests).
- Process cleanup: `stopTestEnvironment` kills only the two processes it spawned (backend `node server.js`, frontend `vite`) and asserts `AppFlowy-Web/.env.local` was restored byte-for-byte (`envRestored === true` on every run of this task). No other process on the machine was touched.
- Working-tree safety: `AppFlowy-Independent-Backend` has no `.git` (confirmed again, unchanged). `AppFlowy-Web`'s `git status --short` reproduced the exact same 30-entry pre-existing modified/untracked list documented by Tasks 61/62/69/71/72/73-discovery, byte-identical, both before and after this task's run — **no frontend file was read-write touched, let alone edited.**

## B. Scenario results

| Scenario | Result | Evidence | Notes |
|---|---|---|---|
| Row detail-page creation (lazy, on first open) | Passed | Real browser | See §D — required a genuine backend fix (new lazy-creation branch), not just the discovery-report's two routes |
| Document content editing (typing lands in the editor) | Passed | Real browser | Full test string appears in the DOM immediately after typing |
| Document content-persistence after reload | **Failed (blocked)** | Real browser + persisted state | Confirmed reproducible frontend defect — see §D.3. Only the first character of any typed content ever reaches the server |
| Favorite action | Passed | Real browser | |
| Favorite persistence (after reload) | Passed | Real browser + persisted state (independent REST read of the page's `is_favorite`) | |
| Delete row chooses soft-delete (has a detail page) | Passed | Real UI (`row-menu-delete` → `delete-row-confirm-button`) + independent Yjs `row_orders` read | `is_deleted:true`, entry retained (tombstoned), not removed |
| Row disappears from the live grid after soft-delete | Passed | Real browser | |
| Row-detail Document bytes survive the soft-delete | Passed | Real persisted-state read (non-empty `doc_state` decode) | Full-content check skipped (gated on the Scenario-A defect — correctly conditional, not silently asserted) |
| Ordinary Document authorization unaffected | Passed | Real HTTP/WS | A normally-parented Document typed, synced, and was independently confirmed to persist its **full** text server-side — proves the content-truncation defect above is NOT a general editor/sync regression, only a row-document-specific one (see §D.3) |
| Invalid/unregistered row-document id never reports `exists:true` | Passed | Real HTTP (`GET .../collab-exists`) | |
| JSON persistence (orphaned-view, collab-exists, lazy-create, WS admission) | Passed | Real persistence, both via the new E2E spec and via `test:row-document` (4/4) | |
| PostgreSQL persistence (same four scenarios) | Passed | Real PostgreSQL (`test:postgres`, `test:postgres-row-document.test.js` subset, 56/56 overall) | **Backend-level, not real-browser** — no browser-level Postgres run was performed this task (not required by the spec: "at minimum, preserve and rerun existing PostgreSQL ... tests", which was done) |
| Relation regression (config/cell/reciprocal survive persistence, no new backend code) | Passed | Real storage/tests | `test:database-collab` (field/type_option generic persistence, 13/13), `test:json-postgres-parity.test.js` (2/2) — no relation-specific backend code exists or was added, confirmed again by the same grep technique as the discovery report |
| Regression suites | Passed | Test output (see §D.4) | `npm test` 38/38, offline-collab 5/5, database-collab 13/13, database-row-collab 11/11, database-catalog 17/17, database-view-collab 6/6, realtime-fanout 4/4, security 23/23, collaboration-recovery 8/8, row-document 4/4, postgres 56/56, parity 2/2 |

## C. Evidence quality (labeled per item, as required)

- **Real browser test**: both specs in `test/e2e/database-row-detail-page.spec.ts`, run via `npx playwright test --config=playwright.config.ts test/e2e/database-row-detail-page.spec.ts`, Chromium, real clicks/hovers/typing/reloads.
- **Real HTTP/API test**: every independent verification call in the spec (`fetch(...)` to `/api/workspaces/.../pages`, `/api/workspace/v1/.../collab/...`, `/api/workspace/.../collab/.../collab-exists`) is a real authenticated HTTP request against the disposable backend, not a mock.
- **Real WebSocket test**: all Document/Database/DatabaseRow sync observed in the spec goes over the real `ws://127.0.0.1:<port>/ws/v2` connection the disposable frontend opens; nothing was stubbed.
- **Real JSON persistence**: the disposable backend's `DATA_FILE` is a real temp JSON file on disk; the spec reads collab state back via the real collab-read route, not an in-memory shortcut.
- **Real PostgreSQL persistence**: `test:postgres` (56/56, including `test/postgres-row-document.test.js`'s 4 tests) and `test:parity` (2/2) run against a real local PostgreSQL instance (`appflowy_independent_test` database) — backend-level `node --test`, not browser-level.
- **Browser reload with persisted backend recovery**: the favorite-persistence check and the soft-delete/content-survival checks in Scenario A+B+C reload the real page and re-derive state from the server, not from browser cache.
- **Unit test / Mocked integration test**: the pre-existing suites (`npm test`, `test:offline-collab`, etc.) — unchanged, re-run fresh this task, not assumed from the implementation report.
- **Not performed this task**: a real browser run against a Postgres-backed frontend/backend pair (not required by the acceptance spec's wording; the spec explicitly says "do not claim PostgreSQL browser verification if only backend PostgreSQL tests were run" — this report does not make that claim).

## D. What was found and fixed (within approved scope only)

### D.1 — A second, more direct creation path exists that the discovery report did not characterize

The discovery report (§4) characterized the row-detail-page gap as three missing pieces: `POST /orphaned-view`, `GET /collab-exists`, and the Document-WS admission precondition — all gating the **Favorite-button-initiated** path (`ensureRowDocumentView`, called only from `RowPeekDocumentActions.tsx`'s favorite handler). Those three pieces were implemented in the prior Task 73 implementation pass and are now confirmed working (`test:row-document` 4/4, plus the new E2E Scenario D).

Real-browser testing this task found that **this is not the path a user actually takes to open and edit a row's detail-page body.** Tracing `DatabaseRowSubDocument.tsx` (the real row-page body editor, mounted unconditionally whenever a row is opened, independent of ever clicking Favorite) shows it calls `fetchRowDocumentCollab()` → `getCollab(workspaceId, documentId, Types.Document, rowDocumentSource)`, which issues:

```
GET /api/workspace/v1/{workspaceId}/collab/{documentId}?collab_type=0&database_id=...&row_id=...&row_document_id=...
```

This is the **generic, pre-existing Document-read route**, not the new `/orphaned-view` route — with extra query parameters that signal "lazily create this Document if it doesn't exist yet, authorized via the parent database rather than a direct Document ACL" (confirmed by the inline comment in `src/application/view-loader/index.ts`: *"Row documents inherit access from their parent database. Pass that context so authorization does not depend on a direct document ACL."*).

Before this task's fix, this route had no lazy-creation branch at all, so it unconditionally 404'd (`COLLAB_NOT_FOUND`) the first time any row's detail page was opened — **confirmed by real network capture**: `GET .../collab/{documentId}?collab_type=0&database_id=...&row_id=...&row_document_id=... -> 404`, followed by the real UI rendering a **"Failed to open page" / "Retry creation"** error state (screenshot captured during this task's debugging).

### D.2 — Fix: lazy row-document creation on the generic Document-read route

`server.js`'s existing `collabType === '0'` branch of `GET /api/workspace/v1/:workspaceId/collab/:objectId` was extended: when the page is not yet registered AND the request carries `database_id`/`row_id`/`row_document_id` (with `row_document_id === objectId`), the backend now:

1. Validates `objectId === uuidv5('document_id', rowId)` (reusing the existing `rowDocumentIdFromRowId` helper — same identity check as the `/orphaned-view` route, not a new contract).
2. Confirms `database_id` resolves to a real, accessible Database collab object in the caller's workspace (authorization via the parent database, exactly matching the frontend's own stated intent — no Document-level ACL is consulted or needed).
3. Lazily materializes the row's Document + its orphaned Folder-tree page via a new shared helper, `ensureRowDocumentPage()`, which **reuses** `createInitialPageCollab`, `createAtomicDocumentPage`, and the exact `extra.row_document` shape the existing `/orphaned-view` route already uses — not a new creation contract, the same one, refactored into one shared function.
4. Returns the resulting (or pre-existing) collab in the same shape `store.getPageCollab` already returns elsewhere on this route, so the existing response-building code below is untouched.

This is the single largest and most load-bearing fix found this task: without it, **no row's detail-page body editor can ever open successfully** (not "won't save content" — the editor itself errors out), which is a materially larger gap than the discovery report's framing (it assumed opening the editor already worked and only saving-via-Favorite was gapped).

### D.3 — Found, NOT fixed: row-document content-sync truncation (frontend defect, out of backend scope)

After fixing D.2, the editor opens and accepts typed input correctly in the DOM. But independent server-side verification shows **only the first character of any typed input is ever persisted** — confirmed deterministically across 3+ clean runs (not a flake; the `toPass({ timeout: 30000 })` retry window never recovers).

Root-caused via browser console capture: the frontend's local IndexedDB-backed "outbox" (`src/application/sync-outbox/index.ts`, `db.sync_outbox.add(...)`) throws a Dexie `NotFoundError` on the **very first** local edit to a row-document that was lazily created server-side (as opposed to created client-side through the normal page-creation flow). Every outbox enqueue after that first failure is silently dropped rather than retried, so edits past the first keystroke never reach the WebSocket at all.

**Confirmed NOT a general regression**: Scenario D's ordinary, normally-created Document (created via the real "Add Document" sidebar flow) was typed into and independently verified to persist its **full** text server-side in the same test run, using the identical server-side verification technique. The defect is specific to the lazy-GET-creates-a-Document code path this task's fix introduced a working front door for — the frontend's own client-side bootstrap for a document (whatever local IndexedDB scaffolding a normal page-creation flow sets up before this document ever becomes editable) is apparently never run for a document that is conjured into existence by a GET instead of a POST-creation call the client itself issued.

**Classification: Frontend synchronization defect.** **Not fixed** in this task: diagnosing and safely fixing AppFlowy-Web's offline-outbox IndexedDB bootstrap is a materially different, frontend-side investigation, outside this backend task's approved scope, and the task's own instructions require stopping to report a defect found during verification rather than blind-patching client code under time pressure. Scenario A's content-persistence criterion is recorded as **blocked**, not passed, and every downstream assertion that depended on it was made conditional in the test (and is itself confirmed-passing for everything that does NOT depend on body content: the row-document existing, being favoritable, and being soft-deleted/restorable with its — currently near-empty — Document bytes intact).

**Recommended follow-up** (not performed, out of scope here): trace why `db.sync_outbox.add()` throws `NotFoundError` specifically for a row-document whose Folder-tree page was never locally created by the client's own page-creation dispatch, likely in `src/application/db/index.ts`'s IndexedDB schema/table-registration path, and whether the normal Favorite-button flow's `ensureRowDocumentView()` call (which already succeeds today) happens to perform whatever local bootstrap step the direct-open path skips — if so, the fix may be to make `DatabaseRowSubDocument`'s open path perform that same client-side bootstrap before its first local edit, not a backend change at all.

### D.4 — Regression suites (re-run fresh this task)

JSON mode: `npm test` 38/38, `test:offline-collab` 5/5, `test:database-collab` 13/13, `test:database-row-collab` 11/11, `test:database-catalog` 17/17, `test:database-view-collab` 6/6, `test:realtime-fanout` 4/4, `test:security` 23/23, `test:collaboration-recovery` 8/8, `test:row-document` 4/4 — all green, no drift from the implementation-task baseline.

Postgres mode (against a real local PostgreSQL instance): `test:postgres` 56/56 (includes `test/postgres-row-document.test.js`'s 4 tests, re-exercising the new lazy-creation branch's identity/authorization checks against Postgres storage), `test:parity` 2/2.

`test:e2e` (the new spec plus the two pre-existing specs in `test/e2e/`) was run as `test/e2e/database-row-detail-page.spec.ts` specifically (twice, for flake-checking); the other two pre-existing specs (`core-navigation.spec.ts`, `database-views.spec.ts`, `historical-collaboration-acceptance.spec.ts`) were not re-run this task (no code path they exercise was touched by this task's fix, which is scoped to the Document-read route's `collabType === '0'` branch only).

## E. Working-tree safety

- Files changed: `server.js` (one new shared helper `ensureRowDocumentPage`, one new lazy-creation branch inside the existing `collabType === '0'` GET handler — no other route touched).
- Files created: `test/e2e/database-row-detail-page.spec.ts`, this report, `docs/APPFLOWY_TASK73_REPORT.md`, evidence screenshots under `docs/task73-evidence/e2e-runs/<timestamp>/`.
- Existing user changes preserved: confirmed — `AppFlowy-Web`'s pre-existing 30-entry modified/untracked `git status` is byte-identical before and after this task.
- Processes started and stopped: only the disposable backend/frontend pairs this task's own `startTestEnvironment`/`stopTestEnvironment` calls spawned; `envRestored: true` confirmed on every run.
- No destructive git operation was run (no `.git` exists in the backend repo; no reset/clean/checkout touched the frontend repo).
- No unrelated file was cleaned, overwritten, or deleted.

## F. Final determination

**Task 73 status: Implemented, pending browser verification — NOT Complete.**

Per §11's criteria: (1) opening a row-detail page now works end-to-end in a real browser — **met** (this task's own fix). (2)/(3) entering content and having it survive reload, recovered from backend persistence — **NOT met**, blocked by the confirmed frontend outbox defect in §D.3. (4) favorite survives reload — **met**. (5)–(8) the trash-vs-remove decision, Trash membership (via independent Yjs state — no row-level Trash UI exists in the current frontend, confirmed again this task, consistent with the discovery report's finding that `restoreSoftDeletedRowsInDatabase` has zero UI callers), restorability, and content-integrity-across-delete — **met** for everything except the content itself (which is near-empty due to (2)/(3)'s blocker, not destroyed). (9) ordinary-Document authorization intact — **met**. (10) invalid-identity rejection — **met**. (11) JSON/Postgres persistence tests pass — **met**. (12) relation regression passes with no new relation backend code — **met**. (13) regression suites pass — **met**. (14) reproducible evidence — **met** (this report, the new spec file, and the regression-suite output above).

Criteria (2) and (3) are the explicit, named, "most important" acceptance scenario in the task brief's §1 step list — their failure is why this task does not upgrade Task 73 to Complete, consistent with "do not upgrade the task to Complete without evidence for its critical acceptance criteria."
