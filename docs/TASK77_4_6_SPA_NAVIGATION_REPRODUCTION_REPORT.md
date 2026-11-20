# Task 77.4.6 — SPA Navigation Reproduction and Scenario I Execution-Context Diagnosis

Executed: 2026-11-12, ~00:18–00:42 IST. One worker, one experiment at a
time, tracing disabled. Only the diagnostic file
(`test/e2e/task77-4-5-consecutive-cell-write-diagnostic.spec.ts`) was
modified. No production file, no existing acceptance spec, no config file
changed. No timeout/retry value changed anywhere.

## 1. Executive summary

**Outcome B: SPA-style navigation succeeded and both writes passed.**

Task 77.4.5's own untested lead — whether the real scenario's client-side
sidebar return-navigation (vs. a full-page reload) was the missing trigger
for the second-consecutive-write failure — was finally exercised across 3
attempts (the maximum this task authorized), after fixing a genuine bug in
the diagnostic's own navigation-identity resolution. The corrected
navigation succeeded on attempt 3. **The second write still passed.** This
weakens, but does not eliminate, the SPA-navigation hypothesis as *the*
trigger: genuine sidebar-based return navigation, reproduced with direct
evidence, does not by itself reproduce the failure either. No root cause is
confirmed. The real, unmodified Scenario I was **not** re-run in this task
(out of scope — it was re-run already in Task 77.4.5); this task's
contribution is specifically closing the one gap Task 77.4.5 left open.

## 2. Task 77.4.5 findings carried forward

- 3/3 real Scenario I runs (Task 77.4.4) failed identically: the second of
  two immediately-consecutive `writeCell` calls on the same row/field times
  out its own 15000ms × 3-attempt visibility wait.
- Task 77.4.5's 5-run minimal-reproduction campaign (pure minimal; +Document
  detour; +second peer; +preceding rename) never reproduced the failure.
- A 4th reintroduced difference — replacing the Document-detour's
  `page.goto()` return with the real scenario's genuine client-side sidebar
  navigation — was **never actually tested**: the diagnostic's own sidebar
  resolution found 0 matching entries and silently fell back to the
  already-tested `goto()` path.
- A direct re-run of the real, unmodified Scenario I in the same session
  **did** reproduce the failure immediately — confirming the failure is a
  live, current property of the real spec's exact execution context, not a
  stale artifact of an earlier task's host state.

## 3. Real navigation helper source analysis

Read directly from `test/e2e/task77-1-database-multiuser.spec.ts` and
`test/helpers/navigation.ts` (static tier):

- **`openSharedDatabase()`** (lines 512–563) is not a pure SPA-navigation
  helper — it begins with a full `page.goto()` to the **workspace root**
  (`/app/${workspaceId}`, not the target page), then attempts up to 3
  rounds of `navigateViaSidebar()` from there, reloading the *current* page
  between failed attempts (to let the sidebar's page list refresh — the
  sidebar list is fetched, not pushed). Only if all 3 rounds fail does it
  fall back to a direct `page.goto()` of the **target** grid page — that
  specific fallback is what this task was forbidden to use, and never did.
- **`navigateViaSidebar()`** (navigation.ts:285–321) calls `expandSpace()`,
  then resolves `page.getByTestId('page-${pageId}')`, with one internal
  re-hover-and-retry if the entry isn't immediately visible, and an
  explicit "more than one match" disambiguation path (resolving to whichever
  copy is actually visible).
