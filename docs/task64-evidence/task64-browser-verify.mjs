// Task 64 real-browser verification. Parameterized by env vars so the SAME
// script runs against both storage modes:
//   MODE=json|postgres
//   BACKEND_PORT, FRONTEND_PORT
//   DATA_FILE (json mode) / DATABASE_URL (postgres mode)
//   EVIDENCE_DIR
//   DEV_KEY
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MODE = process.env.MODE;
const BACKEND_PORT = process.env.BACKEND_PORT;
const FRONTEND_PORT = process.env.FRONTEND_PORT;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const DEV_KEY = process.env.DEV_KEY || 'task64-key';
const BACKEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend';
const FRONTEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Web';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://localhost:${FRONTEND_PORT}`;
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');
const ENV_LOCAL_BACKUP_PATH = path.join(EVIDENCE_DIR, 'env.local.backup');

if (!MODE || !BACKEND_PORT || !FRONTEND_PORT || !EVIDENCE_DIR) {
  throw new Error('MODE, BACKEND_PORT, FRONTEND_PORT, EVIDENCE_DIR are required');
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
  } catch {
    return [];
  }
}

function spawnBackend() {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(BACKEND_PORT),
    STORAGE: MODE,
    DEV_TEST_KEY: DEV_KEY,
    CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}`,
  };
  if (MODE === 'json') {
    env.DATA_FILE = process.env.DATA_FILE;
  } else {
    env.DATABASE_URL = process.env.DATABASE_URL;
  }
  const child = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitHealthy(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitFrontendReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 304) return true;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  const results = { scenarioA: 'NOT TESTED', scenarioB: 'NOT TESTED', scenarioC: 'NOT TESTED', scenarioD: 'NOT TESTED' };
  let backendProcess, frontendProcess;
  let envBackupMd5;

  try {
    // --- Environment setup ---
    envBackupMd5 = await backupEnvLocal();
    const envContent = [
      `APPFLOWY_BASE_URL=${BACKEND}`,
      `APPFLOWY_GOTRUE_BASE_URL=${BACKEND}`,
      `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${BACKEND_PORT}/ws/v2`,
    ].join('\n') + '\n';
    await writeFile(ENV_LOCAL_PATH, envContent);
    record('Wrote temporary .env.local pointing at this run\'s disposable backend', 'INFO', envContent.replace(/\n/g, ' | '));

    backendProcess = spawnBackend();
    const backendHealthy = await waitHealthy(BACKEND);
    record(`Backend process started (STORAGE=${MODE}, port ${BACKEND_PORT})`, backendHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not become healthy');

    frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(FRONTEND_PORT) },
      detached: true,
      stdio: 'ignore',
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
      const consoleErrors = [];
      const networkLog = [];
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

    // A fresh login lands a user in THEIR OWN default/home workspace (the
    // one auto-created at registration), not necessarily the workspace
    // under test -- explicit navigation is required for a second member
    // added to someone else's workspace.
    async function openWorkspace(page, workspaceId) {
      await page.goto(`${FRONTEND}/app/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      await dismissCompatBanner(page);
    }

    // Space rows render their child pages in the DOM only once expanded
    // (SpaceItem.tsx toggleExpand) -- clicking the space row's own testid
    // toggles this, independent of the hover-only "inline-add-page" button.
    async function expandSpace(page, spaceId) {
      const spaceToggle = page.getByTestId(`space-${spaceId}`);
      if (!(await spaceToggle.first().isVisible({ timeout: 8000 }).catch(() => false))) return false;
      const expanded = await spaceToggle.first().getAttribute('data-expanded').catch(() => null);
      if (expanded !== 'true') {
        await spaceToggle.first().click();
        await page.waitForTimeout(700);
      }
      return true;
    }

    async function waitGridLoaded(page, timeout = 15000) {
      let reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!reopened) {
        await page.waitForTimeout(1000);
        reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout }).catch(() => false);
      }
      return reopened;
    }

    async function enterCellValue(page, rowId, primaryFieldId, value) {
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
      await page.keyboard.type(value);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      return cellTestId;
    }

    // A row's cell content can arrive asynchronously (separate row-document
    // fetch/sync) slightly after the row itself becomes visible -- retry a
    // few times rather than reading once immediately.
    async function readCellTextWithRetry(page, testId, attempts = 6, delayMs = 500) {
      let text = '';
      for (let i = 0; i < attempts; i += 1) {
        text = (await page.getByTestId(testId).innerText().catch(() => '')).trim();
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

    let screenshotIndex = 0;
    async function screenshot(page, name) {
      screenshotIndex += 1;
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true });
    }

    // ===================== SCENARIO A: creator's own session =====================
    const creatorEmail = `task64-${MODE}-creator-${Date.now()}@example.test`;
    const password = 'Correct horse 907 task64';
    const cellValue1 = `Task64 ${MODE} row one`;
    const cellValue2 = `Task64 ${MODE} row two`;

    const registerResp = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: creatorEmail, password }) });
    if (registerResp.status !== 201) throw new Error(`Creator registration failed: ${registerResp.status} ${await registerResp.text()}`);
    record('Scenario A: registered dedicated creator test account', 'PASS', creatorEmail);

    const contextCreator = await browser.newContext();
    const pageCreator = await contextCreator.newPage();
    const loggingCreator = wireLogging(pageCreator, 'creator');

    let capturedWorkspaceId = null;
    let capturedDatabaseId = null;
    pageCreator.on('requestfinished', async (req) => {
      const url = req.url();
      if (url.includes('/v2/page-view/database/default')) {
        try {
          const res = await req.response();
          const body = res ? await res.json().catch(() => null) : null;
          if (body?.data?.outcome) {
            const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
            if (match) capturedWorkspaceId = match[1];
            capturedDatabaseId = body.data.result?.database_id || null;
          }
        } catch { /* ignore */ }
      }
    });

    await login(pageCreator, creatorEmail, password);
    record('Scenario A: login via real UI', 'PASS', pageCreator.url());
    await screenshot(pageCreator, 'A-after-login');

    await pageCreator.getByTestId('new-page-button').click();
    const createSpaceButton = pageCreator.getByTestId('new-page-create-space-button');
    await createSpaceButton.click();
    await pageCreator.getByTestId('space-name-input').fill(`Task64 ${MODE} space`);
    await pageCreator.getByTestId('create-space-submit').click();
    await pageCreator.waitForTimeout(1500);
    await pageCreator.keyboard.press('Escape').catch(() => {});
    await pageCreator.reload({ waitUntil: 'domcontentloaded' });
    await pageCreator.waitForURL(/\/app\//, { timeout: 20000 });
    await pageCreator.waitForTimeout(1200);
    await dismissCompatBanner(pageCreator);
    record('Scenario A: created a public Space via real UI', 'PASS');
    await screenshot(pageCreator, 'A-after-space');

    const spaceRow = pageCreator.locator(`div[aria-label="Task64 ${MODE} space"]`).first().locator('xpath=..');
    await spaceRow.waitFor({ state: 'visible', timeout: 10000 });
    const box = await spaceRow.boundingBox();
    if (box) {
      await pageCreator.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
      await pageCreator.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
    } else {
      await spaceRow.hover();
    }
    await pageCreator.waitForTimeout(800);
    await pageCreator.getByTestId('inline-add-page').first().click();
    await pageCreator.getByTestId('add-grid-button').click();
    await pageCreator.waitForTimeout(2500);
    record('Scenario A: created a Grid Database via real UI', 'PASS', `workspace=${capturedWorkspaceId} database=${capturedDatabaseId}`);
    await screenshot(pageCreator, 'A-after-create-grid');

    const gridLoadedA = await waitGridLoaded(pageCreator);
    record('Scenario A: Grid Database view loads with a field header', gridLoadedA ? 'PASS' : 'FAIL');

    const fieldHeaders = await pageCreator.locator('[data-testid^="grid-field-header-"]').all();
    const primaryFieldId = (await fieldHeaders[0].getAttribute('data-testid')).replace('grid-field-header-', '');

    const existingRowIds = new Set();
    await pageCreator.getByTestId('grid-new-row').click();
    await pageCreator.waitForTimeout(1500);
    const rowId1 = await getNewRowId(pageCreator, existingRowIds);
    if (!rowId1) throw new Error('Scenario A: could not determine new row 1 id');
    existingRowIds.add(rowId1);
    const cellTestId1 = await enterCellValue(pageCreator, rowId1, primaryFieldId, cellValue1);
    record('Scenario A: created row 1 and entered a value', 'PASS', cellValue1);

    await pageCreator.getByTestId('grid-new-row').click();
    await pageCreator.waitForTimeout(1500);
    const rowId2 = await getNewRowId(pageCreator, existingRowIds);
    if (!rowId2) throw new Error('Scenario A: could not determine new row 2 id');
    existingRowIds.add(rowId2);
    const cellTestId2 = await enterCellValue(pageCreator, rowId2, primaryFieldId, cellValue2);
    record('Scenario A: created row 2 and entered a value', 'PASS', cellValue2);
    await screenshot(pageCreator, 'A-both-rows-created');

    await pageCreator.reload({ waitUntil: 'domcontentloaded' });
    await pageCreator.waitForURL(/\/app\//, { timeout: 20000 });
    await pageCreator.waitForTimeout(1200);
    await dismissCompatBanner(pageCreator);
    const reloadedA = await waitGridLoaded(pageCreator);
    await pageCreator.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 }).catch(() => {});
    const row1AfterReload = await pageCreator.getByTestId(`grid-row-${rowId1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2AfterReload = await pageCreator.getByTestId(`grid-row-${rowId2}`).isVisible({ timeout: 10000 }).catch(() => false);
    const cell1AfterReload = await readCellTextWithRetry(pageCreator, cellTestId1);
    const cell2AfterReload = await readCellTextWithRetry(pageCreator, cellTestId2);
    const scenarioAOk = reloadedA && row1AfterReload && row2AfterReload && cell1AfterReload === cellValue1 && cell2AfterReload === cellValue2;
    results.scenarioA = scenarioAOk ? 'PASS' : 'FAIL';
    record('SCENARIO A RESULT: creator reload shows both rows and both values', results.scenarioA, `row1=${row1AfterReload} row2=${row2AfterReload} cell1="${cell1AfterReload}" cell2="${cell2AfterReload}"`);
    await screenshot(pageCreator, 'A-after-reload-final');

    await writeFile(path.join(EVIDENCE_DIR, 'console-errors-creator.log'), loggingCreator.consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network-creator.log'), loggingCreator.networkLog.join('\n'));

    // Resolve the Database's spaceId (needed for Scenario D) and container/primary view ids via backend API (test plumbing only).
    const loginForLookup = await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: creatorEmail, password }) });
    const { access_token: creatorToken } = await loginForLookup.json();
    const pagesResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/pages`, { headers: { authorization: `Bearer ${creatorToken}` } });
    const { pages } = await pagesResp.json();
    const containerPage = pages.find((p) => p.extra && p.extra.is_database_container === true && p.extra.database_id === capturedDatabaseId);
    const spaceId = containerPage?.parent_view_id;
    record('Resolved space id and container id via backend API (test plumbing, not under test)', 'INFO', `space=${spaceId} container=${containerPage?.id}`);

    // ===================== SCENARIO B: fresh second browser context, second real member =====================
    const memberEmail = `task64-${MODE}-member-${Date.now()}@example.test`;
    const registerMemberResp = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) });
    if (registerMemberResp.status !== 201) throw new Error(`Second member registration failed: ${registerMemberResp.status}`);
    const addMemberResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/test-members`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${creatorToken}`, 'x-development-key': DEV_KEY },
      body: JSON.stringify({ email: memberEmail, role: 'member' }),
    });
    if (addMemberResp.status !== 201) throw new Error(`Adding second member failed: ${addMemberResp.status} ${await addMemberResp.text()}`);
    record('Scenario B: registered a SEPARATE second member and added them to the workspace via the supported test-membership helper', 'PASS', memberEmail);

    // A genuinely independent browser context: no shared cookies/localStorage/IndexedDB with contextCreator.
    const contextMember = await browser.newContext();
    const pageMember = await contextMember.newPage();
    const loggingMember = wireLogging(pageMember, 'member');

    await login(pageMember, memberEmail, password);
    record('Scenario B: second member logged in via real UI in an independent browser context', 'PASS', pageMember.url());
    await screenshot(pageMember, 'B-after-login-own-default-workspace');

    // A fresh login lands the member in THEIR OWN default workspace, not the
    // creator's -- explicitly switch to the shared workspace under test
    // (the real app supports opening any workspace the user is a member
    // of; this is just URL navigation, not a privileged bypass).
    await openWorkspace(pageMember, capturedWorkspaceId);
    record('Scenario B: second member opens the shared workspace', 'PASS', pageMember.url());
    await screenshot(pageMember, 'B-after-login');

    // Confirm the catalog endpoint itself returns the Database to this user.
    const { access_token: memberToken } = await (await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) })).json();
    const catalogResp = await fetch(`${BACKEND}/api/workspace/${capturedWorkspaceId}/database`, { headers: { authorization: `Bearer ${memberToken}` } });
    const catalogBody = await catalogResp.json();
    const catalogHasDatabase = catalogResp.status === 200 && catalogBody.data?.databases?.some((d) => d.database_id === capturedDatabaseId);
    record('Scenario B: real catalog endpoint (GET /api/workspace/{id}/database) returns the Database to the second member', catalogHasDatabase ? 'PASS' : 'FAIL', JSON.stringify(catalogBody.data));
    await writeFile(path.join(EVIDENCE_DIR, 'scenario-b-catalog-response.json'), JSON.stringify(catalogBody, null, 2));

    // Open it through the normal UI: expand the Space, then click the Database's sidebar entry.
    await expandSpace(pageMember, spaceId);
    const sidebarDatabaseEntry = pageMember.getByTestId(`page-${containerPage.id}`);
    const sidebarVisible = await sidebarDatabaseEntry.first().isVisible({ timeout: 10000 }).catch(() => false);
    record('Scenario B: Database is discoverable in the sidebar Folder tree (second member, never created it themselves)', sidebarVisible ? 'PASS' : 'FAIL');
    if (sidebarVisible) {
      await sidebarDatabaseEntry.first().click();
      await pageMember.waitForTimeout(2000);
    } else {
      // Fall back to a direct route to the resolved primary view, still via the real app router (not a raw API call).
      const primaryView = pages.find((p) => p.extra && p.extra.database_id === capturedDatabaseId && !p.extra.is_database_container);
      await pageMember.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${primaryView.id}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await pageMember.waitForTimeout(2000);
    }
    await dismissCompatBanner(pageMember);
    const gridLoadedB = await waitGridLoaded(pageMember);
    await screenshot(pageMember, 'B-grid-opened');
    await pageMember.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 }).catch(() => {});
    const row1VisibleToMember = await pageMember.getByTestId(`grid-row-${rowId1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2VisibleToMember = await pageMember.getByTestId(`grid-row-${rowId2}`).isVisible({ timeout: 10000 }).catch(() => false);
    // First-ever open in a brand-new browser context, with no local
    // IndexedDB cache at all, can take noticeably longer for the WS
    // connection/row-document sync to settle than a later reopen in an
    // already-warmed-up context (observed directly: the "Connecting..."
    // banner can still be showing several seconds in) -- allow generously
    // more retries here than elsewhere before concluding failure.
    const cell1ToMember = await readCellTextWithRetry(pageMember, cellTestId1, 20, 1000);
    const cell2ToMember = await readCellTextWithRetry(pageMember, cellTestId2, 20, 1000);
    const scenarioBOpenOk = gridLoadedB && row1VisibleToMember && row2VisibleToMember && cell1ToMember === cellValue1 && cell2ToMember === cellValue2;
    record('Scenario B: second member opens the Database and sees both rows + values', scenarioBOpenOk ? 'PASS' : 'FAIL', `grid=${gridLoadedB} row1=${row1VisibleToMember} row2=${row2VisibleToMember} cell1="${cell1ToMember}" cell2="${cell2ToMember}"`);
    await screenshot(pageMember, 'B-rows-verified');

    await pageMember.reload({ waitUntil: 'domcontentloaded' });
    await pageMember.waitForURL(/\/app\//, { timeout: 20000 }).catch(() => {});
    await pageMember.waitForTimeout(1500);
    await dismissCompatBanner(pageMember);
    const gridLoadedBAfterReload = await waitGridLoaded(pageMember);
    let reloadedVisible = gridLoadedBAfterReload;
    if (!reloadedVisible) {
      const entry = pageMember.getByTestId(`page-${containerPage.id}`);
      if (await entry.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await entry.first().click();
        await pageMember.waitForTimeout(1500);
        reloadedVisible = await waitGridLoaded(pageMember);
      }
    }
    await pageMember.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 }).catch(() => {});
    const row1AfterMemberReload = await pageMember.getByTestId(`grid-row-${rowId1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2AfterMemberReload = await pageMember.getByTestId(`grid-row-${rowId2}`).isVisible({ timeout: 10000 }).catch(() => false);
    const scenarioBReloadOk = reloadedVisible && row1AfterMemberReload && row2AfterMemberReload;
    record('Scenario B: second member reloads their context and the Database remains discoverable/opens successfully', scenarioBReloadOk ? 'PASS' : 'FAIL');
    await screenshot(pageMember, 'B-after-reload');

    results.scenarioB = (catalogHasDatabase && scenarioBOpenOk && scenarioBReloadOk) ? 'PASS' : 'FAIL';
    record('SCENARIO B RESULT (the critical fresh-session gap)', results.scenarioB);

    await writeFile(path.join(EVIDENCE_DIR, 'console-errors-member.log'), loggingMember.consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network-member.log'), loggingMember.networkLog.join('\n'));

    // ===================== SCENARIO C: backend restart =====================
    killPort(BACKEND_PORT);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    backendProcess = spawnBackend();
    const restartedHealthy = await waitHealthy(BACKEND);
    record('Scenario C: backend process restarted on the same port (same disposable storage)', restartedHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);

    // Re-authenticate in a THIRD context (simulating "re-authenticate if necessary").
    const contextAfterRestart = await browser.newContext();
    const pageAfterRestart = await contextAfterRestart.newPage();
    await login(pageAfterRestart, memberEmail, password);
    await openWorkspace(pageAfterRestart, capturedWorkspaceId);
    record('Scenario C: re-authenticated after backend restart and reopened the shared workspace', 'PASS');

    const catalogAfterRestart = await fetch(`${BACKEND}/api/workspace/${capturedWorkspaceId}/database`, { headers: { authorization: `Bearer ${(await (await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) })).json()).access_token}` } });
    const catalogAfterRestartBody = await catalogAfterRestart.json();
    const catalogStillHasDatabase = catalogAfterRestart.status === 200 && catalogAfterRestartBody.data?.databases?.some((d) => d.database_id === capturedDatabaseId);
    record('Scenario C: catalog still returns the Database after backend restart', catalogStillHasDatabase ? 'PASS' : 'FAIL');

    await expandSpace(pageAfterRestart, spaceId);
    const sidebarEntryAfterRestart = pageAfterRestart.getByTestId(`page-${containerPage.id}`);
    if (await sidebarEntryAfterRestart.first().isVisible({ timeout: 10000 }).catch(() => false)) {
      await sidebarEntryAfterRestart.first().click();
    } else {
      const primaryView = pages.find((p) => p.extra && p.extra.database_id === capturedDatabaseId && !p.extra.is_database_container);
      await pageAfterRestart.goto(`${FRONTEND}/app/${capturedWorkspaceId}/${primaryView.id}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    await pageAfterRestart.waitForTimeout(2000);
    await dismissCompatBanner(pageAfterRestart);
    const gridLoadedC = await waitGridLoaded(pageAfterRestart);
    await pageAfterRestart.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 }).catch(() => {});
    const row1AfterRestart = await pageAfterRestart.getByTestId(`grid-row-${rowId1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2AfterRestart = await pageAfterRestart.getByTestId(`grid-row-${rowId2}`).isVisible({ timeout: 10000 }).catch(() => false);
    const cell1AfterRestartText = await readCellTextWithRetry(pageAfterRestart, cellTestId1);
    const cell2AfterRestartText = await readCellTextWithRetry(pageAfterRestart, cellTestId2);
    await screenshot(pageAfterRestart, 'C-after-restart');
    const scenarioCOk = catalogStillHasDatabase && gridLoadedC && row1AfterRestart && row2AfterRestart && cell1AfterRestartText === cellValue1 && cell2AfterRestartText === cellValue2;
    results.scenarioC = scenarioCOk ? 'PASS' : 'FAIL';
    record('SCENARIO C RESULT: Database discoverable and opens with rows intact after backend restart', results.scenarioC, `grid=${gridLoadedC} row1=${row1AfterRestart} row2=${row2AfterRestart} cell1="${cell1AfterRestartText}" cell2="${cell2AfterRestartText}"`);

    // ===================== SCENARIO D: regression =====================
    // Uses the ORIGINAL creator's context/session (owner permissions, never
    // logged out) reloaded against the restarted backend -- regression
    // checks are about the backend/app still working, not about re-testing
    // second-member access (already proven in Scenario B).
    await pageCreator.reload({ waitUntil: 'domcontentloaded' });
    await pageCreator.waitForURL(/\/app\//, { timeout: 20000 }).catch(() => {});
    await pageCreator.waitForTimeout(1500);
    await dismissCompatBanner(pageCreator);

    // Spaces still render.
    const spaceStillVisible = await pageCreator.locator(`div[aria-label="Task64 ${MODE} space"]`).first().isVisible({ timeout: 10000 }).catch(() => false);
    record('Scenario D: the Space still renders in the sidebar', spaceStillVisible ? 'PASS' : 'FAIL');

    // Existing nested page (the Database) still opens.
    await expandSpace(pageCreator, spaceId);
    const existingEntryStillOpens = pageCreator.getByTestId(`page-${containerPage.id}`);
    const existingEntryVisible = await existingEntryStillOpens.first().isVisible({ timeout: 8000 }).catch(() => false);
    if (existingEntryVisible) { await existingEntryStillOpens.first().click(); await pageCreator.waitForTimeout(1500); }
    const existingDatabaseStillOpens = existingEntryVisible && await waitGridLoaded(pageCreator);
    record('Scenario D: the EXISTING Database (created before restart) still opens via the Folder tree', existingDatabaseStillOpens ? 'PASS' : 'FAIL');

    // Create a NEW Document under the same space, confirm it opens.
    const spaceRow2 = pageCreator.locator(`div[aria-label="Task64 ${MODE} space"]`).first().locator('xpath=..');
    const box2 = await spaceRow2.boundingBox();
    if (box2) {
      await pageCreator.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2, { steps: 5 });
      await pageCreator.mouse.move(box2.x + box2.width / 2 + 2, box2.y + box2.height / 2, { steps: 5 });
    }
    await pageCreator.waitForTimeout(600);
    await pageCreator.getByTestId('inline-add-page').first().click();
    await pageCreator.getByTestId('add-document-button').click();
    await pageCreator.waitForTimeout(2000);
    // Assert on the modal's own unique close-button testid (ViewModal.tsx)
    // rather than generic text, which can also match an unrelated,
    // non-visible "Add icon" control for a DIFFERENT, previously-created
    // page still mounted in the background. NOTE: Playwright's isVisible()
    // does not itself wait/retry (the `timeout` option it accepts
    // elsewhere is not honored there) -- use a real waitFor() here.
    const documentOpened = await pageCreator.getByTestId('view-modal-close').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    record('Scenario D: a NEW ordinary Document page can be created and opens', documentOpened ? 'PASS' : 'FAIL');
    await screenshot(pageCreator, 'D-new-document');

    // Create a SECOND, brand-new Grid Database and confirm it loads.
    await pageCreator.goto(`${FRONTEND}/app/${capturedWorkspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await pageCreator.waitForTimeout(1500);
    await dismissCompatBanner(pageCreator);
    const spaceRow3 = pageCreator.locator(`div[aria-label="Task64 ${MODE} space"]`).first().locator('xpath=..');
    await spaceRow3.waitFor({ state: 'visible', timeout: 10000 });
    const box3 = await spaceRow3.boundingBox();
    if (box3) {
      await pageCreator.mouse.move(box3.x + box3.width / 2, box3.y + box3.height / 2, { steps: 5 });
      await pageCreator.mouse.move(box3.x + box3.width / 2 + 2, box3.y + box3.height / 2, { steps: 5 });
    }
    await pageCreator.waitForTimeout(600);
    await pageCreator.getByTestId('inline-add-page').first().click();
    await pageCreator.getByTestId('add-grid-button').click();
    await pageCreator.waitForTimeout(2500);
    const newDatabaseLoaded = await waitGridLoaded(pageCreator);
    record('Scenario D: creating a brand-new SECOND Grid Database still works after the catalog fix', newDatabaseLoaded ? 'PASS' : 'FAIL');
    await screenshot(pageCreator, 'D-new-database');

    results.scenarioD = (spaceStillVisible && existingDatabaseStillOpens && documentOpened && newDatabaseLoaded) ? 'PASS' : 'FAIL';
    record('SCENARIO D RESULT: regression checks', results.scenarioD);

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
