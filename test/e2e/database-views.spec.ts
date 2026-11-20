import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { startTestEnvironment, stopTestEnvironment, registerTestUser, TestEnvironment } from '../helpers/test-environment';
import { dismissCompatBanner, hoverSpaceRow } from '../helpers/navigation';

/**
 * Task 72 real-browser verification: creating an ADDITIONAL database view
 * (the one confirmed backend gap this task implemented --
 * POST .../v2/page-view/database-view/default, see
 * docs/TASK72_DATABASE_VIEWS_DISCOVERY.md) through the REAL, reachable
 * AppFlowy-Web "Add view" button, proving the full real contract
 * end-to-end: real click -> real HTTP request -> real client-side
 * atomic-creation receipt validation (a real bug was found and fixed here,
 * see docs/TASK72_DATABASE_VIEWS_IMPLEMENTATION_REPORT.md) -> real
 * persisted backend state, cross-checked independently via the backend's
 * own collab-read API from within the same browser session (not asserted
 * from the server alone).
 *
 * KNOWN LIMITATION (discovered this task, reported, not fixed -- see the
 * implementation report's "known limitations" section): the view-tabs
 * switching UI (DatabaseViewTabs, `view-tab-<id>` elements) did not
 * visibly render for a standalone (non-embedded) database page in this
 * checked-out AppFlowy-Web build during this task's verification, even
 * after the second view was confirmed correctly created, after a full
 * page reload, and even though the exact same testid convention is used
 * by AppFlowy-Web's OWN first-party Playwright suite
 * (playwright/e2e/database/database-view-tabs.spec.ts). The creation
 * flow itself (button, dropdown, POST, client-side validation, server
 * persistence) was fully verified; the tab-switching/rename-via-tab-menu
 * UI could not be exercised at the browser level this task because of
 * this -- a frontend-side rendering gap, out of this backend task's scope
 * to fix (see "don't touch unrelated frontend behavior").
 */

const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'docs', 'task72-evidence', 'e2e-runs', String(Date.now()));
const PASSWORD = 'Correct horse battery staple 72';

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

async function createSpace(page: Page, label: string): Promise<string> {
  let capturedWorkspaceId: string | null = null;
  page.on('requestfinished', async (req) => {
    const m = req.url().match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
    if (m) capturedWorkspaceId = m[1];
  });
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
  expect(capturedWorkspaceId, 'workspace id must be observable from real create-space network traffic').toBeTruthy();
  return capturedWorkspaceId as string;
}

/** Create a Grid database via the real sidebar "+" -> "Grid" flow (same proven path as Task 61's evidence script). */
async function createGridDatabase(page: Page, spaceLabel: string): Promise<string> {
  await hoverSpaceRow(page, spaceLabel);
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-grid-button').click();
  await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
  const pageId = (page.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  expect(pageId, 'database page id must be resolvable from the URL right after creation').toBeTruthy();
  return pageId as string;
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true }).catch(() => {});
}

/** Fetch the Database collab object directly from the backend and decode it -- independent, non-UI verification that creation actually persisted correctly, matching the exact technique used by test/database-view-collab.test.js. */
async function fetchDatabaseViews(
  env: TestEnvironment,
  email: string,
  workspaceId: string,
  databaseId: string
): Promise<{ viewIds: string[]; layouts: Record<string, number> }> {
  const loginResp = await fetch(`${env.backendUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { access_token } = await loginResp.json();
  const collabResp = await fetch(`${env.backendUrl}/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  expect(collabResp.status).toBe(200);
  const collabBody = await collabResp.json();
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(collabBody.data.doc_state));
    const views = doc.getMap('data').get('database').get('views') as Y.Map<Y.Map<unknown>>;
    const viewIds = Array.from(views.keys());
    const layouts: Record<string, number> = {};
    viewIds.forEach((id) => { layouts[id] = Number(views.get(id)!.get('layout')); });
    return { viewIds, layouts };
  } finally {
    doc.destroy();
  }
}

