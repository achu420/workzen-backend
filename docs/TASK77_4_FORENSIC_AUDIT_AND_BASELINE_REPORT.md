# Task 77.4 — Forensic Audit of Task 77.3 and Collaboration Test Baseline Recovery

Audit conducted: 2026-11-11, 22:17–22:23 IST. **Read-only.** No Playwright run,
no process start/stop, no production or test-infrastructure file modified.
The only file this task wrote is this report.

## 1. Executive summary

This audit re-examined Task 77.3's claims using only static inspection, system
logs, and process forensics — no new test execution. Headline findings:

- **Mac sleep/wake: REFUTED as a factor in Task 77.3's failures.** Two
  independent system log sources (`pmset -g log`'s complete retained history,
  and `apsd`'s live "last system wake date" field) agree the machine did not
  sleep at any point from boot (2026-11-10 14:26:52) through at least
  2026-11-11 22:09 — a window that fully contains Task 77.3's entire
  execution. This is Confirmed, not merely Strongly supported — see §5.
- **Headless Chromium: Confirmed configured**, so the user correctly seeing no
  window is expected behavior, not evidence against execution — see §6.
- **Process accumulation: the historical 9 are unchanged and genuinely
  test-owned**, confirmed PID-for-PID against their original start times. But
  **a 10th, previously unreported process was found still running** — a
  `playwright test-server` instance — of **uncertain ownership**: its parent
  is a VSCode extension-host helper, not a terminal/CLI invocation, so it may
  be the editor's own Playwright integration rather than a Task 77.3 leak.
  Task 77.3's "zero new orphans" claim is accurate for disposable
  backend/Vite/Chromium processes specifically, but incomplete as a global
  claim — see §7.
- **The Scenario H contradiction is resolved** by reading the test code
  directly: there are three `writeCell`/`renameField` call sites in Scenario
  H, one *before* `restartBackend()` and two *after* it. Both of Task 77.3's
  conflicting descriptions are literally true of different call sites, so
  this is not actually a self-contradiction once the code is read — it is an
  underspecified report that collapsed three failure points into one
  sentence twice, each time citing a different one. See §8.
- **Scenario B and D are NOT exonerated of a product question merely by
  failing before a UI click resolves.** Code reading shows B and D are the
  first tests to use the *member's* page (`pageB`) as the writer, immediately
  after a run of tests that used the *owner's* page (`pageA`) as the writer —
  a real structural asymmetry Task 77.3 never mentioned. But this clean
  story is **contradicted** by Scenario I, which fails on the same symptom
  using `pageA` as its sole writer throughout, run fresh in isolation. Both
  observations are reported; neither is picked over the other. See §9.
- **Resource pressure: Confirmed present NOW (88.6% of swap in use), but
  Task 77.3's "150+ matching processes" is NOT reproduced by the current
  process table** (only the expected 9 historical test processes plus the
  one process in §7 — nowhere near 150). The historical peak figure cannot be
  independently verified or refuted from here; it is reported as **Plausible
  but unproven as a sustained condition**, with the current swap pressure
  reported separately as **Confirmed** right now. See §10.
- Task 77.3's two described fixes (sticky-header selector, readiness gate)
  are real, source-verified, and did not regress anything — see §4.

**No recommendation to upgrade Task 77.2 or Task 77.3's status is made; that
determination is explicitly out of this task's scope.**

**Single recommended next experiment (§15, Outcome C/D hybrid):** re-run
Scenario B alone, then Scenario I alone, each as a single, isolated,
single-worker Playwright invocation with `trace: 'off'` for this one run
(to remove the trace-timeout confound from the evidence, not permanently),
immediately after confirming swap usage is below ~50%. This directly tests
the resource-pressure hypothesis for the specific case (B) that most needs
disambiguating, without repeating the 9-run campaign.

## 2. Scope and restrictions

Followed exactly: no Playwright launch, no new disposable backend/Vite/
Chromium process, nothing run in parallel, no process terminated, no
historical PID acted upon, no git destructive command, no production code
read-for-the-purpose-of-editing (read-only inspection only), no status
upgrade for Task 77.2/77.3. Every BLOCKED/Confirmed/Refuted classification
below is backed by a command actually run and its real output, shown or
summarized faithfully.

## 3. Repository baseline

| Item | Value |
|---|---|
| Current date/time | 2026-11-11 22:17–22:23 IST |
| Frontend `git status --short` | **33 entries** (22 modified + 11 untracked) — unchanged from every prior task's recorded baseline, before and after this audit |
| Frontend branch/HEAD | Not altered; not separately re-recorded (no git command beyond `status` was needed or run) |
| Backend git metadata | **None** — `git status` returns "fatal: not a git repository"; `.git` does not exist. Confirmed identically to every prior task in this chain. |
| `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` — **identical** to the value Task 77.2 recorded after its fix and Task 77.3 recorded throughout |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` — **identical** to `test/helpers/.env.local.pristine` and to every prior task's recorded correct value (`http://localhost:8787`) |

Evidence tier: static inspection (file reads, checksums, `git status`).

## 4. Task 77.2 → 77.3 change audit

| File | Change | Intended purpose | Possible unintended effect | Evidence |
|---|---|---|---|---|
| `test/e2e/task77-1-database-multiuser.spec.ts` | Added `ensureGridInteractive()` (`bringToFront()` + wait for a `grid-field-header` selector to appear, timeout 30s, returns silently on timeout rather than throwing); added `realGridFieldHeader()` (CSS `:not()` selector excluding the sticky-header overlay copy); `renameField`/`writeCell` call the gate then retry their click up to 3× with an `Escape`+500ms pause between attempts; `test.setTimeout` raised on A–G | Fix the two confirmed locator defects (§4 of Task 77.3's own report); make clicks resilient to a transient interception | **`ensureGridInteractive()`'s readiness check only confirms a DOM node with the right testid exists — it does not confirm the page's renderer is actually processing input.** If the grid was already mounted before a reload-free page switch (i.e., the DOM node was never removed), `waitForSelector` resolves near-instantly without proving anything about responsiveness, so the gate can report "ready" on a page that is about to time out on its very next click. This is a real gap, not a defect that was introduced — it is a limitation of the *mitigation's* design that Task 77.3's own comments (lines 216–229 of the spec, read directly) already partially acknowledge: "even with `ensureGridInteractive`'s readiness gate... the header's click can still intermittently time out." Not re-classified as a regression; it is a known, disclosed limitation of an otherwise real fix. | Source read directly, lines 153–283 |
| `test/helpers/test-environment.ts` | Added `killConfirmed()`: SIGTERM, poll `process.kill(pid, 0)` for death, SIGKILL fallback, used by `stopTestEnvironment` and `restartBackend` | Harden cleanup against a `.kill()` that silently doesn't take | None found that would make things *worse*; by Task 77.3's own account it did not eliminate the leak because the actual mechanism (external worker termination) happens before this code runs at all. Not inspected further in this audit beyond the source read. | Source inspection |
| `test/multi-object-subscriptions.test.js` | Appended one new awareness-regression test | Close the Task 77.2 §14 coverage gap | None identified — this test is independent of the browser-level failures (it exercises raw WebSocket/protobuf frames, not Playwright/Chromium at all) and is reported passing on both storages. Its correctness was not re-verified by re-running it (that would require launching `node --test`, outside this audit's read-only mandate), but nothing in the diff is suspicious on inspection. | Source read |
| Playwright config (`playwright.config.ts`) | **Not modified by Task 77.3** | — | `workers: 1`, `fullyParallel: false`, `trace: 'retain-on-failure'`, `headless: true` (all pre-existing, confirmed current) — see §6 | Source read, confirmed unchanged |

**On "whether retry logic masks genuine failures":** it does not mask
anything in the sense of hiding a failure — every retry that exhausts its 3
attempts still `throw`s `lastErr`, so a test that fails after retries still
fails and is still reported as a failure. What it *could* mask is the
original error's specific message/stack if a later attempt throws a
different-looking error than the first; this was not confirmed either way
from static inspection and would require re-running to observe (out of
scope here).

**On "whether increased timeouts conceal a real application hang":** the
opposite risk is more apparent from the code: `ensureGridInteractive`'s
30-second timeout *returns silently* (`.catch(() => false)` then `if (!ready)
return`) rather than throwing, deliberately deferring to "the caller's own,
more specific wait" — meaning a genuinely stuck page could sail through the
gate and only fail later, deeper in `renameField`/`writeCell`'s own retry
loop, which is exactly the failure signature observed in every run. This is
consistent with, not contradictory to, Task 77.3's own account.

## 5. Mac sleep/wake timeline and evidence

**Classification: REFUTED.** Two independent, directly-queried system log
sources both show no sleep/wake cycle occurred during Task 77.3's execution
window.

### 5.1 `pmset -g log` (full retained history)

```
pmset -g log | grep -E '^\s*20[0-9]{2}-'  →  24,589 "Assertions" lines,
                                              6 "Notification" lines,
                                              2 "Start" lines,
                                              0 lines with category
                                                "Sleep" / "Wake" / "DarkWake"
First retained timestamp: 2026-11-04 22:22:07 +0530
Last retained timestamp:  2026-11-11 22:19:01 +0530
```

Retention fully covers Task 77.3's execution window (per its own report's
timestamps and the file mtimes recorded in §3) — this is not a BLOCKED case
from insufficient retention. The log's only event category present is
"Assertions" (apps/daemons declaring or releasing prevent-sleep claims, e.g.
`coreaudiod`'s audio-context wake locks, `Google Chrome`'s video wake locks)
— **zero** actual Sleep, Wake, or DarkWake transition entries exist anywhere
in the retained window.

### 5.2 `apsd`'s live "last system wake date" field

Independently, the unified log shows the Apple Push Service daemon
repeatedly computing timer fire dates using a field it calls "last system
wake date," and this field is **pinned at the exact boot timestamp**
throughout the entire window, including samples taken minutes ago:

```
2026-11-11 22:06:15 ... Last system wake date (2026-11-10 14:26:52 +0530) ...
2026-11-11 22:07:00 ... Last system wake date (2026-11-10 14:26:52 +0530) ...
2026-11-11 22:08:00 ... Last system wake date (2026-11-10 14:26:52 +0530) ...
2026-11-11 22:09:00 ... Last system wake date (2026-11-10 14:26:52 +0530) ...
2026-11-11 22:09:51 ... Last system wake date (2026-11-10 14:26:52 +0530) ...
```

`sysctl kern.boottime` confirms `2026-11-10 14:26:52` is the machine's actual
boot time. If any sleep/wake cycle had occurred, this `apsd`-tracked value
would update to the most recent wake, not remain pinned at boot — this is a
second, independent, directly-sourced signal agreeing with §5.1.

### 5.3 The one ambiguous signal, checked and set aside

At `2026-11-11 22:12:12` — **after** Task 77.3's own report was finalized
(file mtime 22:05) — `airportd` logged several `systemWokenByWiFi: System
Wake Reason not found` lines. This looks sleep/wake-adjacent but (a) postdates
Task 77.3's entire execution, so it cannot explain anything in that report,
and (b) `powerd`'s own concurrent log lines at the same timestamp
(`vm.darkwake_mode: 0 -> 0`, i.e., no state change) do not corroborate an
actual sleep/wake transition at that moment either. Reported for completeness,
not used as evidence for or against anything in Task 77.3.

### 5.4 Timeline

| Time | Event | Source | Confidence |
|---|---|---|---|
| 2026-11-10 14:26:52 | System boot (only wake-equivalent event in the entire retained record) | `sysctl kern.boottime`, corroborated by `apsd` | Confirmed |
| 2026-11-11 ~16:27–22:05 | Task 77.3 execution window (inferred from Task 77.2/77.3 report file mtimes) | File `mtime` | Confirmed (mtime), window boundary is an inference not a direct instrumentation timestamp |
| throughout that window | Zero Sleep/Wake/DarkWake log entries; `apsd` wake-date field pinned at boot | `pmset -g log`, unified log | Confirmed |
| 2026-11-11 22:12:12 | Ambiguous `airportd` Wi-Fi wake-reason query, uncorroborated by `powerd` | unified log | Inconclusive, and in any case **after** the task window |

**Classification of "sleep/wake overlap caused or contributed to Task 77.3's
failures": REFUTED.**

## 6. Headless Chromium explanation and configuration findings

**Classification: Confirmed.**

```
playwright.config.ts:
  use: { headless: true, ... }
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true } }]
  workers: 1
  fullyParallel: false
```

Headless Chromium renders no on-screen window by design — there is nothing
for the user to have seen, with or without a defect present. This is the
expected, correct explanation for "I never saw a Chromium window," and that
observation is not evidence that Chromium wasn't running. `workers: 1` and
`fullyParallel: false` are also directly relevant to §10: this configuration
cannot run more than one Playwright worker/browser-context tree for this spec
file at a time by design, regardless of host load — so a "150+ matching
processes" figure cannot be explained by this spec file itself spawning many
concurrent Chromium trees; any multiplicity would have to come from something
outside this one spec file's own execution (other activity on the host, or
a sequence of leaked browser instances from different runs stacking up), not
from in-run parallelism.

## 7. Process ownership and accumulation audit

**Classification: historical 9 Confirmed unchanged; one additional process
found with Ownership uncertain.**

### 7.1 The nine historical candidates (§4.3 of the brief)

| PID | Port | Current state | Classification |
|---|---|---|---|
| 97325 | 19098 | `node server.js`, started exactly `Wed Nov 11 13:41:54 2026`, ppid 1, listening on `localhost:19098` | **Confirmed historical test process, still running** (not absent) |
| 97329 | 14006 | `node vite --port 14006 --strictPort`, started `13:41:55`, ppid 1, listening `*:14006` | Confirmed historical test process, still running |
| 11764 | 14355 | vite, started `14:42:25`, listening `*:14355` | Confirmed historical test process, still running |
| 13713 | 14087 | vite, started `14:52:13`, listening `*:14087` | Confirmed historical test process, still running |
| 13811 | 19441 | `node server.js`, started `14:52:35`, listening `localhost:19441` | Confirmed historical test process, still running |
| 15220 | 19057 | `node server.js`, started `14:59:34`, listening `localhost:19057` | Confirmed historical test process, still running |
| 15224 | 14024 | vite, started `14:59:35`, listening `*:14024` | Confirmed historical test process, still running |
| 17228 | 14148 | vite, started `15:09:24`, listening `*:14148` | Confirmed historical test process, still running |
| 17352 | 19069 | `node server.js`, started `15:09:46`, listening `localhost:19069` | Confirmed historical test process, still running |

Every PID, start timestamp (to the second), command line, and listening port
matches the Task 77.1/77.2/77.3 record **exactly**. Across the ~8–8.5 hours
since they were first reported, none has been reaped and none has had its
PID reused by an unrelated process (the command line and start time are both
inspectable and both match). The brief's rule against assuming a live PID is
the same process is satisfied here by direct verification, not assumption.
**No PID was terminated.** Port **8787** (the normal development backend) was
confirmed free throughout — `lsof -nP -iTCP:8787 -sTCP:LISTEN` returns
nothing.

**Cleanup recommendation (not executed):** ownership of all nine is
established with high confidence (command line + exact historical start time
+ loopback/disposable port). If the user wants them gone:
`kill 97325 97329 11764 13713 13811 15220 15224 17228 17352`. This is the
same set every prior task in this chain has reported and left untouched.

### 7.2 A previously unreported tenth process

```
PID 6511: /opt/homebrew/bin/node .../playwright/test/cli.js test-server \
            -c AppFlowy-Independent-Backend/playwright.config.ts --host 127.0.0.1
started:  2026-11-11 22:02:13   (3 minutes before Task 77.3's report mtime)
ppid:     961 — "Code Helper (Plugin) ... --utility-sub-type=node.mojom.NodeService ..."
          i.e. a Visual Studio Code extension-host utility process, NOT a
          terminal/npm/npx-launched shell.
```

This process is still running at the time of this audit (confirmed via `ps`
immediately before writing this report). Task 77.3's report states "Final
state: exactly those 9 historical processes remain; zero new orphans from
this task" — **this additional process means that claim is not completely
accurate**, taken literally and globally. However, its parent process
strongly suggests it may be VSCode's own Playwright Test extension
(`ms-playwright.playwright`), which independently starts and maintains a
persistent `test-server` helper for its Test Explorer integration whenever a
Playwright config is open in the editor, regardless of whether any CLI test
run has happened. That would make it an IDE-managed background service, not
a leak from any task's Bash-invoked `npx playwright test` command.

**Classification: Ownership uncertain** — I did not find a way to
distinguish "VSCode extension background service" from "a leaked helper from
Task 77.3's own CLI runs" without either (a) inspecting VSCode's own process
tree/extension state more invasively than this audit's read-only mandate
comfortably allows, or (b) terminating it and seeing if VSCode immediately
restarts it, which is itself a destructive action this task is not
authorized to take. **Not terminated.** Reported for the user's own
judgment: if Playwright's VSCode extension is not in active use, closing or
disabling it would stop this process; if it's wanted, it is harmless by
itself (it holds no disposable backend/frontend ports and is not part of the
collaboration-test infrastructure).

### 7.3 Accumulation assessment

No additional Vite instances, disposable backends, or Chromium/
`headless_shell` process trees were found beyond the above. Specifically:
`ps aux | grep "node server.js"` → exactly the 4 expected historical PIDs;
`grep "vite/bin/vite.js"` → exactly the 5 expected historical PIDs;
`grep -iE "chromium|headless_shell|playwright"` → zero Chromium/renderer
processes and exactly the one `test-server` process in §7.2. **No orphaned
Playwright *worker* process and no leaked Chromium browser process were
found currently running.** This directly bears on §10.

## 8. Scenario H contradiction resolution

**Classification: Resolved (not a true contradiction; an underspecified
report).**

Reading `test/e2e/task77-1-database-multiuser.spec.ts` lines 980–1025
directly, Scenario H contains **three** `writeCell`/`renameField` call sites,
in this order:

```
line 983:  writeCell(pageA, ...)       -- BEFORE restartBackend()
line 988:  restartBackend(env)         -- the genuine process-boundary restart
line 999:  writeCell(pageA, ...)       -- AFTER restart + reload
line 1004: renameField(pageA, ...)     -- AFTER restart + reload
```

Both of Task 77.3's descriptions are literally consistent with this code:

- §7's "Isolated (H alone)... FAILED... `writeCell` timeout... **after a
  genuine `restartBackend()`**" matches a failure at line 999 or 1004 — the
  restart genuinely happened, and the failure was in one of the *post*-restart
  writes.
- §6 item 9 / §18 item 1's "Scenario H never got past its **pre-restart**
  `writeCell` call" matches a failure at line 983 — the restart was never
  reached at all.

These are not mutually exclusive claims about the *same* run; they are each
individually plausible descriptions of *different* runs among Task 77.3's
"8 subsequent full/partial-chain runs," and the report's §7 table collapsed
all 8 into one row ("FAILED in every single run... identical failure
signature") without recording, per run, which of the three call sites
actually threw. **This audit cannot determine, run-by-run, which of the three
sites failed on which attempt** — no trace, screenshot, or video artifact
from any Scenario H run survived (§7.2's search of `test-results/` found only
a single leftover Scenario I result; nothing for H), and Task 77.3's own
report explicitly records that its diagnostic debug specs and evidence
directory were deleted before finalizing. This specific, finer-grained
question is **BLOCKED** by missing artifacts, consistent with the brief's
instruction to say so rather than reconstruct it.

**What is resolved:** the two statements are not actually contradictory
once the code's three call sites are accounted for; they are both
individually true of some run. **What remains unresolved:** whether
`restartBackend()` ran in the *specific* isolated attempt most prominently
cited, or how many of the 8 chain-run failures were pre- vs. post-restart,
cannot be recovered from available evidence.

One additional, concrete finding from reading `restartBackend`'s call site
and its neighbors: whichever of the three sites failed, **no run of Scenario
H ever reached its final two assertions** (`postRestartDatabasePersisted`,
`postRestartDatabaseLiveMs`, lines 1016, 1022, 1024) — so Task 77.3's
"BLOCKED, not FAILED, is the honest label for the restart criterion" (§7 of
its report) is accurate regardless of which call site failed: no run,
however it failed, produced a genuine restart-survival data point one way or
the other for the Database-level leg, and at best one or two runs may have
produced a genuine (if unrecorded) data point for the DatabaseRow-level leg
if they failed only at line 1004.

## 9. Scenario B/D failure analysis

**Classification: Inconclusive — a real structural asymmetry was found, but
a directly contradicting observation exists and is reported alongside it,
per the brief's instruction not to force one explanation.**

### 9.1 The structural asymmetry (new finding, not in Task 77.3's report)

Reading the suite's test order and writer-page assignment directly:

```
A (writer: pageA) → B (writer: pageB) → C (writer: pageA) → D (writer: pageB) → E (writer: pageA) → F → G (writer: pageA) → H (writer: pageA) → I (writer: pageA)
```

**B and D are the only two tests in the entire suite that use `pageB` (the
member's page) as the writer — and each one runs immediately after a test
that used `pageA` as the writer and that, in its own cleanup, reloaded
`pageB`** (A and C both end with `pageB.reload()` to verify reload
persistence, lines 761 and 817–819). So in the normal full-suite order, B and
D are structurally the two moments in the whole file where the *previously
passive, just-reloaded* context is suddenly asked to be the active writer.
This is a real, previously-unreported asymmetry, and it is at least
consistent with Task 77.3's own backgrounding/renderer-freeze hypothesis in
a more specific form: not generic host pressure, but specifically "the page
that was not just driven is the one whose next click fails."

Task 77.3's report itself states this held even in a **minimal 2-test
isolation**: "B | FAILED (confirmed in isolation too — ran directly after A
alone, still failed)" — i.e., running only A then B from a fresh setup still
reproduces B's failure, which is consistent with the handoff from `pageA` to
`pageB` (not SOMETHING accumulated from C through G) being implicated.

### 9.2 The directly contradicting observation

**Scenario I's own code (read in full, §1028–1087) uses `pageA` as its sole
writer throughout — it never touches `pageB` as a writer at all** — yet Task
77.3's report records it failing on the *same* `writeCell`/`cell.waitFor`
mechanism, in a **run filtered to execute only Scenario I**
(`-g "I\. multi-object"`), which per Playwright's `-g` semantics means
`beforeAll`/`beforeEach` still ran but no other test body did — i.e. `pageA`
and `pageB` were **freshly created** for that run, with no prior A–H history
to accumulate staleness or page-handoff effects from. If the asymmetry in
§9.1 were the operative mechanism, a fresh, pageA-only run should not exhibit
the same failure — but it did (the one surviving artifact in
`test-results/`, confirmed in this audit: `error-context.md` for
"...I. multi-object session...", `Test timeout of 240000ms exceeded`, no
trace or screenshot saved alongside it, consistent with an abrupt
termination before Playwright's own artifact-capture completed).

### 9.3 Where, specifically, B/D/I die

All three fail inside the same mechanism: `writeCell`'s (or `renameField`'s)
bounded 3-attempt click retry loop, each attempt bounded at an 8-second
`.click({timeout: 8000})` — i.e. **during the UI interaction itself**, never
reaching the subsequent collaboration-delivery assertions
(`awaitCellTextLive`/`awaitFieldNameLive`), backend-persistence reads, or
reload verification. This part is unambiguous from the code structure and
from the recovered `error-context.md`'s failure location (`writeCell`,
not any assertion after it): **none of B, D, or I's failures reach far
enough to say anything about the actual collaboration/delivery layer.** Per
the brief's own instruction, this means the backend's subscription
implementation (Task 77.2) is **not** implicated by these specific failures
— the failure point is strictly upstream of any point where that code could
even be exercised by these particular test runs.

### 9.4 Conclusion

Two real, code-verified observations point in different directions: a
structural writer-handoff pattern that *does* correlate with B and D (and is
consistent with a page-specific backgrounding mechanism), and a
pageA-only, fresh-context counterexample in Scenario I that this same
mechanism does not explain. **This audit does not resolve which (if either)
is the true mechanism**, and explicitly declines to pick the tidier story.
What can be said with confidence: the failures are located at the UI
interaction step, not at any collaboration-delivery or persistence check, so
there is no evidence here of a Task 77.2 regression, and no evidence here
that would clear B/D/I as "definitely just flaky UI automation" either —
both remain open questions requiring an actual re-run to resolve, which this
audit was not authorized to perform.

## 10. Resource-pressure assessment

**Classification: current pressure Confirmed; Task 77.3's specific "150+
matching processes... at this session's peak" claim is Plausible but
unproven as a sustained condition — it cannot be reproduced or independently
checked after the fact.**

### 10.1 What is directly, currently measurable

```
sysctl vm.swapusage →  total = 12288.00M, used = 10893.44M (88.6%), free = 1394.56M
ps aux | wc -l       →  610 total processes on the host right now
```

88.6% swap utilization **right now** is a genuinely high figure and is
**Confirmed** as a present condition — this machine is under real memory
pressure at the time of this audit, which is itself evidence worth taking
seriously for any future attempt (see §15).

### 10.2 What is NOT reproduced

The current process table does **not** show anything resembling "150+
matching processes": the only test-related processes found, across every
category checked (`node server.js`, `vite`, `chromium`/`headless_shell`,
`playwright`), total **10** — the 9 historical ones (§7.1, unchanged and
expected) plus the one ambiguous `test-server` helper (§7.2). There is no
way, from this audit's read-only vantage point hours after the fact, to
determine what Task 77.3's own "150+ matching processes" count actually
enumerated — it is not reproducible now, and no sampled historical process
count (e.g., a saved `ps` snapshot taken during an actual run) survived for
this audit to inspect. Per §4.4's own caution about distinguishing unique
PIDs from command-line-pattern matches that could overcount a single process
tree (e.g., matching a Chromium browser process's multiple
helper/GPU/renderer sub-processes, or matching substrings that recur many
times per line), a figure that large is also structurally plausible from
transient, legitimately-short-lived Chromium process trees (a single
Chromium launch typically spawns several helper processes: GPU, network,
renderer-per-page, etc.) that existed only while a browser was actually open
during one of the 9 runs and were correctly cleaned up afterward — which
would make the figure real at the time, self-inflicted by the test run
itself (not an external factor), and simply no longer observable now.

### 10.3 Was it self-inflicted?

Partially answerable from code + config alone: §6 confirms `workers: 1` and
`fullyParallel: false`, so this spec file cannot by itself run more than one
browser-context tree concurrently — any multi-process count from a single
run reflects one Chromium instance's own internal process architecture (GPU/
renderer/network helpers), not multiple competing test runs. Across **9
sequential runs** without the disposable-process leak (§6 item 11 of Task
77.3's report, independently corroborated in §7.1: the leaked backend+Vite
processes are real and are the *same* 9 still running now), each run's own
leaked backend+Vite pair would have persisted into the *next* run's resource
envelope, compounding across the session — this is a concrete, confirmed
mechanism by which the test run's *own* cleanup failure would have
contributed to rising host pressure over the course of the 9 runs, independent
of any external factor. The magnitude of that contribution (9 runs × 2
processes = at most 18 extra long-lived processes, well short of "150+") is
not sufficient by itself to explain a 150+ figure, which still most plausibly
reflects transient per-run Chromium process trees rather than the persistent
leak.

