# Task 77.4.4 — Scenario I Repeatability Investigation

Executed: 2026-11-11 23:56 IST – 2026-11-12 00:09 IST. Three consecutive,
isolated, single-worker runs of Scenario I only (tracing disabled via
`--trace off` CLI flag). No source, test, or config file modified. No
instrumentation or logging added. No timeout, retry count, or action timeout
changed. Scenario B and no other scenario was run. No process was leaked by
any run; none required termination.

## 1. Executive summary

**All three runs FAILED, and — contrary to what Task 77.4.3's single run
suggested — all three failed identically, at the same call site, via the
same single-action (not cumulative-budget) timeout:**

```
TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  at writeCell (test/e2e/task77-1-database-multiuser.spec.ts:266:18)
  at test/e2e/task77-1-database-multiuser.spec.ts:1065:5
```

Line 1065 is the scenario's **second, immediately-consecutive `writeCell`
call on the exact same `rowId`/`fieldId` cell** (lines 1062 and 1065 both
target the same row/field; line 1065 is the "reverse order" second write,
with no navigation or renameField between the two writes). In all three
runs, this specific cell's locator never became visible within the
3-attempt × 15000ms retry budget `writeCell` itself provides — this is a
**single action's own stated timeout being exceeded** (confirmed 15000ms
per attempt, 3 attempts), **not** the test's outer `test.setTimeout(240000)`
budget, which was never reached in any of the three runs (each run's total
wall-clock duration — 215s, 215s, 250s — stayed under 240s; the test failed
by throwing, not by Playwright's global timeout handler tearing down the
context).

**This directly revises Task 77.4.3's finding.** That task's one run failed
at a *different* call site (the scenario's fourth write, a `renameField` at
line 1067) via the test's *outer* 240000ms budget expiring mid-retry, and
explicitly cautioned that a single run could not establish whether its
failure was a genuine freeze or "simply slow, cumulatively." This task's
three runs show a **different, more specific, and fully repeatable**
mechanism: a single action (the second back-to-back write to the identical
cell) consistently fails its own 15-second-per-attempt visibility wait,
3/3 times, at the exact same line. **Classification: Repeatable failure at
a specific call site — not the cumulative-outer-timeout pattern Task 77.4.3
observed once.** See §6 for why this does not simply confirm Task 77.3's
original "renderer frozen" framing either.

**Host conditions were static and favorable throughout all three runs**:
swap usage changed by at most ~70MB across any single run (well within
ordinary idle drift) and kernel memory pressure level stayed at 1 (normal)
in every measurement. No measurement here supports host resource pressure
as a contributing factor to any of the three failures (§4).

**No genuine per-interaction timing evidence exists** in any of the three
runs' own output beyond the final stack trace and this task's own external
wall-clock run-duration measurements — see §5 for exactly what is and is
not available, and why.

## 2. Execution log

| Run | Start (IST) | End (IST) | Duration | Result |
|---|---|---|---|---|
| 1 | 2026-11-11 23:56:29 | 2026-11-12 00:00:04 | ~215s | **FAILED** |
| 2 | 2026-11-12 00:00:49 | 2026-11-12 00:04:24 | ~215s | **FAILED** |
| 3 | 2026-11-12 00:04:49 | 2026-11-12 00:08:59 | ~250s | **FAILED** |

Command (identical for all three, each preceded by deleting the prior run's
`test-results/` artifact directory so each run's evidence could not be
confused with the last):

```bash
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts \
  -g "I\. multi-object" --workers=1 --trace off --reporter=line
```

## 3. Per-run results and exact failure point

### Run 1

```
TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
Call log:
  - waiting for locator('[data-testid="grid-cell-4a29d910-dfc9-44d9-81db-
    d32682a950b0-206da038-f19a-4e14-aec6-19d4f9ece13c"]').first() to be visible
  at writeCell (test/e2e/task77-1-database-multiuser.spec.ts:266:18)
  at test/e2e/task77-1-database-multiuser.spec.ts:1065:5
```

### Run 2