test.describe('Task 72: database view creation via the real AppFlowy-Web UI', () => {
  let env: TestEnvironment;

  test.beforeAll(async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    env = await startTestEnvironment(EVIDENCE_DIR, 'task72-e2e');
  });

  test.afterAll(async () => {
    const { envRestored } = await stopTestEnvironment(env);
    expect(envRestored).toBe(true);
  });

  test('Scenario A: creating a second (Board) view via the real "Add view" button succeeds end-to-end (real HTTP, real client-side receipt validation, real persisted backend state)', async ({ page }) => {
    const email = await registerTestUser(env, 'task72-scenA', PASSWORD);
    await loginUser(page, env.frontendUrl, email);
    const spaceLabel = 'Task72 A space';
    const workspaceId = await createSpace(page, spaceLabel);
    const databasePageId = await createGridDatabase(page, spaceLabel);
    await screenshot(page, '01-grid-created');

    // Resolve the underlying databaseId from the Folder page's own `extra`
    // (test plumbing only, same technique already proven in
    // test/e2e/historical-collaboration-acceptance.spec.ts's resolveSpaceId).
    const ownerTokenResp = await fetch(`${env.backendUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
    });
    const { access_token: token } = await ownerTokenResp.json();
    const pagesResp = await fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/pages`, { headers: { authorization: `Bearer ${token}` } });
    const { pages } = await pagesResp.json();
    const databaseId: string = pages.find((p: { id: string }) => p.id === databasePageId)?.extra?.database_id;
    expect(databaseId, 'the created page must carry extra.database_id').toBeTruthy();

    const before = await fetchDatabaseViews(env, email, workspaceId, databaseId);
    expect(before.viewIds.length, 'a brand-new Grid database starts with exactly one view').toBe(1);

    // Real click, real dropdown, real network request -- the one confirmed
    // backend gap this task implemented. Board is unlimited/non-Pro
    // (confirmed from subscription.ts's isLimitedDatabaseViewLayout).
    const postResponsePromise = page.waitForResponse((res) => res.url().includes('/v2/page-view/database-view/default'), { timeout: 15000 });
    await page.getByTestId('add-view-button').click();
    await page.getByRole('menuitem', { name: 'Board', exact: true }).click();
    const postResponse = await postResponsePromise;
    expect(postResponse.status(), 'the real atomic database-view creation POST must succeed').toBe(200);
    const postBody = await postResponse.json();
    expect(postBody.data.outcome).toBe('applied');
    await screenshot(page, '02-after-add-view-click');

    // No client-side AtomicCreationPendingError (the real bug this task
    // found and fixed: the initial receipt shape was missing fields
    // AppFlowy-Web's own atomic-creation journal requires) and no visible
    // error toast.
    const errorToastVisible = await page.getByText('Failed to add view', { exact: false }).isVisible({ timeout: 2000 }).catch(() => false);
    expect(errorToastVisible, 'no "Failed to add view" toast should appear').toBe(false);

    // Independent, non-UI verification: the backend's own collab state
    // now holds exactly two independent views, with the new one correctly
    // typed as Board (layout=1), nothing lost or duplicated.
    let after = before;
    await expect(async () => {
      after = await fetchDatabaseViews(env, email, workspaceId, databaseId);
      expect(after.viewIds.length).toBe(2);
    }).toPass({ timeout: 10000 });
    const newViewId = after.viewIds.find((id) => !before.viewIds.includes(id))!;
    expect(newViewId).toBeTruthy();
    expect(after.layouts[newViewId], 'DatabaseViewLayout.Board = 1').toBe(1);
    expect(after.layouts[before.viewIds[0]], "the original Grid view's own layout is unaffected").toBe(0);

    // Reload: the original Grid content is still intact and reachable
    // (the creation did not corrupt or replace the open page).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
    await screenshot(page, '03-after-reload');
    const afterReload = await fetchDatabaseViews(env, email, workspaceId, databaseId);
    expect(afterReload.viewIds.sort()).toEqual(after.viewIds.sort());
  });
});
