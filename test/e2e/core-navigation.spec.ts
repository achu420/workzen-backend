import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  startTestEnvironment,
  stopTestEnvironment,
  registerTestUser,
  TestEnvironment,
} from '../helpers/test-environment';
import {
  dismissCompatBanner,
  hoverSpaceRow,
  waitForDocumentReady,
  documentTitleLocator,
  typeIntoDocumentBody,
  readDocumentBodyWithRetry,
  navigateViaSidebar,
  assertActiveDocumentIdentity,
  ensureNoViewModalOpen,
} from '../helpers/navigation';

/**
 * Task 69 core E2E suite. See
 * docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md for the root-cause
 * analysis these scenarios are built from and the historical Task 66/67/68
 * failure modes each one targets.
 *
 * One shared disposable backend+frontend for the whole file (started in
 * beforeAll / stopped in afterAll); every test registers its own
 * disposable user + space + document so tests cannot collide.
 */

const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'docs', 'task69-evidence', 'e2e-runs', String(Date.now()));

let env: TestEnvironment;

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  env = await startTestEnvironment(EVIDENCE_DIR, 'task69-e2e');
});

test.afterAll(async () => {
  const { envRestored } = await stopTestEnvironment(env);
  expect(envRestored).toBe(true);
});

const PASSWORD = 'Correct horse battery staple 69';

