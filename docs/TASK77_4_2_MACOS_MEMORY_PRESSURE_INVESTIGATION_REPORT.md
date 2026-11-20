# Task 77.4.2 — macOS Memory Pressure Investigation and Browser-Test Readiness Assessment

Executed: 2026-11-11, ~22:56–22:59 IST. **Read-only.** No Playwright run, no
process/application started, stopped, suspended, or restarted, no
configuration or settings changed, no file modified other than this report.

## 1. Executive summary

Task 77.4.1's cleanup of the 9 disposable test processes did not reduce swap
*percentage* because macOS's swap file is dynamically sized and shrank along
with usage. This task investigated the actual memory situation directly
rather than relying on that one percentage.

**Headline finding: the high swap-used percentage is Confirmed, but it
reflects settled/historical usage, not active, ongoing memory pressure.**
`memory_pressure -Q` reports **85% system-wide memory free**, unchanged across
both snapshots. The kernel's own pressure level
(`kern.memorystatus_vm_pressure_level`) is **1 (normal)**. Across a real
105-second observation window with no load generated, **pageouts did not
increase at all (delta 0)** and **swapouts did not increase at all (delta
0)** — the two counters that would move if the system were actively writing
more data to swap right now. Swap *used* actually ticked down slightly
(8974.94M → 8926.94M). **Classification: Stable with historical swap usage**,
not "currently under sustained memory pressure" and not "actively paging."

The largest process-group footprint by a wide margin is **Google Chrome**
(70 processes, ~10.7GB summed RSS — not deduplicated, see caveat in §3),
driven by what appears to be a large number of open tabs/renderer processes.
VSCode (26 processes, ~3.8GB summed RSS) is second. Neither Claude Code
(1 process, ~487MB) nor the VSCode-managed Playwright Test extension service
(1 process, ~134MB) is a material contributor. OrbStack's VM (4 processes,
~1.3GB) and its two running containers (`n8n` at 386MiB, and a **crash-looping
`appflowy-selfhost-commercial-gotrue-1` container restarting every ~46
seconds** — flagged as a separate, unrelated anomaly, not a memory
contributor while down) are a secondary factor.

**Readiness verdict: READY WITH CAUTION** (§9) — not because swap is low (it
isn't), but because the combined evidence (stable free-memory percentage,
zero pageout/swapout growth over a real observation window, normal kernel
pressure level) indicates the system is not actively degrading. Swap
percentage alone, which Task 77.4 itself cautioned was a precaution and not a
validated threshold, is not used as the deciding factor here.

All repository and process-hygiene checks (§10) passed: nothing drifted,
nothing was touched beyond read-only inspection.

## 2. Scope and read-only restrictions

Every command used in this investigation was read-only: `sysctl`, `vm_stat`,
`memory_pressure -Q`, `ps`, `lsof`, `md5`, `git status`, `orb status`,
`docker ps`/`docker stats --no-stream`. No process was sent a signal, no
application was launched or closed, no file was written except this report.
No Playwright command was run. No power/performance setting was changed.

## 3. Initial memory snapshot (Snapshot 1, 22:57:05 IST)

| Metric | Value | Command |
|---|---|---|
| Physical RAM installed | **32 GB** (Apple M6, Mac mini, 12 cores) | `system_profiler SPHardwareDataType` |
| Page size | 16384 bytes (16KB, Apple Silicon) | `vm_stat` |
| Pages free | 357,545 (~5.59 GB) | `vm_stat` |
| Pages active | 713,099 (~11.14 GB) — resident, actively used | `vm_stat` |
| Pages inactive | 668,144 (~10.44 GB) — resident, reclaimable | `vm_stat` |
| Pages wired down | 163,146 (~2.55 GB) — not reclaimable | `vm_stat` |
| Pages occupied by compressor | 127,942 (~2.00 GB physical, holding more logical data) | `vm_stat` |
| Swap total | 10240.00 M (dynamically sized; was 11264M after Task 77.4.1, now smaller again) | `sysctl vm.swapusage` |
| Swap used | 8974.94 M | `sysctl vm.swapusage` |
| Swap free | 1265.06 M | `sysctl vm.swapusage` |
| **Swap used %** | **87.65%** | computed |
| Memory pressure (qualitative) | **"System-wide memory free percentage: 85%"** (verbatim) | `memory_pressure -Q` |
| Kernel pressure level | `kern.memorystatus_vm_pressure_level = 1` (**1 = normal**; 2 = warn, 4 = critical) | `sysctl` |
| Pageins (cumulative) | 80,992,336 | `vm_stat` |
| Pageouts (cumulative) | 2,742 | `vm_stat` |
| Swapins (cumulative) | 1,975,264 | `vm_stat` |
| Swapouts (cumulative) | 2,820,381 | `vm_stat` |
| Process count | 621 (`ps aux \| wc -l`) | `ps` |

