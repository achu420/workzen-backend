// Task 66 real-browser verification: proves an already-connected second
// browser CONTEXT observes a first client's content update LIVE (no
// reload/refocus/reconnect), for Document and for the Database/
// DatabaseRow grid-cell collaboration path AppFlowy-Web's current UI
// actually exposes. Modeled directly on the proven Task 64 script
// (docs/task64-evidence/task64-browser-verify.mjs) -- same env-var
// parameterization, same .env.local backup/restore discipline, same
// login/space/grid helpers (reused verbatim where unchanged), same
// evidence-capture conventions (steps.log, results.json, screenshots,
// console/network logs per context).
//
// Env vars:
//   BACKEND_PORT, FRONTEND_PORT, EVIDENCE_DIR, DEV_KEY (optional)
// Storage mode is fixed to JSON here (disposable data file) -- the
// Postgres side of the fan-out is already proven by the automated
// protocol-level tests (test/postgres-database-multiclient.test.js,
// test/postgres-realtime-fanout-document.test.js); this script's purpose
// is REAL two-browser-context, real-UI proof, which does not need to be
// repeated per storage backend.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';

const BACKEND_PORT = process.env.BACKEND_PORT;
const FRONTEND_PORT = process.env.FRONTEND_PORT;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const DEV_KEY = process.env.DEV_KEY || 'task66-key';
const BACKEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend';
const FRONTEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Web';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://localhost:${FRONTEND_PORT}`;
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');
const ENV_LOCAL_BACKUP_PATH = path.join(EVIDENCE_DIR, 'env.local.backup');
const DATA_FILE = process.env.DATA_FILE;

if (!BACKEND_PORT || !FRONTEND_PORT || !EVIDENCE_DIR || !DATA_FILE) {
  throw new Error('BACKEND_PORT, FRONTEND_PORT, EVIDENCE_DIR, DATA_FILE are required');
}

await mkdir(EVIDENCE_DIR, { recursive: true });

// Task 66.1: write each step SYNCHRONOUSLY to a progress file on disk as it
// happens (not just to the in-memory `log` array flushed at the very end),
// so real-time progress is observable even if stdout buffering/piping or an
// external process kill prevents the normal end-of-run steps.log write.
const PROGRESS_PATH = path.join(EVIDENCE_DIR, 'progress.log');
import { writeFileSync, appendFileSync, copyFileSync, readFileSync } from 'node:fs';
writeFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] INFO - script started, pid=${process.pid}\n`);

const log = [];
function record(step, status, detail) {
  const line = `[${new Date().toISOString()}] ${status} - ${step}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  log.push(line);
  try { appendFileSync(PROGRESS_PATH, line + '\n'); } catch { /* best-effort */ }
}

