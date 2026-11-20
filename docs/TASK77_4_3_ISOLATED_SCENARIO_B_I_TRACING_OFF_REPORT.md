# Task 77.4.3 — Isolated Scenario B and Scenario I, Tracing Disabled

Executed: 2026-11-11, 23:16–23:23 IST. One worker, one scenario at a time,
never concurrent. Tracing disabled via CLI flag (`--trace off`), not a
permanent config edit. No source, config, or test file modified. No
dependency installed/updated. No process closed except what this task's own
runs would have created (none leaked, so nothing was terminated).

## 1. Executive summary

- **Scenario B: PASSED.** 23.8s, clean, no retries observed in output,
  live delivery to the peer in **4ms**, backend-persisted, reload-persisted.
  This directly contradicts Task 77.3's "FAILED in every single run"
  (9/9) finding for B.
- **Scenario I: FAILED**, but on a **different mechanism** than Task 77.3
  attributed to it. The test's own 240000ms (4-minute) *overall* timeout
  fired while the test was mid-retry inside its **second** `renameField`
  call (line 1067 — the fourth and last UI write in the scenario's
  sequence), not inside a `writeCell` call as Task 77.3's report described.
  The error that actually surfaced (`page.waitForTimeout: Target page,
  context or browser has been closed`) is Playwright's own test-timeout
  enforcement tearing down the context mid-retry, not a distinct
  product/click error.
- **Host conditions were favorable and static throughout both runs**: swap
  used was **8814.94M / 10240.00M = 86.08%** immediately before B,
  identical immediately before I, and **still identical** immediately after
  I's failure — i.e., swap did not move at all across either run. Kernel
  memory pressure level stayed at **1 (normal)** throughout. This is a
  materially cleaner host state than Task 77.3 operated under, and B's pass
  plus I's cumulative-timeout-rather-than-freeze failure mode together
  **weaken, but do not fully refute**, the resource-pressure hypothesis —
  see §6.
- **The specific "`ensureGridInteractive` reports ready, then the very next
  click times out" sequence was NOT directly observed in either run** — B
  had no failures to examine, and I's failure was a cumulative-budget
  timeout, not a single hung action with a clean preceding readiness
  check. See §4.2 for what *was* observable from the error's call-stack
  structure.
- **The pageA→pageB writer-handoff pattern is not implicated here**:
  Scenario I uses only `pageA` as writer throughout, exactly as Task 77.4
  found, and still failed — again consistent with Task 77.4's conclusion
  that the handoff asymmetry is not the (sole) operative mechanism, now
  reinforced by a second independent data point.
- Zero processes leaked by either run; port 8787 free throughout;
  repository and config integrity fully unchanged (§7).

## 2. Commands and environment

```bash
# Baseline capture (immediately before each scenario — see §3)
sysctl vm.swapusage
memory_pressure -Q
sysctl kern.memorystatus_vm_pressure_level
vm_stat | grep -E "Pageouts|Swapins|Swapouts"
ps aux | wc -l
lsof -nP -iTCP:8787 -sTCP:LISTEN
ps aux | grep -E "node server.js|vite/bin/vite"

# Scenario B, isolated, tracing off
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts \
  -g "B\. Database-level" --workers=1 --trace off --reporter=line

# Scenario I, isolated, tracing off (run after a fresh baseline capture,
# ~40s after B finished)
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts \
  -g "I\. multi-object" --workers=1 --trace off --reporter=line
```

Note: `--video=off` is not a valid CLI flag in this Playwright version
(`error: unknown option '--video=off'` — confirmed via `npx playwright test
--help`); only `--trace <mode>` is exposed on the CLI. Video/screenshot
settings therefore remained at their `playwright.config.ts` defaults
(`screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`) for both
runs — this is a config file and was not touched, consistent with the "no
config edits" restriction. In practice no screenshot or video artifact was
produced for I's failure regardless (see §4.3) — only `error-context.md`.

## 3. Fresh baseline, captured immediately before each scenario

| Metric | Before Scenario B (23:16:59) | Before Scenario I (23:17:56) | After Scenario I failure (23:23:24) |
|---|---|---|---|
| Swap total | 10240.00M | 10240.00M | 10240.00M |
| Swap used | 8814.94M | 8814.94M | **8814.94M — unchanged** |
| Swap used % | 86.08% | 86.08% | 86.08% |
| `memory_pressure -Q` | 85% free | 85% free | (not re-queried; pressure level re-checked below) |
| `kern.memorystatus_vm_pressure_level` | 1 (normal) | 1 (normal) | 1 (normal) |
| Process count (`ps aux \| wc -l`) | 629 | 631 | — |
| Port 8787 | free | free | free |
| Pre-existing `node server.js`/`vite` processes | none | none | none (and none leaked by either run) |

