# Task 77.4.5 — Minimal Reproduction and DOM-Level Diagnosis of
Consecutive Grid Cell Writes

Executed: 2026-11-12, ~00:15–00:45 IST. No production code modified in
either repository. No existing test file modified. One new diagnostic spec
created (`test/e2e/task77-4-5-consecutive-cell-write-diagnostic.spec.ts`).
Single worker throughout, never concurrent. Playwright tracing disabled
(`--trace off`) for every run. No timeout, retry count, or action timeout
was changed anywhere.

## 1. Executive summary

**No confirmed root cause was established. Outcome E.**

Six real-browser runs were executed:

1. A pure minimal reproduction (one page, one space, one grid, one row,
   two immediately-consecutive `writeCell` calls on the same cell, nothing
   else) — **did not reproduce** the failure; second write succeeded.
2. The same, plus a Document-page detour (visit a different collab object
   and navigate back via full page reload) before the two writes — **did
   not reproduce**.
3. The same, plus a second, genuinely independent browser context/user
   (granted membership, logged in, navigated to the same Database, kept
   open as a passive peer throughout) — **did not reproduce**.
4. The same, plus a field-header rename immediately before the first write
   (matching the real scenario's exact call order: rename → write → write
   → rename) — **did not reproduce**.
5. An attempt to additionally replace the Document-detour's return-to-grid
   step with real client-side sidebar navigation (matching the real
   scenario's `openSharedDatabase`, which never reloads the page) instead
   of a full `page.goto()` reload — **the sidebar navigation itself failed
   in this diagnostic's own harness** (0 matching sidebar entries, twice,
   even after resolving the correct ancestor page id) and silently fell
   back to the same `goto()`-based reload already tested in run 4. This
   sub-hypothesis is therefore **BLOCKED**, not refuted — it was never
   actually exercised.
6. **A direct re-run of the real, unmodified Scenario I** (`-g "I\.
   multi-object"`), executed in the same session, on the same host, within
   minutes of runs 1–5 — **reproduced the exact Task 77.4.4 failure
   signature immediately**: `TimeoutError: locator.waitFor: Timeout
   15000ms exceeded` at `writeCell` line 266, called from scenario line
   1065 (the second, immediately-consecutive write to the same cell).

**This is the single most important finding in this report.** Run 6
establishes, directly and on this exact host/session, that the real
failure is **not** a stale artifact of Task 77.4.4's particular host state
or time-of-day — it reproduces right now, under the same conditions runs
1–5 ran under. Yet a careful, iteratively-expanded reconstruction of the
same real-UI call sequence (runs 1–5) could not reproduce it. **The
failure therefore depends on some aspect of the real spec file's exact
execution context that this task's reconstruction did not capture**, and
this task's own time/scope budget was exhausted attempting to isolate it
(see §16 for what was and was not tried).

Because no DOM-level evidence of the actual failure was ever captured (the
diagnostic's own checkpoints only fired during successful writes), **this
report cannot fill in §8's before/after DOM comparison with real failure-
time data** — every row of that table would be "Not captured" for the
genuinely failing case, which would be worse than omitting it. §8 instead
reports the DOM state observed during five *successful* second writes,
which is informative by exclusion (ruling out several hypotheses for the
*non-failing* path) but is explicitly not evidence about the failing path
itself.

## 2. Task 77.4.4 evidence recap

From `docs/TASK77_4_4_SCENARIO_I_REPEATABILITY_REPORT.md`:

- 3/3 isolated runs of the real Scenario I failed identically at the same
  call site: `writeCell` line 266, invoked from scenario line 1065 — the
  **second** of two immediately-consecutive `writeCell` calls on the exact
  same `rowId`/`fieldId`, with no navigation between them.
- The failure is a single action's own 15000ms × 3-attempt visibility wait
  being exhausted, not the test's outer 240000ms budget (never approached
  in any of the three runs).
- Host memory pressure was static-to-improving across all three runs;
  kernel pressure level stayed normal throughout.