**Classification, stated precisely:** "the host was under some real,
partially self-inflicted resource pressure during Task 77.3" — **Strongly
supported** (confirmed current pressure + confirmed persistent leak
mechanism). "The specific count and severity Task 77.3 reported fully
explain the deterministic B/D/G/H/I failures" — **Plausible but unproven**;
no causal test (e.g., reproducing the failure only above some measured
threshold, or clearing it below some threshold and seeing success) was ever
run.

## 11. Task 77.2 implementation reassessment

**No code in `server.js` was modified or even opened for editing in this
audit — only its checksum was verified (§3).** The established evidence from
Task 77.2 is preserved and not re-litigated: 9/9 protocol scenarios on JSON,
9/9 on real PostgreSQL, browser Scenarios A/B/E passing live. §9.3 above adds
one data point consistent with, not contrary to, that evidence: every B/D/I
failure examined in this audit dies at the UI-interaction step, strictly
before any point where the subscription-routing code could be exercised by
that specific test run. **This audit found nothing that calls Task 77.2's
fix into question**, and nothing that would newly support it either beyond
what Task 77.2 and 77.3 already established — this task was not authorized
to re-run the protocol suite to add further confirmation, and did not.

## 12. Test evidence classification

| Area | Evidence tier |
|---|---|
| Repository baseline, md5s, `git status` | Static inspection |
| Task 77.3 file diff (§4) | Static inspection (source reading) |
| Sleep/wake (§5) | Real system log (unified log, `pmset`) — not a test, but a direct, live system-log query |
| Headless config (§6) | Static inspection (config file reading) |
| Process ownership (§7) | Direct process inspection (`ps`, `lsof`) — live, real, not simulated |
| Scenario H contradiction (§8) | Static inspection (test source) + one surviving real-browser-test artifact (`error-context.md` for Scenario I, not H — no H artifact survived) |
| Scenario B/D/I analysis (§9) | Static inspection (test source ordering/writer assignment) + the one surviving real-browser-test artifact |
| Resource pressure (§10) | Current real system measurement (`vm.swapusage`, `ps`) for the present state; historical peak is Blocked/unconfirmable |
| Task 77.2 reassessment (§11) | No new evidence generated; prior reports' evidence tiers stand as recorded there |