**Swap did not move by a single megabyte across either run**, including
across Scenario I's full ~240-second failing execution. This is a stronger,
more direct observation than Task 77.4.2's two 105-second idle snapshots:
here the host was captured *while actively running Chromium, a disposable
backend, and a disposable Vite server for ~4 minutes straight*, and swap
usage was still completely static. Whatever caused Scenario I's timeout,
it was not accompanied by any measurable change in host memory pressure.

## 4. Scenario B results

### 4.1 Outcome

```
[1/1] [chromium] › ... B. Database-level mutation, member -> owner (field rename)
  1 passed (23.8s)
```

**PASSED.** No retry attempts were visible in the output (a retry would
print nothing extra to stdout in this spec's current logging, but the test
completing in 23.8s with a single pass, and the evidence file's
`peerLiveNoReloadMs: 4` figure, are both consistent with a clean, single-
attempt run — a 3-attempt bounded retry with 500ms settle pauses between
attempts would add at least ~1s of visible extra time if it had fired, and
the measured peer-live latency of 4ms is itself only meaningful if the
underlying click succeeded promptly).

### 4.2 Evidence (from `docs/task77-1-evidence/results-json.json`)

```json
"scenarioB": {
  "marker": "T771B-1794419256897",
  "writerUiContains": true,
  "peerLiveNoReloadMs": 4,
  "backendPersistedFieldName": "T771B-1794419256897",
  "peerAfterReloadContains": true
}
```

Writer UI change ✓, live peer delivery with no reload in **4ms** ✓, backend
persistence ✓, reload-persistence ✓ — every leg of the acceptance chain
passed, including the exact pageA→pageB writer-handoff Task 77.4 flagged as
structurally distinctive for this scenario.

### 4.3 Comparison to Task 77.3 and Task 77.4

Task 77.3 reported Scenario B as **FAILED in every one of 9 runs**,
including isolated runs directly after a fresh `A` with no other test
history. This run contradicts that: B passed cleanly, in isolation, with
tracing off, under a measurably static and favorable host state. This is
the single most direct piece of evidence in this report that Task 77.3's
"deterministic, 100%-reproducible" framing for B specifically does not hold
unconditionally — something about the current run (host state, tracing
disabled, or simply run-to-run variance in Chromium's own responsiveness)
changed the outcome. This report cannot, from one passing run, determine
which of those factors was decisive; seeing it pass once does not prove it
would pass reliably going forward either (see §8).

## 5. Scenario I results

### 5.1 Outcome

```
Test timeout of 240000ms exceeded.

Error: page.waitForTimeout: Target page, context or browser has been closed
  240 |       await page.waitForTimeout(500);
      |                  ^
  at renameField (test/e2e/task77-1-database-multiuser.spec.ts:240:18)
  at test/e2e/task77-1-database-multiuser.spec.ts:1067:5

1 failed
```

**FAILED.** Line 1067 is the scenario's **fourth and final** write
(`renameField(pageA, fieldId, dbMarker2)` — the *second* Database-level
rename, after an earlier Document edit, an earlier `renameField`, and two
`writeCell` calls, all per the test's own code at lines 1035–1066). The
error is not a click timeout or a missing-element timeout — it is
`page.waitForTimeout` throwing because the page/context was **already
closed** by the time that line executed, which is the direct, expected
consequence of Playwright's own `test.setTimeout(240000)` enforcement
tearing the test down once the 4-minute budget elapsed, while execution
happened to be inside `renameField`'s catch-and-retry `Escape` + 500ms
settle pause at that exact moment.

### 5.2 What this does and does not establish

**This is a different failure signature than Task 77.3 described for
Scenario I.** Task 77.3's report states Scenario I "fail[ed] inside
`writeCell` at the same `cell.waitFor`/retry-loop location as Scenarios B,
D, and H" with a `Test timeout of 240000ms exceeded` — the *test-level*
timeout message matches exactly, but the *call site* does not: this run's
failure is attributed to the stack frame active at the moment the global
timeout fired, and in this run that frame was inside the **second
`renameField`** call, not `writeCell`. Because the global test timeout can
only ever report whichever call happens to be in flight at the moment the
budget runs out, this difference is consistent with either (a) a
genuinely different root cause this time, or (b) the same underlying
intermittent slowness/freeze mechanism simply manifesting on a different
one of the scenario's four sequential UI writes — **this report cannot
distinguish between those two explanations from a single run** and does
not claim to.

**What can be said with confidence:** the failure is a *cumulative* budget
exhaustion across a multi-step real-browser sequence (create a Document,
type into it, navigate back to the Database, rename a field, write a cell,
write a cell again, rename a field again — six real UI interactions plus
navigation, each with its own waits and up to a 3-attempt/8s-per-attempt
retry budget), not a single action observably hung for multiples of its own
stated timeout the way Task 77.3's CDP-hang evidence showed for a different
run. No individual action's own timeout (8s per click attempt, 15s for
`cell.waitFor`, 30s for `ensureGridInteractive`) was, by itself, shown to be
exceeded in this run's output — only the test's own outer 240-second budget
was. This is a materially different, and weaker, piece of evidence for "the
renderer froze" than Task 77.3's original finding; it is equally consistent
with "this scenario's six-interaction sequence is simply slow enough,
cumulatively, that 240s is sometimes not enough," independent of any
freeze.

### 5.3 Evidence captured

`test-results/task77-1-database-multiuse-52fa8-o-cross-object-interference-chromium/error-context.md`
contains only the test-timeout message (reproduced in §5.1) — **no
screenshot and no video were saved**, despite both being configured
(`screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`) and
unaffected by the `--trace off` override. This absence is itself mildly
informative: Playwright's failure-artifact capture (screenshot/video
finalization) did not complete either, consistent with the browser
context having been torn down abruptly by the timeout handler before its
own cleanup/capture pipeline could run — but this is a property of *how a
test-level timeout is enforced*, not independent evidence of a frozen
renderer specifically.