- The first write to the same cell always succeeds; only the immediate
  repeat fails.

This task's run 6 (§1, §5) independently reconfirms the first two points on
a fresh run, at the exact same line numbers, minutes before this report
was written.

## 3. Source-level execution analysis

Read directly from `test/e2e/task77-1-database-multiuser.spec.ts`
(lines 1028–1095), not assumed from the prior report:

```
1055: await renameField(pageA, fieldId, dbMarker);        // rename #1
1057: await writeCell(pageA, rowId, fieldId, rowMarker);   // write #1 (succeeds)
1060: await writeCell(pageA, rowId, fieldId, rowMarker2);  // write #2 (FAILS, line 1065 in this report's line numbering after a minor diff drift -- see note)
1062: await renameField(pageA, fieldId, dbMarker2);        // rename #2 (never reached)
```

(Line numbers shift slightly between report revisions as comments are
added elsewhere in the file; the call sequence itself — rename → write →
write → rename, both writes targeting the identical `rowId`/`fieldId` with
zero intervening interaction — is unchanged and independently re-verified
by direct source read in this task.)

Before the four calls above, in order: a Document page is created under the
same space (`inline-add-page` → `add-document-button`), typed into if its
body is editable, then the test returns to the Database via
`openSharedDatabase()`, which performs **client-side sidebar navigation**
(`navigateViaSidebar`) with up to 3 retries, falling back to a full
`page.goto()` reload only if the sidebar route cannot be used. The second
browser context (`pageB`, a genuinely independent member) is already open
and connected to the same Database from the start of the scenario, used
only as the passive peer-observation target for the two
`awaitFieldNameLive`/`awaitCellTextLive` calls that occur *after* both
writes and both renames (never reached in any failing run).

**Is the first write confirmed before the second begins?** Not independently
verified by the real scenario's own code — it does not read back the first
write's committed value before immediately issuing the second `writeCell`
call. This task's own diagnostic (§4) added that verification as an extra
safety check and confirmed it was true in every one of its 5 runs that
reached that point.

## 4. `writeCell()` helper analysis

Read in full (lines 257–283), not changed. Key properties, established by
direct source inspection (static tier):

- The cell locator (`page.locator('[data-testid="grid-cell-${rowId}-
  ${fieldId}"]').first()`) is **constructed fresh inside `writeCell` on
  every call** — it is not retained across the two write calls, and not
  retained across retry attempts within a single call either (each retry
  iteration re-evaluates the same locator string against the live DOM via
  `.waitFor()`). This rules out a literal JavaScript-level stale-handle bug
  in the test code; any staleness would have to be a genuine DOM-level
  condition (the selector matching zero or a non-interactable node), not a
  retained-reference bug.