No unit test, protocol-level WebSocket test, JSON/PostgreSQL persistence
test, or new browser test was run in this task, per its explicit restrictions.

## 13. Confirmed findings versus hypotheses

**Confirmed:**
- Repository/baseline integrity (§3).
- No sleep/wake occurred during Task 77.3's execution window (§5).
- Headless Chromium was the configured mode (§6).
- The 9 historical processes are the same processes, unterminated, on their
  original ports (§7.1).
- A 10th process exists that Task 77.3's "zero new orphans" claim did not
  account for (§7.2) — ownership uncertain, but its existence is not.
- Current (not historical) swap pressure is high (§10.1).
- B, D, and the one recovered I failure all die inside the UI-interaction
  step, never reaching a collaboration-delivery or persistence assertion
  (§9.3).
- The Scenario H "contradiction" is explained by three distinct call sites
  in the test code, not an actual inconsistency (§8).

**Strongly supported (multiple independent signals, not single-sourced):**
- Resource pressure was real and at least partially self-inflicted by the
  test run's own cleanup failures compounding across 9 sequential runs (§10.3).

**Plausible but unproven:**
- Task 77.3's specific "150+ matching processes at peak" figure explaining
  the deterministic browser failures (§10.2).
- The pageA→pageB writer-handoff asymmetry (§9.1) as a causal mechanism for
  B/D specifically.

