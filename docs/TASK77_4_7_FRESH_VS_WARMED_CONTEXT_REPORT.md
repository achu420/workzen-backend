# Task 77.4.7 — Controlled Fresh-versus-Warmed Browser Context Comparison for Scenario I

Executed: 2026-11-12, ~00:45–01:00 IST. One worker, one experiment at a
time, tracing disabled (`--trace off`). No production file, no existing
acceptance spec, no config file modified. No timeout/retry value changed
anywhere. New diagnostic spec created:
`test/e2e/task77-4-7-warmed-context-diagnostic.spec.ts`.

## 1. Executive summary

**Outcome B: both the fresh-control arm and the warmed-context arm passed
the second write.** Accumulated execution state from a faithful
reconstruction of Scenarios A–H — including a genuine backend process
restart, 3 real transport-level disconnect/reconnect cycles, two full
`page.reload()`s of `pageA`, and roughly a dozen real UI mutations — **did
not** reproduce Scenario I's repeatable second-consecutive-cell-write
failure on the same long-lived browser context/page.

This directly tests, and weakens, the leading hypothesis carried forward
from Task 77.4.6 (that accumulated browser-context state, not navigation
type, was the missing trigger). It does **not** disprove the original
failure — §13 identifies one concrete, undemonstrated structural difference
between this reconstruction and the real suite that remains the most
likely remaining explanation: the real Scenarios A–H run as **8 separate
Playwright `test()` cases** with real inter-test boundaries, while this
diagnostic performs their operations as **inline function calls inside one
`test()` body**. That specific difference was not — and, within this task's
execution budget, could not be — isolated.

Two warmed-arm executions were run (the maximum "1 additional... to
distinguish a flake from a repeatable result" this task authorizes). The
first was **blocked** mid-warm-up by an unrelated harness flake in the
reconstruction's own `createRow` step (not a Scenario-I mechanism, and not
reproduced on the second attempt). The second completed the full A–H
reconstruction and the exact Scenario I sequence, and passed.

## 2. Task 77.4.4–77.4.6 findings carried forward

- Task 77.4.4: 3/3 isolated runs of the real Scenario I failed identically
  — the **second** of two immediately-consecutive `writeCell` calls on the
  same `rowId`/`fieldId` (scenario line 1065, `writeCell` line 266) times
  out its own 15000ms × 3-attempt visibility wait. No run approached the
  outer 240000ms budget. Host memory pressure was static-to-improving
  across all three runs.
- Task 77.4.5: a 5-run minimal-reproduction campaign in fresh contexts
  (pure minimal; + Document detour; + second peer; + preceding rename;
  + an attempted-but-blocked SPA-navigation difference) never reproduced
  the failure, while a direct re-run of the real, unmodified Scenario I in
  the same session did reproduce it immediately.
- Task 77.4.6: fixed the diagnostic's navigation-identity bug, proved
  genuine SPA sidebar navigation with direct `framenavigated` evidence
  (classified `spa-after-reload-retry`), and the second write **still
  passed** — ruling out "reload vs. SPA navigation" as the sole trigger.

## 3. Original Scenario A–I execution-model analysis

Read directly from `test/e2e/task77-1-database-multiuser.spec.ts` (lines
605–1096), not assumed from prior reports.

- All of P0 and A–I run inside **one** `test.describe` block with **one**
  `beforeAll` (lines 630–690): `contextA`/`contextB`/`pageA`/`pageB` are
  created exactly once and reused, unchanged, across every subsequent
  `test(...)` call in the file. There is no `beforeEach`/`afterEach` that
  recreates pages or contexts (the only `afterEach`, line 708, just saves
  evidence to disk). **Scenario I therefore runs on the identical `pageA`/
  `contextA` objects that every one of A–H already mutated.**
- Each of P0, A, B, …, I is a **separate Playwright `test(...)` call**
  with its own `test.setTimeout(...)` (180000 for A–F, 420000 for G, 300000
  for H, 240000 for I) and its own automatic Playwright-level bookkeeping
  (per-test screenshot-on-failure/video-on-failure capture, hook timing,
  `test.info()` tracking) — this structural property (separate test cases,
  not inline function calls within one test) is identified in §13 as the
  one difference this task could not reproduce or rule out.

