# Task 77 — Collaboration Reliability: Reconnection, Multi-Client and PostgreSQL Browser Verification

## 1. Executive summary

**Verified, with real evidence, and passing:**
- Document reconnection after a genuine backend-process restart (Phase 1, Scenario A) — reusing the existing Task 68 suite, re-run live against the current (Task 76/76.1-fixed) code.
- Two independently-authenticated-user, two-browser-context live Document collaboration, both directions, including immediately after a restart (Phase 2, Scenarios A/B) — same suite.
- Row-detail-page lifecycle (content persistence, favorite, trash-vs-remove) against **real PostgreSQL** storage, real Chromium (Phase 3, Scenario A) — the exact Task 73 scenario, now run with `TASK77_PG_STORAGE=1`.
- Database + DatabaseRow persistence across a genuine backend-process restart against **real PostgreSQL** (Phase 3, Scenario B) — new, narrowly-scoped spec.
- Full backend regression: JSON-mode (129/129), PostgreSQL-mode (56/56), JSON/Postgres parity (2/2).
- Full frontend regression touching this collaboration chain: 158/158 (includes Task 76.1's ordering tests, Task 74's Dexie-area tests, typecheck clean).

**Not verified this pass (explicitly, not silently):**
- Database/DatabaseRow reconnection after a WebSocket disconnect (Phase 1, Scenarios B/C/D).
- Two-client live collaboration for Database-level mutations, DatabaseRow cell edits, multi-object sessions, or concurrent edits (Phase 2, Scenarios C/D/E/F).
- Two-client collaboration against PostgreSQL specifically (Phase 3, Scenario C).

**No defect was found or reproduced this pass.** Everything that was exercised live passed on the first attempt, including the exact Document reconnection/two-client path that most directly exercises Task 76.1's `rawEmit`/`lastBoundObjectId` revert-on-failure logic under a real disconnect/reconnect cycle.

**Final status: Browser verified for the scenarios above — Task 77 is NOT Complete.** The Database/DatabaseRow reconnection and two-client scenario classes remain outstanding acceptance criteria, listed in §9, not silently dropped.

## 2. Environment