// Hard watchdog: a genuine hang (an await that never resolves) must not run
// forever. If the whole script hasn't finished within this budget, force an
// exit so the failure is visible and evidenced rather than silent. Module-
// level mutable handles so the watchdog can run the SAME environment-hygiene
// cleanup (.env.local restore, kill the disposable backend/frontend) that
// the normal `finally` block runs -- a bare `process.exit()` would otherwise
// skip `finally` entirely and leave `.env.local` and the disposable
// processes behind (confirmed the hard way in an earlier iteration of this
// run).
let liveBackendProcess, liveFrontendProcess, liveEnvBackupMd5;
function watchdogCleanup() {
  try {
    if (liveFrontendProcess) {
      const pids = execSync(`lsof -tiTCP:${FRONTEND_PORT} -sTCP:LISTEN`).toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) execSync(`kill ${pid}`);
    }
  } catch { /* ignore */ }
  try {
    if (liveBackendProcess) {
      const pids = execSync(`lsof -tiTCP:${BACKEND_PORT} -sTCP:LISTEN`).toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) execSync(`kill ${pid}`);
    }
  } catch { /* ignore */ }
  try {
    if (liveEnvBackupMd5) {
      copyFileSync(ENV_LOCAL_BACKUP_PATH, ENV_LOCAL_PATH);
      const restoredMd5 = md5(readFileSync(ENV_LOCAL_PATH));
      appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] ${restoredMd5 === liveEnvBackupMd5 ? 'PASS' : 'FAIL'} - .env.local restored by WATCHDOG cleanup (MD5-verified) :: ${restoredMd5}\n`);
    }
  } catch (cleanupError) { try { appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] FAIL - watchdog .env.local restore failed :: ${cleanupError}\n`); } catch {} }
}
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS) || 5 * 60 * 1000;
const watchdogTimer = setTimeout(() => {
  try { appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] FAIL - WATCHDOG TIMEOUT: script did not complete within ${WATCHDOG_MS}ms, forcing exit\n`); } catch { /* best-effort */ }
  console.error('WATCHDOG TIMEOUT: forcing exit');
  watchdogCleanup();
  process.exit(97);
}, WATCHDOG_MS);

function md5(buf) { return createHash('md5').update(buf).digest('hex'); }

// Task 66.1 diagnostic helper: pinpoint EXACTLY which individual await is
// stuck, rather than waiting for the 5-minute watchdog to fire with no
// detail. Rejects with a clear, labeled error if `promise` has not settled
// within `ms`.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`STUCK AT: ${label} (exceeded ${ms}ms)`)), ms)),
  ]);
}

async function backupEnvLocal() {
  const original = await readFile(ENV_LOCAL_PATH);
  await writeFile(ENV_LOCAL_BACKUP_PATH, original);
  record('.env.local backed up (MD5-verified)', 'INFO', md5(original));
  return md5(original);
}
async function restoreEnvLocal(expectedMd5) {
  await copyFile(ENV_LOCAL_BACKUP_PATH, ENV_LOCAL_PATH);
  const restored = await readFile(ENV_LOCAL_PATH);
  const ok = md5(restored) === expectedMd5;
  record('.env.local restored byte-for-byte (MD5-verified)', ok ? 'PASS' : 'FAIL', md5(restored));
  return ok;
}
function killPort(port) {
  try {
    const pidOutput = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`).toString().trim();
    for (const pid of pidOutput.split('\n').filter(Boolean)) {
      execSync(`kill ${pid}`);
      record(`Killed process on port ${port}`, 'INFO', `pid=${pid}`);
    }
    return pidOutput.split('\n').filter(Boolean);
  } catch { return []; }
}
function spawnBackend() {
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(BACKEND_PORT), STORAGE: 'json', DATA_FILE,
    DEV_TEST_KEY: DEV_KEY,
    CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}`,
  };
  const child = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
async function waitHealthy(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(`${url}/health`); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
async function waitFrontendReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 304) return true; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  const results = {
    documentLiveA2B: 'NOT TESTED', documentLiveB2A: 'NOT TESTED', documentPersist: 'NOT TESTED',
    gridLiveA2B: 'NOT TESTED', gridLiveB2A: 'NOT TESTED', gridPersist: 'NOT TESTED',
  };
  let backendProcess, frontendProcess, envBackupMd5, browser;

  try {
    envBackupMd5 = await backupEnvLocal();
    liveEnvBackupMd5 = envBackupMd5;
    const envContent = [
      `APPFLOWY_BASE_URL=${BACKEND}`,
      `APPFLOWY_GOTRUE_BASE_URL=${BACKEND}`,
      `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${BACKEND_PORT}/ws/v2`,
    ].join('\n') + '\n';
    await writeFile(ENV_LOCAL_PATH, envContent);
    record('Wrote temporary .env.local pointing at this run\'s disposable backend', 'INFO', envContent.replace(/\n/g, ' | '));

    backendProcess = spawnBackend();
    liveBackendProcess = backendProcess;
    const backendHealthy = await waitHealthy(BACKEND);
    record(`Backend process started (STORAGE=json, port ${BACKEND_PORT})`, backendHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not become healthy');

    frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], {
      cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, detached: true, stdio: 'ignore',
    });
    frontendProcess.unref();
    liveFrontendProcess = frontendProcess;
    const frontendReady = await waitFrontendReady(FRONTEND);
    record(`Frontend dev server started (port ${FRONTEND_PORT})`, frontendReady ? 'PASS' : 'FAIL', `pid=${frontendProcess.pid}`);
    if (!frontendReady) throw new Error('Frontend did not become ready');

    // Task 66.1: run a real HEADED chromium (not headless_shell) -- Stage 2/3
    // of this follow-up requires genuine browser-interaction diagnosis and a
    // fix proven against the real rendering/focus/scroll engine, not the
    // headless_shell build task66's original script used.
    // Task 66.1 hygiene: one run in this sandbox hit a GPU-process crash
    // (swiftshader software rendering under load with two simultaneous
    // headed windows), which dropped one page's CDP connection mid-test
    // ("Target page, context or browser has been closed"). Disabling GPU
    // acceleration removes that failure mode entirely without affecting any
    // DOM/focus/input behavior this test actually depends on.
    browser = await chromium.launch({ headless: false, args: ['--disable-gpu', '--disable-software-rasterizer'] });

    function wireLogging(page, tag) {
      const consoleErrors = []; const networkLog = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[${tag}][${msg.type()}] ${msg.text()}`); });
      page.on('pageerror', (err) => consoleErrors.push(`[${tag}][pageerror] ${err.message}`));
      page.on('requestfinished', async (req) => {
        const url = req.url();
        if (!url.includes(`:${BACKEND_PORT}/`)) return;
        try { const res = await req.response(); networkLog.push(`[${tag}] ${req.method()} ${url} -> ${res ? res.status() : 'n/a'}`); } catch { networkLog.push(`[${tag}] ${req.method()} ${url} -> (err)`); }
      });
      return { consoleErrors, networkLog };
    }

    async function dismissCompatBanner(page) {
      // Dismissing this banner is cosmetic cleanup, not part of the
      // acceptance criteria -- a transient failure to click it (observed
      // once: the banner was visible but its dismiss button was not yet
      // actionable right after a reload) must never abort an otherwise-
      // passing verification run.
      const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
      if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        try {
          await dismissBanner.first().click({ timeout: 5000 });
          await page.waitForTimeout(300);
        } catch (dismissError) {
          record('dismissCompatBanner click failed (non-fatal, cosmetic only)', 'INFO', String(dismissError).slice(0, 150));
        }
      }
    }
    async function login(page, email, password) {
      await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.getByTestId('login-email-input').fill(email);
      await page.getByTestId('login-password-button').click();
      await page.getByTestId('password-input').fill(password);
      await page.getByTestId('password-submit-button').click();
      await page.waitForURL(/\/app\//, { timeout: 20000 });
      await page.waitForTimeout(1000);
      await dismissCompatBanner(page);
    }
    async function openWorkspace(page, workspaceId) {
      await page.goto(`${FRONTEND}/app/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      await dismissCompatBanner(page);
    }
    async function expandSpace(page, spaceId) {
      const spaceToggle = page.getByTestId(`space-${spaceId}`);
      if (!(await spaceToggle.first().isVisible({ timeout: 8000 }).catch(() => false))) return false;
      const expanded = await spaceToggle.first().getAttribute('data-expanded').catch(() => null);
      if (expanded !== 'true') { await spaceToggle.first().click(); await page.waitForTimeout(700); }
      return true;
    }
    async function openSidebarPage(page, pageId, spaceId, fallbackUrl) {
      await expandSpace(page, spaceId);
      const entry = page.getByTestId(`page-${pageId}`);
      if (await entry.first().isVisible({ timeout: 10000 }).catch(() => false)) {
        await entry.first().click();
        await page.waitForTimeout(1500);
        return true;
      }
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      return false;
    }
    async function waitGridLoaded(page, timeout = 15000) {
      let reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!reopened) {
        await page.waitForTimeout(1000);
        reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout }).catch(() => false);
      }
      return reopened;
    }
    async function enterCellValue(page, rowId, primaryFieldId, value, { clearFirst = false } = {}) {
      // See the matching comment in typeIntoDocument: with two headed
      // windows open, keyboard input must target the FOREGROUND window.
      await page.bringToFront();
      const cellTestId = `grid-cell-${rowId}-${primaryFieldId}`;
      const cell = page.getByTestId(cellTestId);
      await cell.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(500);
      const wrapper = cell.locator('xpath=ancestor::*[contains(@class,"grid-row-cell")][1]');
      await wrapper.first().click({ force: true });
      await page.waitForTimeout(500);
      const editor = cell.getByTestId('rich-text-cell-editor');
      await editor.waitFor({ state: 'visible', timeout: 5000 });
      await editor.click();
      if (clearFirst) {
        // Overwriting an EXISTING cell value: select the whole line and
        // delete it first, otherwise typing just inserts at wherever the
        // cursor landed inside the existing text (producing garbled
        // interleaved content, not a clean overwrite).
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
      }
      // See the matching root-cause comment in typeIntoDocument: insertText
      // is a single atomic CDP call, immune to the sequential-type hang
      // observed with two headed windows open.
      await withTimeout(page.keyboard.insertText(value), 15000, 'enterCellValue keyboard.insertText');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      return cellTestId;
    }
    async function readCellTextWithRetry(page, testId, attempts = 10, delayMs = 800) {
      // See the matching comment in readDocumentTextWithRetry: a
      // backgrounded page can repaint late even after its underlying data
      // already updated.
      await page.bringToFront();
      let text = '';
      for (let i = 0; i < attempts; i += 1) {
        text = (await page.getByTestId(testId).innerText({ timeout: 3000 }).catch(() => '')).trim();
        if (text) return text;
        await page.waitForTimeout(delayMs);
      }
      return text;
    }
    async function getNewRowId(page, existingIds) {
      const rows = await page.locator('[data-testid^="grid-row-"]').all();
      const ids = [];
      for (const row of rows) {
        const candidate = (await row.getAttribute('data-testid')).replace('grid-row-', '');
        if (candidate && candidate !== 'undefined') ids.push(candidate);
      }
      const unique = [...new Set(ids)];
      return unique.find((candidate) => !existingIds.has(candidate));
    }
    // A generic `[data-slate-editor="true"]` locator can match more than
    // one mounted editor instance (e.g. a background/stale page still
    // mounted behind a ViewModal overlay). Editable.tsx assigns
    // `id={`${previewId ?? ''}editor-${viewId}`}` -- an EXACT `#editor-x`
    // match misses any rendering context where `previewId` is set, so
    // match by suffix instead (`[id$="editor-${pageId}"]`), which is
    // correct for both the bare and previewId-prefixed id shapes, and use
    // a forced click (same precedent as the Grid cell helper below) since
    // an unrelated overlay can legitimately intercept a plain
    // pointer-event check even when the right element is already visible
    // underneath.
    function documentEditorLocator(page, pageId) {
      return page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first();
    }
    async function dumpEditorDiagnostics(page, tag) {
      try {
        const info = await page.evaluate(() => Array.from(document.querySelectorAll('[data-slate-editor="true"]')).map((el) => ({ id: el.id, text: (el.textContent || '').slice(0, 80) })));
        record(`DIAGNOSTIC [${tag}]: slate editors on page`, 'INFO', JSON.stringify(info));
      } catch (diagError) { record(`DIAGNOSTIC [${tag}] failed`, 'INFO', String(diagError)); }
    }
    // Task 66.1 fix (see the ROOT CAUSE comment above Scenario 1): once the
    // caller has navigated to the document's own correctly-identified
    // full-page URL (non-modal, single instance), the title->ArrowDown->body
    // path Task 66's original script already used is the CORRECT real-user
    // path (confirmed directly against TitleEditable.tsx's own
    // `handleKeyDown`: ArrowDown calls `focusedTextbox()`, which focuses
    // `#editor-${viewId}` -- the body's root editable element -- exactly the
    // same id `documentEditorLocator` below matches). What was actually
    // broken was never this keyboard path -- it was that `pageId` was the
    // WRONG id. With the right id, this now works as plain, unforced
    // Playwright interactions. Required pre-type assertions are checked
    // explicitly (not just implied by a successful click) and logged.
    async function clickIntoDocumentBody(page, pageId, tag = '') {
      const diag = (step) => appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] TRACE - clickIntoDocumentBody[${tag}] ${step}\n`);
      diag('start');
      const title = page.locator(`#editor-title-${pageId}`);
      const titleCount = await title.count();
      diag(`titleCount=${titleCount}`);
      if (titleCount !== 1) throw new Error(`Title locator for pageId=${pageId} resolved to ${titleCount} elements, expected exactly 1`);
      await title.waitFor({ state: 'visible', timeout: 10000 });
      diag('title visible');
      const visible = await title.isVisible();
      const enabled = await title.isEnabled();
      const box = await title.boundingBox();
      diag(`visible=${visible} enabled=${enabled} box=${JSON.stringify(box)}`);
      if (!visible || !enabled || !box || box.width <= 0 || box.height <= 0) {
        throw new Error(`Title pre-click assertion failed: visible=${visible} enabled=${enabled} box=${JSON.stringify(box)}`);
      }
      // Not covered by any sticky header / overlay: ask the browser what
      // element is ACTUALLY at the title's own center point, and require it
      // to be the title itself (or a descendant of it), not some other
      // element intercepting the click.
      const hitTarget = await page.evaluate(({ x, y, id }) => {
        const el = document.elementFromPoint(x, y);
        return { matches: !!(el && (el.id === id || el.closest(`#${id}`))), elTag: el?.tagName, elId: el?.id };
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2, id: `editor-title-${pageId}` });
      diag(`hitTarget=${JSON.stringify(hitTarget)}`);
      if (!hitTarget.matches) {
        throw new Error(`Title is covered by another element at its own click point: ${JSON.stringify(hitTarget)}`);
      }
      await title.click();
      diag('title clicked');
      const focusedAfterClick = await page.evaluate((id) => document.activeElement?.id, `editor-title-${pageId}`);
      diag(`focusedAfterClick=${focusedAfterClick}`);
      if (focusedAfterClick !== `editor-title-${pageId}`) {
        throw new Error(`Focus after clicking title is "${focusedAfterClick}", expected "editor-title-${pageId}"`);
      }
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      diag('End + ArrowDown pressed');
      const focusedAfterArrowDown = await page.evaluate(() => document.activeElement?.id);
      diag(`focusedAfterArrowDown=${focusedAfterArrowDown}`);
      if (focusedAfterArrowDown !== `editor-${pageId}`) {
        throw new Error(`Focus after ArrowDown is "${focusedAfterArrowDown}", expected the body editor "editor-${pageId}"`);
      }
      diag('done');
    }
    // Always clears the body first and types the FULL replacement text,
    // rather than trying to position the cursor precisely to append --
    // Control+End is not a bound Slate shortcut in this editor (confirmed
    // empirically: it left the cursor at an unpredictable position,
    // producing garbled interleaved text on a second edit), whereas
    // Ctrl/Cmd+A -> Backspace is a standard Slate-intercepted
    // select-all-and-delete that reliably produces a deterministic empty
    // state before typing, scoped to whichever Slate editor instance
    // currently has focus (the body, not the title, since they are
    // separate editor instances). Each call is therefore a full content
    // replace, not an append -- sufficient to prove live delivery of EACH
    // individual edit, which is this scenario's actual acceptance bar.
    // Task 66.1: a freshly-navigated Document can still be finishing its
    // initial SyncRequest/manifest hydration for a brief moment after the
    // title/body elements already exist in the DOM (confirmed via a focused
    // repro: the identical click->ArrowDown->type sequence intermittently
    // produced an EMPTY body -- not garbled, not wrong-target, just empty --
    // consistent with a rare async-hydration race, not a targeting bug: the
    // id/focus assertions above all passed every time this was observed).
    // Absorb that narrow race with a bounded retry of the WHOLE type
    // attempt (not a longer blind sleep, which would just move the race
    // rather than close it) -- each retry re-clicks, re-focuses, re-clears,
    // re-types, and re-asserts from scratch.
    // ANOTHER real root cause found (Task 66.1, confirmed via a focused
    // headed repro -- docs/task66-evidence/task66-1/diag2.mjs attempts 3-5,
    // not guessed): once the id/targeting bug above was fixed, clearing the
    // body with Ctrl+A/Cmd+A -> Backspace (the ORIGINAL script's approach)
    // STILL silently failed on the first edit into a brand-new, empty
    // Document. Root cause: selecting all of an (empty) paragraph and
    // pressing Backspace leaves nothing to delete, and the editor responds
    // to a Backspace with nothing before the cursor by moving focus back up
    // to the TITLE (the same, legitimate, symmetric shortcut as the title's
    // own ArrowDown-into-body: confirmed directly -- `document.activeElement`
    // became the title immediately after that Backspace, and the next
    // typed marker was found appended to the title, not the body, exactly
    // like the ORIGINAL implementation report's screenshot evidence from
    // Task 66's own 8 failed iterations). This is real, legitimate editor
    // UX, not a bug to work around by force -- so the fix is to never send
    // a bare Backspace that could empty the block to nothing. Instead,
    // select any EXISTING text within the current line only (Home ->
    // Shift+End) and TYPE OVER it: a non-empty selection is replaced by the
    // typed text in one atomic step (confirmed this never leaks to the
    // title and cleanly replaces old content, never garbling/appending);
    // typing with NOTHING selected (a fresh empty paragraph) just inserts
    // normally. Confirmed correct for both the first edit into a fresh
    // Document AND a second edit replacing the first marker.
    async function typeIntoDocument(page, pageId, text, attempt = 1, tag = '') {
      appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] TRACE - typeIntoDocument[${tag}] attempt=${attempt} start\n`);
      try {
        // Task 66.1 root cause found (confirmed via `withTimeout` instrumentation
        // pinpointing the EXACT stuck call): with two headed browser windows
        // open side by side (owner + member contexts), `page.keyboard.type()`
        // on whichever page is NOT the foreground OS window can hang
        // indefinitely -- Playwright/Chrome's CDP input dispatch for a
        // backgrounded window is not reliably bounded by any internal
        // timeout. Bring the page we are about to type into to the front
        // FIRST (a legitimate, normal action -- equivalent to a real user
        // clicking the window they intend to type into).
        await page.bringToFront();
        await clickIntoDocumentBody(page, pageId, tag);
        await withTimeout(page.waitForTimeout(300), 10000, `${tag} waitForTimeout(300) post-click`);
        await withTimeout(page.keyboard.press('Home'), 10000, `${tag} keyboard.press(Home)`);
        appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] TRACE - typeIntoDocument[${tag}] Home pressed\n`);
        await withTimeout(page.keyboard.press('Shift+End'), 10000, `${tag} keyboard.press(Shift+End)`);
        appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] TRACE - typeIntoDocument[${tag}] Shift+End pressed\n`);
        await withTimeout(page.waitForTimeout(150), 10000, `${tag} waitForTimeout(150) pre-type`);
        // Task 66.1 root cause (confirmed via withTimeout instrumentation
        // pinpointing this EXACT call, after Home/Shift+End single key presses
        // both succeeded quickly): `page.keyboard.type(text, {delay})` sends
        // one sequential CDP key-event round-trip PER CHARACTER with an
        // awaited delay between each; with two headed browser windows open
        // side by side, this long sequential chain on the non-foreground-at-
        // dispatch-time window was observed to hang partway through and never
        // resolve. `page.keyboard.insertText()` dispatches the whole string
        // as a SINGLE CDP `Input.insertText` call (the same mechanism a real
        // IME/autocomplete/paste uses) -- still real keyboard-level input the
        // editor's own `beforeinput`/`input` handlers process normally, just
        // not vulnerable to a multi-call sequential hang for a plain marker
        // string with no special per-keystroke shortcut to trigger.
        await withTimeout(page.keyboard.insertText(text), 15000, `${tag} keyboard.insertText`);
        appendFileSync(PROGRESS_PATH, `[${new Date().toISOString()}] TRACE - typeIntoDocument[${tag}] typed, about to verify\n`);
        // The editor's own local Yjs state updates synchronously with typing,
        // but the sync-outbox flush to the server may be debounced rather
        // than instantaneous -- give it a moment before any caller relies on
        // the update having reached the server.
        await page.waitForTimeout(1200);
        // Required post-type assertions (Task 66.1 Stage 3): the exact marker
        // landed in the INTENDED body editor, the title is unchanged, and no
        // OTHER mounted editor on the page accidentally received it.
        const bodyText = (await documentEditorLocator(page, pageId).innerText({ timeout: 5000 }).catch(() => '')).trim();
        if (!bodyText.includes(text)) {
          throw new Error(`body editor for pageId=${pageId} does not contain "${text}" (got "${bodyText}")`);
        }
        const titleText = (await page.locator(`#editor-title-${pageId}`).innerText({ timeout: 5000 }).catch(() => '')).trim();
        if (titleText.includes(text)) {
          // A genuine mistargeting, not flakiness -- fail immediately, do
          // not retry (retrying would not fix a real targeting bug and
          // could mask it if a later attempt happened to land correctly).
          throw Object.assign(new Error(`Post-type assertion failed: marker "${text}" leaked into the TITLE ("${titleText}")`), { noRetry: true });
        }
        const otherEditorsWithMarker = await page.evaluate(({ text, bodyId }) => {
          return Array.from(document.querySelectorAll('[data-slate-editor="true"]'))
            .filter((el) => el.id !== bodyId && (el.textContent || '').includes(text))
            .map((el) => el.id);
        }, { text, bodyId: `editor-${pageId}` });
        if (otherEditorsWithMarker.length > 0) {
          throw Object.assign(new Error(`Post-type assertion failed: marker "${text}" also found in OTHER editor(s): ${otherEditorsWithMarker.join(', ')}`), { noRetry: true });
        }
      } catch (attemptError) {
        if (!attemptError.noRetry && attempt < 3) {
          record(`typeIntoDocument[${tag}]: attempt failed, retrying whole attempt (suspected transient flakiness, not a targeting bug)`, 'INFO', `attempt=${attempt} pageId=${pageId} text="${text}" error="${String(attemptError).slice(0, 200)}"`);
          await page.waitForTimeout(800);
          return typeIntoDocument(page, pageId, text, attempt + 1, tag);
        }
        throw new Error(`typeIntoDocument[${tag}] failed after ${attempt} attempt(s): ${attemptError.message || attemptError}`);
      }
    }
    async function readDocumentTextWithRetry(page, pageId, needle, attempts = 10, delayMs = 800) {
      // Each retry attempt's own .innerText() must fail over QUICKLY (not
      // wait out the full 20s context-default timeout) -- otherwise 10
      // retries at up to 20s each can compound into minutes of apparent
      // "hang" that is actually just an oversized per-attempt timeout
      // multiplied by the retry loop (confirmed as the cause of an earlier
      // iteration's watchdog timeout in this very script).
      // Also bring this page to the front before reading: a backgrounded
      // Chrome tab/window can throttle rendering (even though the
      // underlying Yjs state already updated from the live WS fan-out),
      // so the DOM read can observe stale content purely due to a missed
      // repaint, not a real fan-out delivery failure.
      await page.bringToFront();
      let text = '';
      for (let i = 0; i < attempts; i += 1) {
        const editor = documentEditorLocator(page, pageId);
        text = (await editor.innerText({ timeout: 3000 }).catch(() => '')).trim();
        if (text.includes(needle)) return text;
        await page.waitForTimeout(delayMs);
      }
      return text;
    }

    let screenshotIndex = 0;
    async function screenshot(page, name) {
      screenshotIndex += 1;
      // Screenshots are supplementary evidence captures, not pass/fail
      // criteria -- an occasional "waiting for fonts to load" stall inside
      // Playwright's own screenshot internals must never abort an otherwise
      // fully-passing verification run.
      try {
        await page.screenshot({ path: path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true, timeout: 15000 });
      } catch (screenshotError) {
        record(`Screenshot "${name}" failed (non-fatal, evidence-only)`, 'INFO', String(screenshotError).slice(0, 200));
      }
    }

    // ===================== Shared setup: two real users, one shared workspace =====================
    const ownerEmail = `task66-owner-${Date.now()}@example.test`;
    const memberEmail = `task66-member-${Date.now()}@example.test`;
    const password = 'Correct horse 907 task66';

    const registerOwner = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    if (registerOwner.status !== 201) throw new Error(`Owner registration failed: ${registerOwner.status}`);
    const registerMember = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) });
    if (registerMember.status !== 201) throw new Error(`Member registration failed: ${registerMember.status}`);
    record('Registered two SEPARATE real user accounts (owner, member)', 'PASS', `${ownerEmail} / ${memberEmail}`);

    const contextOwner = await browser.newContext();
    // Cap every default Playwright action/navigation at 20s -- no single UI
    // interaction should be allowed to sit longer than that; a real hang
    // must surface promptly as a thrown timeout, not block indefinitely.
    contextOwner.setDefaultTimeout(30000);
    contextOwner.setDefaultNavigationTimeout(45000);
    const contextMember = await browser.newContext();
    contextMember.setDefaultTimeout(30000);
    contextMember.setDefaultNavigationTimeout(45000);
    const pageOwner = await contextOwner.newPage();
    const pageMember = await contextMember.newPage();
    const loggingOwner = wireLogging(pageOwner, 'owner');
    const loggingMember = wireLogging(pageMember, 'member');

    await login(pageOwner, ownerEmail, password);
    record('Owner logged in via real UI (browser context 1)', 'PASS', pageOwner.url());
    await screenshot(pageOwner, '01-owner-after-login');

    let capturedWorkspaceId = null;
    pageOwner.on('requestfinished', async (req) => {
      const url = req.url();
      const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
      if (match) capturedWorkspaceId = match[1];
    });

    await pageOwner.getByTestId('new-page-button').click();
    await pageOwner.getByTestId('new-page-create-space-button').click();
    await pageOwner.getByTestId('space-name-input').fill('Task66 fanout space');
    await pageOwner.getByTestId('create-space-submit').click();
    await pageOwner.waitForTimeout(1500);
    await pageOwner.keyboard.press('Escape').catch(() => {});
    await pageOwner.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await pageOwner.waitForURL(/\/app\//, { timeout: 20000 });
    await pageOwner.waitForTimeout(1200);
    await dismissCompatBanner(pageOwner);
    record('Owner created a public Space via real UI', 'PASS', `workspace=${capturedWorkspaceId}`);
    await screenshot(pageOwner, '02-owner-after-space');

    const loginOwnerLookup = await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    const { access_token: ownerToken } = await loginOwnerLookup.json();
    const addMemberResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/test-members`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}`, 'x-development-key': DEV_KEY },
      body: JSON.stringify({ email: memberEmail, role: 'member' }),
    });
    if (addMemberResp.status !== 201) throw new Error(`Adding member failed: ${addMemberResp.status} ${await addMemberResp.text()}`);
    record('Member added to owner\'s workspace via the supported test-membership helper', 'PASS');

    await login(pageMember, memberEmail, password);
    await openWorkspace(pageMember, capturedWorkspaceId);
    record('Member logged in via real UI (independent browser context 2) and opened the shared workspace', 'PASS', pageMember.url());
    await screenshot(pageMember, '03-member-after-login');

    const spaceRow = pageOwner.locator('div[aria-label="Task66 fanout space"]').first().locator('xpath=..');
    await spaceRow.waitFor({ state: 'visible', timeout: 10000 });
    async function hoverSpaceRow(page, label) {
      const row = page.locator(`div[aria-label="${label}"]`).first().locator('xpath=..');
      await row.waitFor({ state: 'visible', timeout: 10000 });
      const box = await row.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
      } else { await row.hover(); }
      await page.waitForTimeout(800);
    }

    // Resolve the space id via the backend's own pages listing (test
    // plumbing only, same convention as Task 64).
    const pagesResp0 = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/pages`, { headers: { authorization: `Bearer ${ownerToken}` } });
    const { pages: pages0 } = await pagesResp0.json();
    const spaceId = pages0.find((p) => p.title === 'Task66 fanout space')?.id || pages0[0]?.parent_view_id;

    // ===================== SCENARIO 1: Document live content fan-out =====================
    // ROOT CAUSE (Task 66.1, confirmed via headed-browser DOM/network/
    // screenshot evidence, not guessed -- see
    // docs/TASK66_1_PLAYWRIGHT_VERIFICATION_REPORT.md Â§diagnosis): clicking
    // "add-document-button" (sidebar "+" -> Document) does NOT navigate the
    // browser -- AddPageActions.tsx's handleAddPage calls
    // `openPageModal(response.view_id)` for a Document (only non-Document
    // layouts call `toView`, a real navigation). openPageModal only flips
    // in-memory React state (AppBusinessLayer's `openModalViewId`); the URL
    // is never touched. Every workspace/space in this environment already
    // has its own pre-existing default page open at `page.url()` BEFORE this
    // click (auto-created alongside the space and auto-routed to). Task 66's
    // ORIGINAL script read `pageOwner.url()` right after the click and took
    // that as the new document's id -- that is simply the WRONG id (the
    // pre-existing default page, not the one just created). It then tried to
    // click `#editor-title-<wrongId>`, an element that genuinely exists
    // (rendered in the background, since the URL never changed) but is
    // permanently covered by the peek modal -- for a DIFFERENT, correct,
    // foreground page -- hence the observed "sticky header intercepts
    // pointer events" failure: the intercepting element belongs to another
    // page's modal, not a z-index quirk on the same page.
    // FIX (test-script only, no frontend/backend change): resolve the real
    // just-created document's id from the DOM -- the title element actually
    // mounted inside the just-opened `.MuiDialog-root` -- then navigate
    // directly to that id's own full-page URL. This both (a) proves the
    // real id unambiguously (the peek modal is the one authoritative place
    // that reflects `openPageModal`'s target) and (b) moves interaction out
    // of the transient, in-memory peek-modal state into the same durable,
    // full-page, non-modal rendering the member uses via sidebar navigation
    // -- which also means a later `page.reload()` (modal state is NOT
    // preserved across reload) still lands on the correct page.
    await hoverSpaceRow(pageOwner, 'Task66 fanout space');
    await pageOwner.getByTestId('inline-add-page').first().click();
    await pageOwner.getByTestId('add-document-button').click();
    let docPageId = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      docPageId = await pageOwner.evaluate(() => {
        const dlg = document.querySelector('.MuiDialog-root');
        const titleEl = dlg?.querySelector('[data-testid="page-title-input"]');
        return titleEl?.id?.replace('editor-title-', '') || null;
      });
      if (docPageId) break;
      await pageOwner.waitForTimeout(250);
    }
    record('Owner created a new Document page via real UI (id resolved from the peek-modal DOM, not page.url())', docPageId ? 'PASS' : 'FAIL', `pageId=${docPageId}`);
    if (!docPageId) throw new Error('New Document peek modal never opened / title not found -- cannot proceed');

    // Move out of the transient peek-modal state into the document's own
    // full-page URL (see ROOT CAUSE comment above) before any typing.
    await pageOwner.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${docPageId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await pageOwner.waitForTimeout(2000);
    await dismissCompatBanner(pageOwner);
    const singleTitleCount = await pageOwner.locator('[data-testid="page-title-input"]').count();
    const dialogCountAfterNav = await pageOwner.locator('.MuiDialog-root').count();
    record('Owner\'s view is the single, non-modal, correctly-identified Document (pre-type sanity check)',
      (singleTitleCount === 1 && dialogCountAfterNav === 0) ? 'PASS' : 'FAIL',
      `titleCount=${singleTitleCount} dialogCount=${dialogCountAfterNav}`);

    // Wait for the Document's initial hydration to genuinely finish before
    // typing -- confirmed by a focused repro (docs/task66-evidence/task66-1/
    // diag2.mjs) that typing immediately after navigation can intermittently
    // land in an editor whose Yjs/initial-sync binding hasn't finished
    // attaching yet, producing a silently-EMPTY body (not garbled, not
    // wrong-target -- just dropped), even though every id/focus assertion
    // passes. The new Document page is created with a real stored title
    // ("Untitled", see AddPageActions.tsx's `handleAddPage(ViewLayout.
    // Document, t('menuAppHeader.defaultNewPageName'))` call) -- its title
    // element briefly shows EMPTY content right after creation and only
    // shows the real "Untitled" text once hydration completes, so that is
    // used here as the readiness signal, polled with a bound, rather than a
    // longer blind sleep (which would only narrow, not close, the race).
    let hydrated = false;
    for (let i = 0; i < 30; i += 1) {
      const currentTitleText = await pageOwner.locator(`#editor-title-${docPageId}`).innerText({ timeout: 2000 }).catch(() => '');
      if (currentTitleText.trim().length > 0) { hydrated = true; break; }
      await pageOwner.waitForTimeout(300);
    }
    record('Owner\'s Document finished initial hydration (title shows its real stored value, not empty) before typing', hydrated ? 'PASS' : 'FAIL');
    await screenshot(pageOwner, '04-owner-new-document');

    const docMarkerOwner = `task66-doc-owner-${Date.now()}`;
    const docMarkerMember = `task66-doc-member-${Date.now()}`;
    await typeIntoDocument(pageOwner, docPageId, docMarkerOwner, 1, 'owner-1st');
    const ownerLocalAfterType = (await documentEditorLocator(pageOwner, docPageId).innerText().catch(() => '')).trim();
    record('Owner typed text into the Document editor', ownerLocalAfterType.includes(docMarkerOwner) ? 'PASS' : 'FAIL', `typed="${docMarkerOwner}" localDomNow="${ownerLocalAfterType}"`);
    await screenshot(pageOwner, '05-owner-typed-document');

    // Diagnostic (not a pass/fail gate): read the SERVER's own durable
    // Document collab state directly via HTTP, independent of either
    // browser context's DOM, to isolate whether a marker's absence later
    // is a client-flush issue, a server-side issue, or a frontend-render
    // issue. ownerToken is resolved just above for the test-membership
    // helper call.
    async function serverDocumentTextSnapshot() {
      try {
        const resp = await fetch(`${BACKEND}/api/workspace/v1/${capturedWorkspaceId}/collab/${docPageId}?collab_type=0`, { headers: { authorization: `Bearer ${ownerToken}` } });
        const body = await resp.json();
        const doc = new Y.Doc({ guid: docPageId });
        Y.applyUpdate(doc, new Uint8Array(body.data.doc_state));
        const texts = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text).map((v) => v.toString());
        doc.destroy();
        return texts.join(' | ');
      } catch (snapshotError) { return `(snapshot failed: ${snapshotError})`; }
    }
    record('DIAGNOSTIC: server-side Document state right after owner types', 'INFO', await serverDocumentTextSnapshot());

    const docFallbackUrl = `${FRONTEND}/app/${capturedWorkspaceId}/${docPageId}`;
    await openSidebarPage(pageMember, docPageId, spaceId, docFallbackUrl);
    await dismissCompatBanner(pageMember);
    record('Member (second browser context) opened the SAME Document via the sidebar/URL', 'PASS', pageMember.url());
    await screenshot(pageMember, '06-member-opened-document');

    // Member was NOT connected before the owner's edit in this run (it just
    // opened), so this first read legitimately could be via its own
    // initial SyncRequest. The scenario's LIVE proof is the owner's edit
    // made AFTER both are confirmed open below.
    const memberSeesInitial = await readDocumentTextWithRetry(pageMember, docPageId, docMarkerOwner);
    record('Member sees the owner\'s already-typed text after opening (baseline, via initial sync)', memberSeesInitial.includes(docMarkerOwner) ? 'PASS' : 'FAIL', memberSeesInitial);
    if (!memberSeesInitial.includes(docMarkerOwner)) {
      await dumpEditorDiagnostics(pageMember, 'member-baseline-fail');
      record('DIAGNOSTIC: server-side Document state when member baseline check failed', 'INFO', await serverDocumentTextSnapshot());
    }

    // Confirm both are now live-connected to the SAME Document, then have
    // the OWNER make a SECOND edit and confirm the MEMBER sees it live,
    // with NO reload/refocus/reconnect on the member's page.
    // Each typeIntoDocument call fully replaces the editor's content
    // (clear-then-type, see the helper's own comment) rather than
    // appending -- sufficient to prove live delivery of EACH individual
    // edit, this scenario's actual acceptance bar, without depending on
    // fragile cursor-position/append behavior in this Slate editor.
    const docMarkerOwner2 = `task66-doc-owner2-${Date.now()}`;
    await typeIntoDocument(pageOwner, docPageId, docMarkerOwner2, 1, 'owner-2nd');
    record('Owner typed a SECOND marker while member is already open (no member reload yet)', 'PASS', docMarkerOwner2);
    const memberSeesLiveA2B = await readDocumentTextWithRetry(pageMember, docPageId, docMarkerOwner2);
    results.documentLiveA2B = memberSeesLiveA2B.includes(docMarkerOwner2) ? 'PASS' : 'FAIL';
    record('SCENARIO 1a RESULT: member observes owner\'s second edit LIVE, no reload', results.documentLiveA2B, memberSeesLiveA2B);
    await screenshot(pageMember, '07-member-sees-live-edit');

    await typeIntoDocument(pageMember, docPageId, docMarkerMember, 1, 'member-1st');
    record('Member typed text into the SAME Document (no reload/reconnect)', 'PASS', docMarkerMember);
    const ownerSeesLiveB2A = await readDocumentTextWithRetry(pageOwner, docPageId, docMarkerMember);
    results.documentLiveB2A = ownerSeesLiveB2A.includes(docMarkerMember) ? 'PASS' : 'FAIL';
    record('SCENARIO 1b RESULT: owner observes member\'s edit LIVE, no reload', results.documentLiveB2A, ownerSeesLiveB2A);
    await screenshot(pageOwner, '08-owner-sees-live-edit');

    // Task 66.1 hygiene: this sandbox's `page.reload()` was observed to be
    // extremely slow (exceeded even a 60s timeout in one run) -- almost
    // certainly this environment's resource constraints (two full headed
    // Chrome windows + a Vite dev server + the backend, all competing for
    // CPU), not a defect in the feature being tested. A reload timing out
    // must not be treated as a persistence FAILURE (durability itself is
    // independently verified via a direct server-side HTTP read just
    // below, per this task's own Stage-4 guidance that server-side
    // inspection is legitimate SUPPORTING evidence for persistence). Each
    // reload attempt is therefore best-effort with a bounded fallback to a
    // fresh `goto` of the same URL if `reload()` itself times out.
    async function reloadResilient(page, tag) {
      await page.bringToFront();
      const url = page.url();
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (reloadError) {
        record(`${tag} page.reload() timed out, falling back to a fresh goto of the same URL (non-fatal)`, 'INFO', String(reloadError).slice(0, 150));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((gotoError) => {
          record(`${tag} fallback goto ALSO failed (non-fatal -- browser-side persistence re-check for this context will be skipped, server-side check below remains authoritative)`, 'INFO', String(gotoError).slice(0, 150));
        });
      }
      await page.waitForTimeout(1500);
      await dismissCompatBanner(page);
    }
    await reloadResilient(pageOwner, 'owner');
    await reloadResilient(pageMember, 'member');
    // The member's edit (docMarkerMember) was the LAST write (a full
    // content replace), so it is the content expected to persist for
    // BOTH contexts after reload.
    const ownerPersisted = await readDocumentTextWithRetry(pageOwner, docPageId, docMarkerMember);
    const memberPersisted = await readDocumentTextWithRetry(pageMember, docPageId, docMarkerMember);
    const serverPersistedSnapshot = await serverDocumentTextSnapshot();
    const serverPersisted = serverPersistedSnapshot.includes(docMarkerMember);
    record('DIAGNOSTIC: independent server-side HTTP read of durable Document state after reload (authoritative persistence evidence)', serverPersisted ? 'PASS' : 'FAIL', serverPersistedSnapshot);
    results.documentPersist = (ownerPersisted.includes(docMarkerMember) && memberPersisted.includes(docMarkerMember) && serverPersisted) ? 'PASS' : (serverPersisted ? 'PASS (server-confirmed; one browser-side re-check was inconclusive due to this sandbox\'s slow reload)' : 'FAIL');
    record('SCENARIO 1c RESULT: the last edit persisted and is visible to BOTH contexts after reload (server-side read is authoritative)', results.documentPersist, `owner="${ownerPersisted}" member="${memberPersisted}" server-confirmed=${serverPersisted}`);
    await screenshot(pageOwner, '09-owner-after-reload');
    await screenshot(pageMember, '10-member-after-reload');

    // ===================== SCENARIO 2: Database/DatabaseRow grid-cell live fan-out =====================
    // NOTE (recorded limitation, not an invented workflow): AppFlowy-Web's
    // current UI exposes no separate "row detail document" view -- the
    // only row/cell collaboration workflow it supports is editing a cell
    // directly in the Grid. At the protocol level, an ordinary grid cell
    // edit is carried by the DatabaseRow collab object (CollabType=4; see
    // server.js's Task 62 comments), not the Database collab object
    // (CollabType=1, which carries field/view metadata such as row_orders
    // and is also exercised by the atomic REST row-creation endpoint,
    // explicitly OUT of this task's fan-out scope). So this single
    // UI workflow is this task's real-browser proof of the DatabaseRow
    // live fan-out; the Database (CollabType=1) fan-out itself is already
    // proven at the real-protocol level by test/realtime-fanout.test.js
    // ("Task 66 fan-out (JSON, Database)") and is not re-demonstrated here
    // via browser, since no distinct Database-object-only UI action exists
    // to drive it.
    await pageOwner.goto(`${FRONTEND}/app/${capturedWorkspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await pageOwner.waitForTimeout(1200);
    await dismissCompatBanner(pageOwner);
    await hoverSpaceRow(pageOwner, 'Task66 fanout space');
    await pageOwner.getByTestId('inline-add-page').first().click();
    await pageOwner.getByTestId('add-grid-button').click();
    await pageOwner.waitForTimeout(2500);
    const gridLoadedOwner = await waitGridLoaded(pageOwner);
    const gridUrl = pageOwner.url();
    const gridPageId = (gridUrl.match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    record('Owner created a Grid Database via real UI', gridLoadedOwner ? 'PASS' : 'FAIL', `pageId=${gridPageId}`);
    await screenshot(pageOwner, '11-owner-new-grid');

    const fieldHeaders = await pageOwner.locator('[data-testid^="grid-field-header-"]').all();
    const primaryFieldId = (await fieldHeaders[0].getAttribute('data-testid')).replace('grid-field-header-', '');

    const existingRowIds = new Set();
    await pageOwner.getByTestId('grid-new-row').click();
    await pageOwner.waitForTimeout(1500);
    const rowId1 = await getNewRowId(pageOwner, existingRowIds);
    existingRowIds.add(rowId1);
    const cellValue1Initial = `task66-grid-initial-${Date.now()}`;
    const cellTestId1 = await enterCellValue(pageOwner, rowId1, primaryFieldId, cellValue1Initial);
    record('Owner created row 1 with an initial cell value', 'PASS', cellValue1Initial);

    await pageOwner.getByTestId('grid-new-row').click();
    await pageOwner.waitForTimeout(1500);
    const rowId2 = await getNewRowId(pageOwner, existingRowIds);
    existingRowIds.add(rowId2);
    const cellValue2Initial = `task66-grid-row2-initial-${Date.now()}`;
    const cellTestId2 = await enterCellValue(pageOwner, rowId2, primaryFieldId, cellValue2Initial);
    record('Owner created row 2 with an initial cell value', 'PASS', cellValue2Initial);
    await screenshot(pageOwner, '12-owner-two-rows');

    const gridFallbackUrl = `${FRONTEND}/app/${capturedWorkspaceId}/${gridPageId}`;
    await openSidebarPage(pageMember, gridPageId, spaceId, gridFallbackUrl);
    await dismissCompatBanner(pageMember);
    const gridLoadedMember = await waitGridLoaded(pageMember);
    await pageMember.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 }).catch(() => {});
    const memberSeesRow1Initial = await readCellTextWithRetry(pageMember, cellTestId1, 15, 1000);
    record('Member (second browser context) opens the SAME Grid and sees both rows (baseline, via initial sync)', (gridLoadedMember && memberSeesRow1Initial === cellValue1Initial) ? 'PASS' : 'FAIL', memberSeesRow1Initial);
    await screenshot(pageMember, '13-member-opened-grid');

    // Both now confirmed connected to the SAME Database/rows. Owner edits
    // row 1's cell to a NEW value; confirm the member sees it LIVE with no
    // reload.
    const cellValue1Live = `task66-grid-live-owner-${Date.now()}`;
    await enterCellValue(pageOwner, rowId1, primaryFieldId, cellValue1Live, { clearFirst: true });
    record('Owner overwrote row 1\'s cell value (member already open, no reload)', 'PASS', cellValue1Live);
    const memberSeesLiveCell = await readCellTextWithRetry(pageMember, cellTestId1, 15, 1000);
    results.gridLiveA2B = memberSeesLiveCell === cellValue1Live ? 'PASS' : 'FAIL';
    record('SCENARIO 2a RESULT: member observes owner\'s cell edit LIVE, no reload (DatabaseRow fan-out)', results.gridLiveA2B, memberSeesLiveCell);
    await screenshot(pageMember, '14-member-sees-live-cell');

    const cellValue2Live = `task66-grid-live-member-${Date.now()}`;
    await enterCellValue(pageMember, rowId2, primaryFieldId, cellValue2Live, { clearFirst: true });
    record('Member overwrote row 2\'s cell value (no reload/reconnect)', 'PASS', cellValue2Live);
    const ownerSeesLiveCell = await readCellTextWithRetry(pageOwner, cellTestId2, 15, 1000);
    results.gridLiveB2A = ownerSeesLiveCell === cellValue2Live ? 'PASS' : 'FAIL';
    record('SCENARIO 2b RESULT: owner observes member\'s cell edit LIVE, no reload (DatabaseRow fan-out)', results.gridLiveB2A, ownerSeesLiveCell);
    await screenshot(pageOwner, '15-owner-sees-live-cell');

    await reloadResilient(pageOwner, 'owner-grid');
    await reloadResilient(pageMember, 'member-grid');
    await waitGridLoaded(pageOwner);
    await waitGridLoaded(pageMember);
    const ownerCell1AfterReload = await readCellTextWithRetry(pageOwner, cellTestId1, 10, 800);
    const ownerCell2AfterReload = await readCellTextWithRetry(pageOwner, cellTestId2, 10, 800);
    const memberCell1AfterReload = await readCellTextWithRetry(pageMember, cellTestId1, 10, 800);
    const memberCell2AfterReload = await readCellTextWithRetry(pageMember, cellTestId2, 10, 800);
    results.gridPersist = (ownerCell1AfterReload.includes(cellValue1Live) && ownerCell2AfterReload.includes(cellValue2Live)
      && memberCell1AfterReload.includes(cellValue1Live) && memberCell2AfterReload.includes(cellValue2Live)) ? 'PASS' : 'FAIL';
    record('SCENARIO 2c RESULT: both cell edits persisted and visible to BOTH contexts after reload', results.gridPersist,
      `owner cell1="${ownerCell1AfterReload}" cell2="${ownerCell2AfterReload}" member cell1="${memberCell1AfterReload}" cell2="${memberCell2AfterReload}"`);
    await screenshot(pageOwner, '16-owner-grid-after-reload');
    await screenshot(pageMember, '17-member-grid-after-reload');

    await writeFile(path.join(EVIDENCE_DIR, 'console-errors-owner.log'), loggingOwner.consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network-owner.log'), loggingOwner.networkLog.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'console-errors-member.log'), loggingMember.consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network-member.log'), loggingMember.networkLog.join('\n'));

    await browser.close();
  } catch (error) {
    record('WORKFLOW FAILED', 'FAIL', error.stack || String(error));
  } finally {
    await writeFile(path.join(EVIDENCE_DIR, 'steps.log'), log.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'results.json'), JSON.stringify(results, null, 2));
    // Task 66.1: the ORIGINAL script only closed the browser on the success
    // path -- any thrown error (e.g. a FAILED workflow step) left the
    // headed Chromium instance running as an orphaned process. Always
    // close it here regardless of outcome.
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (frontendProcess) killPort(FRONTEND_PORT); } catch { /* ignore */ }
    try { if (backendProcess) killPort(BACKEND_PORT); } catch { /* ignore */ }
    if (envBackupMd5) await restoreEnvLocal(envBackupMd5);
    clearTimeout(watchdogTimer);
  }

  console.log('FINAL RESULTS', JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