**Inconclusive:**
- Whether the writer-handoff asymmetry or a handoff-independent mechanism
  (as Scenario I's pageA-only failure suggests) is the operative cause of the
  B/D/G/H/I failure family (§9.4).

**Refuted:**
- Mac sleep/wake as a contributing factor to Task 77.3's failures (§5).

**Blocked:**
- Per-run, per-call-site attribution of which of Scenario H's three write
  sites failed in which of the 8 chain runs (§8) — no surviving artifact.
- Independent verification of the historical "150+ processes" figure's
  actual composition (§10.2) — not reproducible after the fact.

## 14. Outstanding unknowns

- Whether the VSCode-parented `test-server` process (§7.2) is a harmless IDE
  background service or an actual Task 77.3 leak with an unusual parent —
  not resolved, and this audit was not authorized to terminate it to find
  out destructively.
- The true mechanism behind B/D/G/H/I's deterministic failures — host
  resource pressure, a page-handoff-specific rendering issue, a Playwright/
  Chromium interaction unrelated to either, or some combination — remains
  open. This audit added one real structural observation (§9.1) and one real
  contradiction to it (§9.2) but did not resolve the question.
- Whether `ensureGridInteractive`'s DOM-presence-only readiness check is
  itself insufically strict (§4) — plausible given the symptom pattern, not
  confirmed by any new execution in this task.
- Whether Scenario H's restart/reconnection logic itself works at all — still
  completely unverified; no run in Task 77.3 or this audit produced a single
  data point on it either way.

## 15. Recommended next experiment

**Chosen: a hybrid of Outcome C (resource exhaustion controlled test) and
Outcome D (investigate the UI/locator layer specifically), because §10 and
§9 both ended Inconclusive/Plausible rather than Confirmed, and a single
cheap experiment can discriminate between them.**

**Experiment:** Before running anything, check `sysctl vm.swapusage` and wait
(or ask the user to close unrelated heavy applications) until swap usage is
materially lower than the 88.6% observed here. Then run, as two completely
separate, single-worker, single-test Playwright invocations (never combined,
never the full suite):

1. `npx playwright test test/e2e/task77-1-database-multiuser.spec.ts -g "B\. Database-level" --reporter=line` with `trace: 'off'` and `video: 'off'` overridden for this one invocation only (via `--trace=off --video=off` CLI flags, not a permanent config edit) — isolates whether B fails even with the trace/video-timeout confound removed, under lower host pressure than this session's historical peak.
2. The same for Scenario I alone.

If both now pass reliably (3 consecutive clean runs each, per the original
77.3 repeatability bar), that is strong evidence for the resource-pressure
hypothesis and specifically against a genuine Playwright/Chromium defect,
and the recommended follow-up becomes permanently disabling tracing for this
spec file (Outcome C's conclusion). If either still fails under measurably
low pressure, that refutes resource pressure as sufficient explanation and
redirects investigation specifically to `ensureGridInteractive`'s
DOM-presence-only readiness check and the `pageA`/`pageB` writer-handoff
asymmetry identified in §9.1 (Outcome D). **Do not** run the full 9-scenario
suite again as the first move — it would reproduce the same ambiguity this
audit already found, at the same cost as before, without adding
discriminating power.

## 16. Final status and recommendation

**Task 77.4: Audit complete.** Deliverable produced; no test suite was made
green, per this task's own success criterion — a trustworthy diagnosis and a
single justified next step, not a passing run.

**Baseline confirmed trustworthy and unchanged by this audit:**
- Frontend working tree: unchanged, 33 entries, identical to every prior
  task's recorded baseline.
- Backend production files: unchanged; `server.js` md5 identical to Task
  77.2's post-fix value.
- `.env.local`: unchanged, identical to the pristine backup.
- Processes started or stopped by this audit: **zero** — every command run
  was read-only (`ps`, `lsof`, `pmset`, `log show`, `md5`, `git status`,
  file reads). No disposable backend, Vite instance, or Chromium process was
  launched or terminated by this task.
- Files modified outside this report: **zero.**

**No recommendation is made to upgrade either Task 77.2 or Task 77.3's
status** — both remain exactly as their own reports left them
("Browser verified (partial) — NOT Complete" and "Investigated and partially
fixed — NOT Complete" respectively). This audit's job was to establish
whether the diagnosis underneath those statuses holds up, not to change the
statuses themselves.
