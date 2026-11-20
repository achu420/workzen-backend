// Task 68 Stage 7, Scenario B (backend restart), real-browser verification.
// Modeled directly on the proven Task 66 script
// (docs/task66-evidence/task66-browser-verify.mjs): same env-var
// parameterization, same .env.local backup/restore discipline, same real
// login/space/document helpers (reused verbatim, single-user variant --
// this scenario needs one real browser context, not two), same
// evidence-capture conventions. The NEW part specific to Task 68: after the
// first edit is confirmed durable, the backend process is actually killed
// and a brand-new process is started against the SAME on-disk JSON file,
// then the SAME browser page (no new login) reloads and is checked for (a)
// the pre-restart edit surviving, and (b) a NEW post-restart edit still
// working end-to-end through the real UI.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';

const BACKEND_PORT = process.env.BACKEND_PORT;
const FRONTEND_PORT = process.env.FRONTEND_PORT;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const DEV_KEY = process.env.DEV_KEY || 'task68-key';
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

const log = [];
function record(step, status, detail) {
  const line = `[${new Date().toISOString()}] ${status} - ${step}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  log.push(line);
}

function md5(buf) { return createHash('md5').update(buf).digest('hex'); }

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
    documentEditBeforeRestart: 'NOT TESTED',
    backendRestarted: 'NOT TESTED',
    documentPersistedAfterRestart: 'NOT TESTED',
    documentWritableAfterRestart: 'NOT TESTED',
  };
  let backendProcess, frontendProcess, envBackupMd5;

  try {
    envBackupMd5 = await backupEnvLocal();
    const envContent = [
      `APPFLOWY_BASE_URL=${BACKEND}`,
      `APPFLOWY_GOTRUE_BASE_URL=${BACKEND}`,
      `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${BACKEND_PORT}/ws/v2`,
    ].join('\n') + '\n';
    await writeFile(ENV_LOCAL_PATH, envContent);
    record('Wrote temporary .env.local pointing at this run\'s disposable backend', 'INFO', envContent.replace(/\n/g, ' | '));

    backendProcess = spawnBackend();
    let backendHealthy = await waitHealthy(BACKEND);
    record(`Backend process started (STORAGE=json, port ${BACKEND_PORT})`, backendHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not become healthy');

    frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], {
      cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, detached: true, stdio: 'ignore',
    });
    frontendProcess.unref();
    const frontendReady = await waitFrontendReady(FRONTEND);
    record(`Frontend dev server started (port ${FRONTEND_PORT})`, frontendReady ? 'PASS' : 'FAIL', `pid=${frontendProcess.pid}`);
    if (!frontendReady) throw new Error('Frontend did not become ready');

    const browser = await chromium.launch({
      headless: true,
      executablePath: '/Users/achal/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    });

    function wireLogging(page, tag) {
      const consoleErrors = []; const networkLog = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[${tag}][${msg.type()}] ${msg.text()}`); });
      page.on('pageerror', (err) => consoleErrors.push(`[${tag}][pageerror] ${err.message}`));
      return { consoleErrors, networkLog };
    }

    async function dismissCompatBanner(page) {
      const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
      if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await dismissBanner.first().click();
        await page.waitForTimeout(300);
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
    function documentEditorLocator(page, pageId) {
      return page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first();
    }
    // A brand-new page can open inside the ViewModal quick-preview overlay
    // (a MUI Dialog) rather than as a plain full-page route. That overlay's
    // own sticky header (`div.sticky.top-0.z-[10]`) can intercept pointer
    // events aimed at the title underneath it. Evidence-based fix (attempt
    // 2 of the bounded real-browser-interaction cap): if the Dialog is
    // present, use ViewModal's own "open as page" expand control
    // (src/components/app/ViewModal.tsx, the first IconButton inside that
    // sticky header) to navigate OUT of the modal into the plain route
    // first, where no overlay competes for the title's pointer events.
    async function escapeViewModalIfPresent(page) {
      const dialog = page.locator('.MuiDialog-root').first();
      if (!(await dialog.isVisible({ timeout: 1500 }).catch(() => false))) return false;
      const expandButton = dialog.locator('div.sticky.top-0 button').first();
      if (await expandButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expandButton.click();
        await page.waitForTimeout(1200);
        return true;
      }
      return false;
    }
    async function clickIntoDocumentBody(page, pageId) {
      await escapeViewModalIfPresent(page);
      const title = page.locator(`#editor-title-${pageId}`);
      await title.waitFor({ state: 'visible', timeout: 10000 });
      await title.click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
    }
    async function typeIntoDocument(page, pageId, text) {
      await clickIntoDocumentBody(page, pageId);
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.type(text, { delay: 20 });
      await page.waitForTimeout(1200);
    }
    async function readDocumentTextWithRetry(page, pageId, needle, attempts = 10, delayMs = 800) {
      let text = '';
      for (let i = 0; i < attempts; i += 1) {
        const editor = documentEditorLocator(page, pageId);
        text = (await editor.innerText().catch(() => '')).trim();
        if (text.includes(needle)) return text;
        await page.waitForTimeout(delayMs);
      }
      return text;
    }

    let screenshotIndex = 0;
    async function screenshot(page, name) {
      screenshotIndex += 1;
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true });
    }

    // ===================== Setup: one real user, one workspace, one Document =====================
    const ownerEmail = `task68-restart-${Date.now()}@example.test`;
    const password = 'Correct horse 907 task68';

    const registerOwner = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    if (registerOwner.status !== 201) throw new Error(`Owner registration failed: ${registerOwner.status}`);
    record('Registered real user account via the backend\'s own auth API', 'PASS', ownerEmail);

    const context = await browser.newContext();
    const page = await context.newPage();
    const logging = wireLogging(page, 'owner');

    await login(page, ownerEmail, password);
    record('Logged in via real UI', 'PASS', page.url());
    await screenshot(page, 'owner-after-login');

    let capturedWorkspaceId = null;
    page.on('requestfinished', async (req) => {
      const url = req.url();
      const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
      if (match) capturedWorkspaceId = match[1];
    });

    await page.getByTestId('new-page-button').click();
    await page.getByTestId('new-page-create-space-button').click();
    await page.getByTestId('space-name-input').fill('Task68 restart space');
    await page.getByTestId('create-space-submit').click();
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape').catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    await page.waitForTimeout(1200);
    await dismissCompatBanner(page);
    record('Created a public Space via real UI', 'PASS', `workspace=${capturedWorkspaceId}`);
    await screenshot(page, 'owner-after-space');

    async function hoverSpaceRow(label) {
      const row = page.locator(`div[aria-label="${label}"]`).first().locator('xpath=..');
      await row.waitFor({ state: 'visible', timeout: 10000 });
      const box = await row.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
      } else { await row.hover(); }
      await page.waitForTimeout(800);
    }
    await hoverSpaceRow('Task68 restart space');
    await page.getByTestId('inline-add-page').first().click();
    await page.getByTestId('add-document-button').click();
    await page.waitForTimeout(2000);
    const docUrl = page.url();
    const docPageId = (docUrl.match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    record('Created a new Document page via real UI', docPageId ? 'PASS' : 'FAIL', `pageId=${docPageId}`);
    await screenshot(page, 'new-document');

    // Evidence-based fix (attempt 3 of the bounded real-browser-interaction
    // cap): the newly-created page opened as a ViewModal quick-preview
    // overlay whose underlying full-page route transiently 404s ("We
    // couldn't find this content" toast, visible in the prior attempt's
    // screenshot) immediately after creation -- a timing/propagation gap
    // between the page being created and the outline/route being ready to
    // serve it as a direct full-page navigation, not an interaction bug.
    // Close the modal and navigate via the SIDEBAR instead (expand the
    // space, click the page's own sidebar entry) -- the exact pattern
    // already proven reliable for cross-context navigation in Task 66's
    // real-browser script (`openSidebarPage`), rather than retrying the
    // same modal/full-page-route path a third time.
    const viewModalClose = page.getByTestId('view-modal-close');
    if (await viewModalClose.isVisible({ timeout: 2000 }).catch(() => false)) {
      await viewModalClose.click();
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(500);
    const sidebarEntry = page.getByTestId(`page-${docPageId}`);
    if (await sidebarEntry.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await sidebarEntry.first().click();
    } else {
      // Fall back to re-expanding the space row then retrying the sidebar entry once.
      await hoverSpaceRow('Task68 restart space');
      await page.getByTestId(`page-${docPageId}`).first().click({ timeout: 8000 });
    }
    await page.waitForTimeout(1500);
    await dismissCompatBanner(page);
    const stillHas404Toast = await page.getByText('couldn\'t find this content', { exact: false }).isVisible({ timeout: 1000 }).catch(() => false);
    record('Navigated to the Document via the sidebar entry (bypassing the ViewModal overlay)', stillHas404Toast ? 'FAIL' : 'PASS', `url=${page.url()} still404Toast=${stillHas404Toast}`);
    await screenshot(page, 'after-sidebar-navigation');

    // ===================== Pre-restart edit =====================
    const marker1 = `task68-restart-pre-${Date.now()}`;
    await typeIntoDocument(page, docPageId, marker1);
    const localAfterType = (await documentEditorLocator(page, docPageId).innerText().catch(() => '')).trim();
    results.documentEditBeforeRestart = localAfterType.includes(marker1) ? 'PASS' : 'FAIL';
    record('Typed pre-restart marker text into the Document editor', results.documentEditBeforeRestart, `typed="${marker1}" localDomNow="${localAfterType}"`);
    await screenshot(page, 'pre-restart-edit');

    const ownerTokenResp = await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    const { access_token: ownerToken } = await ownerTokenResp.json();
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
    const serverSnapshotBeforeRestart = await serverDocumentTextSnapshot();
    record('DIAGNOSTIC: server-side Document state before restart', serverSnapshotBeforeRestart.includes(marker1) ? 'PASS' : 'FAIL', serverSnapshotBeforeRestart);

    // ===================== Backend process restart =====================
    // Kill ONLY the backend process this script itself started, then start
    // a BRAND NEW process against the EXACT SAME on-disk JSON data file --
    // a faithful simulation of a real backend restart/crash-recovery, not
    // a reconnect within the same process.
    const preRestartPid = backendProcess.pid;
    killPort(BACKEND_PORT);
    await new Promise((resolve) => setTimeout(resolve, 800));
    backendProcess = spawnBackend();
    backendHealthy = await waitHealthy(BACKEND);
    results.backendRestarted = (backendHealthy && backendProcess.pid !== preRestartPid) ? 'PASS' : 'FAIL';
    record('Backend process restarted against the SAME data file (new process, same port, same JSON file)', results.backendRestarted, `oldPid=${preRestartPid} newPid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not come back healthy after restart');

    // ===================== Post-restart: reload the SAME browser page (no new login) =====================
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissCompatBanner(page);
    await screenshot(page, 'after-backend-restart-reload');
    const textAfterRestart = await readDocumentTextWithRetry(page, docPageId, marker1, 12, 1000);
    results.documentPersistedAfterRestart = textAfterRestart.includes(marker1) ? 'PASS' : 'FAIL';
    record('Pre-restart edit still visible in the REAL BROWSER after backend process restart + page reload', results.documentPersistedAfterRestart, textAfterRestart);

    // ===================== Post-restart: a NEW edit still works end-to-end =====================
    const marker2 = `task68-restart-post-${Date.now()}`;
    await typeIntoDocument(page, docPageId, marker2);
    const localAfterPostType = (await documentEditorLocator(page, docPageId).innerText().catch(() => '')).trim();
    await page.waitForTimeout(1500);
    const serverSnapshotAfterRestartEdit = await serverDocumentTextSnapshot();
    results.documentWritableAfterRestart = (localAfterPostType.includes(marker2) && serverSnapshotAfterRestartEdit.includes(marker2)) ? 'PASS' : 'FAIL';
    record('A NEW edit made after the backend restart is accepted and durably persisted', results.documentWritableAfterRestart, `local="${localAfterPostType}" server="${serverSnapshotAfterRestartEdit}"`);
    await screenshot(page, 'post-restart-new-edit');

    await writeFile(path.join(EVIDENCE_DIR, 'console-errors.log'), logging.consoleErrors.join('\n'));
    await browser.close();
  } catch (error) {
    record('WORKFLOW FAILED', 'FAIL', error.stack || String(error));
  } finally {
    await writeFile(path.join(EVIDENCE_DIR, 'steps.log'), log.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'results.json'), JSON.stringify(results, null, 2));
    try { if (frontendProcess) killPort(FRONTEND_PORT); } catch { /* ignore */ }
    try { if (backendProcess) killPort(BACKEND_PORT); } catch { /* ignore */ }
    if (envBackupMd5) await restoreEnvLocal(envBackupMd5);
  }

  console.log('FINAL RESULTS', JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