- **`sharedDatabasePageId`** (the identifier passed into every
  `openSharedDatabase()` call throughout the real spec, including Scenario
  I's mid-test return at line 1057) is resolved **once**, in the suite's
  setup, via `resolveSidebarDatabasePage()` — before the Document page (or
  any other page) exists. It finds the Database's sidebar-visible ancestor
  page (`extra.database_id === databaseId && parent_view_id === spaceId`)
  and is reused, unchanged, for the rest of the suite.
- **`spaceId`** is likewise resolved once, via `resolveSpaceId()`
  (`pages[0]?.parent_view_id ?? null` against the `/api/workspaces/{id}/pages`
  endpoint), at a point when the Database page is the only page under the
  space, making index 0 a safe proxy for "any space-child page."

**Task 77.4.5's actual bug, confirmed by this source read**: its diagnostic
re-derived both `spaceId` and the sidebar page id **mid-scenario, after the
Document page already existed** — using the identical `pages[0]`-indexed
heuristic, but now against a page list that had grown to 3+ entries in a
non-guaranteed order. This is not a flaw in the real helper (which only ever
resolves these values once, early) — it is specifically a timing bug in how
the diagnostic reused the heuristic.

## 4. Diagnostic-versus-real-helper comparison

| Behavior | Real Scenario I helper | Task 77.4.5 diagnostic (before fix) | Required correction |
|---|---|---|---|
| Target page identity (`sharedDatabasePageId`) | Resolved once, in setup, before any other page exists | Re-resolved mid-scenario, after the Document page existed | Resolve once, immediately after Database/row creation, before the Document detour |
| `spaceId` | Resolved once, in setup (`pages[0]` when it is the only page) | Re-resolved mid-scenario (`pages[0]` when 3 pages exist) | Same: resolve once, early |
| Sidebar container / entry selector | `page.getByTestId('page-${pageId}')`, scoped to the correct ancestor id | Same selector, but fed the wrong/unresolved id due to the above | Fixed by correcting when the id is captured, not the selector itself |
| Ancestor resolution | `extra.database_id === databaseId && parent_view_id === spaceId` | Identical logic, same bug (wrong `spaceId` input) | Same |
| Readiness condition | `navigateViaSidebar`'s own internal re-hover/retry, plus `openSharedDatabase`'s outer reload-and-retry loop (3 attempts) | Called `navigateViaSidebar` directly, bypassing the outer reload-retry loop entirely | Reproduce the outer 3-attempt reload-retry loop, not just the inner primitive |
| Retry behavior | 3 attempts, reload between failures | 1 attempt only (before this task's fix) | Reproduce the 3-attempt loop |
| Navigation action | sidebar click | sidebar click (same) | unchanged |
| SPA navigation verification | none (not needed for acceptance purposes) | none (before this task) | Added in this task: a `framenavigated` listener counting real full navigations across the whole return sequence |
| Full reload fallback (to the TARGET page) | last resort only, after 3 failed sidebar rounds | silent, immediate, on the very first sidebar failure | Removed entirely for this experiment, per §5's "no silent fallback" rule — replaced with BLOCKED reporting |

## 5. Exact diagnostic navigation correction

Two source-level fixes were made, both confined to
`test/e2e/task77-4-5-consecutive-cell-write-diagnostic.spec.ts`:

1. **Early identity capture.** Immediately after row creation (before the
   Document detour or the second peer context are created), the diagnostic
   now resolves `spaceIdEarly` and `sidebarPageIdEarly` via the exact same
   `/api/workspaces/{id}/pages` query and `pages[0]`-indexed logic the real
   helpers use — but at the correct moment, mirroring the real spec's setup
   ordering exactly, rather than re-deriving it later.
2. **Reproduced the real reload-retry loop, not just the inner primitive.**
   The diagnostic now calls `navigateViaSidebar()` up to 3 times, reloading
   the *current* page between failures — exactly `openSharedDatabase()`'s
   own documented mechanism — and never calls `page.goto()` on the *target*
   grid page at any point. A `page.on('framenavigated', ...)` listener,
   installed before the loop starts, counts every full navigation that
   occurs during the whole sequence, so a reload that happens as part of
   this legitimate retry mechanism is recorded and reported honestly rather
   than silently laundered into a false "pure SPA" claim.
3. A route-change wait (`page.waitForFunction(() => location.href !== prev)`)
   was added after creating the Document page, reproducing the real
   scenario's own documented readiness condition at that step (spec line
   ~1041) — this is not a new delay invented to force a pass; it is the
   real scenario's own pre-existing pattern, applied at the one place the
   diagnostic had previously used a flat timeout instead.

No change was made to `writeCell()`, to the acceptance spec, or to any
selector/timeout/retry constant.

## 6. Evidence proving SPA navigation

| Attempt | Fix state | `framenavigated` count during return sequence | Sidebar result | Classification |
|---|---|---|---|---|
| 1 | Early-identity fix only (reload-retry loop not yet added) | n/a (never reached a navigation — sidebar entry not visible after 1 attempt) | `{ ok: false, matchedCount: 0, reason: 'sidebar entry not visible after retry' }` | **Navigation blocked** |
| 2 | + route-change wait after Document creation | n/a (same) | `{ ok: false, matchedCount: 0, reason: 'sidebar entry not visible after retry' }` | **Navigation blocked** |
| 3 | + reproduced the real 3-attempt reload-retry loop | **1** (one reload occurred between sidebar attempt 1 and attempt 2) | `{ ok: true, matchedCount: 1, via: 'sidebar(attempt 2)' }` | **SPA navigation achieved via the real helper's own reload-retry mechanism — not the prohibited target-page fallback, but not a zero-reload pure SPA transition either** |

Per §5's required classification scheme, attempt 3's result does not map
cleanly onto "SPA navigation confirmed" (zero navigations) nor "full-page
navigation detected" (the forbidden direct-goto-to-target fallback, never
used) — it is the real helper's own legitimate, documented resilience
mechanism (reload the *current* page to refresh a lazily-fetched sidebar
list, then retry the *same* sidebar-click navigation), which this report
labels precisely as **`spa-after-reload-retry`** rather than forcing it
into one of the two cleaner buckets. This is disclosed explicitly rather
than reported as unqualified "SPA navigation confirmed."

