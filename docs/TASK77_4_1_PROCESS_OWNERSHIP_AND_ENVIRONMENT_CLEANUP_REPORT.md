# Task 77.4.1 — Playwright Process Ownership Verification and Safe Test-Environment Cleanup

Executed: 2026-11-11, ~22:24 IST. No Playwright test run, no Chromium/Vite/backend
launched, no application or test-infrastructure file modified.

## 1. Executive summary

All 9 historical disposable test processes identified by Task 77.4 were
revalidated fresh (not trusted from the prior report), confirmed identical on
command line + PPID + start time + listening port, gracefully terminated one
at a time via `SIGTERM`, and verified both exited and released their ports.
**No escalation to `SIGKILL` was needed — all 9 exited within 1 second each.**

The 10th process (Playwright `test-server`, PID 6511) was investigated via
read-only process-ancestry and VSCode-extension-manifest inspection and
**classified as Confirmed VSCode-managed Playwright background service** — it
is a sibling of other canonical per-extension helper processes (TypeScript
server, Pylance, Gradle server, JSON server) under the same generic VSCode
extension-host utility process, not a child of any shell/CLI invocation, and
the installed `ms-playwright.playwright` extension's own activation event
(`workspaceContains:**/*playwright*.config.{ts,js,mjs}`) and source
(`out/extension.js` directly references `test-server`) fully explain its
existence. **It was left running, untouched, as required.**

Port `8787` (normal dev backend) was free before and after. Repository
integrity confirmed unchanged. Swap pressure did **not** meaningfully improve
— see §9; the environment is **not** materially more stable for a future
Scenario B/I attempt based on the actual numbers, despite the process cleanup.

## 2. Initial process snapshot

| Metric | Before |
|---|---|
| Total processes (`ps aux \| wc -l`) | 614 |
| Swap usage (`sysctl vm.swapusage`) | used 10565.44M / total 12288.00M = **85.98%** |
| Port 8787 | FREE |
| 9 historical PIDs | all present, matching Task 77.4's record |
| 10th process (PID 6511) | present |

## 3. Revalidation of all nine historical processes

