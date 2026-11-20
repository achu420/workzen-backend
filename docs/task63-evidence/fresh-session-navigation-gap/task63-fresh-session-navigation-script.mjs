import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FRONTEND = 'http://localhost:5202';
const EVIDENCE_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend/docs/task63-evidence/restart';
const ids = JSON.parse(await readFile('/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend/docs/task63-evidence/browser-run/captured-ids.json', 'utf8'));

// Resolve the Database's primary/inline view page id directly via the
// backend's own REST API (not UI sidebar navigation, which merges the
// container+primary-view into one visual row with no separate reliably
// clickable "Grid" sidebar entry) -- this is just test-navigation
// plumbing, not something under test; the actual persistence assertions
// below are still made entirely through the real rendered UI.
async function resolvePrimaryViewId() {
  const loginResp = await fetch('http://127.0.0.1:8802/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ids.email, password: ids.password }) });
  const { access_token } = await loginResp.json();
  const pagesResp = await fetch(`http://127.0.0.1:8802/api/workspaces/${ids.workspaceId}/pages`, { headers: { authorization: `Bearer ${access_token}` } });
  const { pages } = await pagesResp.json();
  const primaryView = pages.find((p) => p.extra && p.extra.database_id === ids.databaseId && !p.extra.is_database_container);
  return primaryView?.id;
}
const primaryViewId = await resolvePrimaryViewId();

const log = [];
function record(step, status, detail) { const line = `[${new Date().toISOString()}] ${status} - ${step}${detail ? ' :: ' + detail : ''}`; console.log(line); log.push(line); }

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: '/Users/achal/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[${msg.type()}] ${msg.text()}`); });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  const networkLog = [];
  page.on('requestfinished', async (req) => {
    const url = req.url();
    if (!url.includes(':8802/')) return;
    try { const res = await req.response(); networkLog.push(`${req.method()} ${url} -> ${res ? res.status() : 'n/a'}`); } catch { networkLog.push(`${req.method()} ${url} -> (err)`); }
  });
  let screenshotIndex = 0;
  async function screenshot(name) { screenshotIndex += 1; await page.screenshot({ path: path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true }); }

  try {
    await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByTestId('login-email-input').fill(ids.email);
    await page.getByTestId('login-password-button').click();
    await page.getByTestId('password-input').fill(ids.password);
    await page.getByTestId('password-submit-button').click();
    await page.waitForURL(/\/app\//, { timeout: 20000 });
    record('Login after backend restart (fresh process, same PostgreSQL database)', 'PASS', page.url());

    await page.waitForTimeout(1500);
    const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
    if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) { await dismissBanner.first().click(); await page.waitForTimeout(300); }

    let reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!reopened && primaryViewId) {
      await page.goto(`${FRONTEND}/app/${ids.workspaceId}/${primaryViewId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 10000 }).catch(() => false);
    }
    await page.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 });
    await screenshot('after-restart-grid-reopened');

    const row1Exists = await page.getByTestId(`grid-row-${ids.row1}`).isVisible({ timeout: 10000 }).catch(() => false);
    const row2Exists = await page.getByTestId(`grid-row-${ids.row2}`).isVisible({ timeout: 10000 }).catch(() => false);
    const cell1Text = (await page.getByTestId(ids.cellTestId1).innerText()).trim();
    const cell2Text = (await page.getByTestId(ids.cellTestId2).innerText()).trim();
    record('Both rows exist after backend restart', (row1Exists && row2Exists) ? 'PASS' : 'FAIL', `row1=${row1Exists} row2=${row2Exists}`);
    record('Both cell values survived backend restart', (cell1Text === ids.cellValue1 && cell2Text === ids.cellValue2) ? 'PASS' : 'FAIL', `cell1="${cell1Text}" cell2="${cell2Text}"`);
    await screenshot('after-restart-final');
  } catch (error) {
    record('RESTART VERIFICATION FAILED', 'FAIL', error.stack || String(error));
    await screenshot('restart-failure').catch(() => {});
  } finally {
    await writeFile(path.join(EVIDENCE_DIR, 'steps.log'), log.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'console-errors.log'), consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network.log'), networkLog.join('\n'));
    await browser.close();
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
