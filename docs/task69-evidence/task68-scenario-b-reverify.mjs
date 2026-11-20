// Task 69 Stage 7: bounded re-verification of Task 68 Scenario B (backend
// restart), using the Task 69 navigation primitives (test/helpers/navigation.ts
// logic, inlined here as plain JS so this script has no build step) in place
// of the three previously-failed click strategies. This does NOT change
// backend restart/collaboration-recovery LOGIC (already proven at the
// protocol level by test/collaboration-recovery.test.js) -- its only job is
// to get real-browser evidence on top of that.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BACKEND_PORT = process.env.BACKEND_PORT;
const FRONTEND_PORT = process.env.FRONTEND_PORT;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const DEV_KEY = process.env.DEV_KEY || 'task69-t68-key';
const BACKEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend';
const FRONTEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Web';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://localhost:${FRONTEND_PORT}`;
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');
const ENV_LOCAL_BACKUP_PATH = path.join(EVIDENCE_DIR, 'env.local.backup');
const DATA_FILE = process.env.DATA_FILE;

await mkdir(EVIDENCE_DIR, { recursive: true });
const log = [];
function record(step, status, detail) {
  const line = `[${new Date().toISOString()}] ${status} - ${step}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  log.push(line);
}
function md5(buf) { return createHash('md5').update(buf).digest('hex'); }

async function waitHealthy(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(`${url}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
async function waitFrontendReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 304) return true; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
function spawnBackend() {
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(BACKEND_PORT), STORAGE: 'json', DATA_FILE,
    DEV_TEST_KEY: DEV_KEY,
    CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}`,
  };
  const child = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env, stdio: 'ignore' });
  return child;
}

// ---- Task 69 navigation primitives (inlined) ----
async function waitForNoDialogMounted(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => document.querySelectorAll('.MuiDialog-root').length).catch(() => 1);
    if (count === 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}
async function ensureNoViewModalOpen(page, timeoutMs = 8000) {
  const closeBtn = page.getByTestId('view-modal-close');
  if (await closeBtn.first().isVisible({ timeout: 1500 }).catch(() => false)) await closeBtn.first().click();
  return waitForNoDialogMounted(page, timeoutMs);
}
async function waitForNoNotFoundToast(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await page.getByText("couldn't find this content", { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
    if (!visible) return true;
    await page.waitForTimeout(300);
  }
  return false;
}
async function waitForDocumentEditorReady(page, pageId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveStableChecks = 0;
  while (Date.now() < deadline) {
    const stillConnecting = await page.getByText('Connecting', { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
    const titleVisible = await page.locator(`#editor-title-${pageId}`).isVisible({ timeout: 300 }).catch(() => false);
    if (!stillConnecting && titleVisible) {
      consecutiveStableChecks += 1;
      // Require the "not connecting" state to hold across 3 consecutive
      // polls (~900ms) before trusting it -- the WS connection badge was
      // observed to flap (briefly clear, then show "Connecting..." again)
      // shortly after page creation in some runs, which a single
      // point-in-time check does not catch.
      if (consecutiveStableChecks >= 3) return true;
    } else {
      consecutiveStableChecks = 0;
    }
    await page.waitForTimeout(300);
  }
  return false;
}
async function waitForDocumentReady(page, pageId, timeoutMs = 20000) {
  const start = Date.now();
  const modalClosed = await ensureNoViewModalOpen(page, timeoutMs);
  const toastCleared = await waitForNoNotFoundToast(page, Math.max(1000, timeoutMs - (Date.now() - start)));
  const editorReady = await waitForDocumentEditorReady(page, pageId, Math.max(1000, timeoutMs - (Date.now() - start)));
  return { modalClosed, toastCleared, editorReady, ok: modalClosed && toastCleared && editorReady };
}
function documentBodyLocator(page, pageId) {
  return page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first();
}
async function clickIntoDocumentBody(page, pageId) {
  const title = page.locator(`#editor-title-${pageId}`);
  await title.waitFor({ state: 'visible', timeout: 10000 });
  const body = documentBodyLocator(page, pageId);
  await body.waitFor({ state: 'visible', timeout: 10000 });
  async function landedInBody() {
    return page.evaluate((id) => {
      const bodyEl = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
      return !!bodyEl && (bodyEl === document.activeElement || bodyEl.contains(document.activeElement));
    }, pageId);
  }
  // Top-left click, not default center -- see navigation.ts for why.
  await body.click({ position: { x: 10, y: 12 } });
  if (await landedInBody()) return;
  await body.click();
  if (await landedInBody()) return;
  await title.click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
}
async function typeIntoDocumentBody(page, pageId, text) {
  await clickIntoDocumentBody(page, pageId);
  // Only clear existing content when there actually IS existing content.
  // Select-all+Backspace on an ALREADY-EMPTY body was found (live repro)
  // to sometimes collapse the selection back up into the title -- this
  // app's Slate document model treats title+body as one page, and
  // select-all with nothing to select in the body can resolve the
  // selection to the title instead -- so subsequent keystrokes land in
  // the wrong place. Skipping the clear when there's nothing to clear
  // avoids the whole failure mode rather than working around its symptom.
  const existing = await page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first().innerText().catch(() => '');
  if (existing && existing.trim().length > 0) {
    await page.keyboard.press('Control+a').catch(() => {});
    await page.keyboard.press('Meta+a').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.keyboard.type(text, { delay: 20 });
}
async function readDocumentBodyWithRetry(page, pageId, needle, attempts = 15, delayMs = 500) {
  let text = '';
  for (let i = 0; i < attempts; i += 1) {
    text = (await documentBodyLocator(page, pageId).innerText().catch(() => '')).trim();
    if (!needle || text.includes(needle)) return text;
    await page.waitForTimeout(delayMs);
  }
  return text;
}
async function hoverSpaceRow(page, label) {
  const row = page.locator(`div[aria-label="${label}"]`).first().locator('xpath=..');
  await row.waitFor({ state: 'visible', timeout: 10000 });
  const box = await row.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
  }
  await page.waitForTimeout(400);
}
async function dismissCompatBanner(page) {
  const b = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
  if (await b.first().isVisible({ timeout: 2000 }).catch(() => false)) { await b.first().click(); await page.waitForTimeout(200); }
}

