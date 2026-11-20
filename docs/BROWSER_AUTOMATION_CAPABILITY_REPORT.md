# Browser Automation Capability Report

Investigation date: 2026-11-05. Read-only check of whether real browser automation is available in this dev environment, following up on Task 49C (which found no `mcp__claude-in-chrome__*` or built-in browser-pane tools and stopped rather than fake-verify).

## 1. Installed packages

- **AppFlowy-Independent-Backend/package.json**: `@playwright/test` `^1.64.1` (devDependency). `node_modules/playwright`, `node_modules/playwright-core`, `node_modules/@playwright` all present. `npx playwright --version` → `Version 1.64.1`.
- **AppFlowy-Web/package.json**: `@playwright/test` `^1.58.2`, plus `playwright-bdd` `8.5.1`. `node_modules/playwright`, `node_modules/playwright-core`, `node_modules/playwright-bdd`, `node_modules/@playwright` present. `npx playwright --version` → `Version 1.58.2`.
- Puppeteer: not found in either repo's `node_modules` or `package.json`.
- This confirms Task 42's earlier dependency-check finding that `@playwright/test` is present in `node_modules`.

AppFlowy-Web has an extensive existing Playwright E2E test suite (hundreds of `.spec.ts` files under `playwright/e2e/`, support helpers under `playwright/support/`, several `playwright.*.config.ts` configs, and npm scripts `test:e2e`, `test:e2e:headed`, `test:e2e:ui`, `test:e2e:debug`, etc.). AppFlowy-Independent-Backend also has its own smaller Playwright test suite under `test/` (`LoginScreen.ts`, `SpaceScreen.ts`, `PageScreen.ts`, `AuthScreen.ts`, `workspace.spec.ts`, `login.spec.ts`) plus `run-e2e-tests.sh`.

## 2. Browser binaries

- `~/Library/Caches/ms-playwright` exists and contains: `chromium-1134`, `chromium-1248`, `chromium_headless_shell-1248`, `ffmpeg-1013`. Playwright-managed Chromium is already downloaded and ready to use.
- System Chrome: `/Applications/Google Chrome.app` is installed (also currently running as a user process — left untouched, not interfered with).
- `chromium`, `google-chrome`, `chromium-browser` CLI binaries: not found on PATH (`which` returned nothing) — this is expected/normal since Playwright uses its own bundled Chromium rather than a system binary.

## 3. Real disposable browser launch — SUCCESS

Ran a minimal disposable script (kept outside both repos, in the session scratchpad only — never committed) that:
1. Launched Chromium via `playwright` (resolved against AppFlowy-Independent-Backend's `node_modules`, no install/modification needed).
2. Opened a local disposable test HTML page (`file://.../browser_test.html`) containing a heading, a button, and a result `div` — not the AppFlowy app itself.
3. Read `page.title()` and `page.textContent('#heading')`.
4. Clicked the test button.
5. Re-read the DOM to confirm the click updated it.
6. Captured a screenshot.
7. Captured a `console.log` fired by the button's onclick handler.
8. Closed the browser cleanly.

Output:
```
TITLE: Browser Automation Test Page
HEADING: Hello Test
RESULT_AFTER_CLICK: clicked
CONSOLE_MESSAGES: ["[log] button was clicked"]
SCREENSHOT_PATH: /private/tmp/.../scratchpad/browser_test_screenshot.png
```
No errors at any step. DOM read before/after click proves real interaction (`not clicked` → `clicked`), and the console message was captured via Playwright's `page.on('console', ...)` listener, confirming console-log access works too. Screenshot file was written successfully to the scratchpad (not committed to either repo).

This demonstrates that genuine, non-Claude-tool browser automation — launch, navigate, read DOM, click, screenshot, read console, close — works today in this environment with zero new installs.

## 4. Existing Chrome processes

`ps aux | grep -i chrome` showed an already-running `/Applications/Google Chrome.app` (plus helper/renderer processes) — this process was only inspected, never touched, killed, or driven in this investigation.

## 5. MCP configuration findings

- No `.vscode/mcp.json` was found anywhere under `/Volumes/work disk/Codes/Tracker` (only `AppFlowy-Web/.vscode/settings.json` exists, and it contains no MCP server entries — just TypeScript/ESLint/formatting settings).
- No project-level `.mcp.json` exists in either repo.
- `~/.claude.json` and `~/.claude/settings.json` exist but no project-scoped MCP servers for Playwright or Chrome DevTools are configured there for this workspace.
- Confirmed (per Task 49C) that `mcp__claude-in-chrome__*` and `mcp__Claude_Browser__*` / `mcp__remote-devices__Claude_Browser__*` tools are not present in this session.
- In principle, an official **Playwright MCP server** (`@playwright/mcp` / `@executeautomation/playwright-mcp-server`-style packages) or a **Chrome DevTools MCP server** could be added via `.vscode/mcp.json` or a project `.mcp.json`, pointing at the already-installed `playwright` package / Chromium binaries. No such config change was made — this is a reporting-only observation per the task's constraints.

## 6. Recommendation

**Playwright is already installed in both repos and launches a real, working disposable Chromium browser successfully — no new setup is required.** The minimum viable path to real browser verification of AppFlowy-Web going forward:

1. Use the existing `@playwright/test` installation in `AppFlowy-Web/node_modules` directly (no global install, no dependency changes needed).
2. Start the AppFlowy-Web dev server as usual, then write a scoped Playwright script/spec (ideally reusing existing helpers under `AppFlowy-Web/playwright/support/`) that navigates to the running dev server, performs the specific interaction to verify, and asserts on the real DOM — the same pattern proven working in Check 2 above, just pointed at the real app instead of a scratch HTML page.
3. Optionally, for a more "Claude-native" workflow, a Playwright MCP server could be added to `.vscode/mcp.json` in a future task (with user approval) so Claude can drive the already-installed Playwright/Chromium directly via MCP tools instead of ad hoc Node scripts — but this is optional; the ad hoc script approach already works today with zero config changes.

No blockers were found. The next task (a 49C re-run) can proceed straight to writing a real Playwright verification script against the running AppFlowy-Web dev server.