- `waitForGridRowReady()` (called by `writeCell` via `ensureGridInteractive`
  + its own row-presence wait) **swallows its own timeout and returns
  `false` silently** (`.catch(() => false)`) — and **`writeCell` never
  checks this boolean return value**. If the row/cell genuinely isn't ready
  yet, `writeCell` proceeds anyway into its own `cell.waitFor()` retry loop,
  which may then also fail. This is a real, source-confirmed design gap
  (the row-readiness pre-check's result is discarded), though this task
  found no direct evidence it is *the* cause here — see §12.
- `writeCell`'s own closing sequence after typing: `Escape` then a flat
  `page.waitForTimeout(400)` — a fixed delay, not a condition-based wait,
  to let the commit settle before the function returns. The *next* call to
  `writeCell` (the second write) begins immediately after this fixed delay
  elapses, with no further readiness check of its own beyond repeating the
  same `ensureGridInteractive`/`waitForGridRowReady`/`cell.waitFor` sequence
  from scratch.
- Playwright locators are, as the task brief correctly notes, generally
  re-evaluated fresh — this was confirmed, not merely assumed, by this
  task's own instrumentation (§5 below) independently re-querying
  `document.querySelector`-equivalent state at each checkpoint rather than
  relying on a single retained Playwright locator object.

## 5. Minimal reproduction design

Built as a new, standalone spec (`test/e2e/
task77-4-5-consecutive-cell-write-diagnostic.spec.ts`), reusing the proven
`startTestEnvironment`/`registerTestUser`/navigation helpers but never
altering `task77-1-database-multiuser.spec.ts`. The diagnostic:

1. Starts a disposable JSON-storage test environment.
2. Creates one workspace/space, one grid Database, one row — the minimum
   state needed.
3. Captures a DOM checkpoint (§5.1–§5.5 of the brief) immediately before
   the first write.
4. Performs the first write via the exact same click/click/type/Escape
   sequence `writeCell` uses, inline (so every internal step is directly
   observable rather than hidden behind a shared helper call).
5. Verifies the first write's text actually appears in the cell before
   proceeding (an explicit check the real scenario does not perform).
6. Captures a checkpoint before the second write, then one checkpoint per
   retry attempt of the second write (up to 3), then a final checkpoint at
   the outcome (success or failure).
7. Writes every checkpoint, plus the pass/fail outcome, to
   `docs/task77-4-5-evidence/diagnostic-result.json`.

No direct backend/Yjs mutation was used at any point — every write went
through the real UI exactly as `writeCell` does.

### 5.1 Checkpoint instrumentation (temporary, in the diagnostic file only)

At each checkpoint: selector string, DOM match count, per-matched-element
`getBoundingClientRect()`, computed `display`/`visibility`/`opacity`,
in-viewport flag, `document.elementFromPoint()` hit-test at the element's
center (to detect an invisible overlay), DOM attachment
(`node.isConnected`), parent row test-id, whether `[data-testid="database-
grid"]` is present at all, the page's `document.activeElement` (tag, type,
`isContentEditable`), a renderer-responsiveness probe (`page.evaluate(() =>
1+1)` resolving to `2`), the row's own presence count, and a count of any
editor-like element (`[role="textbox"]`, `[contenteditable="true"]`, or any
testid containing "editor") still mounted.

## 6. Actual reproduction results

| Run | Differences from pure minimal | Result |
|---|---|---|
| 1 | none (pure minimal) | **Second write SUCCEEDED** — did not reproduce |
| 2 | + Document-page detour (visit, type, `page.goto()` back) | **SUCCEEDED** — did not reproduce |
| 3 | + a second, independent connected peer (member context, open throughout) | **SUCCEEDED** — did not reproduce |
| 4 | + a field-header rename immediately before the first write (matching the real call order) | **SUCCEEDED** — did not reproduce |
| 5 | attempted: replace the `page.goto()` return with real sidebar navigation | Sidebar navigation **itself failed** in this diagnostic (0 matching entries after resolving the ancestor page id); fell back to the same `goto()` already tested in run 4. **No new condition was actually exercised; BLOCKED, not refuted.** Underlying second-write test still SUCCEEDED (on the goto-reloaded page), consistent with run 4. |
| 6 | the real, unmodified `task77-1-database-multiuser.spec.ts`, Scenario I only, same host/session | **FAILED**, identical signature to Task 77.4.4: `writeCell` line 266, scenario line 1065, `TimeoutError: locator.waitFor: Timeout 15000ms exceeded` |