### Execution-state map (built from direct source reading, not assumed)

| Scenario | Page/context reused? | Navigation | Collab objects accessed | WebSocket effects | Database/row mutations | Relevant persistent state |
|---|---|---|---|---|---|---|
| A (752–778) | Yes, `pageA` only | none | Database (ct=1) | one outgoing update | `renameField(pageA)` | Database field name changes |
| B (780–806) | Yes, `pageB` writes, **`pageA` is `page.reload()`-ed** (789) | full reload of `pageA` | Database (ct=1) | one outgoing update + `pageA`'s WS fully re-established by the reload | `renameField(pageB)` | Database field name changes; `pageA` loses all in-memory JS state (full navigation) |
| C (808–834) | Yes, `pageA` writes, `pageB` is `page.reload()`-ed (817) | full reload of `pageB` only | DatabaseRow (ct=4) | one outgoing update | `writeCell(pageA)` | DatabaseRow cell value changes |
| D (836–862) | Yes, `pageB` writes, **`pageA` is `page.reload()`-ed** (845) | full reload of `pageA` (2nd time) | DatabaseRow (ct=4) | one outgoing update + `pageA`'s WS re-established again | `writeCell(pageB)` | DatabaseRow cell value changes; `pageA`'s 2nd full reset |
| E (865–879) | Yes, `pageA` only | none | Database (ct=1), `row_orders` | one outgoing update | `createRow(pageA)` | New row id added to `row_orders` |
| F (882–923) | Yes, both, concurrently | none | 2× DatabaseRow (ct=4), different fields | 2 concurrent outgoing updates | `writeCell(pageA)` + `writeCell(pageB)` via `Promise.all` | Two cell values change concurrently; skipped if <2 fields |
| G (926–978) | Yes, `pageA`/`contextA` | **none** (no page reload — `contextA.setOffline(true/false)` 3×) | Database + DatabaseRow | **3× real WebSocket close+reopen via transport-level offline toggling** | 3× `renameField(pageA)` + 3× `writeCell(pageA)` | 3 real disconnect/reconnect cycles on the exact context/page Scenario I later uses |
| H (980–1025) | Yes, `pageA`/`pageB` | **full reload of both `pageA` and `pageB`** (990, 992) | Database + DatabaseRow | **genuine backend process kill+respawn** (`restartBackend`), both pages' WS fully re-established | `writeCell(pageA)` ×2, `renameField(pageA)` | A real process-boundary restart; both pages' entire JS/WS state reset by reload |
| I (1028–1095) | Yes, `pageA`/`pageB` (unchanged since beforeAll) | Document creation (SPA) + sidebar return (SPA, possibly with a reload-retry) | Document (ct=0) + Database (ct=1) + DatabaseRow (ct=4) | relies on whatever binding state `pageA`'s single WS connection is in after A–H | `renameField` → `writeCell` → `writeCell` → `renameField`, all on `pageA` | **The failing second `writeCell` call** |

### State-category classification (§4 of the brief)

1. **Browser-context state** (cookies/local storage/IndexedDB/session):
   genuinely accumulated across A–H on `contextA` — never cleared, never a
   new context. Two full reloads (B, D) reset in-memory JS but not
   IndexedDB/localStorage/cookies.
2. **Page state** (React state, mounted components, nav history, cached
   data): reset to a fresh mount twice (the B and D reloads) and once more
   by H's restart-triggered reload; **not** reset between E, F, G, or
   between H's reload and I (I runs on the same mounted React tree H's
   reload produced).
3. **Collaboration state** (WebSocket connections, bindings, subscriptions,
   Yjs doc instances, pending sync): this is the category most directly
   implicated by the Task 77.2 fix and the only one G and H specifically,
   deliberately exercise (3 real disconnects + 1 real process restart) on
   the exact connection Scenario I inherits.
