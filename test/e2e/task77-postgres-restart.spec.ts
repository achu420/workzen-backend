import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { startTestEnvironment, stopTestEnvironment, registerTestUser, restartBackend, TestEnvironment } from '../helpers/test-environment';
import { dismissCompatBanner, hoverSpaceRow } from '../helpers/navigation';

/**
 * Task 77 Phase 3 Scenario B: Database + DatabaseRow real-browser
 * persistence across a genuine backend-process restart, against
 * PostgreSQL storage specifically (not JSON). This is a NEW, narrowly
 * scoped test, added because no existing E2E spec exercised Database/Row
 * persistence under a real process restart on Postgres -- Task 68/70's
 * existing restart-persistence coverage (historical-collaboration-
 * acceptance.spec.ts) is Document-only.
 *
 * Requires DATABASE_URL to point at a disposable/isolated Postgres test
 * database; skips cleanly (does not fail) if unset, so this file never
 * blocks the default JSON-only CI/dev path.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = 'Correct horse battery staple 77';
const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'docs', 'task77-evidence', 'e2e-runs', String(Date.now()));

test.skip(!DATABASE_URL, 'DATABASE_URL not set -- Postgres browser restart-persistence scenario not run');

async function loginUser(page: Page, frontendUrl: string, email: string): Promise<void> {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('login-email-input').fill(email);
  await page.getByTestId('login-password-button').click();
  await page.getByTestId('password-input').fill(PASSWORD);
  await page.getByTestId('password-submit-button').click();
  await page.waitForURL(/\/app\//, { timeout: 45000 });
  await page.waitForTimeout(800);
  await dismissCompatBanner(page);
}

async function createSpace(page: Page, label: string): Promise<void> {
  await page.getByTestId('new-page-button').click();
  await page.getByTestId('new-page-create-space-button').click();
  await page.getByTestId('space-name-input').fill(label);
  await page.getByTestId('create-space-submit').click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForTimeout(800);
  await dismissCompatBanner(page);
}

async function createGridDatabase(page: Page, spaceLabel: string): Promise<string> {
  await hoverSpaceRow(page, spaceLabel);
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-grid-button').click();
  await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
  const pageId = (page.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  expect(pageId, 'database page id must be resolvable from the URL right after creation').toBeTruthy();
  return pageId as string;
}

async function createRow(page: Page): Promise<void> {
  await page.getByTestId('grid-new-row').click({ timeout: 10000 }).catch(async () => {
    await page.getByText('New row', { exact: false }).first().click();
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape').catch(() => {});
}

async function countRows(page: Page): Promise<number> {
  return page.locator('[data-testid^="grid-row-"]:not([data-testid="grid-row-undefined"])').count();
}

test.describe('Task 77 Phase 3: Database/DatabaseRow persistence across a real backend restart, PostgreSQL storage', () => {
  let env: TestEnvironment;

  test.beforeAll(async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    env = await startTestEnvironment(EVIDENCE_DIR, 'task77-pg-restart', { storage: 'postgres', databaseUrl: DATABASE_URL });
  });

  test.afterAll(async () => {
    const { envRestored } = await stopTestEnvironment(env);
    expect(envRestored).toBe(true);
  });

  test('Database + 3 rows persist across a genuine backend process restart on Postgres', async ({ page }) => {
    expect(env.storage, 'this scenario must actually be running against postgres storage').toBe('postgres');

    const email = await registerTestUser(env, 'task77-pg', PASSWORD);
    await loginUser(page, env.frontendUrl, email);
    await createSpace(page, 'Task77 Postgres space');
    const databaseId = await createGridDatabase(page, 'Task77 Postgres space');

    await createRow(page);
    await createRow(page);
    await createRow(page);
    await page.waitForTimeout(500);
    const rowCountBefore = await countRows(page);
    expect(rowCountBefore, 'expected 3 rows to exist before restart').toBeGreaterThanOrEqual(3);

    const pidBefore = env.backendProcess.pid;
    await restartBackend(env);
    expect(env.backendProcess.pid, 'restart must be a genuinely new process').not.toBe(pidBefore);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL(new RegExp(`/${databaseId}`), { timeout: 20000 }).catch(() => {});
    await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
    await page.waitForTimeout(800);

    const rowCountAfter = await countRows(page);
    expect(rowCountAfter, 'all 3 rows must survive a real backend restart against Postgres storage').toBe(rowCountBefore);
  });
});