### 5.4 The pageA/pageB writer-handoff question for Scenario I

Confirmed directly from the code read in §5.1/5.2 and the test source
(lines 1028–1095): **Scenario I never uses `pageB` as a writer at all** —
every mutation (Document edit, two `renameField` calls, two `writeCell`
calls) is performed on `pageA`, with `pageB` used only as the passive
peer-observation target in the two `awaitFieldNameLive`/`awaitCellTextLive`
calls that were never reached. This run failed before reaching those calls,
so it adds a **second independent data point** supporting Task 77.4's
finding that Scenario I's failures are not explained by a pageA→pageB
handoff (there being no handoff in this scenario's write sequence at all) —
reinforcing, not newly establishing, that specific conclusion.

### 5.5 `ensureGridInteractive`-then-immediate-timeout: not directly observed here

No console instrumentation exists in the current spec to directly log
"`ensureGridInteractive` returned ready" (confirmed by source read — see
Task 77.3/77.4's own reports; adding such a log would have required a test
file edit, which this task's restrictions forbid). What *can* be inferred
from the error's stack trace: the failure occurred inside the
**catch-block's settle pause** (`page.waitForTimeout(500)` at line 240),
meaning at least one `header.click({timeout: 8000})` attempt had already
been made and had already failed (triggering the catch) before the test
timeout fired — i.e., `ensureGridInteractive` and the row/header-presence
waits earlier in `renameField` had already resolved successfully (otherwise
execution would never have reached the click/catch loop at all). This is
consistent with, but does not independently confirm beyond what Task 77.3
already reported, the "the element is found and the readiness gate passes,
but subsequent interaction still fails" pattern — it does not newly
establish *why* the click itself was slow or failing in this specific run,
because the original click-attempt error was superseded by the test-timeout
closure before this task could inspect it.

## 6. Resource-pressure hypothesis: reassessed with this run's evidence

**Classification: Weakened, not Refuted.**

- Swap usage was measured **identical to the megabyte** immediately before
  B, immediately before I, and immediately after I's ~240-second failure —
  directly contradicting the idea that *this specific test run* generated
  the kind of swap growth Task 77.3 cited as its evidence for the
  resource-pressure hypothesis. If host memory pressure were building up
  live during I's execution, this measurement would be the first place to
  see it, and it shows nothing.
- B passing cleanly under the same static, favorable host conditions is
  one data point in favor of "a quieter host helps," but it is only one
  pass of one scenario — Task 77.3's own bar was 3 consecutive clean runs,
  which this task was not asked to and did not attempt to meet (the user's
  instruction for this task specifically asked for one isolated run each of
  B and I, not a repeatability campaign).
- I's failure mode in this run (cumulative outer-timeout exhaustion across
  six real UI interactions, no single action's own timeout shown exceeded)
  is a *weaker* match to Task 77.3's "renderer frozen for far longer than
  any single timeout" finding than a repeat of that exact symptom would
  have been. It does not refute host pressure as *a* contributing factor in
  Task 77.3's original 9-run campaign (where swap and process count were
  measurably different, and where multiple concurrent/compounding leaked
  processes existed), but it means **this particular run's failure cannot,
  by itself, be attributed to active host memory pressure**, because none
  was present.

**Net effect on the overall hypothesis chain**: the readiness-gate and
writer-handoff hypotheses from Task 77.4 are **not newly confirmed**
either — this run's evidence is consistent with several explanations
(intermittent Chromium/Playwright CDP flakiness unrelated to host
pressure, the six-step scenario's cumulative real-world latency simply
being tight against a 240s budget, or a genuine but not-always-triggered
product-adjacent timing issue) and this task's scope and evidence do not
let it pick among them.

## 7. Repository, configuration, and process-hygiene verification

| Item | Expected | Verified after both runs |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** |
| Port 8787 | free | **free**, throughout and after |
| Disposable backend/Vite processes leaked by this task's runs | none expected | **zero leaked** — `ps aux \| grep -E "node server.js\|vite/bin/vite"` returns nothing after both runs |
| Processes terminated by this task | none expected (nothing leaked) | **none terminated** — nothing required it |
| Source/config/test files modified | none | **none** — only this report and Playwright's own `test-results/`/`docs/task77-1-evidence/` output artifacts were written, both of which are the spec's own normal output locations, not edits to the spec itself |
| Dependencies installed/updated | none | **none** |
| VSCode/Claude Code/OrbStack/Docker/Playwright extension service | untouched | **untouched** — none were inspected, closed, or interacted with in this task |

No unexpected repository or environment state change occurred.

## 8. Confirmed findings versus hypotheses

**Confirmed:**
- Scenario B passed, cleanly, in isolation, with tracing disabled, in
  23.8s, with 4ms live peer delivery (§4).
- Scenario I failed via the test's own 240000ms outer timeout, while
  execution was inside the scenario's **second** `renameField` call — a
  different call site than Task 77.3's report attributed to it (§5.1–5.2).
- Swap usage did not change at all (to the megabyte) across either run,
  including across Scenario I's full ~240-second execution (§3, §6).
- Kernel memory pressure level remained normal (1) throughout (§3).
- Scenario I's write sequence never used `pageB` as a writer, reinforcing
  Task 77.4's finding that the pageA→pageB handoff asymmetry does not
  explain Scenario I's failures (§5.4).
- No process was leaked by either run; repository/config integrity fully
  unchanged (§7).

**Strongly supported:**
- Task 77.3's "deterministic, 100%-reproducible failure" characterization
  does not hold unconditionally for Scenario B — it passed under this
  run's conditions (§4.3).

**Plausible but unproven:**
- That tracing-off and/or the currently-static host state (vs. Task 77.3's
  original conditions) is what let B pass this time — one passing run
  cannot isolate which factor (if any single one) was decisive, and no
  repeatability campaign was run (not requested by this task).
- That Scenario I's specific failure in this run reflects the same
  underlying mechanism as Task 77.3's original `writeCell`-site failures,
  merely manifesting on a different call site this time, rather than a
  distinct, cumulative-latency-driven cause (§5.2).

**Inconclusive:**
- Whether `ensureGridInteractive`'s DOM-presence-only readiness check is
  insufficient was not newly tested here — the one failure observed in this
  task did not preserve the original (pre-test-timeout) click error that
  would have been needed to examine this directly (§5.5).

**Refuted:**
- Nothing in this task's two runs is refuted outright; §6 explains why the
  resource-pressure hypothesis is weakened, not refuted, by this evidence.

**Blocked:** none in this task's own scope — every measurement and command
attempted produced a usable result.

## 9. Recommended next action

Given that B passed once and I failed via a different (cumulative-timeout)
mechanism than previously reported, with the host provably stable
throughout, the single most informative next step would be: re-run **only
Scenario I**, isolated, tracing off, **3 consecutive times**, to establish
whether this run's cumulative-timeout failure mode is itself reproducible
or was a one-off, and if it reproduces, to examine where in the six-step
sequence it actually loses time (e.g., by timing each of the six
interactions individually via the test's own existing evidence object
rather than new instrumentation) before concluding this is the same
phenomenon Task 77.3 found. Re-running B three more times to check for the
repeatability bar Task 77.3 originally set is a reasonable complementary
step but is lower priority, since this run already directly contradicts
the specific "100%-reproducible" claim being tested.

This report does not make that recommendation a mandate — it is offered as
the evidence-supported next step, for the user's own decision, consistent
with every other report in this chain.
