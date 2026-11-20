# Task 70 environment hygiene notes

- Each Playwright `test.describe` block (task66/task67/task68) uses
  `startTestEnvironment`/`stopTestEnvironment` (test/helpers/test-environment.ts):
  random free port pair per run, disposable temp-dir JSON data file, and a
  byte-for-byte MD5-verified backup/restore of `AppFlowy-Web/.env.local`.
  `stopTestEnvironment`'s `envRestored` check is asserted in every `afterAll`.
- Final `.env.local` MD5 after all runs: `c85de40fc13dc3b2379325c6ecc3471d`
  (matches the pre-task baseline captured in Stage 1).
- `ps aux` after all work confirms no leftover `node server.js`, `vite --port`,
  or Chromium/chrome-headless-shell processes, and no process listening on
  any port used by this task's disposable environments.
- One real leak was found and fixed during this task, not swept under the rug:
  an ad hoc re-run of the EXISTING `docs/task67-evidence/task67-browser-verify.mjs`
  script (used only as a diagnostic to understand a historical click-helper
  flake, not a Task 70 deliverable) threw before reaching its own
  `await browser.close()`, leaving 5 headless Chromium processes (pids
  32062-32066) running for the remainder of this session. Identified via
  `ps aux` during the environment-hygiene pass and killed explicitly; its
  `/tmp/t67rerun` scratch directory was also removed. No port was left
  listening as a result (that script's own disposable backend/frontend were
  not leaked, only the browser).
- A stray empty `playwright_a1.stderr` file (from an intermediate diagnostic
  `--reporter=json 2>playwright_a1.stderr` redirect) was found in the backend
  repo root and removed.
- `AppFlowy-Web` git status (`git status --short`) is byte-identical before
  and after this task (23 pre-existing lines, same files) -- no product
  source file was touched. `AppFlowy-Independent-Backend` has no `.git`
  (tracked informally); only files under `test/helpers/`, `test/e2e/`, and
  `docs/` were added or changed, listed in the main report's "Files changed"
  section.
