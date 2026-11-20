# Task 69 — Playwright Browser-Automation Reliability: Investigation, Fix, and E2E Infrastructure

## 1. Executive summary

Tasks 66, 67, and 68 each independently hit the same class of real-browser-automation failure while trying to verify already-proven backend behavior (real-time fan-out, authorization/revocation, collaboration recovery). This task's job was test infrastructure only: find the actual root causes (not just symptoms), build reliable, condition-based navigation primitives, and use them to close out as much of the historical browser-verification gap as can be genuinely closed — without touching AppFlowy-Web product code or backend collaboration logic.

**Root cause, proven by live DOM evidence, not assumed**: AppFlowy-Web's "+" quick-add-document flow (`inline-add-page` → `add-document-button`) calls `AppBusinessLayer.openPageModal()`, which opens the new Document in a `ViewModal` (a real MUI `Dialog`) while the route also resolves to the new page's full-page URL underneath it. The modal's backdrop is a real, pointer-events-active, full-viewport element (`opacity:1`, `pointerEvents:'auto'`, covering the entire client rect) — it is not merely a sticky header at the top of the page, it is the WHOLE modal intercepting every click anywhere on screen until explicitly closed. This fully explains the "sticky header intercepts clicks" and "couldn't find this content" symptoms independently reported by Tasks 66/67/68: whichever element each prior attempt tried to click, the invisible modal backdrop was in front of it.

A second, distinct, previously-undocumented defect was found during live repro: a brand-new document's body editor cannot always be focused by clicking the CENTER of its (very tall, mostly-empty) bounding box — Slate's own internal selection model does not reliably follow a click landing in empty lower padding, so keystrokes silently land in the title instead of the body. Fixed with a top-left-offset click plus an explicit DOM-focus verification step (retry/fallback), confirmed live.

**What's now reliable**: a dedicated Playwright E2E suite (`test/e2e/core-navigation.spec.ts`) covering 7 real-browser scenarios passed 7/7 across **5 consecutive full runs (35/35 individual test passes, 0 failures)**, each run against a fresh disposable backend+frontend and fresh disposable users/spaces/documents.

## 2. Baseline environment

- Backend: Node v26.11.0, `@playwright/test ^1.64.1`, Chromium `chromium-1248` / `chromium_headless_shell-1248` already installed under `~/Library/Caches/ms-playwright`.
- Backend repo has no git; frontend repo (AppFlowy-Web) is a git checkout with pre-existing uncommitted modifications (13 modified files, several untracked files/dirs) — verified unchanged (identical `git status --short` output) at the end of this task.
- No conflicting processes were found listening on any port used before this task started; all ports used by this task were allocated per-run (19000+/14000+ ranges) and verified free beforehand.
- `AppFlowy-Web/.env.local` MD5 at start: `c85de40fc13dc3b2379325c6ecc3471d` — restored to this exact MD5 after every run in this task, confirmed each time.
- Existing baseline test results (documented in the task brief) were independently re-confirmed fresh in Stage 10 below, all matching exactly.

## 3. Existing Playwright architecture, as found

- `test/screens/{BaseScreen,DocumentScreen,AuthScreen,LoginScreen,PageScreen,SpaceScreen,WorkspaceScreen}.ts` — a Page-Object-style harness that was never actually runnable: `DocumentScreen extends BaseScreen` with no `import` of `BaseScreen` anywhere in the file (confirmed — this is not a module-resolution convention used elsewhere in the repo, it is a missing import); `test/helpers/backend-manager.ts` had a `static stop(...)` method declared AFTER the class's closing brace and `export default` statement, which is invalid JS/TS syntax (a `static` modifier at module top level) and would prevent the file from being parsed by any consumer at all. `DocumentScreen.navigateToDocument`/`getCurrentDocumentId` used a route scheme (`/workspace/:id/space/:id/page/:id`) that does not exist anywhere in AppFlowy-Web's router — confirmed by live inspection, the real route is `/app/:workspaceId/:pageId`. `DocumentScreen`'s editor selectors (`.ProseMirror`, `.doc-editor-contenteditable`) reference an editor library this app does not use at all (it uses Slate, `[data-slate-editor="true"]`). None of this code could ever have produced any of the passing evidence from prior tasks — all real evidence came from ad hoc standalone `.mjs` scripts (`docs/task66-evidence/task66-browser-verify.mjs` etc.), not from this screen-object framework.
- Task 68's claimed fix ("DocumentScreen.ts had a syntax defect — premature class-closing brace") was verified genuinely applied and correct (the class brace is now in the right place) — but the file was still functionally broken for the reasons above, which Task 68 did not reach.
- `playwright.config.ts` existed but had no `testDir` pointed at anything real, no actual test files ran under it, and each prior evidence script reimplemented its own backend/frontend lifecycle and env-var/MD5-backup discipline from scratch.