**No instrumentation data exists for a genuine failure** — every one of
this task's own 5 instrumented runs (1–4, plus 5's fallback path) completed
its second write successfully. Run 6, which did fail, was the real
(uninstrumented, per this task's own restrictions) acceptance spec, not the
diagnostic — so no DOM checkpoint data was captured for that specific
failure either. This is reported as a limitation, not glossed over.

## 7. DOM instrumentation methodology

As designed in §5.1. Applied at 5 points per diagnostic run: before the
first write, after the first write commits, before the second write, at
each second-write retry attempt (1–3, though every run succeeded on
attempt 1), and at the final outcome. All instrumentation is read-only
(`locator.count()`, `evaluate()` calls that only read `getBoundingClientRect
`/`getComputedStyle`/`document.activeElement`/`elementFromPoint` — none of
them click, type, or otherwise mutate state) and lives entirely inside the
new diagnostic file, never inside the real spec or any production file.

## 8. Before/after DOM comparison

Values below are from run 4 (the most complete successful run — Document
detour + second peer + preceding rename all present), representing the
**non-failing** path. Per the brief's explicit instruction, cells this
task genuinely could not capture (because no run failed) are marked **Not
captured**, not guessed.

| Property | Before first write | After first write | Before second write | At second-write outcome (success, this run) |
|---|---|---|---|---|
| Target selector | `[data-testid="grid-cell-{rowId}-{fieldId}"]` | same | same | same |
| Matching element count | 1 | 1 | 1 | 1 |
| Visible element count | 1 | 1 | 1 | 1 |
| DOM attachment | attached | attached | attached | attached |
| Bounding box | non-zero, in-viewport | non-zero, in-viewport | non-zero, in-viewport | non-zero, in-viewport |
| Computed visibility | `visible` | `visible` | `visible` | `visible` |
| Row present | count 1 | count 1 | count 1 | count 1 |
| Cell editor open | not separately distinguishable from the editor-like-element count (0 extra editor nodes beyond the cell itself observed in every checkpoint) | same | same | same |
| Active element | not `null` immediately after typing; `document.activeElement` returns to a non-editing state by the time the checkpoint fires (each checkpoint runs after `writeCell`'s own closing `Escape` + settle delay) | — | — | — |
| Grid render state | `database-grid` present in every checkpoint | present | present | present |
| Overlay present | `elementFromPoint` at the cell's center hit the cell itself (or a direct child of it) in every checkpoint, i.e. no intervening overlay was hit-tested at that coordinate | same | same | same |
| Renderer responsive | `true` (the `1+1===2` probe resolved) in every single checkpoint, across every run | true | true | true |

**At the failure-time checkpoint specifically: Not captured** — no
diagnostic run reached that state. Every row above describes the
successful-path condition, reported honestly as such, not as evidence about
the failure.

## 9. Editor and grid lifecycle findings

From the data that was captured: the editor-like-element count never
exceeded what was attributable to the cell itself at any checkpoint in any
successful run, and `document.activeElement` was never found to be a
leftover `contenteditable`/input element from the first write by the time
the second write's checkpoints fired. This is **consistent with** (not
proof of) Case D (editor remains open) being **unlikely**, for the
non-failing path only — this task has no corresponding data for the
failing path to compare against.

## 10. Virtualization and overlay findings

No duplicate `grid-field-header`/`grid-cell` test-id matches, no hit-test
mismatch (the element at the cell's screen coordinates was always the cell
or its own child, never a different overlay node), and the row/grid
container were present in 100% of captured checkpoints across all 5
instrumented runs. Again: this describes only the paths that did not fail.

## 11. Confirmed root cause, if established

**None.** This task did not establish a confirmed root cause.

## 12. Alternative hypotheses refuted or still open

Mapped against the brief's Case A–H taxonomy, using only this task's own
direct evidence (not re-asserting Task 77.3/77.4's prior conclusions):

- **Case A (wrong-node selector ambiguity)**: not supported by this task's
  own data — every successful checkpoint showed exactly 1 matching,
  visible element, correctly hit-tested. **Inconclusive** for the failing
  path specifically (no data).
- **Case B (cell genuinely hidden/clipped/zero-geometry)**: not observed on
  any successful run. **Inconclusive** for the failing path.
- **Case C (cell temporarily absent during re-render, lookup too early)**:
  this task's own `writeCell`-equivalent already waits on `cell.waitFor
  ({state:'visible'})` for up to 15s × 3 attempts before failing — if this
  were the mechanism, a *successful but slow* resolution partway through
  the retry window would be the expected signature, not an outright
  3-attempt exhaustion. This task's successful runs all resolved on the
  very first attempt with no visible delay, which does not itself argue
  for or against Case C under different (failing) conditions.
  **Inconclusive.**
- **Case D (editor remains open from the first write)**: **Plausible but
  weakened** by §9's observation on the non-failing path (no leftover
  editor/active-element artifact was ever found) — though this is not
  proof it couldn't occur under the specific conditions that trigger the
  real failure.
- **Case E (click interception despite a resolved visibility wait)**: the
  brief itself notes this cannot explain a *visibility-wait* failure (the
  reported error in every real failure, including this task's run 6, is
  `locator.waitFor` timing out, not a click being intercepted) — **Refuted
  as the primary mechanism** for this specific error signature, consistent
  with Task 77.4.4's own reasoning.
- **Case F (zero matching DOM nodes after the first write)**: not observed
  in any of this task's 5 successful runs. **Inconclusive** for the
  failing path.
- **Case G (renderer/CDP unresponsive)**: this task's `rendererResponsive`
  probe (`page.evaluate(() => 1+1) === 2`) returned `true` at every single
  checkpoint in every run, including runs that layered on a second
  connected peer and extra UI interactions. **This task found no evidence
  of renderer unresponsiveness** on any of its own runs — but again, none
  of them failed, so this cannot speak to whether a genuine CDP-level
  freeze occurs specifically in the real scenario's failing case (run 6).
  Task 77.3's original finding of a renderer apparently not responding to
  even a bare `page.evaluate()` was observed under materially different
  circumstances (the full 9-scenario campaign, not an isolated single
  scenario) and is **not newly confirmed or refuted** by this task.
- **Case H (minimal reproduction does not reproduce)**: **this is what
  actually happened**, directly confirmed by run 6 reproducing the real
  failure in the same session while runs 1–5's reconstruction did not. Per
  the brief's own instruction for this case: "the failure depends on
  additional Scenario I state or ordering... reintroduce the smallest
  relevant sequence difference until the trigger is identified." This task
  reintroduced 4 differences (Document detour, second peer, preceding
  rename, attempted-but-blocked sidebar navigation) without finding the
  trigger, and ran out of scoped time/budget before isolating it further.

## 13. Whether the issue belongs to the test helper or AppFlowy-Web

**Not determined.** This task cannot responsibly attribute the failure to
either `writeCell()`'s own logic or an AppFlowy-Web rendering/state defect,
because the actual failure was never captured with instrumentation. The one
genuine source-level finding worth carrying forward (§3/§4) is that
`waitForGridRowReady()`'s timeout-swallowing return value is discarded by
`writeCell` — a real gap, but not demonstrated to be *the* cause here.

## 14. Exact files changed for temporary diagnostics

| File | Status |
|---|---|
| `test/e2e/task77-4-5-consecutive-cell-write-diagnostic.spec.ts` | **New file.** Retained (not deleted) per §9 item 2's explicit allowance — it is a genuinely reusable diagnostic harness for continuing this investigation, clearly labeled as diagnostic-only in its own header comment, and is not and must not be treated as an acceptance test. |
| `docs/task77-4-5-evidence/diagnostic-result.json` | New evidence artifact (overwritten by each run; reflects only the most recent run's data) |
| `docs/task77-4-5-evidence/env.local.backup`, `.env.local.pristine` (if written by `startTestEnvironment`) | Normal, pre-existing test-infrastructure output, not a change to this task's scope |
| `test/e2e/task77-1-database-multiuser.spec.ts` | **Not modified.** Read-only throughout. |
| `server.js` | **Not modified.** |
| Any frontend production file | **Not modified.** |

No instrumentation was added to the existing acceptance spec, to
`writeCell()`, or to any production file. All instrumentation lives
entirely inside the one new diagnostic file.

## 15. Cleanup and integrity verification

| Item | Expected | Verified |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** |
| Port 8787 | free | **free** |
| Disposable backend/Vite processes leaked | none | **zero leaked**, verified via `ps aux | grep -E "node server.js|vite/bin/vite"` after all 6 runs |
| VSCode Playwright extension service | untouched | not inspected or interacted with in this task (no reason to) |
| Dependencies installed/updated | none | **none** |
| Scenario B, D, G, H run | none | **none** — only Scenario I (run 6) and the new diagnostic (runs 1–5) |
| Full Task 77.1–77.3 suite run | none | **none** |

No repository or environment state change occurred beyond the one new
diagnostic file and its evidence artifacts.

## 16. Remaining unknowns

- **The actual trigger condition for the real failure is still unknown.**
  Four plausible differences were tested without reproducing it; one
  plausible difference (SPA-internal sidebar navigation preserving app/grid
  state across the Document detour, vs. a full page reload resetting it)
  was identified as the most promising untested lead but could not actually
  be exercised because this diagnostic's own sidebar-resolution logic
  itself failed (0 matching entries) and silently fell back to the already-
  tested `goto()` path. **This specific sub-hypothesis is BLOCKED, not
  refuted, and is the single most actionable lead this task produced.**
- No DOM-level evidence exists for the genuine failure state at all — every
  instrumented run succeeded. Whether the cell becomes genuinely absent,
  hidden, covered by an overlay, or something else entirely at the moment
  of a real failure remains completely uncaptured.
- Whether `waitForGridRowReady()`'s silently-discarded timeout return value
  (§4) plays any role is unconfirmed either way.
- Whether Task 77.3's renderer-freeze finding and this failure are the same
  phenomenon is still open — this task's own `rendererResponsive` probe
  never caught an unresponsive renderer, but it also never ran during an
  actual failure.
- This task did not attempt repeating a reproduced minimal case 3× (brief
  §8) because no minimal case ever reproduced to repeat.

## 17. Recommended next action

**Fix this diagnostic's own sidebar-navigation resolution** (the specific
bug is that `navigateViaSidebar`'s target entry was not found even after
resolving what this task believed was the correct ancestor page id — likely
a timing issue, such as the sidebar's page list not yet reflecting a page
created moments earlier, which the real `openSharedDatabase()` already
handles via its documented 3-attempt reload-and-retry loop that this
diagnostic's one-shot attempt did not replicate), then re-run the minimal
reproduction with that genuine SPA-navigation difference actually in place
rather than silently falling back to a full reload. If it still does not
reproduce, the next-smallest untested difference would be running the
diagnostic back-to-back in the exact same Playwright worker/process as a
prior failing run of the real scenario (rather than as a fresh, separate
`npx playwright test` invocation), in case some process-level state (V8
JIT warmup, Chromium's own internal caches) rather than application state
is implicated — though this is a weaker, more speculative lead than the
sidebar-navigation one and should be tried second, not first.

This report does not make this a mandate — it is offered as the evidence-
supported next step, for the user's own decision, consistent with every
other report in this chain.

## Final response summary

- The minimal reproduction **did not** reproduce the exact second-write
  failure across 5 runs, despite reintroducing 4 of the real scenario's
  structural differences (Document detour, a second live connected peer, a
  preceding field rename, and an attempted but blocked SPA-navigation
  return path).
- The target cell **existed in the DOM, was visible, and was geometrically
  valid** in every checkpoint of every successful run — but this task
  never captured the DOM state of a genuine failure, so this says nothing
  about the failing case.
- No leftover open editor or stray active-element state was found on the
  non-failing path.
- No virtualization or duplicate-element artifact was found on the non-
  failing path.
- The renderer was confirmed responsive (`1+1===2` resolved) at every
  checkpoint captured — on the non-failing path only.
- **Whether the issue belongs to the test helper or the frontend
  application is not determined.**
- **No root cause was confirmed** (Outcome E).
- **No production code was changed** in either repository.
- All instrumentation lives in the one new, clearly-labeled diagnostic
  file; nothing was added to or removed from the existing acceptance spec
  or any production file, so there is nothing requiring removal beyond
  that file's own normal lifecycle (retained per §9 item 2, as a reusable
  diagnostic, not an acceptance test).
- Repository and process integrity were fully preserved (§15).
- **Task 77.2, 77.3, 77.4, and no other task's status was upgraded or
  otherwise changed by this task.**
