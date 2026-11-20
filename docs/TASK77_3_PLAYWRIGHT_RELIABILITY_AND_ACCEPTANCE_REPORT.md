# Task 77.3 — Playwright Grid Interaction Reliability and Collaboration Acceptance Closure

## 1. Executive summary

Task 77.2 fixed the confirmed Database-level WebSocket fan-out defect (9/9
protocol scenarios on JSON and PostgreSQL; Task 77.1 §4 A/B/E flipped from
FAILED to PASSED in a real browser). Two browser acceptance scenarios
remained blocked going into this task: Task 77.1 Scenario H (genuine backend
restart) and Scenario I (one session multiplexing Document + Database +
DatabaseRow), both failing on Playwright grid-interaction timeouts *before*
reaching their collaboration assertions.

**This task found and fixed two genuine, confirmed test-infrastructure
defects**, and diagnosed — without being able to fully resolve — a third,
harder problem that is now the dominant blocker:

1. **FIXED, confirmed by isolated reproduction**: the grid's sticky-header
   overlay duplicates every `grid-field-header-<id>` node inside the same
   `database-grid` container Task 77.1's disambiguation relied on, so a
   `.first()`/`.last()` heuristic could resolve to either copy depending on
   DOM mount order. Replaced with an ancestor-excluding CSS selector,
   confirmed correct via a standalone Chromium reproduction.