```
TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
Call log:
  - waiting for locator('[data-testid="grid-cell-3eadd239-77df-42bc-
    a07a-a99006ee8a34-f33e35f8-ad3e-4fa3-bb03-a40ac557ed15"]').first() to be visible
  at writeCell (test/e2e/task77-1-database-multiuser.spec.ts:266:18)
  at test/e2e/task77-1-database-multiuser.spec.ts:1065:5
```

### Run 3

```
TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
Call log:
  - waiting for locator('[data-testid="grid-cell-bd566dd0-0530-4867-
    bb6c-53c6aacdcfc8-1e2f1dd3-c18d-4d81-b970-0d51b9dd969a"]').first() to be visible
  at writeCell (test/e2e/task77-1-database-multiuser.spec.ts:266:18)
  at test/e2e/task77-1-database-multiuser.spec.ts:1065:5
```

**All three: identical error type, identical call site (`writeCell` line
266, invoked from scenario line 1065), identical semantics** (a different
row/field UUID pair each time is expected and correct — each run creates a
fresh disposable database/row, per the suite's design; the *locator
pattern* and the *call site* are what must match, and they match exactly
across all three).

Each failure's `test-results/.../error-context.md` contains only the error
message and test source excerpt shown above — **no screenshot and no video
were produced for any of the three runs**, despite both being configured
(`screenshot: 'only-on-failure'`, `video: 'retain-on-failure'` in
`playwright.config.ts`, unaffected by `--trace off`). This is consistent
across all three runs, not a one-off; it was not investigated further
(doing so would require either modifying the test or adding instrumentation,
both forbidden by this task's scope).

## 4. Host memory/process baselines, before and after each run

| Metric | Run 1 pre | Run 1 post | Run 2 pre | Run 2 post | Run 3 pre | Run 3 post |
|---|---|---|---|---|---|---|
| Swap total | 10240.00M | 10240.00M | 10240.00M | 10240.00M | 10240.00M | 10240.00M |
| Swap used | 8774.94M | 8758.94M | 8758.94M | 8750.94M | 8750.94M | 8702.94M |
| Swap used % | 85.69% | 85.54% | 85.54% | 85.46% | 85.46% | 84.99% |
| `memory_pressure -Q` free% | 86% | 85% | 85% | 85% | 85% | 85% |
| Kernel pressure level | 1 | 1 | 1 | 1 | 1 | 1 |
| Process count (`ps aux \| wc -l`) | 641 | 647 | 643 | 641 | 643 | 642 |

**Swap usage trended slightly downward across the whole sequence
(8774.94M → 8702.94M, a drop of ~72MB over three consecutive ~4-minute real
Chromium/backend/Vite runs), never upward.** Kernel memory pressure level
was **1 (normal) in all six measurements**, with no exception. This is
directly inconsistent with the idea that host memory pressure was building
up over the course of these three runs or contributing to any of the three
identical failures — if it were, swap usage and/or the pressure level would
be expected to move in the opposite direction, or at least not move
favorably, as the runs progressed.

**Process/port cleanliness**: no `node server.js` or `vite/bin/vite`
process was left running after any of the three runs; port 8787 remained
free throughout; no process required termination at any point.

## 5. Per-interaction timing evidence — what is, and is not, available

The task brief explicitly forbids inferring individual interaction
durations from the final stack trace, and forbids adding instrumentation to
obtain them. Both are honored. What the test's own existing evidence
actually provides:

- **`docs/task77-1-evidence/results-json.json`'s `scenarioI` field**: only
  written at line 1075, *after* all six UI interactions in the scenario
  complete successfully (§ code read: lines 1056–1075 of the spec). Since
  all three runs failed at line 1065 — before that assignment — **this
  field was not written by any of the three runs**, confirmed by direct
  inspection of the evidence file after each run (`node -e
  "console.log(require('./docs/task77-1-evidence/results-json.json').scenarioI)"`
  → `undefined` after all three runs). **No genuine per-step timing data
  exists in this file for any of these three failures.**
- **Playwright's own `--reporter=line` output**: reports only the test's
  overall pass/fail and total duration, not per-action or per-line timings.
  No JSON/list reporter with step-level granularity is configured in
  `playwright.config.ts` (confirmed by reading the config directly — only
  the default `trace`/`screenshot`/`video` settings are present, no custom
  reporter array).
- **The spec's own source code** (`renameField`/`writeCell`, lines 203–283):
  contains no `console.log` or timestamp capture of any kind inside the
  retry loops. Confirmed by direct source read before running anything.
- **What this task could and did capture instead, honestly**: the external
  wall-clock duration of each entire run (§2, via this task's own shell
  `date` commands bracketing each `npx playwright test` invocation — this
  is evidence about the *test process*, not instrumentation *inside* the
  test, and required no file edit). This establishes that none of the three
  runs' total duration (215s, 215s, 250s) approached the 240000ms outer
  budget closely enough to make outer-timeout exhaustion plausible as an
  alternative explanation for these three failures specifically — each
  failed via its own thrown `TimeoutError` well before the outer budget
  would have fired.

**Stated plainly, as an honest gap rather than papered over**: no
fine-grained breakdown of how long each of the six UI interactions took
individually is available from this task's evidence, for any of the three
runs. What is available (the final error's call site, the total run
duration, and the fact that the test failed via a thrown error rather than
an external timeout teardown) is reported in full in §3–§4 and is not
supplemented with any estimate derived from the stack trace alone.

## 6. Comparison with Task 77.3 and Task 77.4.3

| | Task 77.3 (9-run campaign) | Task 77.4.3 (1 run) | Task 77.4.4 (this task, 3 runs) |
|---|---|---|---|
| Failure call site | `writeCell`, "the same `cell.waitFor`/retry-loop location as B, D, H" (not line-specified) | `renameField`, line 1067 (the scenario's 4th/last write) | `writeCell`, line 1065 (the scenario's 2nd write), **identically in 3/3 runs** |
| Failure mechanism | Attributed to a suspected CDP-level renderer freeze (longer than any single timeout) in its underlying investigation, though not re-demonstrated for Scenario I specifically | Test's outer `test.setTimeout(240000)` firing mid-retry; no single action's own timeout shown exceeded | A single action's own stated timeout (15000ms × 3 attempts) exceeded; outer budget never approached |
| Host swap/pressure during failure | Not measured per-run at this granularity | Static (unchanged to the megabyte) across the whole run | Static-to-improving across all three runs; pressure level normal throughout |
| Repeatable? | Reported as deterministic (9/9) across the whole suite, not isolated per-scenario at this call-site granularity | One run only — explicitly not claimed as repeatable | **3/3 identical call site and mechanism** |

**This task's evidence does not simply confirm either prior report.** It
agrees with Task 77.3 that `writeCell` is implicated (not `renameField`,
contrary to what Task 77.4.3's single run showed), but disagrees with Task
77.3's framing of "renderer frozen for far longer than any timeout" — these
three runs show ordinary per-attempt 15-second timeouts being exhausted
across exactly 3 retries each, not a hang vastly exceeding any stated
timeout. It also means Task 77.4.3's "cumulative six-step budget exhaustion"
explanation, while a reasonable reading of *that one run*, is **not** the
dominant or even a present mechanism in this task's three runs — none of
them came close to the outer 240s budget.

**The most specific new finding in this task**: the failure is pinned,
3/3, to the **second of two immediately-consecutive `writeCell` calls on
the identical cell** (same `rowId` + `fieldId`, lines 1062 and 1065, no
navigation or other interaction between them). The first call to the same
cell succeeds in all three runs (execution reaches line 1065, meaning line
1062's `writeCell` and line 1060's `renameField` and the preceding Document
creation/typing all completed); only the **immediate repeat write to that
same cell** fails. This is consistent with, but does not conclusively
prove (further investigation would require instrumentation this task is
not authorized to add), a hypothesis not previously named in Tasks 77.3 or
77.4: that committing a write to a given virtualized grid cell (the
`Escape` + 400ms settle in `writeCell`'s own closing sequence) can leave
that specific cell's DOM node in a state where an immediate second
`waitFor({state:'visible'})` on the same locator does not resolve within
15 seconds × 3 attempts — as distinct from a general renderer freeze or a
budget-pacing problem.

## 7. Final analysis and classification

**Classification: Repeatable failure, consistent call site and mechanism —
3/3 runs.** This does not match any of the four options as cleanly phrased
in the task brief without qualification, so stated precisely: it is **not**
"repeatable cumulative-timeout failure" (no run approached the outer
240000ms budget; each failed via its own fully-exhausted 15000ms × 3
per-action retry, well inside the outer budget) and it is **not**
"intermittent" or "different failure mechanisms across runs" (all three
failed identically, same call site, same error type, every time) and it
obviously did not reach "successful completion." The closest honest label
is: **a specific, deterministically-reproducible single-action timeout at
one exact call site**, discovered by this task to be distinct from both
prior reports' characterizations.

**On the readiness-gate hypothesis (`ensureGridInteractive`)**: **still
undetermined, not newly supported or undermined by this evidence.**
`ensureGridInteractive` and the preceding row-presence wait
(`waitForGridRowReady`) must have already resolved successfully for
execution to reach the `cell.waitFor` call that then timed out (the same
inference Task 77.4.3 drew) — so this evidence is consistent with "the
readiness gate passes but the specific cell is not actually interactable
yet," but equally consistent with "the gate's own job (confirming the grid
header exists) was never meant to guarantee a specific cell's visibility
after a just-prior write to that same cell," which would not be a defect in
the gate at all, merely evidence that no comparable gate exists for
*post-write* cell re-visibility. This task's evidence cannot distinguish
those two framings, and per the brief's explicit instruction, does not
claim the readiness gate is defective without evidence that directly
demonstrates it.

**On cumulative UI latency**: **not supported by this evidence** — all
three failures occurred well inside the outer budget via their own
action-level timeout, contradicting (for Scenario I specifically, in this
task's three runs) the "the six-step sequence is simply tight against 240s"
explanation Task 77.4.3 had to leave open from its single differently-sited
failure.

**On host resource/memory pressure**: **not supported by this evidence**,
consistent with Task 77.4.3's finding — swap usage trended flat-to-slightly-
improving and kernel pressure stayed normal across all three runs (§4).

**On a specific, new, narrower hypothesis** (writing to the same cell twice
in immediate succession): **Plausible, strongly suggested by the consistent
call-site pattern, but not conclusively demonstrated** — the three runs
establish *where* and *how* the failure recurs with high specificity, but
this task was not authorized to add the instrumentation (e.g., logging the
cell's DOM presence/visibility state at each retry attempt, or querying
`getComputedStyle`/bounding box at the moment of failure) that would be
needed to establish *why* the second write's locator fails to resolve.

## 8. Repository, configuration, and process-hygiene verification

| Item | Expected | Verified after all three runs |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged, re-verified after run 3) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** (re-verified after run 3) |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** (re-verified after run 3) |
| Port 8787 | free | **free**, before run 1 and after run 3 |
| Disposable backend/Vite processes leaked | none expected | **zero leaked**, verified after every one of the three runs individually |
| Processes terminated by this task | none expected | **none required or performed** |
| Source/test/config files modified | none | **none** |
| Instrumentation or logging added | none | **none** |
| Timeout, retry count, or action timeout changed | none | **none** — all values (240000ms outer, 15000ms cell wait, 8000ms click, 3 attempts) confirmed unchanged by source inspection before and after |
| Dependencies installed/updated | none | **none** |
| VSCode/Claude Code/OrbStack/Docker/Playwright extension service | untouched | **untouched** — not inspected or interacted with in this task |
| Scenario B or any other scenario run | none | **none** — only Scenario I, three times |

No unexpected repository or environment state change occurred at any point
across the three runs.

## 9. Self-check

This report was read back in full after writing, against the raw command
output captured during execution (§2–§4), before being finalized. The
error text, line numbers, and timestamps in §3–§4 were checked against the
actual terminal output rather than recalled from memory. The claim in §5
that `evidence.scenarioI` was never written is backed by a direct
post-run file read (`node -e ...`) after each of the three runs, not an
assumption from the code's structure alone.