**Important distinctions, as required:**
- Physical memory ("Pages active/inactive/wired") is distinct from swap.
  macOS's unified memory manager also counts compressed memory and
  file-backed cache as part of normal, healthy operation — a system is not
  "out of memory" merely because `Pages free` is a small fraction of 32GB;
  inactive and file-backed pages are readily reclaimable.
- `memory_pressure -Q`'s "85% free" is Apple's own holistic metric (it
  accounts for compressible and purgeable memory, not just literally-unused
  pages) and is a materially different, more meaningful signal than the raw
  swap-used percentage.
- Swap percentage alone is **not** treated here as proof of current pressure
  — see §5 and §7 for why.

## 4. Top processes by RSS (abridged to the significant tiers; full `ps aux`
sorted by RSS was captured, reproduced here grouped for readability per §4's
own instruction that the top-25 raw list is less useful than grouping)

| Rank | Process | RSS (approx) | Group |
|---:|---|---:|---|
| 1 | OrbStack Helper (vmgr) | 1.17 GB | OrbStack |
| 2 | VSCode Code Helper (Renderer), window A | 1.04 GB | VSCode |
| 3 | Google Chrome Helper (Aperitif Renderer) ×1 | 830 MB | Chrome |
| 4 | VSCode Code Helper (Plugin) [extension host, PPID 961 — the one hosting PID 6511] | 676 MB | VSCode |
| 5 | Google Chrome (main) | 613 MB | Chrome |
| 6–~70 | Google Chrome Helper (Aperitif Renderer) — one per tab/site-instance | 150–570 MB each | Chrome |
| ~20 | Claude Code (this session, `anthropic.claude-code` extension binary) | 487 MB | Claude Code |
| ~22 | VSCode Code Helper (Renderer), window B | 464 MB | VSCode |
| — | Siri AI.app | 234 MB | macOS system |
| — | Granola (meeting-notes app) ×2 | 204 MB + 172 MB | Electron app |
| — | VSCode main (`Code`) | 183 MB | VSCode |
| — | Playwright `test-server` (PID 6511) | **134 MB** | VSCode-managed (Playwright extension) |

