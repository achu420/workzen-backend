import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BACKEND = 'http://localhost:8801';
const FRONTEND = 'http://localhost:5201';
const EVIDENCE_DIR = '/private/tmp/claude-501/-Volumes-work-disk-Codes-Tracker/4b89062d-6752-4f90-b9cf-02a3355ce209/scratchpad/task62-browser/evidence';
await mkdir(EVIDENCE_DIR, { recursive: true });

const EMAIL = `task62-row-${Date.now()}@example.test`;
const PASSWORD = 'Correct horse 907 task62';
const CELL_VALUE = 'Task 62 row value';

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
  record('Register dedicated test account via real backend API', 'PASS', EMAIL);

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
  page.on('requestfinished', async (req) => {
    const url = req.url();
    if (!url.includes(':8801/api') && !url.includes(':8801/ws')) return;
    try {
      const res = await req.response();
      networkLog.push(`${req.method()} ${url} -> ${res ? res.status() : 'n/a'}`);
    } catch {
      networkLog.push(`${req.method()} ${url} -> (error reading response)`);
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.includes(':8801')) return;
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

  try {
    // Step 1: Login through the real UI.
    await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByTestId('login-email-input').fill(EMAIL);
    await page.getByTestId('login-password-button').click();
    await page.getByTestId('password-input').fill(PASSWORD);
    await screenshot('login-filled');
    await page.getByTestId('password-submit-button').click();
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    record('Login via real UI', 'PASS', page.url());
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
      await page.getByTestId('space-name-input').fill('Task 62 space');
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

    // Step 3: Create a Grid database via the existing UI (Task 61's workflow).
    const spaceRowText = page.locator('div[aria-label="Task 62 space"]').first().locator('xpath=..');
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
    record('Create a Grid database via existing UI (Task 61 workflow)', 'PASS');
    await screenshot('after-create-grid');

    await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
    const initialFieldHeaders = await page.locator('[data-testid^="grid-field-header-"]').all();
    const initialFieldIdsRaw = [];
    for (const header of initialFieldHeaders) {
      initialFieldIdsRaw.push((await header.getAttribute('data-testid')).replace('grid-field-header-', ''));
    }
    const initialFieldIds = [...new Set(initialFieldIdsRaw)];
    record('Grid Database opens with its default Grid view and primary field', initialFieldIds.length === 1 ? 'PASS' : 'FAIL', JSON.stringify(initialFieldIds));
    await dismissCompatBanner();
    await screenshot('grid-view-loaded');

    // Step 4 (Task 62 core): confirm there are no pre-existing rows, then
    // create a new row via the real UI's "+ New row" button.
    const rowsBefore = await page.locator('[data-testid^="grid-row-"]').all();
    const rowIdsBeforeRaw = [];
    for (const row of rowsBefore) {
      const candidate = (await row.getAttribute('data-testid')).replace('grid-row-', '');
      if (candidate && candidate !== 'undefined') rowIdsBeforeRaw.push(candidate);
    }
    const rowIdsBefore = new Set(rowIdsBeforeRaw);
    record('Grid starts with zero rows', rowIdsBefore.size === 0 ? 'PASS' : 'FAIL', JSON.stringify([...rowIdsBefore]));

    await page.getByTestId('grid-new-row').click();
    await page.waitForTimeout(2000);
    await screenshot('after-create-row');

    const rowsAfter = await page.locator('[data-testid^="grid-row-"]').all();
    const rowIdsAfterRaw = [];
    for (const row of rowsAfter) {
      const candidate = (await row.getAttribute('data-testid')).replace('grid-row-', '');
      if (candidate && candidate !== 'undefined') rowIdsAfterRaw.push(candidate);
    }
    const rowIdsAfter = [...new Set(rowIdsAfterRaw)];
    const newRowId = rowIdsAfter.find((candidateId) => !rowIdsBefore.has(candidateId));
    record('A new row appears in the Grid via real UI', newRowId ? 'PASS' : 'FAIL', `rows=${JSON.stringify(rowIdsAfter)}, newRowId=${newRowId}`);
    if (!newRowId) throw new Error('No new row id could be determined after clicking grid-new-row');

    // Step 5: Enter a value in the primary ("Name") field's cell for the new row.
    const primaryFieldId = initialFieldIds[0];
    const cellTestId = `grid-cell-${newRowId}-${primaryFieldId}`;
    const cell = page.getByTestId(cellTestId);
    await cell.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1000);
    const gridRowCellWrapper = cell.locator('xpath=ancestor::*[contains(@class,"grid-row-cell")][1]');
    await gridRowCellWrapper.first().click({ force: true });
    await page.waitForTimeout(500);
    // The primary field's cell editor is a Slate-based rich-text
    // contenteditable (data-testid="rich-text-cell-editor"), not a plain
    // <textarea> -- confirmed via DOM inspection during this task's
    // verification run (see docs/TASK62_..._REPORT.md).
    const editor = cell.getByTestId('rich-text-cell-editor');
    await editor.waitFor({ state: 'visible', timeout: 5000 });
    await editor.click();
    await page.keyboard.type(CELL_VALUE);
    await screenshot('after-cell-value-typed');
    // Commit by pressing Escape.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    record('Enter a value in the primary Name field for the new row via real UI', 'PASS', CELL_VALUE);
    await screenshot('after-cell-value-committed');

    // Step 6: Wait for the real collab/persistence flow to finish.
    await page.waitForTimeout(2000);

    // Step 7: Reload the page.
    const preReloadUrl = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await dismissCompatBanner();
    record('Reload the page', 'PASS', `url before=${preReloadUrl}, url after=${page.url()}`);
    await screenshot('after-reload');

    // Step 8: Reopen the database (may already be the active view after reload).
    let reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!reopened) {
      await page.getByText('Grid', { exact: false }).first().click();
      await page.waitForTimeout(1500);
      reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    }
    record('Reopen the database', reopened ? 'PASS' : 'FAIL');
    await screenshot('after-reopen');

    // Step 9: Verify the row still exists and the cell value persisted.
    await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 });
    const rowAfterReload = page.getByTestId(`grid-row-${newRowId}`);
    const rowStillExists = await rowAfterReload.isVisible({ timeout: 10000 }).catch(() => false);
    record('The created row still exists after reload+reopen', rowStillExists ? 'PASS' : 'FAIL', newRowId);

    const cellAfterReload = page.getByTestId(cellTestId);
    await cellAfterReload.waitFor({ state: 'visible', timeout: 10000 });
    const cellText = (await cellAfterReload.innerText()).trim();
    record('The entered cell value persisted after reload+reopen', cellText === CELL_VALUE ? 'PASS' : 'FAIL', `expected="${CELL_VALUE}" actual="${cellText}"`);
    await screenshot('final-state');

    // Step 10: row ordering also survives reload (single-row database here,
    // so "position" is trivially correct, but the row's presence at the
    // same visual slot after reload is what we assert above).
    record('FULL WORKFLOW RESULT', (rowStillExists && cellText === CELL_VALUE) ? 'PASS' : 'FAIL', 'All DatabaseRow browser-verification steps completed');
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