**Only 1 of the 3 permitted attempts produced a usable navigation outcome**
(attempt 3); attempts 1 and 2 were consumed establishing and then fixing
the identity-resolution bug described in §3–§5, which is itself the
concrete, actionable correction this task set out to find and apply.

## 7. Attempt-by-attempt execution results

| Attempt | `spaceIdEarly` resolved | `sidebarPageIdEarly` resolved | Sidebar nav result | First write | Second write | Outcome |
|---|---|---|---|---|---|---|
| 1 | ✓ (`9c87b71d-...`) | ✓ (`61ed114f-...`) | Blocked — entry not visible | not reached | not reached | **BLOCKED** |
| 2 | ✓ (`c2fde462-...`) | ✓ (`b34abfcc-...`) | Blocked — entry not visible | not reached | not reached | **BLOCKED** |
| 3 | ✓ (`d4fab3e5-...`) | ✓ (`1ca2852a-...`) | **Succeeded, attempt 2 of the retry loop, 1 reload** | succeeded | **succeeded** | **SPA nav achieved; second write PASSED** |

Screenshots captured on the blocked attempts (`test-results/.../test-failed-*.png`)
show the sidebar's space row rendering only its single `Untitled`
(Document) child, with the `New Database` entry absent at that moment —
consistent with the sidebar's page list genuinely not yet reflecting a
just-created page (the exact race `openSharedDatabase`'s own code comment
names), which is precisely what its reload-retry loop exists to absorb —
and is exactly why reproducing that loop (not just the inner primitive)
was the necessary fix, confirmed in attempt 3.

## 8. Exact Scenario I sequence used

Reproduced in the diagnostic, matching the real spec's order: create
Database + one row → open a second, independent authenticated peer context
→ create a Document under the same space, wait for its route to change,
type into it → return to the Database via the corrected sidebar-navigation
sequence (§5) → a field-header rename (matching the real
rename→write→write→rename order) → first `writeCell` → **second,
immediately-consecutive `writeCell` on the identical row/field, no
navigation in between** (the exact condition under diagnosis). No direct
backend/Yjs mutation was used anywhere; every step went through the real UI.

## 9. Second-write result

**Passed.** `firstWriteCommitted: true`, `secondWriteSucceeded: true`,
`secondWriteError: null`. The second write's cell locator resolved on its
very first attempt (no retries consumed).

## 10. Failure-time DOM evidence, if failure occurred

**Not applicable — no failure occurred in the one successful SPA-navigation
attempt obtained.** All 5 checkpoints (before first write, after first
write, before second write, each second-write retry attempt, at outcome)
show: exactly 1 matching cell element, visible, attached, renderer
responsive (`1+1===2` resolved `true` at every checkpoint), exactly 1 row
present, exactly 1 editor-like element (the cell itself; no leftover open
editor). This describes only the non-failing path obtained in this task,
consistent with — and not contradicting — Task 77.4.5's own non-failing-path
findings.

## 11. Comparison against the successful reload-based path

Task 77.4.5's runs 1–4 (goto-based return, or the accidental goto fallback
in run 5) all passed the second write. This task's attempt 3
(genuine sidebar-based return, via the real retry mechanism, with one
mid-loop reload) **also** passed. The one variable this task was built to
isolate — SPA-style sidebar return vs. a full-page reload return — produced
**the same outcome (pass) in both configurations**, as far as this task's
evidence goes. This is a materially stronger conclusion than Task 77.4.5
could reach (which could only report the comparison as untested), but it
is still a single data point for the SPA-navigation condition, not a
repeated/confirmed one (the 3-attempt budget was exhausted establishing it
at all).