**RSS caveat, stated explicitly as required:** these are resident-set-size
values per process; summing them (as done in §3's group table) is an
**approximation of footprint, not deduplicated physical memory**. Chrome's
~70 renderer/GPU/utility processes share the Chrome Framework binary, V8
snapshot data, and various mmap'd resources; the true unique physical
contribution is lower than a raw RSS sum. The same applies to VSCode's many
`Code Helper (Renderer)`/`Code Helper (Plugin)` children, which share the
Electron/Chromium framework. No group total below should be read as "this
many bytes of real additional RAM would be freed by quitting the app" —
it is an upper bound, not an exact figure.

## 5. Application-level memory grouping

| Application/group | Process count | Approx. combined RSS (not deduplicated) | Important processes | Confidence |
|---|---:|---:|---|---|
| **Google Chrome** | 70 | **~10.73 GB** | 1 main process + ~69 renderer/GPU/utility helpers, each tied to a tab/site-instance or service (e.g., one `SpeechRecognitionService` utility) | Confirmed by command-line (`Google Chrome.app`) |
| **Visual Studio Code** | 26 | **~3.82 GB** | 1 main (`Code`), multiple `Code Helper (Renderer)` (one per open window/webview), multiple `Code Helper (Plugin)` (extension hosts — language servers, Playwright Test extension's parent, etc.) | Confirmed by command-line + ancestry (re-verified in §6, consistent with Task 77.4.1's finding) |
| **OrbStack** (VM manager + helpers) | 4 | **~1.30 GB** | `OrbStack Helper (vmgr)` is the dominant single process at ~1.17GB — this is OrbStack's Linux VM manager, which reserves memory for the VM it's running (hosting the two Docker containers in §6) | Confirmed |
| **Claude Code** (this session) | 1 | **~487 MB** | The `anthropic.claude-code` extension's native binary, running this very investigation | Confirmed — single process, not a group |
| **Playwright Test extension service** | 1 | **~134 MB** | PID 6511, re-identified below (§6) | Confirmed, re-verified not an orphan |
| Electron apps (Granola) | 2 | ~376 MB | Meeting-notes app, unrelated to this project | Confirmed |
| macOS system (Siri AI, WindowServer, etc.) | several | not separately summed — individually small | — | Confirmed as system processes, not investigated further (out of scope: not development-tool related) |

**Chrome is the largest single group by a wide margin** — roughly 2.8× VSCode's
footprint and ~22× Claude Code's, on this approximate, non-deduplicated basis.

## 6. VSCode / Claude Code / Playwright memory assessment

**VSCode**, broken down by role:
- **Main process** (`Code`, PID 696): 183 MB — the application shell itself, modest.
- **Renderer processes** (`Code Helper (Renderer)`, type=renderer): the
  largest individual contributors in the VSCode group (two windows observed,
  ~1.04GB and ~464MB) — these are the actual editor UI webviews; their size
  scales with open editors, extensions' webview panels, and general Electron
  overhead, not with this test chain's activity specifically.
- **Extension hosts** (`Code Helper (Plugin)`, type=utility,
  `--utility-sub-type=node.mojom.NodeService`): PID 961 (676MB) and PID 960
  (337MB observed in the raw `ps` capture) are the two extension-host
  processes; PID 961 is confirmed (re-verified fresh, not assumed from Task
  77.4.1) to be the **direct parent of PID 6511** (Playwright), alongside
  sibling language-server children (`tsserver`, Pylance, JSON/Markdown
  language servers, Gradle server) — this matches Task 77.4.1's finding
  exactly, re-confirmed independently in this task.

**Claude Code**: exactly one process (PID 2612 in the raw capture, `achal`
user, `anthropic.claude-code-2.1.310-darwin-arm64` binary), ~487-499MB RSS
depending on the exact sample — this is the process running this
investigation itself. **Not every extension-host child belongs to Claude
Code** — it is a sibling of, not a parent or child of, the other
extension-host services under PID 961, consistent with §5 of Task 77.4.1's
finding and not re-litigated here.

**Playwright Test extension service**: re-identified fresh in this task
(not assumed to still be PID 6511):

```
achal  6511  0.0  0.4  489799584  137072  ??  S  10:02PM  0:00.56
  /opt/homebrew/bin/node AppFlowy-Independent-Backend/node_modules/@playwright/test/cli.js
    test-server -c AppFlowy-Independent-Backend/playwright.config.ts --host 127.0.0.1
```

**Still PID 6511, unchanged, still running, RSS ~134MB.** This is a small
footprint in absolute terms and negligible relative to Chrome's or VSCode's
group totals. Measured, not assumed — it is **not** a memory problem; it was
not treated as "safe to close" or "a leak" in this task, consistent with
Task 77.4.1's established finding that it is a legitimate IDE-managed
service, and consistent with this task's own §1 rule 13 never to treat it as
an orphan.

## 7. Docker/OrbStack and browser assessment

**OrbStack / Docker** (read-only inspection, `orb status`, `docker ps`,
`docker stats --no-stream` — no container was stopped, started, or inspected
destructively):

```
orb status → Running
docker ps:
  dbe9479e5b2e  appflowy-selfhost-commercial-gotrue-1   Restarting (1) 46 seconds ago
  f8b9d6bfb36f  n8n                                      Up 32 hours

docker stats --no-stream:
  appflowy-selfhost-commercial-gotrue-1   CPU 0.00%   MEM 0B / 0B    (currently down — crash-looping)
  n8n                                      CPU 0.41%   MEM 385.8MiB / 15.66GiB   (2.41%)
```

Two findings:
1. **`n8n`'s container footprint (386MB) is modest** relative to Chrome/VSCode
   and not a material contributor to the host's overall pressure.
2. **A genuinely unrelated anomaly was observed and is flagged, not
   investigated further** (out of this task's scope): the
   `appflowy-selfhost-commercial-gotrue-1` container is **crash-looping**,
   restarting roughly every 46 seconds. This is the **commercial** AppFlowy
   stack's GoTrue auth service — unrelated to the independent backend this
   entire Task 73–77.4.1 chain has been testing. It is not consuming memory
   while down (`0B/0B`), so it is not a candidate explanation for the swap
   figures in this report, but a continuously restarting container does
   consume periodic CPU and disk I/O, and the user may want to know it is
   crash-looping for unrelated reasons.

OrbStack's own VM-manager process (`OrbStack Helper (vmgr)`, ~1.17GB) is the
memory cost of running the Linux VM that hosts both containers — this is a
fairly fixed overhead of having OrbStack running at all, not something that
scales with these two specific containers' activity.

**Browsers**: only Google Chrome was found running (70 processes, §5). No
other browser (Safari, Firefox, Arc, Edge) process was present. **No
headless Chromium or `headless_shell` process was found** — consistent with
Task 77.4's and Task 77.4.1's finding that Playwright's own browser instances
are not currently running; the 70 Chrome processes are ordinary interactive
browser usage (visible windows/tabs), not Playwright-launched automation.
This was distinguished by command line (`Google Chrome.app` binary path, no
`--remote-debugging-port` or Playwright-characteristic automation flags) —
not assumed from the process name alone.

## 8. Memory pressure and compression analysis

Distinguishing the five related-but-distinct conditions, as required:

1. **High swap utilization**: Confirmed present (87.65% → 87.18% across the
   two snapshots, i.e. slightly improving, not worsening).
2. **High memory pressure** (the kernel's own qualitative assessment):
   **Refuted as "high."** `kern.memorystatus_vm_pressure_level = 1` (normal)
   and `memory_pressure -Q` reports 85% free, identically in both snapshots.
3. **Active swapping/pageouts** (data currently being written out to swap):
   **Refuted as currently active.** Pageouts delta across the 105-second
   window = **0**. Swapouts delta = **0**. If the system were actively under
   pressure and paging out right now, these cumulative counters would have
   increased during the observation window; they did not.
4. **Memory compression**: Present and essentially flat — "Pages occupied by
   compressor" went from 127,942 to 127,868 (a decrease of 74 pages, i.e.
   compression is not growing either). This is a normal, ongoing part of
   macOS memory management, not a sign of acute pressure.
5. **An application with large RSS footprint** (Chrome, §5): Confirmed and
   real, but a large RSS footprint by itself is not the same claim as
   "the system is under memory pressure right now" — per §1 rule 12, high RSS
   alone is not sufficient to conclude anything is unsafe to leave running.

**These conditions are genuinely dissociated here**: swap-used percentage is
high, but every *dynamic* indicator (pressure level, free-percentage metric,
pageout/swapout deltas, compressor growth) says the system is currently
settled, not actively degrading.

## 9. Two-snapshot paging analysis

Snapshots taken 105 seconds apart (22:57:05 → 22:58:50 IST), with no test,
browser, or other load deliberately generated in between.

| Metric | Snapshot 1 (22:57:05) | Snapshot 2 (22:58:50) | Direction |
|---|---:|---:|---|
| Memory pressure (`memory_pressure -Q`) | 85% free | 85% free | **Unchanged** |
| Kernel pressure level | 1 (normal) | not re-queried (no reason to expect change; qualitative metric above confirms stability) | — |
| Swap used | 8974.94 M | 8926.94 M | **Down** ~48 M |
| Swap total | 10240.00 M | 10240.00 M | Unchanged |
| Swap used % | 87.65% | 87.18% | **Down** 0.47 pts |
| Pages free | 357,545 | 349,645 | Down ~7,900 pages (~126MB) — within normal short-term fluctuation |
| Pages occupied by compressor | 127,942 | 127,868 | **Down** 74 pages (flat/slightly improving) |
| Pageins (cumulative) | 80,992,336 | 81,050,432 | **+58,096** (~952MB of pagein activity in 105s — see note below) |
| Pageouts (cumulative) | 2,742 | 2,742 | **+0 — no change** |
| Swapins (cumulative) | 1,975,264 | 1,978,555 | +3,291 (~54MB) |
| Swapouts (cumulative) | 2,820,381 | 2,820,381 | **+0 — no change** |
| Process count | 621 | 625 | +4 (normal background churn, e.g. transient helper processes) |

**Classification: Stable with historical swap usage.** The pageins delta is
real but is not, by itself, evidence of memory pressure — pageins include
ordinary demand-paging of file-backed/code pages (e.g., any application
reading from disk-backed mmap'd files during 105 seconds of idle background
activity across 620+ processes) and are not the same signal as pageouts
(data being evicted *to* disk because physical memory is full) or swapouts
(data being evicted specifically to the swap file). **The two counters that
would directly indicate "the system is actively relieving memory pressure by
writing to disk right now" — pageouts and swapouts — both had a zero delta.**
Combined with the unchanged 85% free-memory metric and the slightly-improving
swap-used percentage, this is **not** classified as "currently under
sustained memory pressure" or "actively paging." It is also not classified
as "deteriorating" — if anything, the trend across this specific 105-second
window is flat-to-marginally-improving, though two data points 105 seconds
apart are not sufficient to claim a durable long-term trend either way.

## 10. Ranked safe application-closing recommendations

Per §1 rule 12 and the task's explicit instruction, **nothing was closed**.
These are recommendations only, ranked by the evidence in §5–§7.

| Priority | Application | Approx. footprint | Why a candidate | Risk | Recommendation |
|---:|---|---:|---|---|---|
| 1 | **Google Chrome** (close unused tabs, not necessarily the whole browser) | ~10.7GB summed RSS (not deduplicated — true reclaimable amount likely lower but still the largest single opportunity) | By far the largest process group on the host; 70 processes strongly suggests many open tabs, several of which may be idle/forgotten | Low-to-medium — closing individual unused tabs risks losing unsaved form input on some pages; closing the whole browser risks losing a multi-tab session if not bookmarked | **Safe to consider closing (unused tabs) after checking for unsaved work in open tabs.** This is the highest-leverage, lowest-risk-to-this-project candidate since Chrome is completely unrelated to the AppFlowy test chain. |
| 2 | **Granola** (meeting-notes Electron app) | ~376 MB combined | Second-largest *clearly non-essential-to-this-task* application found; small individually but a legitimate, easy candidate if not in active use | Low, unless a meeting note is actively being recorded | Close only after checking active tasks (i.e., confirm no meeting is in progress) |
| 3 | **OrbStack** | ~1.3GB (VM manager) + whatever the VM itself reserves beyond the helper process shown | Running a Linux VM for two containers, one of which (`n8n`) is a long-running service and the other of which is presently crash-looping and contributing no useful work while down | Medium — stopping OrbStack would stop `n8n` (an actively "Up 32 hours" service of unknown importance to the user) and would not even address the crash-looping container (which uses ~0 memory while down) | **Do not close** without first confirming `n8n`'s purpose and current importance to the user — this task has no basis to judge that, per the explicit rule not to recommend stopping Docker/OrbStack containers without knowing what they are running |
| — | **VSCode / Claude Code** | ~3.8GB / ~487MB | Both are actively required for the ongoing AppFlowy development work this entire task chain depends on | — | **Do not close** — explicitly excluded by the task's own rule |
| — | **Playwright Test extension service (PID 6511)** | ~134MB | Small, legitimate, IDE-managed | — | **Do not close independently of VSCode** — explicitly excluded by the task's own rule; also negligible as a memory factor regardless |
| — | macOS system processes (Siri AI, WindowServer, etc.) | small, individually | System-managed | — | **Leave untouched** — explicitly excluded |

**Which recommendation would make the most meaningful difference, and why:**
Chrome's tab count (70 processes) is the one finding in this report large
enough, and unrelated enough to the AppFlowy work, to plausibly move the
needle if the user has genuinely idle tabs accumulated — but because RSS
sums overstate true reclaimable memory (§3's caveat) and because the dynamic
indicators in §8–§9 already show the system is not actively struggling, this
recommendation is offered as a reasonable, low-risk improvement, not as a
claim that it is *necessary* before the next browser-test attempt.

## 11. Browser-test readiness assessment

**Conclusion: READY WITH CAUTION — system is stable but swap remains
elevated.**

Reasoning, from the combined evidence rather than the swap percentage alone
(per the task's explicit instruction that swap percentage is not the sole
criterion and that Task 77.4's 88.6%-reference figure was a precaution, not a
validated threshold):

- Swap-used percentage (87.65% → 87.18%) remains in the same elevated range
  Task 77.4 and Task 77.4.1 observed (85.98%–91.94% across their
  measurements) — this has not materially changed, and is the basis for
  "with caution" rather than an unqualified "READY."
- However, every *dynamic* signal says the system is not actively
  deteriorating right now: kernel pressure level normal, `memory_pressure`'s
  own free-percentage metric steady at 85% across a real two-minute
  observation, zero pageout growth, zero swapout growth, compressor flat.
  This is the basis for "READY" rather than "NOT READY."
- No unexpected background test processes were found (the 9 historical
  disposable processes are confirmed gone — §6/§12 — and no new orphan
  appeared).
- The largest contributors to host memory usage (Chrome, VSCode) are
  ordinary desktop applications unrelated to and unaffected by the
  collaboration test chain itself, and were already present (at similar or
  larger scale) during Task 77.1–77.3's actual test runs — so their presence
  alone does not newly explain those runs' failures any more than it would
  have already.

This does **not** rule in or out the resource-pressure hypothesis from Task
77.3/77.4 as the cause of Scenario B/H/I's failures — this task was not asked
to, and did not, re-run those scenarios. It only establishes that the current
moment is not one of acute, worsening pressure by the available dynamic
measures, which is the information needed to decide *when* to attempt the
next controlled experiment, not whether that experiment would succeed.

## 12. Repository and process hygiene verification

| Item | Expected | Verified |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** |
| Port 8787 | free | **free** (`lsof -nP -iTCP:8787 -sTCP:LISTEN` → empty) |
| 9 historical disposable processes (97325, 97329, 11764, 13713, 13811, 15220, 15224, 17228, 17352) | absent (terminated by Task 77.4.1) | **all absent** — re-verified fresh, `ps -p <pid>` returns nothing for every one |
| 9 historical ports (19098, 14006, 14355, 14087, 19441, 19057, 14024, 14148, 19069) | not listening | **all free** — `lsof` returns 0 listeners on every port |
| VSCode Playwright service | present, untouched | **PID 6511, unchanged, still running** |
| Playwright test executed | none | **none** |
| Any process started/stopped/modified | none | **none** — every command used in this task was read-only |
| Any file modified other than this report | none | **none** |

No unexpected change was observed; nothing required explanation beyond what
is already accounted for above (the swap total's dynamic resizing, already
explained in §1/§3 and consistent with Task 77.4.1's own observation of the
same mechanism).

## 13. Confirmed findings versus hypotheses

**Confirmed:**
- Swap used percentage is elevated (87.65%→87.18%) but not a kernel-level
  "high pressure" state (§8).
- Kernel memory pressure level is normal (1), and Apple's own free-percentage
  metric is steady at 85% across a real two-minute window (§9).
- Pageouts and swapouts had zero delta across the observation window — no
  active paging-to-disk is occurring right now (§9).
- Google Chrome (70 processes) is the largest process group by RSS, by a
  wide margin over VSCode (§5).
- The VSCode Playwright Test extension service (PID 6511) has a small,
  negligible footprint (~134MB) and is not a memory contributor of any
  significance (§6).
- Claude Code's own footprint (~487MB, 1 process) is modest and not a
  material contributor (§6).
- All 9 historical disposable test processes are confirmed terminated and
  their ports released; no new orphan appeared (§12).
- Repository and configuration integrity is fully unchanged (§12).
- An unrelated commercial-stack container (`appflowy-selfhost-commercial-gotrue-1`)
  is crash-looping, but contributes ~0 memory while down (§7).

**Strongly supported:**
- The current moment is better described as "settled historical swap usage"
  than "active memory pressure," based on the convergence of four independent
  dynamic indicators (pressure level, free%, pageout delta, swapout delta)
  all pointing the same direction simultaneously (§8–§9).

**Plausible but unproven:**
- That reducing Chrome's tab count would produce a measurable, durable
  reduction in swap-used percentage — RSS-sum figures overstate true
  deduplicated/reclaimable memory (§3), and this was not tested by actually
  closing anything (out of scope, per the task's own rules).

**Inconclusive:**
- Whether this host's general memory profile (independent of the 9 now-gone
  disposable test processes) materially contributed to Task 77.3's
  deterministic Scenario B/D/G/H/I browser failures — this task did not
  re-run those scenarios and cannot speak to causation, only to the current
  state of the host.

**Refuted:**
- That the system is "currently under sustained memory pressure" or "actively
  paging" in the sense of ongoing, worsening resource exhaustion right now
  (§8–§9) — the zero pageout/swapout deltas and stable 85%-free metric
  directly contradict that specific claim, independent of the elevated swap
  percentage.

**Blocked:** none — every measurement attempted in this task's scope produced
a usable result.

## 14. Outstanding unknowns

- Whether Task 77.3's historically-cited "150+ matching processes" figure
  (already found unreproducible by Task 77.4, §10.2 of that report) might
  have included a large transient Chrome-tab-driven process count coincident
  with ordinary browser usage, rather than Playwright/test-specific processes
  — this task adds one more data point (Chrome alone can carry ~70 processes
  under completely ordinary, present-day use) consistent with that
  possibility, but cannot confirm it retroactively.
- Whether closing a meaningful number of Chrome tabs would move the dynamic
  indicators (pageouts/swapouts) that are currently flat — not tested, as
  closing anything was out of this task's scope.
- Whether the `appslow-selfhost-commercial-gotrue-1` crash loop predates this
  entire test chain or was somehow triggered by it — not investigated;
  flagged only as an observation, consistent with this task's instruction not
  to assume ownership/causation without evidence and not to go beyond its
  own scope.
- Long-term trend beyond the 105-second window observed here — two snapshots
  this close together establish the *current* trajectory is flat, not a
  multi-hour trend; this task did not attempt a longer observation (the
  spec's suggested window was 60–120 seconds, which was honored, not
  exceeded without reason).

## 15. Final recommendation

**The Mac is not under acute, worsening memory pressure right now** —
despite an elevated and historically-consistent swap-used percentage, every
other, more direct indicator (kernel pressure level, Apple's own
free-memory metric, and zero growth in pageouts/swapouts across a genuine
105-second observation window) shows a settled, non-deteriorating system.
**Final readiness classification: READY WITH CAUTION** — the host is stable
enough that a controlled, single-scenario, single-worker experiment (as Task
77.4 itself recommended) would not obviously be invalidated by acute,
worsening host pressure, but the elevated swap baseline itself has not
resolved and should not be assumed irrelevant either.

If the user wants to reduce the swap baseline before any further attempt
(not required by this task's own evidence, but offered as the single most
likely lever): close unused Google Chrome tabs first (§10, priority 1) — it
is the largest, lowest-risk, most clearly test-chain-unrelated candidate
found. VSCode, Claude Code, OrbStack/Docker, and the Playwright extension
service should all remain untouched, per this task's explicit rules and
because none of them were found to be material contributors in the first
place.

**No process or application was started, stopped, suspended, or modified by
this task.** No file other than this report was created or changed. No
Playwright test was run. No status for Task 77.2, 77.3, 77.4, or 77.4.1 was
upgraded or otherwise changed — none of that was this task's call.
