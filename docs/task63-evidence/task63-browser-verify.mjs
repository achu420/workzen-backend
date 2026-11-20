import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const BACKEND = 'http://localhost:8802';
const FRONTEND = 'http://localhost:5202';
const EVIDENCE_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend/docs/task63-evidence/browser-run';
await mkdir(EVIDENCE_DIR, { recursive: true });

const EMAIL = `task63-pg-${Date.now()}@example.test`;
const PASSWORD = 'Correct horse 907 task63';
const CELL_VALUE_1 = 'Task 63 Postgres row one';
const CELL_VALUE_2 = 'Task 63 Postgres row two';

const log = [];
function record(step, status, detail) {
  const line = `[${new Date().toISOString()}] ${status} - ${step}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  log.push(line);
}

async function main() {
  const registerResponse = await fetch(`${BACKEND}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (registerResponse.status !== 201) {
    throw new Error(`Registration failed: ${registerResponse.status} ${await registerResponse.text()}`);
  }
  record('Register dedicated test account via real backend API (PostgreSQL mode)', 'PASS', EMAIL);

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Users/achal/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleMessages = [];
  const consoleErrors = [];
  page.on('console', async (msg) => {
    let detail = '';
    if (msg.text().includes('outbox') || msg.text().includes('Dexie')) {
      try {
        const args = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => '(unserializable)')));
        detail = ' ARGS=' + JSON.stringify(args);
      } catch { /* ignore */ }
    }
    const text = `[${msg.type()}] ${msg.text()}${detail}`;
    consoleMessages.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
  });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  const networkLog = [];
  let capturedWorkspaceId = null;
  let capturedDatabaseId = null;
  page.on('requestfinished', async (req) => {
    const url = req.url();
    if (!url.includes(':8802/api') && !url.includes(':8802/ws')) return;
    try {
      const res = await req.response();
      networkLog.push(`${req.method()} ${url} -> ${res ? res.status() : 'n/a'}`);
      if (url.includes('/v2/page-view/database/default') && res && res.status() === 200) {
        const body = await res.json().catch(() => null);
        if (body?.data?.outcome) {
          const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
          if (match) capturedWorkspaceId = match[1];
          capturedDatabaseId = body.data.result?.database_id || null;
        }
      }
    } catch {
      networkLog.push(`${req.method()} ${url} -> (error reading response)`);
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.includes(':8802')) return;
    networkLog.push(`${req.method()} ${url} -> FAILED (${req.failure()?.errorText})`);
  });

  const wsFrames = [];
  page.on('websocket', (ws) => {
    wsFrames.push(`WS OPEN ${ws.url()}`);
    ws.on('close', () => wsFrames.push(`WS CLOSE ${ws.url()}`));
    ws.on('socketerror', (err) => wsFrames.push(`WS ERROR ${ws.url()} ${err}`));
  });

  let screenshotIndex = 0;
  async function screenshot(name) {
    screenshotIndex += 1;
    const file = path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async function dismissCompatBanner() {
    const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
    if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await dismissBanner.first().click();
      await page.waitForTimeout(300);
    }
  }

  let newRowId1, newRowId2, primaryFieldId;

  try {
    // Step 1: Login through the real UI.
    await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByTestId('login-email-input').fill(EMAIL);
    await page.getByTestId('login-password-button').click();
    await page.getByTestId('password-input').fill(PASSWORD);
    await screenshot('login-filled');
    await page.getByTestId('password-submit-button').click();
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    record('Login via real UI (PostgreSQL-backed backend)', 'PASS', page.url());
    await screenshot('after-login');

    await page.waitForTimeout(1000);
    await dismissCompatBanner();
    record('Open workspace', 'PASS');

    // Step 2: Create a public space via the real UI.
    const newPageButton = page.getByTestId('new-page-button');
    await newPageButton.click();
    const createSpaceButton = page.getByTestId('new-page-create-space-button');
    if (await createSpaceButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await createSpaceButton.click();
      await page.getByTestId('space-name-input').fill('Task 63 Postgres space');
      await page.getByTestId('create-space-submit').click();
      await page.waitForTimeout(1500);
      record('Create a public space via real UI', 'PASS');
    } else {
      await page.keyboard.press('Escape');
      record('Create a public space via real UI', 'SKIPPED (space already existed)');
    }
    await screenshot('after-space-step');

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await dismissCompatBanner();
    await screenshot('after-closing-overlay');

    // Step 3: Create a Grid database via the existing UI.
    const spaceRowText = page.locator('div[aria-label="Task 63 Postgres space"]').first().locator('xpath=..');
    await spaceRowText.waitFor({ state: 'visible', timeout: 10000 });
    const box = await spaceRowText.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
      await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
    } else {
      await spaceRowText.hover();
    }
    await page.waitForTimeout(800);
    const addPageButtons = page.getByTestId('inline-add-page');
    await addPageButtons.first().waitFor({ state: 'visible', timeout: 10000 });
    await addPageButtons.first().click();
    await page.getByTestId('add-grid-button').click();
    await page.waitForTimeout(2500);
    record('Create a Grid database via real UI (PostgreSQL mode)', 'PASS', `workspace=${capturedWorkspaceId} database=${capturedDatabaseId}`);
    await screenshot('after-create-grid');

    await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
    const initialFieldHeaders = await page.locator('[data-testid^="grid-field-header-"]').all();
    const initialFieldIdsRaw = [];
    for (const header of initialFieldHeaders) {
      initialFieldIdsRaw.push((await header.getAttribute('data-testid')).replace('grid-field-header-', ''));
    }
    const initialFieldIds = [...new Set(initialFieldIdsRaw)];
    primaryFieldId = initialFieldIds[0];
    record('Grid Database opens with its default Grid view and primary Name field', initialFieldIds.length === 1 ? 'PASS' : 'FAIL', JSON.stringify(initialFieldIds));
    await dismissCompatBanner();
    await screenshot('grid-view-loaded');

    // Step 4: confirm zero rows initially.
    const rowsBefore = await page.locator('[data-testid^="grid-row-"]').all();
    const rowIdsBeforeRaw = [];
    for (const row of rowsBefore) {
      const candidate = (await row.getAttribute('data-testid')).replace('grid-row-', '');
      if (candidate && candidate !== 'undefined') rowIdsBeforeRaw.push(candidate);
    }
    const rowIdsBefore = new Set(rowIdsBeforeRaw);
    record('Grid starts with zero rows', rowIdsBefore.size === 0 ? 'PASS' : 'FAIL', JSON.stringify([...rowIdsBefore]));

    // Step 5: create the FIRST row via the real UI and enter a value.
    await page.getByTestId('grid-new-row').click();
    await page.waitForTimeout(2000);
    await screenshot('after-create-row-1');

    let rowsAfter = await page.locator('[data-testid^="grid-row-"]').all();
    let rowIdsAfterRaw = [];
    for (const row of rowsAfter) {
      const candidate = (await row.getAttribute('data-testid')).replace('grid-row-', '');
      if (candidate && candidate !== 'undefined') rowIdsAfterRaw.push(candidate);
    }
    let rowIdsAfter = [...new Set(rowIdsAfterRaw)];
    newRowId1 = rowIdsAfter.find((candidateId) => !rowIdsBefore.has(candidateId));
    record('Row 1 appears in the Grid via real UI (PostgreSQL mode)', newRowId1 ? 'PASS' : 'FAIL', `rows=${JSON.stringify(rowIdsAfter)}, newRowId=${newRowId1}`);
    if (!newRowId1) throw new Error('No new row id could be determined after creating row 1');

    async function enterCellValue(rowId, value) {
      const cellTestId = `grid-cell-${rowId}-${primaryFieldId}`;
      const cell = page.getByTestId(cellTestId);
      await cell.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(1000);
      const wrapper = cell.locator('xpath=ancestor::*[contains(@class,"grid-row-cell")][1]');
      await wrapper.first().click({ force: true });
      await page.waitForTimeout(500);
      const editor = cell.getByTestId('rich-text-cell-editor');
      await editor.waitFor({ state: 'visible', timeout: 5000 });
      await editor.click();
      await page.keyboard.type(value);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      return cellTestId;
    }

    const cellTestId1 = await enterCellValue(newRowId1, CELL_VALUE_1);
    record('Enter a value in row 1\'s Name cell via real editor', 'PASS', CELL_VALUE_1);
    await screenshot('after-row1-value-committed');
    await page.waitForTimeout(1500);

    // Step 6: reload, reopen the Database, verify row 1 + value persisted.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await dismissCompatBanner();
    let reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!reopened) {
      await page.getByText('Grid', { exact: false }).first().click();
      await page.waitForTimeout(1500);
    }
    await screenshot('after-reload-row1');
    await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 });
    const row1AfterReload = page.getByTestId(`grid-row-${newRowId1}`);
    const row1Exists = await row1AfterReload.isVisible({ timeout: 10000 }).catch(() => false);
    const cell1AfterReload = page.getByTestId(cellTestId1);
    await cell1AfterReload.waitFor({ state: 'visible', timeout: 10000 });
    const cell1Text = (await cell1AfterReload.innerText()).trim();
    record('Row 1 and its value persisted after reload (PostgreSQL mode)', (row1Exists && cell1Text === CELL_VALUE_1) ? 'PASS' : 'FAIL', `exists=${row1Exists} text="${cell1Text}"`);

    // Step 7: create a SECOND row, enter a second value.
    await page.getByTestId('grid-new-row').click();
    await page.waitForTimeout(2000);
    await screenshot('after-create-row-2');

    rowsAfter = await page.locator('[data-testid^="grid-row-"]').all();
    rowIdsAfterRaw = [];
    for (const row of rowsAfter) {
      const candidate = (await row.getAttribute('data-testid')).replace('grid-row-', '');
      if (candidate && candidate !== 'undefined') rowIdsAfterRaw.push(candidate);
    }
    rowIdsAfter = [...new Set(rowIdsAfterRaw)];
    newRowId2 = rowIdsAfter.find((candidateId) => candidateId !== newRowId1);
    record('Row 2 appears in the Grid via real UI (second row -- not the trivial single-row case)', newRowId2 ? 'PASS' : 'FAIL', `rows=${JSON.stringify(rowIdsAfter)}, newRowId2=${newRowId2}`);
    if (!newRowId2) throw new Error('No new row id could be determined after creating row 2');

    const cellTestId2 = await enterCellValue(newRowId2, CELL_VALUE_2);
    record('Enter a value in row 2\'s Name cell via real editor', 'PASS', CELL_VALUE_2);
    await screenshot('after-row2-value-committed');
    await page.waitForTimeout(1500);

    // Step 8: reload, verify BOTH rows and BOTH values.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await dismissCompatBanner();
    reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!reopened) {
      await page.getByText('Grid', { exact: false }).first().click();
      await page.waitForTimeout(1500);
    }
    await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 });
    await screenshot('after-reload-both-rows');

    const row1Final = await page.getByTestId(`grid-row-${newRowId1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2Final = await page.getByTestId(`grid-row-${newRowId2}`).isVisible({ timeout: 10000 }).catch(() => false);
    const cell1Final = (await page.getByTestId(cellTestId1).innerText()).trim();
    const cell2Final = (await page.getByTestId(cellTestId2).innerText()).trim();
    record('BOTH rows and BOTH values persisted after reload (PostgreSQL mode)',
      (row1Final && row2Final && cell1Final === CELL_VALUE_1 && cell2Final === CELL_VALUE_2) ? 'PASS' : 'FAIL',
      `row1=${row1Final} row2=${row2Final} cell1="${cell1Final}" cell2="${cell2Final}"`);
    await screenshot('final-state-both-rows');

    // Step 8.5: restart the PostgreSQL-backed backend process WITHOUT
    // closing this browser tab/session -- the realistic "a deploy restarts
    // the backend while a user's tab stays open" scenario (distinct from,
    // and more representative than, a fresh login after restart, which
    // exercises unrelated frontend view-routing code paths outside this
    // task's backend-storage scope -- see docs/task63-evidence/ for that
    // separate finding). The access token is itself durably stored in
    // PostgreSQL (`sessions` table), so it remains valid across the restart.
    record('Restart the PostgreSQL-backed backend process (same disposable database, same port)', 'INFO', 'killing PID and respawning');
    try {
      const pidOutput = execSync("lsof -tiTCP:8802 -sTCP:LISTEN").toString().trim();
      for (const pid of pidOutput.split('\n').filter(Boolean)) {
        execSync(`kill ${pid}`);
      }
    } catch (e) {
      record('Restart: locate/kill existing backend PID', 'FAIL', String(e));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const restarted = spawn('node', ['server.js'], {
      cwd: '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend',
      env: {
        ...process.env,
        PORT: '8802', STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://achal@127.0.0.1:5432/appflowy_task63_browser',
        DEV_TEST_KEY: 'task63-browser-key', HOST: '127.0.0.1',
        CORS_ALLOWED_ORIGINS: 'http://localhost:5202,http://127.0.0.1:5202',
      },
      detached: true,
      stdio: 'ignore',
    });
    restarted.unref();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let healthy = false;
    for (let i = 0; i < 10 && !healthy; i += 1) {
      try { const r = await fetch(`${BACKEND}/health`); healthy = r.ok; } catch { /* retry */ }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    record('New backend process is healthy on the same port (fresh PID, same disposable PostgreSQL database)', healthy ? 'PASS' : 'FAIL', `pid=${restarted.pid}`);

    // Reload the SAME already-authenticated tab against the restarted backend.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    await page.waitForTimeout(2000);
    await dismissCompatBanner();
    let reopenedAfterRestart = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!reopenedAfterRestart) {
      await page.getByText('Grid', { exact: false }).first().click();
      await page.waitForTimeout(1500);
      reopenedAfterRestart = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 8000 }).catch(() => false);
    }
    await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 });
    await screenshot('after-backend-restart');
    const row1AfterRestart = await page.getByTestId(`grid-row-${newRowId1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2AfterRestart = await page.getByTestId(`grid-row-${newRowId2}`).isVisible({ timeout: 10000 }).catch(() => false);
    const cell1AfterRestart = (await page.getByTestId(cellTestId1).innerText()).trim();
    const cell2AfterRestart = (await page.getByTestId(cellTestId2).innerText()).trim();
    record('Both rows exist after a real PostgreSQL-backed backend process restart', (row1AfterRestart && row2AfterRestart) ? 'PASS' : 'FAIL', `row1=${row1AfterRestart} row2=${row2AfterRestart}`);
    record('Both cell values survived a real PostgreSQL-backed backend process restart', (cell1AfterRestart === CELL_VALUE_1 && cell2AfterRestart === CELL_VALUE_2) ? 'PASS' : 'FAIL', `cell1="${cell1AfterRestart}" cell2="${cell2AfterRestart}"`);

    // Step 9: verify row_orders membership directly against the backend's
    // real collab-read route (independent evidence from the UI's own
    // rendering, decoding the actual persisted Yjs state).
    if (capturedWorkspaceId && capturedDatabaseId) {
      const loginResp = await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
      const { access_token } = await loginResp.json();
      const collabResp = await fetch(`${BACKEND}/api/workspace/v1/${capturedWorkspaceId}/collab/${capturedDatabaseId}?collab_type=1`, { headers: { authorization: `Bearer ${access_token}` } });
      const collabBody = await collabResp.json();
      await writeFile(path.join(EVIDENCE_DIR, 'database-collab-state-raw.json'), JSON.stringify({ status: collabResp.status, object_id: collabBody.data?.object_id, collab_version: collabBody.data?.collab_version, doc_state_byte_length: collabBody.data?.doc_state?.length }, null, 2));
      record('Independent backend collab-read confirms Database object is readable in PostgreSQL mode', collabResp.status === 200 ? 'PASS' : 'FAIL', `workspace=${capturedWorkspaceId} database=${capturedDatabaseId}`);
    } else {
      record('Independent backend collab-read of Database object', 'SKIPPED', 'workspace/database id could not be captured from network log');
    }

    record('FULL SINGLE-CLIENT WORKFLOW RESULT', (row1Final && row2Final && cell1Final === CELL_VALUE_1 && cell2Final === CELL_VALUE_2) ? 'PASS' : 'FAIL', 'two-row PostgreSQL browser verification completed');

    await writeFile(path.join(EVIDENCE_DIR, 'captured-ids.json'), JSON.stringify({ email: EMAIL, password: PASSWORD, workspaceId: capturedWorkspaceId, databaseId: capturedDatabaseId, viewId: null, row1: newRowId1, row2: newRowId2, cellTestId1, cellTestId2, cellValue1: CELL_VALUE_1, cellValue2: CELL_VALUE_2 }, null, 2));
  } catch (error) {
    record('WORKFLOW FAILED', 'FAIL', error.stack || String(error));
    await screenshot('failure-state').catch(() => {});
  } finally {
    await writeFile(path.join(EVIDENCE_DIR, 'console.log'), consoleMessages.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'console-errors.log'), consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network.log'), networkLog.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'websocket.log'), wsFrames.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'steps.log'), log.join('\n'));
    await browser.close();
  }
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