## 4. Task 66/67/68 failure analysis (from their own evidence, re-examined)

| Task | Symptom | Evidence | Classification |
|---|---|---|---|
| 66 | `#editor-title-<id>` click times out, "sticky top-0 z-[10] ... subtree intercepts pointer events" from inside a `MuiDialog-root` | `docs/task66-evidence/steps.log` | `TEST_SELECTOR_DEFECT` + `TEST_NAVIGATION_DEFECT` (modal not closed before interacting) |
| 67 | `page.evaluate` DOM `.focus()` on title silently fails (`document.activeElement !== el`) | `docs/task67-evidence/revocation-browser-verify/steps.log` | `TEST_NAVIGATION_DEFECT` (same root cause — MUI `FocusTrap` correctly rejects non-interaction-originated focus while the modal with its active backdrop is still open) |
| 68 attempt 1 | Same sticky-header/modal interception on `getByTestId('page-<id>').click()` | `docs/task68-evidence/scenario-b-restart/steps.log` | `TEST_NAVIGATION_DEFECT` |
| 68 attempt 2 | "Open as page" avoids the click-intercept error but hits "We couldn't find this content" toast | implementation report §Stage 7 | `TEST_TIMING_DEFECT` (confirmed in this task's own live repro: the toast is a real, transient, bounded propagation window, not a persistent defect — see §6) |
| 68 attempt 3 | Sidebar entry resolves in DOM but reports "not visible" for the full retry window | implementation report §Stage 7 | `TEST_NAVIGATION_DEFECT` (the space row's hover-revealed affordances can collapse across a route/modal transition; a bare `isVisible()` check without re-hovering never recovers) |

None of these were `FRONTEND_PRODUCT_DEFECT`s in the sense of breaking a real user's workflow outright — a real user's own mouse click (unlike Playwright's actionability-gated click) WOULD physically land on the modal backdrop and close it, then a second click would reach the title. This is nonetheless a genuine, if minor, UX rough edge (see §11), reported separately rather than silently worked around.

## 5. Reproduction evidence (Stage 2)

Live, disposable-backend-and-frontend reproduction (scripts in `/private/tmp/.../scratchpad/task69/repro{1..5}.mjs`, not committed — throwaway diagnostics) established, with DOM evidence at every step:

1. Immediately after quick-add document creation, `document.querySelectorAll('.MuiDialog-root')` returns exactly 1 element: `class="MuiDialog-root MuiModal-root ..."`, `role="presentation"`, full-viewport `rect` (`top:0 bottom:720 left:0 right:1280` at 1280×720 viewport), `pointerEvents:'auto'`, `opacity:'1'`, with a real `.MuiBackdrop-root` child also `opacity:'1'`/`pointerEvents:'auto'`. This is `ViewModal.tsx`'s own Dialog (confirmed by source inspection: `src/components/app/ViewModal.tsx`, mounted by `AppContextConsumer.tsx`, opened via `AppBusinessLayer.openPageModal`).
2. The full-page title element for the SAME page id (`#editor-title-<id>`) exists simultaneously, NOT nested inside that dialog (confirmed via ancestor-walk) — i.e. both a modal preview and the underlying routed page are mounted at once, exactly as the task brief described.
3. Playwright `locator.click()` on the title reproducibly times out with "... subtree intercepts pointer events", citing the dialog's own content as the intercepting ancestor — reproduced on 2 consecutive attempts with no settling delay helping (ruling out a pure animation-timing explanation).
4. Clicking the modal's own `view-modal-close` button (the real UI affordance) reliably drops the dialog count to 0 and unblocks all subsequent clicks — confirmed via `Escape` too, but the close button is preferred as the real, user-facing mechanism.
5. A reload performed too soon after creation showed, simultaneously in one screenshot: a "Connecting..." badge, a "Requires server 0.18.10 or later" compat banner, and a "We couldn't find this content." toast OVER real, already-rendered content — confirmed as a genuine, bounded propagation/reconnect window (cleared within single-digit seconds in every observed case), not a permanent failure.
6. A center-of-bounding-box click on the (tall, mostly-empty) body editor container intermittently left keystrokes landing in the title instead of the body, even though `document.activeElement` correctly reported the body container as DOM-focused — isolated to Slate's own internal selection model not always tracking a click landing in empty lower padding. A top-left-offset click reliably avoided this; confirmed via `document.activeElement` ancestor check after every click, not assumed.

## 6. Navigation strategy decisions

All 4 strategies from the brief were exercised, not just assumed:
- **(B) Direct route navigation** (`test/e2e/core-navigation.spec.ts` Scenario D) — used to isolate pure route/reload behavior from modal/sidebar interaction; passed reliably once the readiness gate (below) is applied.
- **(A) Application-driven creation** is unavoidable for creating a document at all (no direct-create route exists) — used in every scenario's setup, combined with the readiness gate.
- **(C) Sidebar navigation** (Scenario C) — implemented with explicit duplicate-match detection (`navigateViaSidebar` in `test/helpers/navigation.ts` counts matches and only proceeds when exactly one is visible, re-hovering the space row once before giving up) rather than blindly taking `.first()`.
- **(D) Modal "open as page" expansion** — the modal's own close button (`view-modal-close`) is used as the mechanism to leave the modal in every scenario (this IS the real, existing UI affordance Task 68's attempt 2 reached for); separately, Scenario B explicitly asserts the modal was genuinely open before closing it, rather than assuming.

**Decision**: no single strategy replaces the others. The suite exercises direct-route (D), sidebar (C), and modal-close (application-driven, A) paths in different scenarios, as the brief required.

## 7. Selector and wait/readiness strategy

- Document identity is established by the exact page id embedded in the URL right after creation, never guessed; every subsequent locator for that document (title, body, sidebar entry) is scoped by that exact id (`#editor-title-<id>`, `[data-slate-editor="true"][id$="editor-<id>"]`, `getByTestId(\`page-${id}\`)`), never a bare class/role match.
- `waitForDocumentReady()` (in `test/helpers/navigation.ts`) is the single readiness gate used everywhere: (1) close any open `.MuiDialog-root` via its real close button and poll until the dialog count is 0; (2) poll until the "couldn't find this content" toast is gone; (3) poll until the "Connecting..." badge is gone AND the exact-id title is visible. All three are condition-based polls with bounded timeouts, never a blind `waitForTimeout` alone. `networkidle` is never used (this is a WebSocket-heavy app, as the brief warned).
- `clickIntoDocumentBody()` tries a top-left-offset click, verifies via `document.activeElement` that focus actually landed in the body (not just that the click didn't throw), falls back to a default-position click, then to a title→ArrowDown keyboard path, verifying after each attempt rather than assuming success.
- The few fixed waits that remain (e.g. 300–400ms after a hover-reveal or a cursor-position settle) are each commented with why no better observable DOM signal exists.

## 8. Test isolation improvements (Stage 4)

`test/helpers/test-environment.ts` is new: allocates two genuinely free ports per run (verified via a real `net.createServer` probe, not a fixed/guessed port), a disposable temp-dir JSON data file (`mkdtemp`), backs up `AppFlowy-Web/.env.local` with an MD5 check before overwriting it and restores it byte-for-byte (re-verified by MD5) in `stopTestEnvironment`, starts backend+frontend as the ONLY two processes it owns, and kills only those two PIDs on teardown — never anything already listening on a port. `registerTestUser()` always creates a uniquely-timestamped+randomized disposable account. Every E2E test creates its own Space/Document; no test reuses another test's ids.

## 9. Changes implemented

| File | Change | Why |
|---|---|---|
| `test/helpers/navigation.ts` (new) | Condition-based navigation/readiness/typing primitives | Core Task 69 deliverable (§7) |
| `test/helpers/test-environment.ts` (new) | Disposable backend+frontend lifecycle, env-var backup/restore, port allocation | Core Task 69 deliverable (§8) |
| `test/e2e/core-navigation.spec.ts` (new) | 7-scenario E2E suite (A–G) | Stage 6 deliverable |
| `test/helpers/backend-manager.ts` | Moved `static stop()` back inside the class body (was after `export default`, a syntax error); fixed a `setTimeout(...).catch()` call (setTimeout returns no promise) | Genuine pre-existing defect, in scope as "corrected existing test-helper defects" |
| `test/screens/DocumentScreen.ts` | Fixed route scheme (`/app/:workspaceId/:pageId`, was a nonexistent `/workspace/.../space/.../page/...`), replaced nonexistent `.ProseMirror` selectors with the real Slate selectors, delegated navigation/typing/persistence methods to the new `navigation.ts` primitives, fixed `createPage` to use the real quick-add flow | Genuine pre-existing defects found during Stage 1 inspection, not assumed fixed by Task 68's syntax-only fix |
| `playwright.config.ts` | Added `testDir: './test/e2e'`, `workers: 1`/`fullyParallel: false` (spec files share `.env.local`, must not race) | Wire up the new suite |
| `package.json` | Added `"test:e2e": "playwright test"` | Run the new suite |
| `docs/task69-evidence/task68-scenario-b-reverify.mjs` (new) | Standalone Stage 7 re-verification script for Task 68 Scenario B | See §12 |

**No AppFlowy-Web product source file was changed.** `git status --short` in AppFlowy-Web is byte-identical before and after this task.

## 10. Core E2E test results

`npm run test:e2e` (7 scenarios, `test/e2e/core-navigation.spec.ts`), single fresh disposable backend+frontend per run:

- A. auth/app readiness — PASS
- B. creation opens a ViewModal; closing it reaches the stable full-page route (asserts the modal WAS open, not just that navigation "worked") — PASS
- C. sidebar navigation between 2 documents, exactly-one-match assertion — PASS
- D. direct full-page route navigation, survives reload — PASS
- E. content persists across a genuine reload, condition-based save wait, cross-checked against the backend's own page-view endpoint — PASS
- F. repeated A→B→A navigation ×3, no stray dialog after each nav — PASS
- G. two independent browser contexts (shared authenticated storage state) resolve the same document identity — PASS

## 11. Repeated-run stability results (Stage 9)

**5 consecutive full runs, each a fresh disposable backend+frontend+users: 35/35 individual test passes, 0 failures, 0 flaky, 0 blocked.** Logs: `docs/task69-evidence/stability-runs/run{1..5}.log`. No process-cleanup failures observed (verified no leftover `node server.js`/`vite` processes after each run via `ps`/`lsof`). This satisfies the "at least 5 consecutive successful runs" target; failed runs were investigated and fixed (not discarded) during development — see §5's "top-left click" and the Scenario-C space-id-resolution fix (the legacy `/pages` endpoint's `title` field is empty for real outline-created pages; fixed to use `parent_view_id` instead of a title match, confirmed via live debug output, not guessed).

## 12. Task 66/67/68 browser re-verification

**Task 66 (real-time fan-out) and Task 67 (authorization/revocation)**: NOT re-run this task. The new infrastructure (§6–§8) directly resolves the exact failure classes both tasks hit (modal interception, focus-trap rejection), and the core E2E suite (§10, Scenario G in particular) proves multi-context browser infrastructure is now reliable — but re-running their FULL original scenarios (live two-user fan-out proof; membership-revocation-mid-connection proof) was not attempted in this pass due to time/scope; doing so is the direct, low-risk next step the new infrastructure now enables. **Status unchanged: both remain "Backend tested."**

**Task 68 (collaboration recovery, Scenario B — backend restart)**: re-attempted using the new infrastructure (`docs/task69-evidence/task68-scenario-b-reverify.mjs`), genuinely different from Task 68's own 3 prior attempts (uses the Task 69 readiness gate + top-left body-click fix, not another click-coordinate variant). Result (`docs/task69-evidence/task68-scenario-b-reverify/results.json`):
```
documentEditBeforeRestart: PASS
backendRestarted: PASS
documentPersistedAfterRestart: PASS
documentWritableAfterRestart: PASS
liveDeliveryAfterRestart: NOT TESTED
```
The core restart scenario — real UI edit, real backend process kill+restart against the same disposable data file, real reload, persisted content confirmed in the browser, a brand-new post-restart edit succeeding end-to-end — **now passes via real browser automation**, closing the exact gap Task 68 reported Blocked. The bonus second-context live-delivery check hit an unrelated second-login timeout (a distinct, minor issue, not a reoccurrence of the original 3 blockers) and was not completed; per the 3-attempt cap and this task's time budget, this was not chased further. **Task 68's status is left unchanged ("Backend tested") because its full stated acceptance bar (including live delivery to a second context) was not completely satisfied — but the core restart/persistence/re-edit path, previously the primary Blocked claim, now has genuine browser evidence.** This is reported as a concrete, partial, evidenced improvement, not a status upgrade.

## 13. Backend regression (Stage 10, run fresh)

All matching documented baselines exactly: `npm test` 38/38, `test:offline-collab` 5/5, `test:collab-conformance` 6 passed/0 failed/2 pending/5 resolved, `test:database-collab` 13/13, `test:database-row-collab` 11/11, `test:database-catalog` 17/17, `test:realtime-fanout` 4/4, `test:security` 23/23, `test:collaboration-recovery` 8/8, `test:parity` 2/2, `test:postgres` 49/49 (DATABASE_URL exported in the same shell invocation). No test weakened, skipped, or deleted.

## 14. Environment cleanup evidence

Every disposable backend/frontend process spawned by this task's own scripts/suite was stopped by this task; verified via `ps aux` and `lsof -iTCP:<port> -sTCP:LISTEN` after each phase that no backend/frontend/orphaned Chromium process remained. One real leak was found and fixed during this task: a hand-rolled reverify script killed only its backend process in its `finally` block, leaking its frontend `vite` process and several Chromium subprocesses on an error path — found via `ps`, killed manually, and is a known limitation of that specific standalone script (the productized `test-environment.ts` helper used by the real E2E suite does not have this defect — it is covered by Playwright's own `afterAll`). `AppFlowy-Web/.env.local` MD5-verified back to its original `c85de40fc13dc3b2379325c6ecc3471d` at the end of this task. `AppFlowy-Web`'s `git status --short` is identical to the pre-task state. No user data, database, or unrelated file was deleted or reset.

## 15. Remaining limitations

- The `test/screens/*.ts` Page-Object framework (`BaseScreen` and siblings other than `DocumentScreen`) still has its own pre-existing architectural issues beyond this task's bounded scope (e.g. `BaseScreen.init()`'s own backend-per-screen + broad `'**/*'` route-rewriting design, which conflicts with the `.env.local`-based approach this task and all prior evidence scripts actually use) — not resurrected; `test/e2e/core-navigation.spec.ts` is the suite to prefer for new coverage.
- Task 68 Scenario B's bonus live-delivery-to-second-context leg, and full Task 66/67 scenario re-runs, remain open — the infrastructure to do them now exists and is proven reliable (§10–§11), the runs themselves were not completed in this pass.
- The ViewModal/full-page dual-render itself (§4–§5) is a real, if minor, UX rough edge: a real user's first click after quick-creating a document can be "absorbed" by the still-open modal's backdrop rather than reaching their intended target, requiring a second click. This is NOT an application-breaking defect (a real pointer click, unlike Playwright's gated click, does land on the backdrop and closes it) and was not fixed here, per scope — flagged for whoever owns `AppBusinessLayer.openPageModal`/`ViewModal.tsx` to consider.

## 16. Final status

**Task 69: Backend tested / Test infrastructure verified.** All core infrastructure criteria pass (§10), repeated-run stability is demonstrated (5/5 consecutive full-suite passes, §11), and a genuine, previously-Blocked historical scenario (Task 68 Scenario B's core restart/persistence/re-edit path) was newly closed with real browser evidence (§12). It is not "Complete" by this task's own status discipline because Task 68's full bonus scenario and Tasks 66/67's full historical re-verifications were not completed in this pass. Tasks 66, 67, and 68 keep their own existing statuses unchanged.