Each PID was independently re-checked (not assumed from Task 77.4's table):
current existence, full command line, PPID, exact start time, and listening
port.

| PID | Current command | Start time | PPID | Listening port | Ownership |
|---|---|---|---|---|---|
| 97325 | `node server.js` | Wed Nov 11 13:41:54 2026 | 1 | 127.0.0.1:19098 | **Confirmed same disposable test process** |
| 97329 | `node .../vite.js --port 14006 --strictPort` | 13:41:55 | 1 | *:14006 | Confirmed |
| 11764 | `node .../vite.js --port 14355 --strictPort` | 14:42:25 | 1 | *:14355 | Confirmed |
| 13713 | `node .../vite.js --port 14087 --strictPort` | 14:52:13 | 1 | *:14087 | Confirmed |
| 13811 | `node server.js` | 14:52:35 | 1 | 127.0.0.1:19441 | Confirmed |
| 15220 | `node server.js` | 14:59:34 | 1 | 127.0.0.1:19057 | Confirmed |
| 15224 | `node .../vite.js --port 14024 --strictPort` | 14:59:35 | 1 | *:14024 | Confirmed |
| 17228 | `node .../vite.js --port 14148 --strictPort` | 15:09:24 | 1 | *:14148 | Confirmed |
| 17352 | `node server.js` | 15:09:46 | 1 | 127.0.0.1:19069 | Confirmed |

Every one of the 9 matched on all four criteria (command line, PPID, exact
start second, listening port) against Task 77.4's record taken ~7 minutes
earlier. No PID had exited, none was reused by an unrelated process. **All 9
are eligible for cleanup under §2's rule.**

## 4. Per-process termination and verification results

Each process was sent `SIGTERM` individually (never a broad `killall`/`pkill`),
with a per-process wait loop checking for exit every second up to 10 seconds.

| PID | Port | Termination attempted | Exit time | Termination successful | Port released |
|---|---|---|---|---|---|
| 97325 | 19098 | SIGTERM | 1s | ✓ | ✓ FREE |
| 97329 | 14006 | SIGTERM | 1s | ✓ | ✓ FREE |
| 11764 | 14355 | SIGTERM | 1s | ✓ | ✓ FREE |
| 13713 | 14087 | SIGTERM | 1s | ✓ | ✓ FREE |
| 13811 | 19441 | SIGTERM | 1s | ✓ | ✓ FREE |
| 15220 | 19057 | SIGTERM | 1s | ✓ | ✓ FREE |
| 15224 | 14024 | SIGTERM | 1s | ✓ | ✓ FREE |
| 17228 | 14148 | SIGTERM | 1s | ✓ | ✓ FREE |
| 17352 | 19069 | SIGTERM | 1s | ✓ | ✓ FREE |

**9/9 confirmed, 9/9 terminated, 9/9 ports released. Zero escalations to
SIGKILL required; zero processes needed user approval for further action.**

## 5. VSCode Playwright process ownership investigation

### 5.1 Current identity (re-identified, not assumed from Task 77.4)

```
PID 6511 (unchanged from Task 77.4's identification):
  /opt/homebrew/bin/node AppFlowy-Independent-Backend/node_modules/@playwright/test/cli.js
    test-server -c AppFlowy-Independent-Backend/playwright.config.ts --host 127.0.0.1
  ppid: 961
  start: Wed Nov 11 22:02:13 2026 (unchanged)
  cwd: /Volumes/work disk/Codes/Tracker
  listening: 127.0.0.1:53319 (LISTEN) + one ESTABLISHED connection 53319<->53320
```

Note: its listening socket (53319) is **not** any of the 9 disposable
backend/Vite ports (14xxx/19xxx) — it is an unrelated ephemeral port used for
its own IPC with a client, consistent with a persistent background service
rather than a disposable test-environment component.

### 5.2 Process ancestry

```
PID 6511  ppid 961  -- the Playwright test-server
PID  961  ppid 696  -- "Code Helper (Plugin)" (generic VSCode extension-host utility process)
PID  696  ppid   1  -- /Applications/Visual Studio Code.app/.../MacOS/Code
```

PID 961 hosts multiple sibling extension-background-service processes
alongside PID 6511, all with identical `ppid 961`:

- `markdown-language-features/dist/serverWorkerMain` (built-in VSCode extension)
- `ms-python.vscode-python-envs/.../pet server`
- `openai.chatgpt/.../codex app-server`
- `anthropic.claude-code/.../claude` (this very session's own CLI process)
- `vscjava.vscode-gradle/.../gradle-server.jar`
- `json-language-features/server/dist/node/jsonServerMain`
- `ms-python.vscode-pylance/dist/server.bundle.js`
- two `typescript/lib/tsserver.js` instances

This is the generic "one utility-type Code Helper process hosts N extensions'
background servers as direct children" pattern VSCode uses — **PID 6511 sits
in exactly the same structural position as TypeScript's `tsserver`,
Pylance's language server, and Gradle's server**, none of which are
CLI/terminal-launched. No command in this ancestry originates from a shell
prompt, `npx`, or `npm run`.

### 5.3 Extension-manifest confirmation

```
~/.vscode/extensions/ms-playwright.playwright-1.1.19/package.json:
  "displayName": "Playwright Test for VSCode"
  "activationEvents": ["workspaceContains:**/*playwright*.config.{ts,js,mjs}"]

grep -rl "test-server" ~/.vscode/extensions/ms-playwright.playwright-1.1.19/
  → out/extension.js
```

The extension **is installed**, its activation trigger is a workspace
containing a `playwright*.config.{ts,js,mjs}` file — which
`AppFlowy-Independent-Backend/playwright.config.ts` satisfies exactly — and
its own bundled `extension.js` directly references spawning a `test-server`.
This fully and specifically explains PID 6511's existence; it is not a
generic inference from the parent's name alone.

### 5.4 Classification

**Confirmed VSCode-managed Playwright background service.** (Not merely
"strongly supported" — the extension manifest, activation trigger, and
sibling-process structural pattern together constitute direct, specific
evidence, not just a plausible inference from the parent process's generic
name.)

This process is expected to remain active for as long as this VSCode window
has the backend repository open with its Playwright config present and the
Playwright Test extension enabled — it is unrelated to any of Tasks 77.1–77.4's
CLI-driven test runs and was not created or leaked by any of them.

## 6. Whether the tenth process was left untouched

**Yes — confirmed untouched.** PID 6511 was neither sent a signal nor
restarted nor queried in any way beyond standard read-only `ps`/`lsof`
inspection. Verified still running, unchanged PID, immediately after the 9
terminations (§5.1).

## 7. Development-port verification

| Port | Before | After |
|---|---|---|
| 8787 (normal dev backend) | FREE | FREE |
| 19098, 14006, 14355, 14087, 19441, 19057, 14024, 14148, 19069 (the 9 historical) | all LISTENING | all **FREE** |
| 53319 (PID 6511's own) | LISTENING | still LISTENING (untouched, expected) |

No unexpected backend or Vite process appeared during this task. The VSCode
Playwright process remains running as required.

## 8. Before-and-after process counts

| Metric | Before | After |
|---|---|---|
| Total processes (`ps aux \| wc -l`) | 614 | 608 |
| Test-related processes (`node server.js` / `vite.js` / `playwright`) | 10 (9 disposable + PID 6511) | 1 (PID 6511 only) |

## 9. Before-and-after swap measurements

| Metric | Before | After |
|---|---|---|
| `vm.swapusage` total | 12288.00M | 11264.00M |
| `vm.swapusage` used | 10565.44M | 10357.31M |
| **Used %** | **85.98%** | **91.94%** |

**The swap percentage did not improve — it is marginally higher after
cleanup than before.** The absolute used figure dropped by ~208MB, but
macOS's swap file also shrank (dynamic sizing) from 12288M to 11264M total,
so the *percentage* used actually rose. This is consistent with Task 77.4's
own caution: the 9 disposable processes were long-lived but individually
low-memory Node/Vite instances, and their exit does not materially relieve
whatever is actually driving this host's swap pressure (614→608 total
processes is a 1% drop). **No claim of improved memory-pressure stability is
made** — the opposite caution applies: do not assume the environment is now
low-pressure merely because 9 processes exited.

## 10. Repository integrity verification

| Item | Expected | Verified |
|---|---|---|
| Frontend `git status --short` entry count | 33 | **33** (unchanged) |
| Backend `server.js` md5 | `f46509f6e92a258cf8277a8614af62c9` | **matches exactly** |
| `AppFlowy-Web/.env.local` md5 | `c85de40fc13dc3b2379325c6ecc3471d` | **matches exactly** |
| Files modified by this task | none expected | only this report file was created; nothing else written |

No repository changes were discarded; no application or test file was
touched.

## 11. Blocked or uncertain findings

None. Every check in this task's scope produced a definite result:

- All 9 historical PIDs: definitively confirmed, not uncertain.
- PID 6511: definitively classified as a VSCode-managed service (§5.4),
  not left as "ownership uncertain" — the evidence (extension manifest +
  activation trigger + sibling-process pattern) was conclusive.
- No PID required SIGKILL escalation or user approval.
- No port, process count, swap, or checksum measurement was unavailable.

## 12. Readiness assessment for the next experiment

**Not ready, on the actual numbers.** Swap usage is 91.94% after cleanup
(up from 85.98% before), i.e. materially *higher*, not lower, than the
88.6% reference point Task 77.4 observed and explicitly warned against
treating as a safe threshold. The 9-process cleanup accomplished its stated
goal (environment hygiene, ports released, ownership established) but did
**not** produce the "materially lower swap pressure" precondition Task 77.4's
recommended next experiment (re-running Scenario B and Scenario I alone,
isolated, with tracing off) called for.

**Recommendation:** do not proceed to that experiment yet. Swap pressure on
this host is apparently driven by something other than these 9 disposable
test processes — closing unrelated heavy applications (browsers, IDEs,
other large processes unrelated to this test chain) and re-measuring
`sysctl vm.swapusage` before the next attempt would be a more direct
precondition check than this cleanup alone could satisfy.

## Final response summary

- **9 of 9** historical processes were confirmed identical to Task 77.4's
  record (command line + PPID + start time + port, all matching).
- **9 of 9** were successfully terminated via `SIGTERM` (all exited within
  1 second) and had their ports verified released. **Zero** required
  `SIGKILL` escalation or further approval.
- The 10th process (PID 6511) was determined, with high confidence (direct
  evidence: extension manifest, activation trigger, sibling-process
  ancestry), to be **VSCode's own Playwright Test extension background
  service** — not a leak from any task in this chain. **It remains running,
  untouched**, exactly as required.
- Port **8787 remained free** throughout.
- Swap usage: **85.98% → 91.94%** (higher, not lower) after cleanup; total
  process count 614 → 608.
- **No files or configuration were changed** beyond creating this one
  report; `server.js` and `.env.local` checksums confirmed unchanged;
  frontend `git status` unchanged at 33 entries.
- **The machine is not demonstrated to be sufficiently stable for the next
  Scenario B/I experiment** — the swap figure moved in the wrong direction,
  so Task 77.4's own precondition (materially lower swap than 88.6%) is not
  met. No Scenario B or Scenario I test was run. No Task 77.2, 77.3, or 77.4
  status was upgraded.