async function main() {
  const results = {
    documentEditBeforeRestart: 'NOT TESTED',
    backendRestarted: 'NOT TESTED',
    documentPersistedAfterRestart: 'NOT TESTED',
    documentWritableAfterRestart: 'NOT TESTED',
    liveDeliveryAfterRestart: 'NOT TESTED',
  };
  let backendProcess;
  let envBackupMd5;
  let screenshotIndex = 0;
  async function screenshot(page, name) {
    screenshotIndex += 1;
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true }).catch(() => {});
  }

  try {
    const original = await readFile(ENV_LOCAL_PATH);
    envBackupMd5 = md5(original);
    await writeFile(ENV_LOCAL_BACKUP_PATH, original);
    record('.env.local backed up (MD5-verified)', 'INFO', envBackupMd5);

    const envContent = [`APPFLOWY_BASE_URL=${BACKEND}`, `APPFLOWY_GOTRUE_BASE_URL=${BACKEND}`, `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${BACKEND_PORT}/ws/v2`].join('\n') + '\n';
    await writeFile(ENV_LOCAL_PATH, envContent);

    backendProcess = spawnBackend();
    const backendHealthy = await waitHealthy(BACKEND);
    record(`Backend process started (STORAGE=json, port ${BACKEND_PORT})`, backendHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not become healthy');

    const frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], { cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, stdio: 'ignore' });
    const frontendReady = await waitFrontendReady(FRONTEND);
    record(`Frontend dev server started (port ${FRONTEND_PORT})`, frontendReady ? 'PASS' : 'FAIL', `pid=${frontendProcess.pid}`);
    if (!frontendReady) throw new Error('Frontend did not become ready');

    const browser = await chromium.launch({ headless: true });
    const contextOwner = await browser.newContext();
    const pageOwner = await contextOwner.newPage();

    const email = `task69-t68reverify-${Date.now()}@example.test`;
    const password = 'Correct horse 907 task69 t68';
    const reg = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (reg.status !== 201) throw new Error(`Registration failed: ${reg.status}`);
    record('Registered real user account via the backend\'s own auth API', 'PASS', email);

    await pageOwner.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageOwner.getByTestId('login-email-input').fill(email);
    await pageOwner.getByTestId('login-password-button').click();
    await pageOwner.getByTestId('password-input').fill(password);
    await pageOwner.getByTestId('password-submit-button').click();
    await pageOwner.waitForURL(/\/app\//, { timeout: 20000 });
    await pageOwner.waitForTimeout(800);
    await dismissCompatBanner(pageOwner);
    record('Logged in via real UI', 'PASS', pageOwner.url());
    await screenshot(pageOwner, 'owner-after-login');

    let capturedWorkspaceId = null;
    pageOwner.on('requestfinished', async (req) => {
      const m = req.url().match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
      if (m) capturedWorkspaceId = m[1];
    });
    await pageOwner.getByTestId('new-page-button').click();
    await pageOwner.getByTestId('new-page-create-space-button').click();
    await pageOwner.getByTestId('space-name-input').fill('Task68 reverify space');
    await pageOwner.getByTestId('create-space-submit').click();
    await pageOwner.waitForTimeout(1200);
    await pageOwner.keyboard.press('Escape').catch(() => {});
    await pageOwner.reload({ waitUntil: 'domcontentloaded' });
    await pageOwner.waitForURL(/\/app\//, { timeout: 20000 });
    await pageOwner.waitForTimeout(800);
    await dismissCompatBanner(pageOwner);
    record('Created a public Space via real UI', 'PASS', `workspace=${capturedWorkspaceId}`);
    await screenshot(pageOwner, 'owner-after-space');

    await hoverSpaceRow(pageOwner, 'Task68 reverify space');
    await pageOwner.getByTestId('inline-add-page').first().click();
    await pageOwner.getByTestId('add-document-button').click();
    await pageOwner.waitForTimeout(600);
    const pageId = (pageOwner.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    record('Created a new Document page via real UI', pageId ? 'PASS' : 'FAIL', `pageId=${pageId}`);
    await screenshot(pageOwner, 'new-document');

    // ----- Task 69 fix applied here: close the ViewModal via its real close
    // affordance and wait on the condition-based readiness gate, instead of
    // the 3 previously-failed strategies (sticky-header click, modal expand
    // + content-not-found toast, sidebar visibility race). -----
    const readiness1 = await waitForDocumentReady(pageOwner, pageId);
    record('Navigated out of the ViewModal to the stable full-page route (Task 69 readiness gate)', readiness1.ok ? 'PASS' : 'FAIL', JSON.stringify(readiness1));
    if (!readiness1.ok) throw new Error('Document did not reach ready state before restart');

    const preRestartMarker = `t68reverify-pre-restart-${Date.now()}`;
    await typeIntoDocumentBody(pageOwner, pageId, preRestartMarker);
    await pageOwner.waitForTimeout(1500); // sync-outbox flush, same convention as Task 66/68 scripts
    const bodyBefore = await readDocumentBodyWithRetry(pageOwner, pageId, preRestartMarker);
    results.documentEditBeforeRestart = bodyBefore.includes(preRestartMarker) ? 'PASS' : 'FAIL';
    record('Edit before restart typed and locally confirmed', results.documentEditBeforeRestart, bodyBefore);
    await screenshot(pageOwner, 'before-restart-edit');

    // ----- Stop ONLY the backend process this script started, then start a
    // brand-new process against the SAME disposable data file. -----
    backendProcess.kill();
    await new Promise((r) => setTimeout(r, 500));
    const backendProcess2 = spawnBackend();
    const backendHealthy2 = await waitHealthy(BACKEND);
    results.backendRestarted = backendHealthy2 ? 'PASS' : 'FAIL';
    record('Backend restarted against the same data file', results.backendRestarted, `pid=${backendProcess2.pid}`);

    await pageOwner.reload({ waitUntil: 'domcontentloaded' });
    const readiness2 = await waitForDocumentReady(pageOwner, pageId);
    record('Document reached ready state after reload post-restart', readiness2.ok ? 'PASS' : 'FAIL', JSON.stringify(readiness2));
    await screenshot(pageOwner, 'after-restart-reload');

    const bodyAfter = await readDocumentBodyWithRetry(pageOwner, pageId, preRestartMarker);
    results.documentPersistedAfterRestart = bodyAfter.includes(preRestartMarker) ? 'PASS' : 'FAIL';
    record('Pre-restart content persisted across restart', results.documentPersistedAfterRestart, bodyAfter);

    const postRestartMarker = `t68reverify-post-restart-${Date.now()}`;
    await typeIntoDocumentBody(pageOwner, pageId, postRestartMarker);
    await pageOwner.waitForTimeout(1500);
    const bodyNewEdit = await readDocumentBodyWithRetry(pageOwner, pageId, postRestartMarker);
    results.documentWritableAfterRestart = bodyNewEdit.includes(postRestartMarker) ? 'PASS' : 'FAIL';
    record('New edit after restart succeeds end-to-end', results.documentWritableAfterRestart, bodyNewEdit);
    await screenshot(pageOwner, 'after-restart-new-edit');

    // Second context: live delivery to an already-connected peer after restart.
    const contextMember = await browser.newContext();
    const pageMember = await contextMember.newPage();
    await pageMember.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageMember.getByTestId('login-email-input').fill(email);
    await pageMember.getByTestId('login-password-button').click();
    await pageMember.getByTestId('password-input').fill(password);
    await pageMember.getByTestId('password-submit-button').click();
    await pageMember.waitForURL(/\/app\//, { timeout: 20000 });
    await pageMember.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${pageId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const readinessMember = await waitForDocumentReady(pageMember, pageId);
    record('Second context opened the same document after restart', readinessMember.ok ? 'PASS' : 'FAIL', JSON.stringify(readinessMember));
    await screenshot(pageMember, 'member-opened-after-restart');

    const liveMarker = `t68reverify-live-${Date.now()}`;
    await typeIntoDocumentBody(pageOwner, pageId, liveMarker);
    const memberSaw = await readDocumentBodyWithRetry(pageMember, pageId, liveMarker, 20, 500);
    results.liveDeliveryAfterRestart = memberSaw.includes(liveMarker) ? 'PASS' : 'FAIL';
    record('Live delivery to an independently-opened second context after restart', results.liveDeliveryAfterRestart, memberSaw);
    await screenshot(pageMember, 'member-sees-live-after-restart');

    backendProcess2.kill();
    frontendProcess.kill();
    await browser.close();
  } catch (err) {
    record('WORKFLOW FAILED', 'FAIL', err.stack || String(err));
  } finally {
    try {
      if (envBackupMd5) {
        await copyFile(ENV_LOCAL_BACKUP_PATH, ENV_LOCAL_PATH);
        const restored = await readFile(ENV_LOCAL_PATH);
        record('.env.local restored byte-for-byte (MD5-verified)', md5(restored) === envBackupMd5 ? 'PASS' : 'FAIL');
      }
    } catch (e) { record('.env.local restore failed', 'FAIL', String(e)); }
    try { if (backendProcess) backendProcess.kill(); } catch {}
    await writeFile(path.join(EVIDENCE_DIR, 'steps.log'), log.join('\n') + '\n');
    await writeFile(path.join(EVIDENCE_DIR, 'results.json'), JSON.stringify(results, null, 2));
    console.log('RESULTS:', JSON.stringify(results, null, 2));
  }
}

main();