2. **FIXED, confirmed by trace-screencast evidence**: a backgrounded
   `BrowserContext` page can be silently discarded and fully re-bootstrap (the
   app's own loading splash, not merely a lost-focus state) when later
   brought back to front; a bare `bringToFront()` does not wait out that
   reload. Added a readiness gate that waits for the grid's own signal to
   reappear, and re-dismisses the compat banner, before any interaction.
3. **DIAGNOSED, NOT resolved**: even with both of the above fixed, a bounded
   retry, generous timeouts, a clean process table, and a disproven
   cold-start-click theory, Scenarios B, D, G, H and I remain **deterministically
   reproducible failures** — not intermittent flakiness — in every one of 9
   independent full/partial real-browser runs executed in this task. The
   evidence (a trace screencast showing a visually normal, fully-rendered
   grid at the exact moment of failure, combined with the fact that even a
   bare `page.evaluate()` diagnostic failed to return within its own
   unbounded wait) points at genuine Chromium renderer unresponsiveness for
   the backgrounded `BrowserContext`, most plausibly driven by sustained
   host memory/CPU pressure from this session's own long-running parallel
   test execution (confirmed independently: 150+ matching processes and
   heavy swap compression observed at this session's peak). This is reported
   as the best-evidenced leading hypothesis, not a certainty — see §4, §7, §8.

A related, independently-confirmed **test-harness defect** was found: the
disposable backend/frontend processes `stopTestEnvironment` spawns reliably
survive the `.kill()` call during a real Playwright run (12/12 of this
task's own full-suite runs each leaked their 2 processes), apparently because
Playwright's own "trace recording timeout exceeded" watchdog hard-kills the
worker process before `test.afterAll`'s cleanup code ever runs — confirmed by
the fact that hardening the kill logic itself (SIGTERM-then-SIGKILL,
confirmed-dead) did **not** stop the leak. This is a genuine finding, but one
this task's two helper functions cannot fix from inside themselves; see §6
and §16.

**Final Task 77.3 status: Investigated and partially fixed — NOT Complete.**
**Recommendation on Task 77.2: do NOT upgrade to Complete.** Scenarios H and I
do not clear the repeatability bar (§10, §11); upgrading would misrepresent
untested/failing acceptance criteria as satisfied.

## 2. Task 77.1 / 77.2 acceptance gaps (recap)

| Gap | Status entering this task |
|---|---|
| Scenario H (genuine backend restart, two clients) | BLOCKED — `writeCell` timeout before any restart/delivery assertion |
| Scenario I (one session, 3 collab types) | BLOCKED — `writeCell` timeout before any delivery assertion |
| Multi-object awareness regression | NOT TESTED (Task 77.2 §14 item 5) |

## 3. Original grid locator failure analysis

Investigated per §4's instruction to distinguish failure classes rather than
assume one cause. Findings, each confirmed with direct evidence (trace
screencasts, DOM queries, or standalone reproduction), not inferred from the
error message alone:

| Failure class | Confirmed? | Evidence |
|---|---|---|
| Sticky-header duplicate interception | **Yes — real, and fixed** | Source inspection (`GridStickyHeader.tsx`'s `pointer-events` toggle) + a standalone Chromium reproduction (`querySelectorAll` with the ancestor-excluding selector returns exactly 1 of 2 matches) |
| Full app reload/splash while backgrounded | **Yes — real, and mitigated** | A trace screencast captured at the exact `renameField` timeout showed the app's loading splash (bouncing dots), not the grid, immediately after the preceding scenario's own `pageB.reload()` |
| Element genuinely absent (0 DOM matches) | Observed once | A different run's diagnostic logged `count=0` for the *unfiltered* testid query -- not a sticky-header ambiguity, a transient full absence, consistent with the same backgrounding/reload class above |
| Cold-start Playwright input dispatch (page's first-ever click) | **Tested and REFUTED** | Added a harmless `page.mouse.move()` "warm-up" on both pages before any scenario; re-ran A+B; B failed identically. Removed the warm-up (§5, §17) since it provided no benefit |
| Click intercepted by an invisible overlay despite a normal-looking screenshot | Attempted to isolate, **inconclusive** | Added a diagnostic branch (final retry attempt: capture `elementFromPoint` + try `force: true`) to distinguish "overlay intercepts" from "renderer frozen". The diagnostic itself never completed -- the preceding plain `.click({timeout:8000})` did not return within 8 real seconds, well past its own timeout parameter, which is consistent with the underlying CDP channel to that page being stalled, not with a selector/overlay problem a `force` click could route around |
| Genuine product/application failure (AppFlowy itself broken) | **Ruled out** | Pre-existing scenarios A, C, E pass in every single run, on the identical grid, with the identical helpers, in the identical suite -- the application's real-time collaboration itself (the thing Task 77.2 fixed) is not implicated |

## 4. Sticky-header and virtualization findings

**Mechanism** (`AppFlowy-Web/src/components/database/components/grid/grid-table/GridVirtualizer.tsx`):
the grid toggles a sticky header overlay's `style.opacity` and
`style.pointerEvents` based on scroll position (`shouldShowStickyHeader`).
Both the virtualized header row and the sticky overlay copy carry the same
`data-testid="grid-field-header-<id>"`, and both are descendants of the same
`[data-testid="database-grid"]` container
(`AppFlowy-Web/src/components/database/grid/Grid.tsx` → `GridVirtualizer` →
`GridStickyHeader`), so `database-grid`-scoping does not disambiguate them.
Task 77.1's `.first()`/`.last()` heuristic could resolve to either copy
depending on DOM mount order, and a preceding `scrollIntoViewIfNeeded()` could
itself nudge scroll position enough to flip the sticky overlay's
`pointer-events` mid-click.

**Fix**: `GridStickyHeader`'s own wrapper carries a stable, source-verified
class, `grid-sticky-header`, unique to that component (confirmed by
`grep -rn "grid-sticky-header"` across the frontend — only the component
definition and one unrelated test reference it). A CSS `:not()` selector with
a descendant-combinator argument (`[data-testid="grid-field-header-<id>"]:not(.grid-sticky-header [data-testid="grid-field-header-<id>"])`)
reliably selects only the non-sticky copy. Verified correct in isolation:

```
node -e "... page.setContent('<div class=\"grid-sticky-header\">...</div><div>...</div>'); \
  page.locator('[data-testid=\"h-1\"]:not(.grid-sticky-header [data-testid=\"h-1\"])').count() ..."
→ count with :not complex = 1
```

This selector is correct and is NOT the cause of the remaining B/D/G/H/I
failures (§7/§8 confirm the real element is found and visually present at
failure time).

**Virtualization**: `waitForGridRowReady` (pre-existing, Task 77.1) already
scrolls the target row container into view before querying its cell; no
defect was found in that logic itself.

## 5. Test helper changes

All changes are in the test-only files below. **No production file in either
repository was modified.**

| File | Change | Why |
|---|---|---|
| `test/e2e/task77-1-database-multiuser.spec.ts` | Added `realGridFieldHeader()` (sticky-header-excluding selector); added `ensureGridInteractive()` (readiness gate: `bringToFront()` + wait for the grid's own signal + re-dismiss compat banner); `renameField`/`writeCell` now call the gate and retry their click up to 3 times with an Escape+settle pause between attempts; bumped `test.setTimeout` on scenarios A–G to accommodate the new gates (120000→180000, 300000→420000 for G) | Fixes items 1–2 of §3; the retry and bumped timeouts are defensive, not fixes for the item-3 freeze (confirmed in §8, they do not resolve it) |
| `test/helpers/test-environment.ts` | Added `killConfirmed()` (SIGTERM, poll for death, SIGKILL fallback) used by both `stopTestEnvironment` and `restartBackend` in place of a bare `.kill()` | Hardens process cleanup against a signal silently not taking effect; did **not** eliminate the leak in practice (§6) because the leak's actual mechanism is external to these functions |
| `test/multi-object-subscriptions.test.js` | Appended one new test: "Task 77.3 §9 ... AWARENESS updates ... after its active binding has moved to the last row" | Closes the Task 77.2 §14 coverage gap (content fan-out was tested; awareness fan-out was not) |

Two things were added, tested, found NOT to help, and **removed** before
finalizing (disclosed rather than silently dropped):

- A `page.mouse.move()` "warm-up" on both pages in `beforeAll`, testing
  whether a page's first-ever click has extra Playwright/Chromium dispatch
  latency. Refuted (§3); removed.
- A diagnostic branch on the final retry attempt that tried `boundingBox()` +
  `elementFromPoint()` + a `force: true` click, to distinguish an invisible
  overlay from a frozen renderer. The diagnostic itself never completed in
  the one run it was exercised in (§3's last row); removed rather than left
  in as effectively dead, confusing code. The report records what it would
  have told us had it completed.

### 5.1 What §5's "extract reusable helpers" item was NOT done, and why

§5E asked that helper extraction, if necessary, keep the existing Task 77.1
spec's behavior unchanged and not create a second framework. No extraction
was needed this task: all fixes are internal to functions already private to
`task77-1-database-multiuser.spec.ts` (`renameField`, `writeCell`, plus two
new small helpers), so the file's external behavior/structure is unchanged
and nothing needed to be shared with a second spec.

## 6. Backend restart infrastructure changes

Investigated per §6's checklist:

1. Backend starts on a disposable port — unchanged, confirmed working.
2. Frontend starts on a disposable port — unchanged, confirmed working.
3. Environment configuration isolated — unchanged; the Task 77.2 `.env.local`
   pristine-backup hardening (`test/helpers/.env.local.pristine`, canonical
   value `http://localhost:8787`, md5 `c85de40f...`) was verified intact
   throughout this task (§15) and not modified.
4. Backend process ownership recorded — unchanged (`env.backendProcess`).
5. Backend readiness checked via a real health condition — unchanged
   (`waitHealthy`), confirmed working in every restart this task triggered.
6. Restart terminates only the current test-owned backend — unchanged,
   confirmed (no other backend was ever affected across 9+ runs).
7. The replacement backend starts with the same storage configuration —
   unchanged, confirmed (`STORAGE`/`DATA_FILE`/`DATABASE_URL` all copied from
   the live `env` object).
8. The JSON/Postgres storage location is identical across restart —
   unchanged, confirmed (same `dataFile` path reused).
9. Frontend reconnects using its existing behavior — not reached in any run;
   Scenario H never got past its pre-restart `writeCell` call.
10. The test waits for actual reconnection, not a sleep — pre-existing
    behavior (`pageX.waitForSelector(grid-field-header)` after reload), not
    changed.
11. **Cleanup terminates only processes created by the current run — found
    broken in practice, not by design.** See immediately below.
12. Environment configuration restored reliably — confirmed, every run
    (§15).

**Finding on item 11**: `stopTestEnvironment`'s `.kill()` reliably left both
spawned processes running in 12 of 12 of this task's own full-suite runs
(verified via `ps`, well after the `npx playwright test` CLI process itself
had exited). This was hardened (`killConfirmed`: SIGTERM, poll for actual
death via `process.kill(pid, 0)`, SIGKILL fallback) and the hardening is
correct in isolation (a standalone Node script spawn+kill test confirms
basic `.kill()` already works fine outside Playwright). **The hardening did
NOT stop the leak** in a subsequent real run (6 more leaked processes after
it was applied) — the most plausible explanation, consistent with the
repeated "Fixture 'trace recording' timeout of 120000ms exceeded during
teardown/setup" messages accompanying nearly every failed test in this task,
is that Playwright's own trace-recording watchdog force-terminates the
*worker process* itself when a test's teardown/setup trace step hangs too
long, which happens *before* `test.afterAll` (and therefore
`stopTestEnvironment`) ever runs. No in-process cleanup function can defend
against the process it's running in being killed externally. This is
reported as a genuine, repeatedly-observed test-harness characteristic, not
fixed (fixing it would mean changing Playwright's own tracing/retry
configuration, a judgment call outside this task's "smallest safe backend
[test-infra] change" mandate — flagged as a recommended follow-up in §18).

## 7. Scenario H results

| Attempt | Context | Result | Evidence |
|---|---|---|---|
| Isolated (H alone) | Before any fix | FAILED | `writeCell` timeout on `cell.waitFor({visible})`, 15000ms, after a genuine `restartBackend()` |
| 8 subsequent full/partial-chain runs (`run2`–`run8`, each with cumulatively more fixes applied: sticky-header fix, `ensureGridInteractive`, bounded retry, bumped timeouts, `killConfirmed`, clean process table) | Varying fix combinations | **FAILED in every single run** | Identical failure signature each time: `writeCell`'s `cell.click()`/`cell.waitFor` times out; in several runs accompanied by "Fixture 'trace recording' timeout of 120000ms exceeded" |

**Classification: INCONCLUSIVE, leaning ENVIRONMENT FAILURE.** Not classified
as PRODUCT DEFECT: scenarios A, C, E (identical application, identical
collaboration code path) pass in every run. Not classified as a confirmed
TEST HARNESS DEFECT in the sense of a logic bug this task could locate and
fix: every harness-level hypothesis tested (sticky header, reload/discard,
cold-start dispatch, process-table pressure) was either fixed and insufficient,
or tested and refuted. The remaining, best-evidenced explanation — sustained
host memory/CPU pressure degrading a backgrounded Chromium renderer to the
point that CDP calls on it do not return within their own stated timeouts —
was not independently, conclusively proven (the one diagnostic designed to
distinguish it from an overlay-interception theory did not get to run,
itself consistent with the freeze being real and severe). **The genuine
backend-restart acceptance criterion from Task 77.1 §4 H is NOT demonstrated
in a real browser by this task.**

Not reported as a FAILED product/persistence/restart claim: no run reached
far enough to make *any* assertion about restart-survival behavior one way or
the other. "BLOCKED," not "FAILED," is the honest label for the restart
criterion specifically.

## 8. Scenario I results

Run once in isolation (§10 required individual-first; repeatability was not
reached — see §11):

```
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts -g "I\. multi-object" --reporter=line
```

**Result: FAILED.** `Test timeout of 240000ms exceeded`, failing inside
`writeCell` at the same `cell.waitFor`/retry-loop location as Scenarios B, D,
and H. This is the fourth independent scenario to fail on exactly this
mechanism, strengthening §7's classification rather than suggesting a
separate Scenario-I-specific cause.

**Whether the frontend multiplexes Document + Database + DatabaseRow over one
WebSocket connection: NOT PROVEN by this task's browser run**, because the
run never reached the point where all three objects were open simultaneously
to observe the connection's SyncRequest sequence. This is a narrower, more
honest claim than Task 77.2's report made (§13.3 there inferred it from the
*mechanism* of how a grid view works, not from direct observation) — Task
77.3 could not add direct observational proof here because the scenario
never got that far. The protocol-level proof that a single connection CAN
correctly fan out across Document+Database+DatabaseRow subscriptions
(Task 77.2 Scenario B equivalent, extended by this task's own awareness
regression, §9 below) stands on its own regardless.

## 9. Awareness regression results

Added `test/multi-object-subscriptions.test.js`: "Task 77.3 §9 ... a
connection subscribed to a Database plus two DatabaseRows still receives
AWARENESS updates for the Database and a DatabaseRow after its active binding
has moved to the last row." Real WebSocket/protobuf, no mocks — same style as
Task 77.2's suite. Covers:

- Database awareness delivered to a multi-object subscriber whose active
  binding has moved to a DatabaseRow.
- DatabaseRow (row A) awareness delivered after the sender's own active
  binding subsequently moves to row A (rules out "still keyed off the
  Database send").
- Isolation: row B awareness never arrives as a side effect of either send.
- Sender-side admission is unchanged: an awareness update sent for an object
  the sender has not bound as its active object is still rejected (close code
  **1003** — "Unsupported ... collaboration message," verified against the
  live `server.js` source rather than assumed; not 1008, which is specific to
  update-admission rejection).

| Storage | Command | Result |
|---|---|---|
| JSON | `node --test --test-timeout=60000 --test-reporter=spec --test-name-pattern="77.3" test/multi-object-subscriptions.test.js` | **PASSED** (1/1, 204.8ms) |
| PostgreSQL | `DATABASE_URL=postgresql://achal@localhost:5432/appflowy_independent_test TASK77_2_STORAGE=postgres node --test ...` | **PASSED** (1/1, 312.6ms) |

Evidence tier: real WebSocket/protocol test, against real JSON and real
PostgreSQL persistence.

## 10. Individual versus combined suite results

| Scenario | Individually | In the full A–I sequence |
|---|---|---|
| A, C, E | PASSED (every run) | PASSED (every run) |
| B | FAILED (confirmed in isolation too — ran directly after A alone, still failed) | FAILED (every run) |
| D | Not separately isolated beyond the full chain | FAILED (every run) |
| F | Out of scope (pre-existing, Task 77.1-documented inconclusive flake) | FAILED once observed this task, consistent with its prior status |
| G | FAILED standalone (paired with H alone) and FAILED in the full chain | FAILED (every run, hits its own `test.setTimeout` budget: 300000ms baseline, 420000ms after bumping) |
| H | FAILED standalone and FAILED in every combined run | FAILED (every run) |
| I | FAILED standalone (only run attempted) | Not run as part of a full combined sequence due to time budget |

Combined-run interference (Task 77.1 §13.4's phenomenon) was **not** the
dominant explanation here: B fails even run directly after A alone, in an
otherwise pristine two-test file, which rules out "accumulated state from C
through G" as B's cause.

## 11. Repeatability results

**Target not met.** §10.C asked for 3 consecutive independent successes each
of H and I, plus 3 successful combined runs. Actual:

- **H: 0/4 successes** across 4 independent attempts in this task (1 solo,
  3 as part of a full/partial chain).
- **I: 0/1 successes** (only 1 attempt was time-affordable; it failed).
- **Combined H+I in one run: not attempted** (both individually fail
  reliably; running them together would not have produced new information
  and would have cost ~10 more minutes of wall-clock for a result already
  known).

This is reported as a **deterministic, 100%-reproducible failure across every
attempt**, not "flaky" in the sense of unpredictable pass/fail — which is
itself useful, stronger evidence than ordinary flakiness would be: it means
whatever the root cause is, it is a systematic property of this
test/environment combination at the time these runs were executed, not
random noise. Per the task's own instruction ("If a scenario remains flaky,
report the observed frequency and root cause. Do not describe a one-off pass
as stable verification"), this frequency (0/4, 0/1) and the leading-hypothesis
root cause (§7, §8) are reported exactly as observed.

## 12. JSON results

All backend JSON suites green, matching the Task 77.2 baseline exactly:

```
npm test                              tests 38   pass 38   fail 0
npm run test:offline-collab           tests  5   pass  5   fail 0
npm run test:database-collab          tests 13   pass 13   fail 0
npm run test:database-row-collab      tests 11   pass 11   fail 0
npm run test:database-catalog         tests 17   pass 17   fail 0
npm run test:database-view-collab     tests  6   pass  6   fail 0
npm run test:realtime-fanout          tests  4   pass  4   fail 0
npm run test:security                 tests 23   pass 23   fail 0
npm run test:collaboration-recovery   tests  8   pass  8   fail 0
npm run test:row-document             tests  4   pass  4   fail 0
                                       ------------------------------
                                       TOTAL 129  pass 129  fail 0
node --test test/multi-object-subscriptions.test.js
                                       tests 10   pass 10   fail 0   (includes Task 77.3's new awareness test)
```

`npm run test:collab-conformance` → exit 0, 6 RESOLVED + 1 PENDING
(`cross-instance-replay`, pre-existing, unrelated), no FAIL.

## 13. PostgreSQL results

Real PostgreSQL (`appflowy_independent_test`, the pre-existing isolated test
database; `pg_isready` confirmed accepting connections; nothing production
or commercial touched):

```
DATABASE_URL=... npm run test:postgres               tests 56   pass 56   fail 0
DATABASE_URL=... npm run test:parity                 tests  2   pass  2   fail 0
DATABASE_URL=... TASK77_2_STORAGE=postgres node --test test/multi-object-subscriptions.test.js
                                                      tests 10   pass 10   fail 0
```

No browser-level PostgreSQL scenario was exercised in this task (H and I both
use JSON storage by default in the spec and were never reached far enough to
be worth re-running against Postgres as well); this is additive scope beyond
what this task's charter required and was not attempted.

## 14. Backend regression results

Covered in full in §12–§13. No backend production file (`server.js` or any
`*.js` outside `test/`) was modified. `server.js` md5 confirmed
`f46509f6e92a258cf8277a8614af62c9`, identical to Task 77.2's post-fix value.

## 15. Frontend regression results

```
npx jest AppSyncLayer.test.tsx useSync.test.ts useSyncContextLifecycle.history.test.ts \
  useSyncContextLifecycle.ordering.test.ts sync-outbox.test.ts src/application/db/__tests__ --coverage=false
→ Test Suites: 9 passed, 9 total;  Tests: 158 passed, 158 total

npm run type-check → clean, exit 0
```

Matches the Task 77.2 baseline exactly (158/158, typecheck clean). **No
frontend production file was created or modified** in this task — `git
status --short` in `AppFlowy-Web` is 33 entries (22 modified + 11 untracked)
before and after, unchanged from every prior task's recorded baseline.

## 16. Environment and process cleanup

**`.env.local`**: confirmed byte-identical to the canonical pristine value
throughout and at the end of this task:

```
APPFLOWY_BASE_URL=http://localhost:8787
APPFLOWY_GOTRUE_BASE_URL=http://localhost:8787
APPFLOWY_WS_BASE_URL=ws://localhost:8787/ws/v2
md5: c85de40fc13dc3b2379325c6ecc3471d  (matches test/helpers/.env.local.pristine exactly)
```

**Processes**: inspected live via `ps` before and after every run in this
task, per §11's explicit instruction not to act on a historical PID list.
This task's own runs leaked their disposable backend/frontend processes 12
times (§6) despite the `killConfirmed` hardening; each time, this task
identified the leaked PIDs by full command line (`node server.js` /
`node .../vite/bin/vite.js --port 14xxx --strictPort`, all started at
timestamps matching this task's own run windows) and terminated **only**
those, verified immediately after by `ps` that exactly the 9 pre-existing
historical orphans remained (97325, 97329, 11764, 13713, 13811, 15220, 15224,
17228, 17352 — the same set Task 77.1/77.2 reported and left alone, per
instruction, throughout this entire task). **Final state: exactly those 9
historical processes remain; zero new orphans from this task.**

The normal development environment (port 8787) was never occupied by any
disposable test instance and remained free throughout.

## 17. Files changed

| File | Classification | Why |
|---|---|---|
| `test/e2e/task77-1-database-multiuser.spec.ts` | Test infrastructure | §5: sticky-header fix, readiness gate, bounded retry, bumped timeouts |
| `test/helpers/test-environment.ts` | Test infrastructure | §6: `killConfirmed` hardening |
| `test/multi-object-subscriptions.test.js` | Test / new regression | §9: awareness fan-out coverage |
| `docs/TASK77_3_PLAYWRIGHT_RELIABILITY_AND_ACCEPTANCE_REPORT.md` | Documentation | This file |

**No production file in either repository was modified.** Three throwaway
diagnostic spec files created during investigation
(`test/e2e/_debug-h.spec.ts`, `_debug-g.spec.ts`, `_debug-g2.spec.ts`) and
their evidence directory (`docs/task77-3-debug/`) were deleted before
finalizing — they existed only to capture the trace-screencast and DOM-state
evidence cited in §3/§4/§7 and are not part of the deliverable. No commits,
no pushes, no `git reset`/`checkout`/`clean`/`restore`. The upstream
`AppFlowy` repo and the commercial repo were not touched.

## 18. Remaining limitations

Stated plainly, per the task's own instruction not to describe a blocked
scenario as passed:

1. **Scenario H (genuine backend restart) remains BLOCKED**, not passed, not
   failed-as-a-product-claim — no run got far enough to make any assertion
   about restart/reconnection/persistence behavior.
2. **Scenario I (multi-object session) remains BLOCKED** for the same
   reason; the claim that one connection multiplexes all three collab types
   is unproven by direct browser observation in this task (though it stands
   on Task 77.2's protocol-level proof and architectural necessity, per §8).
3. **Scenario B and D (Database/DatabaseRow rename & cell-write,
   member-initiated) now FAIL DETERMINISTICALLY** in every run of this task,
   including runs where they had previously passed in Task 77.1/77.2's own
   evidence. This is itself concerning and should be investigated further;
   this task's best evidence points at session-induced host resource
   pressure (§7) rather than a regression in Task 77.2's fix (§9's protocol
   tests, which don't depend on browser rendering at all, pass cleanly on
   both storage backends), but this was not conclusively isolated from an
   actual change in frontend/backend behavior.
4. **The process-leak mechanism (§6 item 11) is diagnosed but not fixed.**
   The most likely cause — Playwright's own trace-recording-timeout-driven
   worker termination bypassing `afterAll` — is outside a test-helper
   function's ability to prevent. Recommended follow-up: investigate
   disabling or shortening trace recording specifically for this spec file,
   or wrapping the whole suite in an external process-group-aware launcher
   that can guarantee cleanup regardless of how the Playwright CLI process
   exits.
5. **The §6 required browser Scenario D (restart + PostgreSQL) and Scenario E
   (PostgreSQL multi-object) were not attempted** — JSON-mode Scenarios H and
   I never passed, so there was no basis to additionally attempt the
   PostgreSQL variants.
6. **The repeatability bar (3 consecutive clean runs of H, of I, and of a
   combined suite) was not met** — reported as 0/4 and 0/1 respectively,
   honestly, rather than padded with a partial success that didn't occur.
7. Scenario F (pre-existing, Task 77.1-documented concurrent-edit flake) was
   observed to fail once in this task's full-chain runs, consistent with its
   already-documented inconclusive status; not re-investigated, out of this
   task's scope.
8. The diagnostic that would have most directly distinguished "invisible
   overlay intercepting the click" from "renderer genuinely frozen" (§3's
   last row, §7) did not complete in its one execution, because the
   underlying freeze apparently also stalls the diagnostic's own
   `page.evaluate()` call. This leaves the exact mechanism one step short of
   fully pinned down; a follow-up with CPU/memory profiling of the Chromium
   renderer process during a reproduction (rather than relying on
   `ps`/screenshots alone) would be the natural next step.

## 19. Final task status

**Task 77.3: Investigated and partially fixed — NOT Complete.**

Genuinely fixed and proven: the sticky-header selector ambiguity (isolated
reproduction) and the tab-discard/splash-reload race (trace-screencast
evidence); both are real defects this task found, understood, and corrected
with evidence, independent of whether they fully explain the remaining
failures. The multi-object awareness regression gap identified in Task 77.2
§14 is now closed on both JSON and PostgreSQL. Full backend (JSON 129/129,
Postgres 56/56, parity 2/2, multi-object-subscriptions including the new
awareness test 10/10 on each storage) and frontend (158/158, typecheck clean)
regression suites are green with no drift from the Task 77.2 baseline. No
production code was touched in either repository; the frontend's 33-entry
`git status` baseline is unchanged; `.env.local` and the process table were
left exactly as found (plus the 9 pre-existing historical orphans, untouched
throughout).

**Not Complete** because the task's actual purpose — closing Task 77.1
Scenarios H and I — was not achieved. Both remain BLOCKED, and in this task's
own repeated attempts (9 full/partial real-browser runs total), the failure
was deterministic rather than merely unresolved flakiness, now affecting two
additional previously-passing scenarios (B, D) as well. The leading,
evidence-supported hypothesis is sustained host resource pressure degrading
Chromium's handling of backgrounded multi-context pages during this
session's own long debugging run, rather than a defect in the collaboration
implementation itself (scenarios A, C, E — exercising the identical
Task 77.2 fix — pass in every run).

**Recommendation on Task 77.2's status: do not upgrade to Complete.** Its
acceptance table explicitly requires real-browser multi-object and
restart-persistence verification (§10 of that task's brief); neither was
obtained here. Task 77.2's own "Browser verified (partial)" status remains
the accurate one. The underlying fan-out fix itself is not called into
question by anything found in this task — the two-client Database/DatabaseRow
scenarios that exercise it directly (A, C, E) continue to pass reliably, and
its own protocol-level test suite (now 10/10 including the new awareness
coverage) remains fully green on both storage backends.

**Recommended follow-up**, in priority order: (1) re-attempt H and I on a
quiescent machine with no other test load, to determine whether the resource-
pressure hypothesis is correct in isolation; (2) if confirmed, consider
running this specific spec file with Playwright tracing disabled or on a
single retry budget, to remove the "trace-timeout kills the worker before
cleanup" confound from both the browser-test results and the process-leak
problem simultaneously; (3) profile the Chromium renderer process (not just
`ps`'s coarse view) during a live reproduction to get a direct confirmation
or refutation of the freeze hypothesis.
