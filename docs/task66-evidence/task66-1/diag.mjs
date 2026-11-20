// Diagnostic-only script (Task 66.1 Stage 2): headed browser reproduction of
// the ViewModal title-click interception. Not the acceptance script. Writes
// screenshots + a JSON diagnostics dump into the task66-1 evidence dir.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_PORT = 8796;
const FRONTEND_PORT = 5196;
const BACKEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend';
const FRONTEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Web';
const EVIDENCE_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend/docs/task66-evidence/task66-1/diag';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://localhost:${FRONTEND_PORT}`;
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');
const ENV_LOCAL_BACKUP_PATH = path.join(EVIDENCE_DIR, 'env.local.diag.backup');
const DATA_FILE = path.join(EVIDENCE_DIR, 'diag-data.json');

await mkdir(EVIDENCE_DIR, { recursive: true });

function killPort(port) {
  try {
    const pidOutput = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`).toString().trim();
    for (const pid of pidOutput.split('\n').filter(Boolean)) { execSync(`kill ${pid}`); }
  } catch { /* nothing listening */ }
}
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

const original = await readFile(ENV_LOCAL_PATH);
await writeFile(ENV_LOCAL_BACKUP_PATH, original);

let backendProcess, frontendProcess;
try {
  const envContent = [
    `APPFLOWY_BASE_URL=${BACKEND}`,
    `APPFLOWY_GOTRUE_BASE_URL=${BACKEND}`,
    `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${BACKEND_PORT}/ws/v2`,
  ].join('\n') + '\n';
  await writeFile(ENV_LOCAL_PATH, envContent);

  backendProcess = spawn('node', ['server.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(BACKEND_PORT), STORAGE: 'json', DATA_FILE, DEV_TEST_KEY: 'diag-key', CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}` },
    detached: true, stdio: 'ignore',
  });
  backendProcess.unref();
  console.log('backend healthy:', await waitHealthy(BACKEND), 'pid', backendProcess.pid);

  frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, detached: true, stdio: 'ignore',
  });
  frontendProcess.unref();
  console.log('frontend ready:', await waitFrontendReady(FRONTEND), 'pid', frontendProcess.pid);

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  const email = `diag-owner-${Date.now()}@example.test`;
  const password = 'Correct horse 907 diag';
  const reg = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  console.log('register status', reg.status);

  await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email-input').fill(email);
  await page.getByTestId('login-password-button').click();
  await page.getByTestId('password-input').fill(password);
  await page.getByTestId('password-submit-button').click();
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForTimeout(1000);

  // dismiss compat banner if present
  const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
  if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await dismissBanner.first().click();
    await page.waitForTimeout(300);
  }

  let capturedWorkspaceId = null;
  page.on('requestfinished', async (req) => {
    const url = req.url();
    const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
    if (match) capturedWorkspaceId = match[1];
  });

  await page.getByTestId('new-page-button').click();
  await page.getByTestId('new-page-create-space-button').click();
  await page.getByTestId('space-name-input').fill('Diag space');
  await page.getByTestId('create-space-submit').click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape').catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForTimeout(1200);

  try {
    const tok = (await (await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).access_token;
    const pagesResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/pages`, { headers: { authorization: `Bearer ${tok}` } });
    const { pages } = await pagesResp.json();
    console.log('PAGES RIGHT AFTER SPACE CREATION (before any add-document click):', JSON.stringify(pages.map((p) => ({ id: p.id, title: p.title, parent_view_id: p.parent_view_id })), null, 2));
  } catch (e) { console.log('pre-doc pages fetch failed', e); }

  const spaceRow = page.locator('div[aria-label="Diag space"]').first().locator('xpath=..');
  await spaceRow.waitFor({ state: 'visible', timeout: 10000 });
  const box = await spaceRow.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
  }
  await page.waitForTimeout(800);
  let createdPageIdFromNetwork = null;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (resp.request().method() === 'POST' && /\/page$/.test(url.split('?')[0])) {
      try {
        const body = await resp.json();
        console.log('PAGE-CREATE NETWORK RESPONSE', url, JSON.stringify(body).slice(0, 300));
        if (body?.view_id) createdPageIdFromNetwork = body.view_id;
        if (body?.data?.view_id) createdPageIdFromNetwork = body.data.view_id;
      } catch { /* not json or already consumed */ }
    }
  });

  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-document-button').click();
  await page.waitForTimeout(2500);
  console.log('createdPageIdFromNetwork =', createdPageIdFromNetwork);

  const docUrl = page.url();
  const docPageId = (docUrl.match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  console.log('created doc page id', docPageId, 'url', docUrl);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-just-created.png'), fullPage: false });

  // Poll until the modal's OWN title element matches docPageId (settles any
  // outline-resolution race) instead of assuming a fixed wait is enough.
  let settleAttempts = 0;
  let settled = false;
  for (; settleAttempts < 20; settleAttempts += 1) {
    const check = await page.evaluate((id) => {
      const dlg = document.querySelector('.MuiDialog-root');
      const t = dlg?.querySelector('[data-testid="page-title-input"]');
      return { dialogTitleId: t?.id || null, toastVisible: !!document.querySelector('[data-sonner-toast]') };
    }, docPageId);
    console.log(`settle-poll[${settleAttempts}]`, JSON.stringify(check));
    if (check.dialogTitleId === `editor-title-${docPageId}`) { settled = true; break; }
    await page.waitForTimeout(500);
  }
  console.log('SETTLED:', settled, 'after', settleAttempts, 'polls (', settleAttempts * 500, 'ms)');
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '01b-after-settle-wait.png'), fullPage: false });

  // === CORRECTED HYPOTHESIS: the document was opened via openPageModal, NOT
  // URL navigation, so page.url() right after the click is the WRONG page
  // (whatever was already routed). The REAL new page's id is whichever title
  // is inside the just-opened .MuiDialog-root. Verify this directly. ===
  const realId = await page.evaluate(() => {
    const dlg = document.querySelector('.MuiDialog-root');
    const t = dlg?.querySelector('[data-testid="page-title-input"]');
    return t?.id?.replace('editor-title-', '') || null;
  });
  console.log('REAL (modal-derived) page id:', realId, '   vs   URL-derived docPageId:', docPageId, '   SAME?', realId === docPageId);

  if (realId && realId !== docPageId) {
    let realClickError = null;
    try { await page.locator(`#editor-title-${realId}`).click({ timeout: 8000 }); } catch (e) { realClickError = String(e).slice(0, 300); }
    console.log('CORRECTED-ID title click error (if any):', realClickError);
    if (!realClickError) {
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      const marker2 = `diag-correctedid-marker-${Date.now()}`;
      await page.keyboard.type(marker2, { delay: 20 });
      await page.waitForTimeout(500);
      const bodyText2 = await page.locator(`[data-slate-editor="true"][id$="editor-${realId}"]`).first().innerText().catch(() => '(not found)');
      const titleText2 = await page.locator(`#editor-title-${realId}`).innerText().catch(() => '(not found)');
      console.log('CORRECTED-ID AFTER TYPING: bodyText=', JSON.stringify(bodyText2), 'titleText=', JSON.stringify(titleText2));
      console.log('CORRECTED-ID MARKER LANDED IN BODY (not title):', bodyText2.includes(marker2) && !titleText2.includes(marker2));
    }
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '01c-corrected-id-type-attempt.png'), fullPage: false });

    // === Does navigating directly to the real document's URL (as a reload
    // or a fresh open would) render it cleanly as the MAIN routed page,
    // with no modal and no id confusion? This matters because openPageModal
    // state is in-memory only -- it will NOT survive a page.reload(). ===
    await page.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${realId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const afterDirectNav = await page.evaluate((id) => {
      const titles = Array.from(document.querySelectorAll('[data-testid="page-title-input"]')).map((el) => el.id);
      const dialogCount = document.querySelectorAll('.MuiDialog-root').length;
      const bodyEl = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
      return { titles, dialogCount, bodyText: bodyEl ? bodyEl.textContent : null };
    }, realId);
    console.log('AFTER DIRECT NAV TO REAL DOC URL (simulates reload):', JSON.stringify(afterDirectNav));
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '07-direct-nav-to-real-doc.png'), fullPage: false });
  }

  // === DIAGNOSTICS: before any interaction ===
  const titleSel = `#editor-title-${docPageId}`;
  const stickySel = '.MuiDialog-root .sticky';
  async function dump(tag) {
    const data = await page.evaluate(({ titleSel, stickySel }) => {
      const title = document.querySelector(titleSel);
      const sticky = document.querySelector(stickySel);
      const dialogPaper = document.querySelector('.MuiDialog-root .MuiPaper-root');
      function rect(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom }; }
      function cs(el, prop) { return el ? getComputedStyle(el)[prop] : null; }
      return {
        titleRect: rect(title),
        stickyRect: rect(sticky),
        dialogPaperRect: rect(dialogPaper),
        dialogPaperScrollTop: dialogPaper ? dialogPaper.scrollTop : null,
        activeElementId: document.activeElement ? document.activeElement.id : null,
        activeElementTestId: document.activeElement ? document.activeElement.getAttribute('data-testid') : null,
        titleZIndex: cs(title, 'zIndex'),
        stickyZIndex: cs(sticky, 'zIndex'),
        titleVisible: title ? (title.getBoundingClientRect().width > 0 && title.getBoundingClientRect().height > 0) : false,
      };
    }, { titleSel, stickySel });
    console.log(`DIAG[${tag}]`, JSON.stringify(data, null, 2));
    return data;
  }

  try {
    const pagesResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/pages`, { headers: { authorization: `Bearer ${(await (await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).access_token}` } });
    const { pages } = await pagesResp.json();
    console.log('ALL PAGES IN WORKSPACE:', JSON.stringify(pages.map((p) => ({ id: p.id, title: p.title, parent_view_id: p.parent_view_id, layout: p.layout })), null, 2));
  } catch (e) { console.log('pages fetch failed', e); }

  const multiMount = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('[data-testid="page-title-input"]')).map((el) => ({ id: el.id, text: el.textContent, rect: el.getBoundingClientRect() }));
    const dialogs = Array.from(document.querySelectorAll('.MuiDialog-root')).map((el, i) => ({
      index: i,
      ariaHidden: el.getAttribute('aria-hidden'),
      display: getComputedStyle(el).display,
      zIndex: getComputedStyle(el).zIndex,
      rect: el.getBoundingClientRect(),
      hasTitleInput: !!el.querySelector('[data-testid="page-title-input"]'),
      titleInputId: el.querySelector('[data-testid="page-title-input"]')?.id,
    }));
    return { titles, dialogs, activeElement: document.activeElement?.id, bodyChildCount: document.body.children.length };
  });
  console.log('MULTI-MOUNT CHECK', JSON.stringify(multiMount, null, 2));

  const before = await dump('before-any-click');

  // Compute whether sticky overlaps title vertically right now
  function overlaps(a, b) {
    if (!a || !b) return 'unknown (missing rect)';
    return !(a.bottom <= b.top || b.bottom <= a.top) ? 'OVERLAP' : 'no-overlap';
  }
  console.log('OVERLAP CHECK (sticky vs title):', overlaps(before.stickyRect, before.titleRect));

  await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-before-fix-attempt.png'), fullPage: false });

  // Try the EXPLICIT scroll-to-top fix on the dialog paper / scroll container
  await page.evaluate(() => {
    const dialogPaper = document.querySelector('.MuiDialog-root .MuiPaper-root');
    if (dialogPaper) dialogPaper.scrollTop = 0;
    // Also the known appflowy-scroll-container class per ViewModal.tsx PaperProps
    const scroller = document.querySelector('.appflowy-scroll-container');
    if (scroller) scroller.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const after = await dump('after-scroll-to-top');
  console.log('OVERLAP CHECK after scroll-to-top (sticky vs title):', overlaps(after.stickyRect, after.titleRect));

  await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-after-scroll-to-top.png'), fullPage: false });

  // Now attempt the real click + measure outcome
  let clickError = null;
  try {
    await page.locator(titleSel).click({ timeout: 8000 });
  } catch (e) { clickError = String(e).slice(0, 500); }
  console.log('click error (if any):', clickError);
  const afterClick = await dump('after-click-attempt');
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '04-after-click-attempt.png'), fullPage: false });

  await writeFile(path.join(EVIDENCE_DIR, 'diagnostics.json'), JSON.stringify({ before, after, afterClick, clickError, overlapBefore: overlaps(before.stickyRect, before.titleRect), overlapAfter: overlaps(after.stickyRect, after.titleRect) }, null, 2));

  // === HYPOTHESIS: close the (wrong-target) peek modal via its real close
  // button, then interact with the MAIN routed page's own title/body, which
  // is unobstructed once the modal is gone. ===
  const closeBtn = page.locator('[data-testid="view-modal-close"]');
  const closeVisible = await closeBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
  console.log('close button visible:', closeVisible);
  if (closeVisible) {
    await closeBtn.first().click();
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '05-after-modal-close.png'), fullPage: false });

  const mainTitleCheck = await page.evaluate((id) => {
    const el = document.getElementById(`editor-title-${id}`);
    const dialogStillOpen = !!document.querySelector('.MuiDialog-root[role="presentation"]') &&
      getComputedStyle(document.querySelector('.MuiDialog-root')).display !== 'none';
    if (!el) return { found: false, dialogStillOpen };
    const r = el.getBoundingClientRect();
    return { found: true, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, dialogStillOpen };
  }, docPageId);
  console.log('MAIN TITLE CHECK after modal close:', JSON.stringify(mainTitleCheck));

  let mainClickError = null;
  try {
    await page.locator(`#editor-title-${docPageId}`).click({ timeout: 8000 });
  } catch (e) { mainClickError = String(e).slice(0, 300); }
  console.log('main title click error (if any):', mainClickError);

  if (!mainClickError) {
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const marker = `diag-marker-${Date.now()}`;
    await page.keyboard.type(marker, { delay: 20 });
    await page.waitForTimeout(500);
    const bodyText = await page.locator(`[data-slate-editor="true"][id$="editor-${docPageId}"]`).first().innerText().catch(() => '(not found)');
    const titleText = await page.locator(`#editor-title-${docPageId}`).innerText().catch(() => '(not found)');
    console.log('AFTER TYPING: bodyText=', JSON.stringify(bodyText), 'titleText=', JSON.stringify(titleText), 'markerTyped=', marker);
    console.log('MARKER LANDED IN BODY (not title):', bodyText.includes(marker) && !titleText.includes(marker));
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '06-after-type-attempt.png'), fullPage: false });

  await browser.close();
} finally {
  try { if (frontendProcess) killPort(FRONTEND_PORT); } catch {}
  try { if (backendProcess) killPort(BACKEND_PORT); } catch {}
  await copyFile(ENV_LOCAL_BACKUP_PATH, ENV_LOCAL_PATH);
  const restored = await readFile(ENV_LOCAL_PATH);
  console.log('env.local restored, matches original:', Buffer.compare(restored, original) === 0);
}