4. **Test-process state** (shared JS variables, helper caches, listeners):
   `wsA`/`wsB`/`consoleA`/`consoleB` listeners are registered once in
   `beforeAll` and accumulate events across the whole file; `fieldId`/
   `rowId`/`databaseId`/etc. are shared module-scope variables, unchanged
   across all tests.
5. **Backend state** (persisted data, membership, peer registrations): by
   the time I runs, the Database collab has been renamed 6+ times, the row
   has been written 6+ times, a 2nd row exists (from E), and the backend
   process itself is a **different OS process** than the one the test
   suite originally started against (H's restart) — all genuinely
   persisted, not simulated.

This task's reconstruction (§6) exercises all five categories to the extent
practical; category 2 (page/React state) is the one most affected by the
difference named in §13.

## 4. Fresh-versus-warmed experimental design

Built as `test/e2e/task77-4-7-warmed-context-diagnostic.spec.ts` (new file;
the original acceptance spec was never opened for editing). Two `test(...)`
cases in one `test.describe`, each with its **own**, fully isolated
disposable backend environment (`task77-4-7-arma` / `task77-4-7-armb`
data directories) and its own freshly-registered owner/member identities —
Arm A cannot contaminate Arm B and vice versa. Both arms ran sequentially
in the same Playwright worker/process (`--workers=1`), using the same
`browser` fixture, but each arm calls `browser.newContext()` independently
— same browser **process**, genuinely different, never-shared **contexts**
across arms (the brief's own distinction, honored).

- **Arm A (fresh control)**: `beforeAll`-equivalent setup only, then the
  exact Scenario I sequence immediately.
- **Arm B (warmed)**: the same setup, then a faithful reconstruction of
  A–H's actual pageA/pageB/contextA-touching operations **in original
  order, on the same never-recreated context/page objects**, then the
  identical Scenario I sequence on that now-warmed `pageA`/`pageB`.

## 5. Exact A–H operations reproduced

| Scenario | Classification | Detail |
|---|---|---|
| P0 | **Omitted, with reason** | Read-only HTTP/DOM queries; confirmed by source read to have no observable effect on `pageA`/`pageB`/`contextA`/`contextB` state |
| A | **Exact reuse** | `renameField(pageA, fieldId, marker)` — identical helper code, identical call shape |
| B | **Exact reuse of its pageA-visible effect** | `renameField(pageB, ...)` (so the Database collab's field-name state matches the real run, not merely the reload) followed by `pageA.reload()` + the same post-reload wait — identical to lines 783–792 |
| C | **Exact reuse** | `writeCell(pageA, ...)` + `pageB.reload()` |
| D | **Exact reuse of its pageA-visible effect** | `writeCell(pageB, ...)` + `pageA.reload()` + `waitForGridRowReady(pageA, ...)` — identical to lines 839–848 |
| E | **Exact reuse** | `createRow(pageA)` (identical helper), `awaitRowPresentLive(pageB, ...)` kept for fidelity |
| F | **Exact reuse, including the original's own skip condition** | Identical `headerCount >= 2` gate; if satisfied, identical `Promise.all([writeCell(pageA,...), writeCell(pageB,...)])` concurrent pattern |
| G | **Exact reuse of all contextA/pageA operations; reconstructed poll durations** | The 3× `contextA.setOffline(true)` / wait 2500ms / `setOffline(false)` / wait 6000ms / `renameField(pageA,...)` / `writeCell(pageA,...)` sequence is identical. The two `awaitFieldNameLive`/`awaitCellTextLive` polls on `pageB` were shortened from the original's 10000ms/20000ms to 1500ms each (with intentionally-unmatchable marker strings), since this diagnostic does not assert on G's own delivery/persistence criteria — only reproduces G's connection-cycle effect on `contextA`/`pageA`. **This is a disclosed, deliberate reconstruction difference, not an oversight.** |
| H | **Exact reuse, including the genuine backend restart** | `writeCell(pageA,...)` → `restartBackend(env)` (real process kill+respawn against the same storage) → `pageA.reload()` + `pageB.reload()` → `writeCell(pageA,...)` → `renameField(pageA,...)` — identical to lines 983–1004 |

## 6. Operations omitted or reconstructed differently

- **P0**: omitted (§5, no state effect).
- **G's peer-poll duration**: reconstructed with shortened, intentionally-
  non-matching polls (§5) — a deliberate trade to keep this task's total
  execution time tractable, disclosed rather than silently done.
- **Structural difference not reconstructed at all** (the most important
  one): the real A–H sequence is 8 separate Playwright `test(...)` cases;
  this diagnostic performs their operations as inline function calls
  inside a single `test(...)` body. See §13 for why this specific gap was
  not closed within this task's budget.

## 7. Browser-context and page-lifetime evidence

Confirmed directly, not assumed:

- `contextA`/`pageA` (and `contextB`/`pageB`) are created exactly once per
  arm, via a single `browser.newContext()`/`context.newPage()` call pair,
  and never recreated for the remainder of that arm's test body — matching
  the real suite's `beforeAll`-once model.
- Two full `page.reload()`s of `pageA` occurred during Arm B's warm-up (B's
  and D's documented effects), plus a third full reload after H's
  `restartBackend()` — three genuine full navigations of `pageA` before
  Scenario I's own sequence began, matching the real suite's count exactly.
- `restartBackend(env)` was genuinely invoked in Arm B — confirmed by the
  test completing successfully only after this call resolved (it `await`s
  the real process kill+respawn) and by the subsequent `pageA`/`pageB`
  reloads succeeding against the new process.
- 3 genuine WebSocket disconnect/reconnect cycles occurred via
  `contextA.setOffline(true/false)` — a transport-level toggle, not a
  simulated event.

## 8. Collaboration-state evidence

Observable, without adding production instrumentation:

- By the time Scenario I's sequence began in Arm B, the Database collab
  had been mutated via `renameField` at least 5 times (A, B's pageB write,
  G×3, H) and the target row's cell had been written at least 6 times (C,
  D's pageB write, G×3, H×2) — each confirmed to have actually executed by
  the warm-up code's own control flow completing without throwing (the
  `.catch(() => {})` on G's calls would only suppress an error, not
  prevent the attempt).
- `pageA`'s single WebSocket connection survived 3 real disconnects and 1
  real backend-process replacement before Scenario I's sequence ran on it
  — i.e., by the time the failing-in-the-real-suite second `writeCell`
  call happened in this reconstruction, `pageA`'s connection had a
  materially more eventful history than Arm A's connection, which was
  never disconnected or reconnected at all.
- No production instrumentation was added; this evidence comes entirely
  from the warm-up code's own control flow and the DOM checkpoints in §9.

## 9. Fresh-control results (Arm A)

**PASSED.** Duration: 48.3s. `firstWriteCommitted: true`,
`secondWriteSucceeded: true`, `secondWriteError: null`. All 4 captured
checkpoints (before-write, retry-attempt-1, outcome-success, plus
after-first-write-commits) show: 1 matching cell, 1 visible, attached,
in-viewport, `computedVisibility: "visible"`, hit-test resolves to the same
node, renderer responsive (`1+1===2` → `true`), 4 rows present, 1
editor-like element, `activeElementTag: "BODY"` (no leftover open editor).

## 10. Warmed-context results (Arm B)

**Attempt 1: BLOCKED in warm-up, not at Scenario I.** `createRow(pageA)`
(the reconstruction's own E-equivalent step) failed its
`expect(rows).toHaveCount(before + 1)` assertion — the row count stayed at
1 across the full 15000ms poll window (34 consecutive reads), i.e. the
"New row" click did not visibly add a row within 15 seconds in this one
attempt. This happened **before** Scenario I's sequence was ever reached,
so **this specific attempt tested nothing about the hypothesis** and is
reported as a harness block, not a Scenario-I result, per the brief's own
rule 20.

**Attempt 2 (the one additional warmed execution this task authorizes, to
distinguish a flake from a repeatable result): PASSED, start to finish.**
Duration: 2.0 minutes total (including the real backend restart and 3
offline/online cycles). The identical `createRow` step that blocked
attempt 1 completed normally. This confirms attempt 1's block was a
**non-repeatable flake in this diagnostic's own warm-up reconstruction**,
unrelated to Scenario I's own mechanism (attempt 1 never got close to it).

Attempt 2's full result: `firstWriteCommitted: true`,
`secondWriteSucceeded: true`, `secondWriteError: null`. All 9 of A–H's
listed operations completed (§5's table), including the genuine backend
restart. `spaNavigationEvidence: { framenavigatedCount: 3,
viaClassification: "spa-after-reload-retry" }` — confirming, independently
of Task 77.4.6, that the return-to-Database navigation again used the real
helper's legitimate reload-retry mechanism, not a prohibited direct
target-page `goto()`. `docEditable: false` this run (vs. `true` in some
prior tasks' runs) — noted as an observed difference, not interpreted
further; the second-write result does not depend on this branch per the
source code (§3).

## 11. Second-write failure-time DOM evidence

**Not applicable — no failure occurred in either arm.** Both Arm A and Arm
B's attempt 2 passed the second write on the first retry attempt. Per the
brief's own instruction ("the most important requirement is to capture
this information during a genuine failure, if one occurs... do not treat
successful-path observations as evidence about a failing path"), §9's and
§10's checkpoint data describe only the two non-failing paths obtained by
this task and are not presented as evidence about the real suite's actual
failure state.

## 12. Comparison of the two arms

| Property | Arm A (fresh) | Arm B (warmed, attempt 2) |
|---|---|---|
| Prior full `pageA` reloads before the 2-write sequence | 0 | 3 (B, D, H) |
| Prior real WS disconnect/reconnect cycles on `contextA` | 0 | 3 (G) |
| Genuine backend process restarts before the sequence | 0 | 1 (H) |
| Prior real `renameField`/`writeCell` mutations on `pageA` | 0 | ~11 |
| SPA-navigation classification during Document→Database return | not separately tracked in Arm A (ran once, not compared) | `spa-after-reload-retry` |
| Second-write result | **PASSED** | **PASSED** |
| Duration | 48.3s | 2.0 min |

**Both arms produced the same outcome.** The single largest, most
deliberately accumulated difference this task could construct between them
— a genuine process restart plus 3 real disconnects plus 3 full reloads
plus ~11 prior mutations, all on the exact context/page objects Scenario I
then runs on — did not change the result.

## 13. Confirmed, weakened, refuted and unresolved hypotheses

- **Confirmed** (real browser interaction + navigation-event evidence): a
  faithful reconstruction of A–H's actual `pageA`/`pageB`/`contextA`
  operations — including a genuine backend restart and 3 real
  disconnect/reconnect cycles — can be performed as inline function calls
  within one Playwright test body without throwing, and the resulting
  warmed context still passes Scenario I's sequence.
- **Weakened, not refuted**: the hypothesis that accumulated
  browser-context/page/collaboration state from Scenarios A–H is
  sufficient, by itself, to reproduce Scenario I's second-write failure.
  Two independent lines of evidence now weigh against it as a *sufficient*
  single-factor explanation (this task's Arm B, and Task 77.4.6's genuine
  SPA-navigation test), while the real suite continues to reproduce the
  failure reliably (Task 77.4.4, and the direct re-run in Task 77.4.5 §1).
- **Unresolved, and the most concrete remaining lead**: this reconstruction
  performs A–H's *operations* but not A–H's *Playwright test-case
  structure*. The real suite runs P0 and A–I as **8 separate `test(...)`
  calls**, each with Playwright's own per-test lifecycle (independent
  `test.setTimeout` tracking, automatic failure-artifact capture wiring,
  `test.info()` reset, hook hand-off between tests). This diagnostic
  performs the equivalent operations as **function calls inside one
  `test(...)` body**. Whether Playwright's own inter-test boundary
  machinery (not the application) materially changes `pageA`'s state in a
  way that matters to the second write was **not tested by this task** and
  remains open. This is a plausible, not a confirmed, explanation.
- **Refuted, directly, by Attempt 1 vs Attempt 2**: that the `createRow`
  block observed in Arm B's first attempt is a repeatable, deterministic
  failure — it did not recur on an immediate retry under the same
  reconstruction code and sequence, consistent with an environmental flake
  rather than a defect in the warm-up reconstruction's logic.
- **Inconclusive**: whether G's shortened peer-poll durations (§5, §6)
  matter to the eventual second-write outcome — this task traded poll
  fidelity for tractable total runtime and cannot rule out that the full
  10s/20s polling windows (rather than 1.5s) would have left `pageA`'s
  connection in a measurably different state by the time Scenario I ran.

## 14. Whether accumulated context state contributes to the failure

**Not confirmed as the explanation by this task's evidence.** The specific,
large, and faithfully-reconstructed form of accumulated state this task
tested (3 disconnects, 1 real restart, 3 reloads, ~11 mutations, same
never-recreated context/page) did not reproduce the failure. This narrows,
but does not close, the search space — the one remaining structural
difference (§13, separate-test-case vs. inline-function-call execution) was
identified but not tested.

## 15. Whether the test helper or AppFlowy-Web appears responsible

**Not determined by this task.** No new evidence in this task implicates
`writeCell()`, the grid component, or any specific frontend/test-helper
code as the cause — both arms passed, so there is no failure to attribute.
The one new, disclosed-but-unresolved harness observation (§10, Arm B
attempt 1's `createRow` block) did not recur and was not chased further
given this task's authorized execution budget (max 1 fresh + 1 warmed + 1
additional warmed) was fully spent reaching a conclusive Outcome B.

## 16. Exact files changed

| File | Status |
|---|---|
| `test/e2e/task77-4-7-warmed-context-diagnostic.spec.ts` | **New file.** Diagnostic only, clearly labeled as such in its own header comment. Contains byte-level-equivalent copies of every helper from `task77-1-database-multiuser.spec.ts` needed to reconstruct A–H and I (duplicated, not imported, since the original does not `export` them), plus new read-only DOM-checkpoint instrumentation (`captureCellCheckpoint`) and the two-arm test structure. |
| `docs/task77-4-7-evidence/diagnostic-result.json` | New evidence artifact, overwritten after each test by `saveEvidence()` |
| `docs/task77-4-7-evidence/` (env backups, etc.) | Normal `startTestEnvironment`/`stopTestEnvironment` output, not a change to this task's scope |
| `docs/TASK77_4_7_FRESH_VS_WARMED_CONTEXT_REPORT.md` | **New.** This file. |
| `test/e2e/task77-1-database-multiuser.spec.ts` | **Not modified.** Read-only throughout (md5 `3899dad9498e4060e96453cd4742489c`, unchanged before and after) |
| `server.js` | **Not modified** (md5 `f46509f6e92a258cf8277a8614af62c9`, unchanged) |
| Any frontend production file | **Not modified** |

No production file, no Task 77.2 subscription code, no WebSocket admission
logic, no Playwright configuration file, and no existing test file was
changed anywhere in either repository.

## 17. Cleanup and integrity verification

| Item | Expected | Verified |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** |
| Original Scenario I file md5 | unchanged from before this task | **`3899dad9498e4060e96453cd4742489c`, confirmed unchanged** |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** |
| Port 8787 | free | **free** |
| Disposable backend/Vite processes leaked | none | **zero leaked**, verified via `ps aux` after both arms and both warmed attempts |
| VSCode Playwright extension service | present, untouched | **present** (confirmed running, a different PID than previously observed, consistent with normal IDE-managed lifecycle; not started/stopped/interacted with by this task) |
| Dependencies installed/updated | none | **none** |
| Scenario B, D, G, H run independently | none | **none** — only reproduced as part of the Arm B reconstruction's operations, never run as the original acceptance spec's own test cases |
| Full Task 77.1–77.3 suite run | none | **none** |
| Production files modified | none | **none**, confirmed by the md5 checks above |

## 18. Remaining unknowns

- **The real mechanism behind Scenario I's repeatable failure is still not
  identified.** Five tasks (77.4.4–77.4.7) have now tested host memory
  pressure, SPA-vs-reload navigation, and a faithful operational
  reconstruction of accumulated A–H state — none reproduced it, while the
  real, unmodified spec continues to.
- **The one concrete, untested structural difference** (§13): whether
  running the warm-up as 8 genuinely separate Playwright `test(...)` cases,
  rather than inline function calls in one test body, matters. This was
  identified but not exercised within this task's authorized execution
  budget.
- Whether G's shortened peer-poll durations materially affect the outcome
  (§13) is untested.
- Whether Arm B attempt 1's one-off `createRow` block has any relationship
  to the real failure family is unknown — it did not recur, was not
  chased further, and is reported only as an observed, non-repeating event.
- The actual DOM state of a genuine Scenario I failure remains uncaptured
  by any task in this chain to date — no diagnostic run (across 77.4.5,
  77.4.6, or this task) has ever itself failed with instrumentation
  attached.

## 19. Recommended next action

The single most promising untested lead is now the structural difference
named in §13: **reconstruct the warm-up as genuinely separate Playwright
`test(...)` cases** (e.g., a new diagnostic file with 9 real `test(...)`
blocks mirroring P0/A–I's structure, sharing `pageA`/`pageB`/`contextA`
exactly as the real suite's single `beforeAll` does, rather than performing
A–H's operations as function calls inside one `test()`), to determine
whether Playwright's own per-test lifecycle — not any application
behavior — is the differentiator between "reproduces" and "doesn't
reproduce." This is a larger undertaking than this task's budget (at most
1 fresh + 2 warmed executions) allowed, and should be scoped as its own
follow-up task rather than attempted as a fourth execution here.

This report does not make this a mandate — it is offered as the
evidence-supported next step, for the user's own decision, consistent with
every other report in this chain.

## Final response summary

- **The real Phase 1 state-accumulation map was built from direct source
  reading** of `task77-1-database-multiuser.spec.ts` (§3), not assumed from
  prior reports — it shows Scenario I runs on the exact `pageA`/`contextA`
  objects created once in `beforeAll` and mutated by every one of A–H,
  including 3 full reloads, 3 real disconnect/reconnect cycles, and a
  genuine backend process restart.
- **A–H's `pageA`/`pageB`/`contextA`-touching operations were reused
  verbatim** (exact copies of `renameField`/`writeCell`/`createRow`/
  `openSharedDatabase`/`restartBackend`/`contextA.setOffline`), in original
  order, on a never-recreated context/page pair; only P0 (no state effect)
  was omitted and G's peer-poll durations were deliberately shortened
  (disclosed in §5/§6/§13) since this task does not assert on G's own
  acceptance criteria.
- **The warmed arm genuinely retained the same browser context/page
  throughout** — confirmed by the warm-up code completing without
  recreating `contextA`/`pageA`, by 3 real full reloads and 1 real backend
  restart being observably invoked (§7), and by direct `framenavigated`
  evidence during the final SPA return navigation (§10).
- **Fresh-arm result: PASSED** (48.3s). **Warmed-arm result: PASSED**
  on the completed attempt (2.0 min; a first attempt was blocked by an
  unrelated, non-repeating `createRow` flake in warm-up, before Scenario I
  was ever reached).
- **Neither arm failed**, so no failure-time DOM evidence exists to report
  (§11) — this is stated honestly, not fabricated.
- **Outcome B**: SPA-style/warmed-context execution succeeded and both
  writes passed in both arms. This does not disprove the original failure;
  §13 identifies the exact, most-likely remaining untested difference
  (separate-test-case vs. inline-function-call warm-up structure).
- **No root cause was confirmed.**
- **No production file changed** in either repository (verified by
  unchanged md5s for `server.js` and the original Scenario I spec).
- **The original Scenario I acceptance test was preserved**, unopened for
  editing, md5-verified unchanged.
- **All temporary processes and resources were cleaned up** — zero leaked
  disposable backend/Vite processes, port 8787 free, frontend git status
  unchanged at 33 entries, VSCode's Playwright extension service left
  running untouched.

No status for Task 77.2, 77.3, 77.4, or any other task was upgraded or
otherwise changed by this task.