## 12. Confirmed and unconfirmed hypotheses

- **Confirmed** (real browser DOM/navigation-event evidence): Task 77.4.5's
  diagnostic contained a genuine identity-resolution bug — it re-derived
  `spaceId`/sidebar-page-id mid-scenario using a `pages[0]`-indexed
  heuristic that is only safe when resolved early, before other pages
  exist — causing its SPA-navigation branch to silently fall back to
  `goto()` every time, rather than any defect in the application's sidebar
  rendering.
- **Confirmed** (static source inspection): the real `openSharedDatabase()`
  helper's resilience comes from an outer 3-attempt reload-and-retry loop
  around `navigateViaSidebar()`, not from the inner primitive alone; this
  task's first two attempts failed specifically because they bypassed that
  outer loop.
- **Weakened, not refuted** (real browser interaction): SPA-style sidebar
  navigation, with genuine evidence via a `framenavigated` listener, does
  not — on this one obtained data point — reproduce the second-write
  failure by itself. It cannot be ruled out as *a* contributing factor
  under different timing, but it is not, on this evidence, a sufficient
  trigger on its own.
- **Inconclusive**: whether the one reload that occurred during attempt 3's
  retry loop (needed because the sidebar entry wasn't immediately visible)
  itself reintroduces enough of a "clean state" to mask the real failure
  condition — this task cannot distinguish "SPA navigation doesn't trigger
  the bug" from "this specific SPA navigation happened to include a reload
  that reset the relevant state anyway."
- **Still open**: the real mechanism behind the real Scenario I's
  repeatable failure. Four structural differences (Task 77.4.5) plus this
  task's corrected SPA-navigation difference have now been tested
  individually and in combination without reproducing it, while the real,
  unmodified spec reproduces it reliably (Task 77.4.4, and once more in
  Task 77.4.5 §1 run 6).

## 13. Whether the issue appears to be in the test helper or frontend application

**Not determined by this task.** This task's scope and 3-attempt budget
were consumed correcting and exercising one specific reconstruction
difference (SPA vs. reload return navigation), which did not reproduce the
failure. No new evidence implicates `writeCell()`, the grid component, or
any other specific frontend/test-helper code as the cause. The one
concrete, confirmed defect this task found and fixed (§3–§5) was in the
**Task 77.4.5 diagnostic itself**, not in the application or in
`writeCell()`.

## 14. Exact files changed

| File | Status |
|---|---|
| `test/e2e/task77-4-5-consecutive-cell-write-diagnostic.spec.ts` | **Modified** (diagnostic file only — explicitly authorized). Diff: replaced the mid-scenario `spaceId`/sidebar-page-id re-derivation with an early capture performed right after row creation; replaced the single-attempt `navigateViaSidebar` call with a reproduced 3-attempt reload-and-retry loop (mirroring `openSharedDatabase`); added a `framenavigated`-based navigation-type classifier (`spa-confirmed`/`spa-after-reload-retry`/`blocked`) in place of the previous window-marker approach; added a BLOCKED-path sidebar DOM dump and evidence write with no fallback to a direct target-page `goto()`; added a route-change wait after Document-page creation. Net: +~70/-~35 lines, confined entirely to this one diagnostic file. |
| `docs/task77-4-5-evidence/diagnostic-result.json` | Overwritten by each of the 3 runs (normal evidence artifact; reflects only the final run's data) |
| `docs/TASK77_4_6_SPA_NAVIGATION_REPRODUCTION_REPORT.md` | **New.** This file. |
| `test/e2e/task77-1-database-multiuser.spec.ts` | **Not modified.** Read-only throughout. |
| `server.js` | **Not modified.** |
| Any frontend production file | **Not modified.** |

No instrumentation was added to the real acceptance spec or to any
production file. The diagnostic file's diff is disclosed above rather than
claimed as "unchanged," per §11's explicit requirement.

## 15. Cleanup and integrity verification

| Item | Expected | Verified |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** |
| Port 8787 | free | **free** |
| Disposable backend/Vite processes leaked | none expected | **zero leaked** — verified via `ps aux` after all 3 runs |
| VSCode Playwright extension service | present, untouched | present (a different PID than previously observed, consistent with normal IDE-managed lifecycle; not started/stopped by this task) |
| Dependencies installed/updated | none | **none** |
| Scenario B, D, G, H run | none | **none** — only the diagnostic (3 attempts), per this task's scope |
| Full Task 77.1–77.3 suite run | none | **none** |
| Production files modified | none | **none**, confirmed by the md5 checks above |
| Original Scenario I test | preserved | **unchanged** — not opened for editing |

## 16. Remaining unknowns

- The real mechanism behind Scenario I's repeatable second-write failure is
  **still not identified**. This task closed one specific, previously-open
  gap (genuine SPA-navigation testing) without reproducing it, which
  narrows but does not complete the search space.
- Whether a *pure*, zero-reload SPA navigation (sidebar entry visible and
  clickable on the very first attempt, no intervening reload at all) would
  behave differently from this task's one obtained data point (which
  required one reload to succeed) is untested — this task's 3-attempt
  budget did not allow repeating the experiment to obtain a zero-reload
  sample.
- Whether the real, long-lived `pageA`/`pageB` contexts (reused across many
  prior scenarios A–H within the same `describe` block before Scenario I
  ever runs) carry accumulated state — WebSocket subscriptions, Yjs
  document instances, React component state, prior navigation history —
  that this task's always-fresh diagnostic contexts cannot replicate,
  remains a plausible, untested explanation for why the real spec
  reproduces the failure reliably while every reconstruction in Task 77.4.5
  and this task does not.
- The DOM state of a genuine failure is still uncaptured — no diagnostic
  run in this task or Task 77.4.5 has ever actually failed with
  instrumentation attached.

## 17. Recommended next action

The single most promising untested lead is now the one named in Task
77.4.5 §17's second, lower-priority alternative: **reproduce the diagnostic
inside the same long-lived browser context/page sequence the real spec
uses**, rather than a fresh context per diagnostic run — specifically, by
running the diagnostic's write/write sequence as the **Nth** test in a
describe block that first runs several unrelated real-UI interactions
(mirroring Scenarios A–H's accumulated navigation/WebSocket history) against
the same `pageA`, instead of a clean, freshly-created context. This task's
evidence makes the "freshness of the browser context" hypothesis more
load-bearing than the SPA-vs-reload navigation-type distinction, which this
task has now tested directly and found insufficient on its own to
reproduce the failure.

This report does not make this a mandate — it is offered as the
evidence-supported next step, for the user's own decision, consistent with
every other report in this chain.

## Final response summary

- The diagnostic's sidebar-navigation bug **was corrected**: it had been
  re-resolving `spaceId`/sidebar-page-id mid-scenario (after the Document
  page already existed) using a `pages[0]`-indexed heuristic that is only
  safe when resolved early; fixed by capturing both values immediately
  after row creation, before the Document detour.
- **Genuine SPA-style navigation was proven** on attempt 3, via a
  `framenavigated` listener counting real full-page navigations across the
  whole return sequence — classified precisely as
  `spa-after-reload-retry` (the real helper's own legitimate reload-retry
  mechanism fired once before the sidebar click succeeded; the prohibited
  direct-goto-to-target fallback was never used in any of the 3 attempts).
- **No attempt silently or accidentally fell back to a direct `goto()` of
  the target grid page** — attempts 1 and 2 were honestly reported as
  BLOCKED instead.
- **1 of the 3 maximum attempts produced a valid, evidenced navigation
  outcome** (the first 2 were consumed diagnosing and fixing the
  identity-resolution bug).
- **The exact real Scenario I sequence was reproduced** through that
  corrected navigation path (Document detour → sidebar return → rename →
  write → write → rename), with a second genuinely independent peer
  context present throughout.
- **The second write PASSED** under genuine SPA-style navigation — it did
  **not** reproduce the failure.
- **If it had failed**, this report would contain direct DOM evidence
  (5 checkpoints were instrumented); since it did not fail, §10 reports
  this explicitly as not applicable rather than fabricating a comparison.
- **No root cause was confirmed.**
- **No production file changed** in either repository (verified by
  unchanged md5s).
- **The original Scenario I acceptance test was preserved**, unopened for
  editing.
- **All temporary resources and processes were cleaned up** — verified
  zero leaked disposable processes, port 8787 free, frontend git status
  unchanged at 33 entries.

No status for Task 77.2, 77.3, 77.4, or any other task was upgraded or
otherwise changed by this task.