async function loginFreshUser(page: Page, prefix: string): Promise<string> {
  const email = await registerTestUser(env, prefix, PASSWORD);
  await page.goto(`${env.frontendUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('login-email-input').fill(email);
  await page.getByTestId('login-password-button').click();
  await page.getByTestId('password-input').fill(PASSWORD);
  await page.getByTestId('password-submit-button').click();
  await page.waitForURL(/\/app\//, { timeout: 20000 });
  await page.waitForTimeout(800);
  await dismissCompatBanner(page);
  return email;
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
  expect(capturedWorkspaceId).toBeTruthy();
  return capturedWorkspaceId as string;
}

/** Resolve a Space's view id via the backend's own pages listing -- test plumbing only, not a UI assertion. */
async function resolveSpaceId(workspaceId: string, _spaceLabel: string, ownerToken: string): Promise<string | null> {
  // The backend's legacy flat `/pages` listing does not carry the real
  // outline's display title (its own `title` field is empty for pages
  // created through the real v2 outline API that the browser UI uses),
  // so matching by `spaceLabel` text does not work here -- confirmed
  // empirically, not assumed. Since each test in this scenario uses
  // exactly one Space, every listed page's `parent_view_id` IS that
  // Space's id; use that instead of guessing a title match.
  const resp = await fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/pages`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (!resp.ok) return null;
  const { pages } = await resp.json();
  return pages[0]?.parent_view_id ?? null;
}

async function loginForToken(email: string, password: string): Promise<string> {
  const resp = await fetch(`${env.backendUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const { access_token } = await resp.json();
  return access_token;
}

async function createDocumentViaQuickAdd(page: Page, spaceLabel: string): Promise<string> {
  await hoverSpaceRow(page, spaceLabel);
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-document-button').click();
  await page.waitForTimeout(600);
  const pageId = (page.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  expect(pageId, 'document id must be resolvable from the URL right after creation').toBeTruthy();
  return pageId as string;
}

// ===================== Scenario A: auth + app readiness =====================
test('A. auth and app readiness', async ({ page }) => {
  await loginFreshUser(page, 'scenA');
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.getByTestId('new-page-button')).toBeVisible({ timeout: 10000 });
});

// ===================== Scenario B: creation + modal navigation =====================
test('B. document creation opens a ViewModal; closing it reaches the stable full-page route', async ({ page }) => {
  await loginFreshUser(page, 'scenB');
  const spaceLabel = 'Scenario B space';
  await createSpace(page, spaceLabel);

  const pageId = await createDocumentViaQuickAdd(page, spaceLabel);

  // Confirm the ViewModal is actually open (this is the real, proven
  // behavior -- not assumed) before exercising navigation out of it.
  const dialogWasOpen = await page.evaluate(() => document.querySelectorAll('.MuiDialog-root').length > 0);
  expect(dialogWasOpen, 'new Document is expected to open inside a ViewModal').toBe(true);

  const readiness = await waitForDocumentReady(page, pageId);
  expect(readiness.modalClosed, 'ViewModal should close via its own close affordance').toBe(true);
  expect(readiness.toastCleared, 'the "couldn\'t find this content" propagation toast should clear').toBe(true);
  expect(readiness.editorReady, 'editor should become ready (Connecting gone, title visible)').toBe(true);

  await assertActiveDocumentIdentity(page, pageId);
  await expect(documentTitleLocator(page, pageId)).toBeEditable();
});

// ===================== Scenario D: direct-route navigation =====================
test('D. direct full-page route navigation (bypassing modal/sidebar) loads the correct document after reload', async ({ page }) => {
  await loginFreshUser(page, 'scenD');
  const spaceLabel = 'Scenario D space';
  const workspaceId = await createSpace(page, spaceLabel);
  const pageId = await createDocumentViaQuickAdd(page, spaceLabel);
  await waitForDocumentReady(page, pageId);

  const directUrl = `${env.frontendUrl}/app/${workspaceId}/${pageId}`;
  await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const readiness = await waitForDocumentReady(page, pageId);
  expect(readiness.ok, `direct navigation to ${directUrl} should resolve to a usable editor`).toBe(true);
  await assertActiveDocumentIdentity(page, pageId);

  // Reload at the direct route and verify identity again -- isolates route
  // behavior from any residual in-memory navigation state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const readiness2 = await waitForDocumentReady(page, pageId);
  expect(readiness2.ok).toBe(true);
  await assertActiveDocumentIdentity(page, pageId);
});

// ===================== Scenario E: content persistence =====================
test('E. content persists across a genuine reload (condition-based save/sync wait, not a fixed sleep)', async ({ page }) => {
  await loginFreshUser(page, 'scenE');
  const spaceLabel = 'Scenario E space';
  await createSpace(page, spaceLabel);
  const pageId = await createDocumentViaQuickAdd(page, spaceLabel);
  await waitForDocumentReady(page, pageId);

  const marker = `task69-e2e-marker-${Date.now()}`;
  await typeIntoDocumentBody(page, pageId, marker);

  // Cross-check persistence independently of the browser: poll the
  // backend's own page-content resolution until the marker is durable,
  // bounded (not a fixed sleep).
  let backendConfirmed = false;
  for (let i = 0; i < 20; i += 1) {
    const resp = await fetch(`${env.backendUrl}/api/workspace/${(page.url().match(/\/app\/([^/]+)\//) || [])[1]}/v2/page-view/${pageId}`).catch(() => null);
    if (resp && resp.ok) {
      const body = await resp.text().catch(() => '');
      if (body.includes(marker)) {
        backendConfirmed = true;
        break;
      }
    }
    await page.waitForTimeout(500);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  const readiness = await waitForDocumentReady(page, pageId);
  expect(readiness.ok).toBe(true);
  await assertActiveDocumentIdentity(page, pageId);

  const content = await readDocumentBodyWithRetry(page, pageId, marker);
  expect(content, 'the exact marker must survive a genuine reload').toContain(marker);
  // Backend cross-check is informational (endpoint/body shape is not part
  // of this task's contract) -- report but do not hard-fail the scenario
  // on it alone, since the browser-level proof above is the acceptance bar.
  test.info().annotations.push({ type: 'backend-cross-check', description: String(backendConfirmed) });
});

// ===================== Scenario C: sidebar navigation between 2+ documents =====================
test('C. sidebar navigation between two documents, detecting duplicate/stale matches rather than guessing', async ({ page }) => {
  const email = await loginFreshUser(page, 'scenC');
  const spaceLabel = 'Scenario C space';
  const workspaceId = await createSpace(page, spaceLabel);

  const pageId1 = await createDocumentViaQuickAdd(page, spaceLabel);
  await waitForDocumentReady(page, pageId1);
  await ensureNoViewModalOpen(page);

  const pageId2 = await createDocumentViaQuickAdd(page, spaceLabel);
  await waitForDocumentReady(page, pageId2);
  await ensureNoViewModalOpen(page);

  const token = await loginForToken(email, PASSWORD);
  const resolvedSpaceId = await resolveSpaceId(workspaceId, spaceLabel, token);
  expect(resolvedSpaceId).toBeTruthy();

  const navTo1 = await navigateViaSidebar(page, pageId1, resolvedSpaceId as string, spaceLabel);
  expect(navTo1.ok, navTo1.reason).toBe(true);
  expect(navTo1.matchedCount, 'exactly one sidebar entry should match page 1\'s testid').toBe(1);
  await waitForDocumentReady(page, pageId1);
  await assertActiveDocumentIdentity(page, pageId1);

  const navTo2 = await navigateViaSidebar(page, pageId2, resolvedSpaceId as string, spaceLabel);
  expect(navTo2.ok, navTo2.reason).toBe(true);
  expect(navTo2.matchedCount, 'exactly one sidebar entry should match page 2\'s testid').toBe(1);
  await waitForDocumentReady(page, pageId2);
  await assertActiveDocumentIdentity(page, pageId2);
});

// ===================== Scenario F: repeated navigation =====================
test('F. repeated A->B->A navigation keeps correct identity, no stale overlay/duplicate active state', async ({ page }) => {
  await loginFreshUser(page, 'scenF');
  const spaceLabel = 'Scenario F space';
  const workspaceId = await createSpace(page, spaceLabel);
  const pageId1 = await createDocumentViaQuickAdd(page, spaceLabel);
  await waitForDocumentReady(page, pageId1);
  await ensureNoViewModalOpen(page);
  const pageId2 = await createDocumentViaQuickAdd(page, spaceLabel);
  await waitForDocumentReady(page, pageId2);
  await ensureNoViewModalOpen(page);

  for (let round = 0; round < 3; round += 1) {
    await page.goto(`${env.frontendUrl}/app/${workspaceId}/${pageId1}`, { waitUntil: 'domcontentloaded' });
    expect((await waitForDocumentReady(page, pageId1)).ok, `round ${round}: nav to page1`).toBe(true);
    await assertActiveDocumentIdentity(page, pageId1);
    expect(await page.evaluate(() => document.querySelectorAll('.MuiDialog-root').length), `round ${round}: no stray dialog after nav to page1`).toBe(0);

    await page.goto(`${env.frontendUrl}/app/${workspaceId}/${pageId2}`, { waitUntil: 'domcontentloaded' });
    expect((await waitForDocumentReady(page, pageId2)).ok, `round ${round}: nav to page2`).toBe(true);
    await assertActiveDocumentIdentity(page, pageId2);
    expect(await page.evaluate(() => document.querySelectorAll('.MuiDialog-root').length), `round ${round}: no stray dialog after nav to page2`).toBe(0);
  }
});

// ===================== Scenario G: independent browser contexts =====================
test('G. two independent browser contexts on the same document both resolve the correct identity', async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();

  await loginFreshUser(pageA, 'scenG-a');
  const spaceLabel = 'Scenario G space';
  const workspaceId = await createSpace(pageA, spaceLabel);
  const pageId = await createDocumentViaQuickAdd(pageA, spaceLabel);
  await waitForDocumentReady(pageA, pageId);

  // Context B: a genuinely independent browser context carrying context A's
  // authenticated storage state (cookies + localStorage, which is where
  // this app's auth tokens actually live -- `addCookies` alone would not
  // reproduce a real second signed-in client). This proves infrastructure
  // reliability for multi-context workflows, not a second collaborator's
  // authorization, which is Task 67's own concern.
  const storageState = await contextA.storageState();
  const contextB = await browser.newContext({ storageState });
  const pageB = await contextB.newPage();
  await pageB.goto(`${env.frontendUrl}/app/${workspaceId}/${pageId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const readyA = await waitForDocumentReady(pageA, pageId);
  const readyB = await waitForDocumentReady(pageB, pageId);
  expect(readyA.ok).toBe(true);
  expect(readyB.ok, 'second context should independently resolve the same document').toBe(true);
  await assertActiveDocumentIdentity(pageA, pageId);
  await assertActiveDocumentIdentity(pageB, pageId);

  await contextA.close();
  await contextB.close();
});