- Frontend: `/Volumes/work disk/Codes/Tracker/AppFlowy-Web` (pre-existing working-tree changes preserved; `git status --short` = 33 entries, unchanged in count from before this task).
- Backend: `/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend` (no `.git`, confirmed).
- Browser: Chromium via `@playwright/test` (project's pinned version, headless).
- Backend storage modes exercised: JSON (default disposable mode) and PostgreSQL.
- PostgreSQL test environment: a **pre-existing, dedicated, isolated** local database `appflowy_independent_test` (owned by the local user, already provisioned before this task — confirmed via `psql -l` that it is a distinct database from every other project database on the machine, e.g. `pinkdream_dev`, `Simply blood`; nothing production or commercial was touched). Connection string used: `postgresql://achal@localhost:5432/appflowy_independent_test`, passed via `DATABASE_URL`.
- Test users/workspaces: each scenario registers its own disposable, uniquely-timestamped users (no shared/reused credentials across scenarios); no tokens or credentials are logged in this report.

## 3. Reconnection results (Phase 1)

| Scenario | Steps | Result | Evidence |
|---|---|---|---|
| A — Document reconnection | Owner creates Document, types content; live two-context Document suite drives a real backend-process restart (`restartBackend()` — kills and respawns the actual `node server.js` process against the same data file/port), both browser contexts reload and reconnect, content verified present (`test('C2. backend restart against the SAME storage; both contexts reconnect and pre-restart content persists')`) | **PASSED** | Real Chromium, real process restart: `npx playwright test test/e2e/historical-collaboration-acceptance.spec.ts -g "Task 68"` → `3 passed (33.2s)` |
| B — Database reconnection | Open a Database, disconnect/reconnect, mutate (e.g. rename a view/field), verify rebind-before-update and post-reload persistence | **NOT TESTED** | No existing spec exercises this; not built this pass — see §9 |
| C — DatabaseRow reconnection | Open a Database with a row, disconnect/reconnect, edit a cell, verify binding + persistence | **NOT TESTED** | Same as B |
| D — Repeated reconnect (×3) | Repeat disconnect/reconnect 3+ times for one object, verify no stale binding / no duplicate or lost updates | **NOT TESTED** for Database/DatabaseRow. **Partially covered for Document**: the Task 68 suite's C1→C2→C3 sequence is itself two reconnect-relevant transitions (pre-restart live delivery, the restart itself, post-restart bidirectional live delivery) on the same two contexts, all passing — but this is 1 restart, not 3 repeated disconnects of a still-running backend, so it does not fully satisfy Scenario D's literal repetition requirement. | Real Chromium (see Scenario A) |

Scenario A's pass is **direct, real evidence** that Task 76.1's `rawEmit`-returns-`Promise<boolean>`/`lastBoundObjectId`-revert-on-failure logic (and Task 76's underlying awaitable-SyncRequest ordering fix) survives a genuine process-boundary reconnect without regressing — the suite's own C2/C3 tests require both post-restart rebind and bidirectional live delivery to succeed, and they did, with no `1008` close observed in either browser context's console/network activity during the run.

## 4. Two-client results (Phase 2)

Two genuinely independent `browser.newContext()` instances with two independently registered/authenticated users (owner + member), not two tabs of one session — confirmed by reading the suite's `beforeAll` (`contextA = await browser.newContext(); contextB = await browser.newContext();`, separate `registerTestUser` calls, explicit membership grant via the backend API).

| Scenario | Direction | Result | Live delivery vs. HTTP fallback | Evidence |
|---|---|---|---|---|
| A — Document: Client 1 → Client 2 | Owner → Member | **PASSED** | **Live** (`readDocumentBodyWithRetry` with no `page.reload()` on the receiving side, before a separate reload-based check) — explicit hard assertion `expect(bSawLive, 'Task 71 fix: member must receive the pre-restart marker LIVE, without a reload').toContain(...)` | `C1` in the same run |
| B — Document: Client 2 → Client 1, post-restart | Member → Owner, and Owner → Member, both immediately after the real restart | **PASSED** | **Live**, both directions, no reload — `C3`'s hard assertions on `bSawPostALive`/`aSawPostBLive` | Same run |
| C — Database-level update | Client 1/2 | **NOT TESTED** | — | No existing coverage for sharing a Database page across two independent workspace members' browser contexts; not built this pass |
| D — DatabaseRow cell update | Client 1/2 | **NOT TESTED** | — | Same reason as C |
| E — Multiple object contexts | Document + Database + DatabaseRow in one session | **NOT TESTED** | — | Not attempted |
| F — Concurrent edits | Separate parts of a shared object | **NOT TESTED** | — | Not attempted |

Persisted-state proof (not just UI-visible) for Scenarios A/B: both contexts additionally reload and re-verify content after the restart in `C2`/`C3`, which reads the content fresh from the backend-served Document state, not from a long-lived in-memory client cache.

## 5. PostgreSQL browser results (Phase 3)

| Scenario | Result | Evidence level |
|---|---|---|
| A — Row-detail lifecycle (content persistence, favorite, trash-vs-remove, ordinary-Document-authorization control) | **PASSED** | **Real browser connected to PostgreSQL.** `TASK77_PG_STORAGE=1 DATABASE_URL=postgresql://achal@localhost:5432/appflowy_independent_test npx playwright test test/e2e/database-row-detail-page.spec.ts --reporter=line` → `2 passed (30.0s)`. This is the identical, unmodified Task 73 scenario (its own code was not changed; only `beforeAll`'s storage selection became opt-in-configurable), now proven against Postgres instead of only JSON. |
| B — Database and row persistence, including after a real backend restart | **PASSED** | **Real browser + real backend restart against PostgreSQL.** New spec `test/e2e/task77-postgres-restart.spec.ts`: creates a Database, creates 3 rows, restarts the actual backend process (`restartBackend()`) against the same `DATABASE_URL`, reloads, confirms all 3 rows are still present. `1 passed (16.1s)`. Skips cleanly (does not fail) when `DATABASE_URL` is unset, so it never affects the default JSON-only path — confirmed: `1 skipped` when run without `DATABASE_URL`. |
| C — PostgreSQL collaboration (two-client) | **NOT TESTED** | Depends on Phase 2's Database/DatabaseRow two-client infrastructure, which was not built this pass |

## 6. Regression results (Phase 4)

### Backend

```
$ npm test                              → 38/38 passed
$ npm run test:offline-collab           → 5/5 passed
$ npm run test:database-collab          → 13/13 passed
$ npm run test:database-row-collab      → 11/11 passed
$ npm run test:database-catalog         → 17/17 passed
$ npm run test:database-view-collab     → 6/6 passed
$ npm run test:realtime-fanout          → 4/4 passed
$ npm run test:security                 → 23/23 passed
$ npm run test:collaboration-recovery   → 8/8 passed
$ npm run test:row-document             → 4/4 passed
Subtotal: 129/129 passed
```

```
$ DATABASE_URL=postgresql://achal@localhost:5432/appflowy_independent_test npm run test:postgres
→ 56/56 passed (includes row-document, security/authorization, version-history,
  collaboration-recovery, and the full end-to-end isolated-persistence/concurrency
  suite, all against real Postgres)
```

```
$ DATABASE_URL=... npm run test:parity   → 2/2 passed
```

No failures, no skips, no known flakes recurred.

### Frontend

```
$ npx jest src/components/app/layers/__tests__/AppSyncLayer.test.tsx \
    src/components/ws/__tests__/useSync.test.ts \
    src/components/ws/sync/__tests__/useSyncContextLifecycle.history.test.ts \
    src/components/ws/sync/__tests__/useSyncContextLifecycle.ordering.test.ts \
    src/application/sync-outbox/__tests__/sync-outbox.test.ts \
    src/application/db/__tests__ --coverage=false
→ Test Suites: 9 passed, 9 total
→ Tests: 158 passed, 158 total
```

```
$ npm run type-check   → clean, exit 0
```

This confirms Task 71's binding fix, Task 74's Dexie fix, and Task 76/76.1's ordering fix all remain intact and mutually compatible after this task's (additive-only) changes.

## 7. Defects discovered

**None.** Every scenario actually exercised live passed on its first run; no reproduction attempt was needed. No production code was changed in this task (see §8 — only test infrastructure and a new test file).

## 8. Files changed

| File | Classification | Why |
|---|---|---|
| `test/helpers/test-environment.ts` | Test infrastructure | Added an optional, default-preserving `options: { storage?: 'json' \| 'postgres'; databaseUrl?: string }` parameter to `startTestEnvironment()`, and made `restartBackend()` reuse the environment's own recorded storage mode instead of hardcoding `'json'`. Every existing caller that omits the new parameter is byte-for-byte unaffected (confirmed: re-ran `database-row-detail-page.spec.ts` and `database-views.spec.ts`-style flows with no option passed — identical behavior). |
| `test/e2e/database-row-detail-page.spec.ts` | Test infrastructure (1-line opt-in) | Added an `TASK77_PG_STORAGE=1`-gated branch in `beforeAll` to optionally start the disposable environment against Postgres. Default (unset) behavior unchanged — confirmed by re-running it with no env var set: `2 passed`, identical to its pre-existing baseline result. |
| `test/e2e/task77-postgres-restart.spec.ts` | New test | New, narrowly-scoped spec for Phase 3 Scenario B (Database/DatabaseRow restart-persistence against Postgres). Skips cleanly without `DATABASE_URL`. |
| `docs/TASK77_COLLABORATION_RELIABILITY_REPORT.md` | Documentation/report | This file. |

No backend production file was changed. No Task 71, Task 74, or Task 76/76.1 production file was changed. No destructive git operation was run; all pre-existing modified/untracked files in both repositories were preserved (frontend `git status --short` entry count unchanged; backend has no `.git`).

## 9. Remaining limitations

Explicitly outstanding, not silently dropped:

1. **Database reconnection** (Phase 1, Scenario B) — not tested.
2. **DatabaseRow reconnection** (Phase 1, Scenario C) — not tested.
3. **Repeated (3×) reconnect** for Database/DatabaseRow specifically (Phase 1, Scenario D) — not tested; the Document-only repeated-transition evidence in §3 is related but not a literal substitute.
4. **Two-client Database-level mutation delivery** (Phase 2, Scenario C) — not tested.
5. **Two-client DatabaseRow cell-edit delivery** (Phase 2, Scenario D) — not tested.
6. **Multi-object (Document+Database+DatabaseRow) two-client session** (Phase 2, Scenario E) — not tested.
7. **Concurrent-edit convergence** (Phase 2, Scenario F) — not tested.
8. **Two-client collaboration against PostgreSQL** (Phase 3, Scenario C) — not tested; depends on items 4–6 first existing for any storage mode.

The common root cause of 1–7: no existing Playwright helper shares a Database/DatabaseRow page across two independently-authenticated workspace members' browser contexts the way `openSharedDocument()` already does for ordinary Documents (confirmed by grep — that helper and its membership-grant plumbing in `historical-collaboration-acceptance.spec.ts` are Document-specific). Building that helper, plus the view/field/cell interaction selectors for a second authenticated user, is a materially-sized new-test-authoring effort, not something this verification-focused pass attempted to construct from scratch under its own time budget. This is a real gap in coverage, not a known or suspected defect — nothing in this task's evidence suggests Database/DatabaseRow reconnection or two-client delivery behaves differently from the proven Document case, but that is an inference from architecture, not a tested fact, and should not be reported as verified.

## 10. Final task status

**Browser verified** — for: Document reconnection, Document two-client live delivery (both directions, including post-restart), PostgreSQL row-detail-page browser lifecycle, and PostgreSQL Database/Row restart-persistence, all with real-Chromium evidence, plus full backend/Postgres/parity/frontend regression passing.

**Task 77 is NOT Complete.** Outstanding acceptance criteria, per §9: Database/DatabaseRow reconnection (items 2–3), two-client Database/DatabaseRow/multi-object/concurrent-edit delivery (items 4–7), and two-client PostgreSQL collaboration (item 8). Recommend a focused follow-up task scoped specifically to building the missing "share a Database page across two independent members" test infrastructure and then exercising Phase 1 Scenarios B–D and Phase 2 Scenarios C–F against it.
