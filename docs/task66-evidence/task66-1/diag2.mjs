// Diagnostic 2: focused repro of "type into the FULL-PAGE (non-modal) route
// right after navigating there" -- does the keyboard-navigation path
// (title click -> End -> ArrowDown -> type) actually insert text there, and
// if not, what DOES work (direct click on the body/placeholder)?
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_PORT = 8798;
const FRONTEND_PORT = 5198;
const BACKEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend';
const FRONTEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Web';
const EVIDENCE_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend/docs/task66-evidence/task66-1/diag2';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://localhost:${FRONTEND_PORT}`;
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');
const ENV_LOCAL_BACKUP_PATH = path.join(EVIDENCE_DIR, 'env.local.diag2.backup');
const DATA_FILE = path.join(EVIDENCE_DIR, 'diag2-data.json');

await mkdir(EVIDENCE_DIR, { recursive: true });

function killPort(port) {
  try {
    const pidOutput = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`).toString().trim();
    for (const pid of pidOutput.split('\n').filter(Boolean)) { execSync(`kill ${pid}`); }
  } catch {}
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
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(BACKEND_PORT), STORAGE: 'json', DATA_FILE, DEV_TEST_KEY: 'diag2-key', CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}` },
    detached: true, stdio: 'ignore',
  });
  backendProcess.unref();
  console.log('backend healthy:', await waitHealthy(BACKEND));

  frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, detached: true, stdio: 'ignore',
  });
  frontendProcess.unref();
  console.log('frontend ready:', await waitFrontendReady(FRONTEND));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  context.setDefaultTimeout(20000);
  const page = await context.newPage();

  const email = `diag2-owner-${Date.now()}@example.test`;
  const password = 'Correct horse 907 diag2';
  await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

  await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email-input').fill(email);
  await page.getByTestId('login-password-button').click();
  await page.getByTestId('password-input').fill(password);
  await page.getByTestId('password-submit-button').click();
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForTimeout(1000);
  const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
  if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) { await dismissBanner.first().click(); await page.waitForTimeout(300); }

  let capturedWorkspaceId = null;
  page.on('requestfinished', async (req) => {
    const m = req.url().match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
    if (m) capturedWorkspaceId = m[1];
  });

  await page.getByTestId('new-page-button').click();
  await page.getByTestId('new-page-create-space-button').click();
  await page.getByTestId('space-name-input').fill('Diag2 space');
  await page.getByTestId('create-space-submit').click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape').catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForTimeout(1200);

  const spaceRow = page.locator('div[aria-label="Diag2 space"]').first().locator('xpath=..');
  await spaceRow.waitFor({ state: 'visible', timeout: 10000 });
  const box = await spaceRow.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
  }
  await page.waitForTimeout(800);
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-document-button').click();

  let realId = null;
  for (let i = 0; i < 40; i += 1) {
    realId = await page.evaluate(() => {
      const dlg = document.querySelector('.MuiDialog-root');
      const t = dlg?.querySelector('[data-testid="page-title-input"]');
      return t?.id?.replace('editor-title-', '') || null;
    });
    if (realId) break;
    await page.waitForTimeout(250);
  }
  console.log('realId (from modal)', realId);

  // Go straight to the full-page URL WITHOUT typing in the modal at all.
  await page.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${realId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-fullpage-just-navigated.png'), fullPage: false });

  const initialState = await page.evaluate((id) => {
    const title = document.getElementById(`editor-title-${id}`);
    const body = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
    return {
      titleFound: !!title, titleText: title?.textContent, titleRect: title?.getBoundingClientRect(),
      bodyFound: !!body, bodyId: body?.id, bodyText: body?.textContent,
      activeElement: document.activeElement?.id,
    };
  }, realId);
  console.log('INITIAL STATE on full page:', JSON.stringify(initialState));

  // Attempt 1: title click -> End -> ArrowDown -> type (the existing approach)
  await page.locator(`#editor-title-${realId}`).click();
  await page.waitForTimeout(200);
  const focusAfterTitleClick = await page.evaluate(() => document.activeElement?.id);
  console.log('focus after title click:', focusAfterTitleClick);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const focusAfterArrowDown = await page.evaluate(() => document.activeElement?.id);
  console.log('focus after ArrowDown:', focusAfterArrowDown);
  const selectionInfo1 = await page.evaluate(() => {
    const sel = window.getSelection();
    return { rangeCount: sel.rangeCount, anchorNodeType: sel.anchorNode?.nodeType, anchorNodeName: sel.anchorNode?.nodeName, isCollapsed: sel.isCollapsed };
  });
  console.log('selection after ArrowDown:', JSON.stringify(selectionInfo1));
  const marker1 = `diag2-attempt1-${Date.now()}`;
  await page.keyboard.type(marker1, { delay: 30 });
  await page.waitForTimeout(600);
  const afterAttempt1 = await page.evaluate((id) => {
    const body = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
    const title = document.getElementById(`editor-title-${id}`);
    return { bodyText: body?.textContent, titleText: title?.textContent };
  }, realId);
  console.log('AFTER ATTEMPT 1 (keyboard-nav):', JSON.stringify(afterAttempt1), 'marker=', marker1, 'landed in body?', afterAttempt1.bodyText?.includes(marker1));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-after-attempt1.png'), fullPage: false });

  // Attempt 2: DIRECT click on the body/placeholder itself (now that there is
  // no modal/sticky-header to intercept it -- the original blocker is gone).
  const bodyLocator = page.locator(`[data-slate-editor="true"][id$="editor-${realId}"]`).first();
  const bodyVisible = await bodyLocator.isVisible().catch(() => false);
  console.log('body locator visible for direct click?', bodyVisible);
  if (bodyVisible) {
    await bodyLocator.click();
    await page.waitForTimeout(200);
    const focusAfterBodyClick = await page.evaluate(() => document.activeElement?.id);
    console.log('focus after DIRECT body click:', focusAfterBodyClick);
    const marker2 = `diag2-attempt2-${Date.now()}`;
    await page.keyboard.type(marker2, { delay: 30 });
    await page.waitForTimeout(600);
    const afterAttempt2 = await page.evaluate((id) => {
      const body = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
      const title = document.getElementById(`editor-title-${id}`);
      return { bodyText: body?.textContent, titleText: title?.textContent };
    }, realId);
    console.log('AFTER ATTEMPT 2 (direct body click):', JSON.stringify(afterAttempt2), 'marker=', marker2, 'landed in body?', afterAttempt2.bodyText?.includes(marker2));
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-after-attempt2.png'), fullPage: false });

  // Attempt 3: reproduce the EXACT production typeIntoDocument sequence on a
  // FRESH SECOND empty document -- title click -> End -> ArrowDown -> wait
  // -> Control+a -> Meta+a -> Backspace -> wait -> type. This isolates
  // whether the Ctrl+A/Backspace "clear first" step on an EMPTY document is
  // what's breaking it.
  await page.goto(`${FRONTEND}/app/${capturedWorkspaceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await hoverSpaceRowLocal();
  async function hoverSpaceRowLocal() {
    const row = page.locator('div[aria-label="Diag2 space"]').first().locator('xpath=..');
    await row.waitFor({ state: 'visible', timeout: 10000 });
    const b = await row.boundingBox();
    if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 }); await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2, { steps: 5 }); }
    await page.waitForTimeout(800);
  }
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-document-button').click();
  let realId3 = null;
  for (let i = 0; i < 40; i += 1) {
    realId3 = await page.evaluate(() => {
      const dlg = document.querySelector('.MuiDialog-root');
      const t = dlg?.querySelector('[data-testid="page-title-input"]');
      return t?.id?.replace('editor-title-', '') || null;
    });
    if (realId3) break;
    await page.waitForTimeout(250);
  }
  console.log('realId3', realId3);
  await page.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${realId3}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.locator(`#editor-title-${realId3}`).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const focusBeforeClear = await page.evaluate(() => document.activeElement?.id);
  console.log('focus before clear-sequence:', focusBeforeClear);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+a').catch(() => {});
  await page.keyboard.press('Meta+a').catch(() => {});
  const selAfterSelectAll = await page.evaluate(() => {
    const sel = window.getSelection();
    return { isCollapsed: sel.isCollapsed, rangeCount: sel.rangeCount, anchorNodeName: sel.anchorNode?.nodeName, focusNodeName: sel.focusNode?.nodeName, toStringLen: sel.toString().length };
  });
  console.log('selection after Ctrl+A/Meta+A:', JSON.stringify(selAfterSelectAll));
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(300);
  const stateAfterBackspace = await page.evaluate((id) => {
    const body = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
    return { bodyHTML: body?.innerHTML, activeElement: document.activeElement?.id, bodyChildCount: body?.children.length };
  }, realId3);
  console.log('state after Backspace (before typing):', JSON.stringify(stateAfterBackspace));
  const marker3 = `diag2-attempt3-${Date.now()}`;
  await page.keyboard.type(marker3, { delay: 20 });
  await page.waitForTimeout(1200);
  const afterAttempt3 = await page.evaluate((id) => {
    const body = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
    return { bodyText: body?.textContent, bodyHTML: body?.innerHTML };
  }, realId3);
  console.log('AFTER ATTEMPT 3 (exact production clear-first sequence):', JSON.stringify(afterAttempt3), 'marker=', marker3, 'landed?', afterAttempt3.bodyText?.includes(marker3));
  const titleAfterAttempt3 = await page.locator(`#editor-title-${realId3}`).innerText().catch(() => '(err)');
  console.log('titleText after attempt 3 (did it leak into title?):', JSON.stringify(titleAfterAttempt3));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '04-after-attempt3.png'), fullPage: false });

  // Attempt 4: with content ALREADY present (from attempt 3's typed text,
  // if any landed, or just re-type first), clear using the SAME safe
  // technique the existing Grid-cell helper already uses successfully
  // (End -> Shift+Home -> Backspace, a same-block selection) instead of
  // Ctrl+A/Meta+A (a possible "select all" that empties the block enough to
  // trigger some body->title navigation shortcut), then type a new marker.
  await page.keyboard.type('seed-content-for-attempt4', { delay: 20 });
  await page.waitForTimeout(600);
  const seedState = await page.evaluate((id) => document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`)?.textContent, realId3);
  console.log('seed content before attempt4 clear:', JSON.stringify(seedState));
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const focusAfterSafeClear = await page.evaluate(() => document.activeElement?.id);
  console.log('focus after End->Shift+Home->Backspace clear:', focusAfterSafeClear);
  const marker4 = `diag2-attempt4-${Date.now()}`;
  await page.keyboard.type(marker4, { delay: 20 });
  await page.waitForTimeout(800);
  const afterAttempt4 = await page.evaluate((id) => document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`)?.textContent, realId3);
  console.log('AFTER ATTEMPT 4 (safe End->Shift+Home->Backspace clear):', JSON.stringify(afterAttempt4), 'marker=', marker4, 'landed?', afterAttempt4?.includes(marker4));

  // Attempt 5 (clean state): the REAL fix candidate -- never send a bare
  // Backspace that could empty the block to nothing. Select any existing
  // text first (Home -> Shift+End), then TYPE OVER it directly (replaces a
  // non-empty selection in one atomic step; inserts normally if nothing was
  // selected, i.e. a fresh empty paragraph). Verify both the first type
  // (nothing selected, fresh doc) and a SECOND type (replacing the first
  // marker) land correctly in the body, never the title.
  await page.goto(`${FRONTEND}/app/${capturedWorkspaceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await hoverSpaceRowLocal();
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-document-button').click();
  let realId5 = null;
  for (let i = 0; i < 40; i += 1) {
    realId5 = await page.evaluate(() => {
      const dlg = document.querySelector('.MuiDialog-root');
      const t = dlg?.querySelector('[data-testid="page-title-input"]');
      return t?.id?.replace('editor-title-', '') || null;
    });
    if (realId5) break;
    await page.waitForTimeout(250);
  }
  console.log('realId5', realId5);
  await page.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${realId5}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  async function safeTypeReplace(marker) {
    await page.locator(`#editor-title-${realId5}`).click();
    await page.waitForTimeout(100);
    const focusT = await page.evaluate(() => document.activeElement?.id);
    if (focusT !== `editor-title-${realId5}`) { await page.locator(`#editor-title-${realId5}`).click(); }
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.waitForTimeout(150);
    await page.keyboard.type(marker, { delay: 20 });
    await page.waitForTimeout(700);
    const focusAfter = await page.evaluate(() => document.activeElement?.id);
    const bodyT = await page.evaluate((id) => document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`)?.textContent, realId5);
    const titleT = await page.locator(`#editor-title-${realId5}`).innerText().catch(() => '(err)');
    return { focusAfter, bodyT, titleT };
  }

  const m5a = `diag2-attempt5a-${Date.now()}`;
  const result5a = await safeTypeReplace(m5a);
  console.log('ATTEMPT 5a (first type, fresh empty doc, safe replace technique):', JSON.stringify(result5a), 'marker=', m5a, 'landedInBody?', result5a.bodyT?.includes(m5a), 'leakedToTitle?', result5a.titleT?.includes(m5a));

  const m5b = `diag2-attempt5b-${Date.now()}`;
  const result5b = await safeTypeReplace(m5b);
  console.log('ATTEMPT 5b (SECOND type, replacing first marker, safe replace technique):', JSON.stringify(result5b), 'marker=', m5b, 'landedInBody?', result5b.bodyT?.includes(m5b), 'leakedToTitle?', result5b.titleT?.includes(m5b), 'oldMarkerGone?', !result5b.bodyT?.includes(m5a));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '05-after-attempt5.png'), fullPage: false });

  await browser.close();
} finally {
  try { if (frontendProcess) killPort(FRONTEND_PORT); } catch {}
  try { if (backendProcess) killPort(BACKEND_PORT); } catch {}
  await copyFile(ENV_LOCAL_BACKUP_PATH, ENV_LOCAL_PATH);
  const restored = await readFile(ENV_LOCAL_PATH);
  console.log('env.local restored, matches original:', Buffer.compare(restored, original) === 0);
}
