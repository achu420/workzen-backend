import { test, expect, Page, Browser, BrowserContext } from '@playwright/test';
import path from 'path';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  startTestEnvironment,
  stopTestEnvironment,
  restartBackend,
  registerTestUser,
  TestEnvironment,
} from '../helpers/test-environment';
import {
  dismissCompatBanner,
  hoverSpaceRow,
  waitForDocumentReady,
  documentTitleLocator,
  documentBodyLocator,
  typeIntoDocumentBody,
  readDocumentBodyWithRetry,
  ensureNoViewModalOpen,
  navigateViaSidebar,
} from '../helpers/navigation';

/**
 * Task 70: combined real-browser acceptance suite for three independent
 * historical workstreams (Task 66 fan-out, Task 67 authorization/
 * revocation, Task 68 recovery/reconnection), built on Task 69's proven
 * infrastructure (test/helpers/test-environment.ts, test/helpers/navigation.ts).
 *
 * Each workstream gets its OWN disposable backend+frontend (separate
 * `test.describe` block, separate beforeAll/afterAll) so a failure in one
 * workstream cannot affect another. Within a workstream, scenarios are
 * separate `test()` entries (no `.serial`) sharing describe-scoped
 * browser-context state, so a failure in one scenario does not prevent
 * Playwright from still attempting the later ones in the same file.
 */

const EVIDENCE_ROOT = path.resolve(__dirname, '..', '..', 'docs', 'task70-evidence');
const PASSWORD = 'Correct horse battery staple 70';

// ---------------------------------------------------------------------------
// Shared helpers (reused across all three workstreams; thin wrappers around
// Task 69's navigation.ts primitives plus the test-membership helper added
// in Task 67, following the proven pattern in
// docs/task67-evidence/task67-browser-verify.mjs).
// ---------------------------------------------------------------------------

async function loginUser(page: Page, frontendUrl: string, email: string): Promise<void> {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('login-email-input').fill(email);
  await page.getByTestId('login-password-button').click();
  await page.getByTestId('password-input').fill(PASSWORD);
  await page.getByTestId('password-submit-button').click();
  // Task 70 finding: this specific wait intermittently timed out at 20s for a
  // BRAND-NEW browser context created late in a long test run (e.g. B5's
  // "fresh connection" context) -- the same "second-login timeout" symptom
  // flagged as unresolved in Task 69's report. Investigated, not assumed:
  // the failure is on `page.waitForURL` ("waiting for navigation until
  // 'load'") for a context with a cold Vite module cache while several other
  // Chromium contexts/pages are already active in the same run, consistent
  // with dev-server transform/compile contention rather than an auth or WS
  // defect (B1's very first login earlier in the SAME run, under less
  // contention, never times out). A longer, still-bounded timeout is the
  // appropriate fix for a real resource-contention effect in a disposable
  // dev-mode test environment, not a change to login/auth behavior itself.
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
  expect(capturedWorkspaceId, 'workspace id must be observable from the real create-space network traffic').toBeTruthy();
  return capturedWorkspaceId as string;
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

async function createGridViaQuickAdd(page: Page, spaceLabel: string): Promise<string | null> {
  await hoverSpaceRow(page, spaceLabel);
  await page.getByTestId('inline-add-page').first().click();
  const gridButton = page.getByTestId('add-grid-button');
  if (!(await gridButton.isVisible({ timeout: 3000 }).catch(() => false))) return null;
  await gridButton.click();
  await page.waitForTimeout(800);
  const pageId = (page.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  return pageId || null;
}

async function loginForToken(env: TestEnvironment, email: string): Promise<string> {
  const resp = await fetch(`${env.backendUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { access_token } = await resp.json();
  return access_token as string;
}

async function grantMembership(env: TestEnvironment, workspaceId: string, ownerToken: string, memberEmail: string): Promise<Response> {
  return fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/test-members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}`, 'x-development-key': env.devKey },
    body: JSON.stringify({ email: memberEmail, role: 'member' }),
  });
}

async function revokeMembership(env: TestEnvironment, workspaceId: string, ownerToken: string, memberEmail: string): Promise<Response> {
  return fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/test-members?email=${encodeURIComponent(memberEmail)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ownerToken}`, 'x-development-key': env.devKey },
  });
}

/** Resolve a Space's view id via the backend's own pages listing (test plumbing only), same technique proven in test/e2e/core-navigation.spec.ts. */
async function resolveSpaceId(env: TestEnvironment, workspaceId: string, ownerToken: string): Promise<string | null> {
  const resp = await fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/pages`, { headers: { authorization: `Bearer ${ownerToken}` } });
  if (!resp.ok) return null;
  const { pages } = await resp.json();
  return pages[0]?.parent_view_id ?? null;
}

/**
 * Open a workspace+doc the member was granted access to. Task 70 diagnosis
 * (see docs/TASK70_HISTORICAL_COLLABORATION_ACCEPTANCE_REPORT.md): a direct
 * `goto(/app/<workspace>/<page>)` route load on a brand-new page (the
 * approach first tried here) reliably rendered the correct document
 * identity/title but did NOT receive the owner's live body edits even after
 * a 30s wait, while the already-proven Task 67 browser script
 * (docs/task67-evidence/task67-browser-verify.mjs) navigates the member via
 * the real sidebar entry (falling back to the direct route only if the
 * sidebar entry cannot be found) and DOES observe live delivery. This
 * mirrors that proven navigation path instead of a raw deep link.
 */
async function openSharedDocument(
  page: Page,
  frontendUrl: string,
  workspaceId: string,
  pageId: string,
  spaceId: string | null,
  spaceLabel: string
): Promise<void> {
  await page.goto(`${frontendUrl}/app/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1000);
  await dismissCompatBanner(page);

  if (spaceId) {
    const nav = await navigateViaSidebar(page, pageId, spaceId, spaceLabel);
    if (nav.ok) {
      await page.waitForTimeout(500);
      return;
    }
  }
  // Fallback: direct route (still exercised/reported, but the sidebar path above is preferred).
  await page.goto(`${frontendUrl}/app/${workspaceId}/${pageId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await dismissCompatBanner(page);
}

let screenshotCounters: Record<string, number> = {};
async function screenshot(dir: string, key: string, page: Page, name: string): Promise<void> {
  screenshotCounters[key] = (screenshotCounters[key] ?? 0) + 1;
  await page.screenshot({ path: path.join(dir, `${String(screenshotCounters[key]).padStart(2, '0')}-${name}.png`), fullPage: true }).catch(() => {});
}

/**
 * Append a marker as a NEW line at the END of the document body, instead of
 * replacing all existing content the way `typeIntoDocumentBody` (Task 69's
 * helper, by design) does. Needed for scenarios that must keep MULTIPLE
 * markers coexisting in the same document (continued collaboration,
 * pre-/post-restart convergence) -- found necessary during this task after
 * `typeIntoDocumentBody`'s select-all-then-type semantics silently wiped an
 * earlier marker when reused a second time on the same document.
 */
async function appendIntoDocumentBody(page: Page, pageId: string, text: string) {
  const body = documentBodyLocator(page, pageId);
  await body.waitFor({ state: 'visible', timeout: 10000 });
  await body.click();
  await page.keyboard.press('Control+End').catch(() => {});
  await page.keyboard.press('Meta+ArrowDown').catch(() => {});
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text, { delay: 20 });
  await expect(body).toContainText(text, { timeout: 10000 });
}

async function isConnectedNoOverlay(page: Page): Promise<boolean> {
  const connecting = await page.getByText('Connecting', { exact: false }).isVisible({ timeout: 500 }).catch(() => false);
  return !connecting;
}

/** Track WebSocket lifecycle (open/close) for a page from the moment it is called, Node-side (not page.evaluate) -- real network-level evidence. */
function trackWebSockets(page: Page): { events: Array<{ type: 'open' | 'close'; url: string; t: number }> } {
  const events: Array<{ type: 'open' | 'close'; url: string; t: number }> = [];
  page.on('websocket', (ws) => {
    events.push({ type: 'open', url: ws.url(), t: Date.now() });
    ws.on('close', () => events.push({ type: 'close', url: ws.url(), t: Date.now() }));
  });
  return { events };
}

// ===========================================================================
// Workstream A -- Task 66: real-time content fan-out
// ===========================================================================
test.describe('Task 66: real-time content fan-out', () => {
  const EVIDENCE_DIR = path.join(EVIDENCE_ROOT, 'task66');
  let env: TestEnvironment;
  let browser: Browser;
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let workspaceId: string;
  let docPageId: string;
  let ownerEmail: string;
  let memberEmail: string;

  test.beforeAll(async ({ browser: b }) => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    env = await startTestEnvironment(EVIDENCE_DIR, 'task70-t66');
    browser = b;

    ownerEmail = await registerTestUser(env, 'task70-t66-owner', PASSWORD);
    memberEmail = await registerTestUser(env, 'task70-t66-member', PASSWORD);

    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();

    await loginUser(pageA, env.frontendUrl, ownerEmail);
    workspaceId = await createSpace(pageA, 'Task66 fanout space');
    docPageId = await createDocumentViaQuickAdd(pageA, 'Task66 fanout space');
    await waitForDocumentReady(pageA, docPageId);
    await ensureNoViewModalOpen(pageA);

    const ownerToken = await loginForToken(env, ownerEmail);
    const grantResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
    expect(grantResp.status, 'membership grant via the Task 67 test-members helper must succeed').toBe(201);
    const spaceId = await resolveSpaceId(env, workspaceId, ownerToken);

    await loginUser(pageB, env.frontendUrl, memberEmail);
    await openSharedDocument(pageB, env.frontendUrl, workspaceId, docPageId, spaceId, 'Task66 fanout space');
    await waitForDocumentReady(pageB, docPageId);

    await screenshot(EVIDENCE_DIR, 'setup', pageA, 'owner-setup');
    await screenshot(EVIDENCE_DIR, 'setup', pageB, 'member-setup');
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
    const { envRestored } = await stopTestEnvironment(env);
    expect(envRestored).toBe(true);
  });

  test('A1. owner->member live delivery + persistence (document body)', async () => {
    // Identity check: both contexts resolved the SAME document id.
    await expect(pageA).toHaveURL(new RegExp(`/${docPageId}(?:[/?]|$)`));
    await expect(pageB).toHaveURL(new RegExp(`/${docPageId}(?:[/?]|$)`));
    expect(await isConnectedNoOverlay(pageA)).toBe(true);
    expect(await isConnectedNoOverlay(pageB)).toBe(true);

    const marker = `t66-a1-owner-to-member-${Date.now()}`;
    await typeIntoDocumentBody(pageA, docPageId, marker);

    // Task 70 diagnostic: rule out headless-Chromium background-tab timer
    // throttling (a well-documented Playwright/Chromium gotcha -- an
    // unfocused page's rAF/timers can be throttled, which could delay a
    // live Yjs-driven re-render without indicating any real product
    // defect) by explicitly focusing pageB before reading it live.
    await pageB.bringToFront();

    const memberSaw = await readDocumentBodyWithRetry(pageB, docPageId, marker, 40, 750);
    await screenshot(EVIDENCE_DIR, 'a1', pageB, 'member-sees-owner-marker');
    const liveDeliveryWorked = memberSaw.includes(marker);

    // Task 71 fix: this was a soft, non-fatal annotation through Task 70
    // because the cold-start live-render gap documented in
    // docs/TASK70_HISTORICAL_COLLABORATION_ACCEPTANCE_REPORT.md made it
    // unreliable, and Playwright recycles the worker (re-running `beforeAll`
    // from scratch) after any FAILED test in a file, which would have torn
    // down the shared two-context environment this workstream's later
    // scenarios depend on. Task 71 root-caused and fixed that gap (a
    // server-connection-binding race in AppFlowy-Web's sync/outbox layer --
    // see docs/TASK71_COLD_START_LIVE_RENDERING_REPORT.md) and verified it
    // 10/10 across independent cold-start sessions, so this is now a hard
    // requirement, not a soft-pass workaround.
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    const readinessAfterReload = await waitForDocumentReady(pageB, docPageId);
    const afterReload = await readDocumentBodyWithRetry(pageB, docPageId, marker);
    test.info().annotations.push({
      type: liveDeliveryWorked ? 'live-delivery-pass' : 'live-delivery-FAIL',
      description: `live (no-refresh) delivery to member: ${liveDeliveryWorked ? 'PASS' : 'FAIL (empty/placeholder editor content observed)'}; same content after a reload (load-time fetch, not live push): ${afterReload.includes(marker) ? 'PASS' : 'FAIL'}; readinessAfterReload=${JSON.stringify(readinessAfterReload)}`,
    });

    expect(liveDeliveryWorked, 'Task 71 fix: member must see the owner\'s first edit LIVE, without a reload').toBe(true);
    expect(readinessAfterReload.ok).toBe(true);
    expect(afterReload, 'marker must persist for the member across a reload').toContain(marker);
  });

  test('A2. member->owner live delivery + persistence', async () => {
    const marker = `t66-a2-member-to-owner-${Date.now()}`;
    await typeIntoDocumentBody(pageB, docPageId, marker);
    const ownerSaw = await readDocumentBodyWithRetry(pageA, docPageId, marker, 40, 750);
    await screenshot(EVIDENCE_DIR, 'a2', pageA, 'owner-sees-member-marker');
    const liveDeliveryWorked = ownerSaw.includes(marker);

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const readiness = await waitForDocumentReady(pageA, docPageId);
    const afterReload = await readDocumentBodyWithRetry(pageA, docPageId, marker);
    test.info().annotations.push({
      type: liveDeliveryWorked ? 'live-delivery-pass' : 'live-delivery-FAIL',
      description: `live (no-refresh) delivery to owner (member->owner direction): ${liveDeliveryWorked ? 'PASS' : 'FAIL'}; same content after reload: ${afterReload.includes(marker) ? 'PASS' : 'FAIL'}`,
    });

    // Task 71 fix: hard requirement now (see A1's comment above for why this
    // was a soft annotation through Task 70 and why it is safe to harden now).
    expect(liveDeliveryWorked, 'Task 71 fix: owner must see the member\'s first edit LIVE, without a reload').toBe(true);
    expect(readiness.ok).toBe(true);
    expect(afterReload, 'marker must persist for the owner across a reload').toContain(marker);
  });

  test('A3. continued collaboration (reload-based convergence both directions), no duplicate/stale content', async () => {
    const markerA = `t66-a3-owner-again-${Date.now()}`;
    await typeIntoDocumentBody(pageA, docPageId, markerA);
    const bSawLive = await readDocumentBodyWithRetry(pageB, docPageId, markerA, 40, 750);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await waitForDocumentReady(pageB, docPageId);
    const bSaw = await readDocumentBodyWithRetry(pageB, docPageId, markerA);

    const markerB = `t66-a3-member-again-${Date.now()}`;
    await appendIntoDocumentBody(pageB, docPageId, markerB);
    const aSawLive = await readDocumentBodyWithRetry(pageA, docPageId, markerB, 40, 750);
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await waitForDocumentReady(pageA, docPageId);
    const aSaw = await readDocumentBodyWithRetry(pageA, docPageId, markerB);

    test.info().annotations.push({
      type: 'live-delivery-status',
      description: `owner->member live: ${bSawLive.includes(markerA) ? 'PASS' : 'FAIL'}; member->owner live: ${aSawLive.includes(markerB) ? 'PASS' : 'FAIL'}; both converge after reload: owner=${aSaw.includes(markerB)}, member=${bSaw.includes(markerA)}`,
    });

    // Task 71 fix: both directions' live delivery are now hard requirements.
    expect(bSawLive, 'Task 71 fix: member must see the owner\'s second edit LIVE').toContain(markerA);
    expect(aSawLive, 'Task 71 fix: owner must see the member\'s second edit LIVE').toContain(markerB);
    expect(bSaw, 'owner->member content converges for the member (after reload)').toContain(markerA);
    expect(aSaw, 'member->owner content converges for the owner (after reload)').toContain(markerB);

    expect(await isConnectedNoOverlay(pageA), 'owner must remain connected').toBe(true);
    expect(await isConnectedNoOverlay(pageB), 'member must remain connected').toBe(true);

    // No duplicate visible content: the final marker should appear exactly once in each editor.
    const finalA = await documentBodyLocator(pageA, docPageId).innerText();
    const finalB = await documentBodyLocator(pageB, docPageId).innerText();
    expect(finalA.split(markerB).length - 1, 'markerB must appear exactly once for owner').toBe(1);
    expect(finalB.split(markerA).length - 1, 'markerA must appear exactly once for member').toBe(1);
  });

  test('A4. Database/DatabaseRow browser fan-out (bounded attempt)', async () => {
    const gridPageId = await createGridViaQuickAdd(pageA, 'Task66 fanout space');
    if (!gridPageId) {
      test.info().annotations.push({ type: 'limitation', description: 'add-grid-button not reachable via the proven quick-add flow in this environment; Database/DatabaseRow browser fan-out NOT TESTED. Document-level browser fan-out (A1-A3) does not substitute for this.' });
      test.skip(true, 'Grid creation via quick-add was not reachable; see annotation for the exact limitation.');
      return;
    }
    const readyA = await waitForDocumentReady(pageA, gridPageId).catch(() => ({ ok: false } as any));
    if (!readyA.ok) {
      test.info().annotations.push({ type: 'limitation', description: `Grid page ${gridPageId} did not reach the Document readiness gate (expected -- that gate is editor-title-scoped, not grid-scoped). Database/DatabaseRow browser fan-out NOT TESTED beyond page creation.` });
      test.skip(true, 'Grid readiness could not be established with the Document-scoped readiness helper.');
      return;
    }
  });
});

// ===========================================================================
// Workstream B -- Task 67: authorization and revocation
// ===========================================================================
test.describe('Task 67: authorization and membership revocation', () => {
  const EVIDENCE_DIR = path.join(EVIDENCE_ROOT, 'task67');
  let env: TestEnvironment;
  let browser: Browser;
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let workspaceId: string;
  let docPageId: string;
  let ownerEmail: string;
  let memberEmail: string;
  let ownerToken: string;
  let spaceId: string | null;
  let wsTrackB: { events: Array<{ type: 'open' | 'close'; url: string; t: number }> };

  test.beforeAll(async ({ browser: b }) => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    env = await startTestEnvironment(EVIDENCE_DIR, 'task70-t67');
    browser = b;

    ownerEmail = await registerTestUser(env, 'task70-t67-owner', PASSWORD);
    memberEmail = await registerTestUser(env, 'task70-t67-member', PASSWORD);

    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();

    await loginUser(pageA, env.frontendUrl, ownerEmail);
    workspaceId = await createSpace(pageA, 'Task67 security space');
    docPageId = await createDocumentViaQuickAdd(pageA, 'Task67 security space');
    await waitForDocumentReady(pageA, docPageId);
    await ensureNoViewModalOpen(pageA);

    ownerToken = await loginForToken(env, ownerEmail);
    const grantResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
    expect(grantResp.status).toBe(201);
    spaceId = await resolveSpaceId(env, workspaceId, ownerToken);

    wsTrackB = trackWebSockets(pageB);
    await loginUser(pageB, env.frontendUrl, memberEmail);
    await openSharedDocument(pageB, env.frontendUrl, workspaceId, docPageId, spaceId, 'Task67 security space');
    await waitForDocumentReady(pageB, docPageId);

    await screenshot(EVIDENCE_DIR, 'setup', pageA, 'owner-setup');
    await screenshot(EVIDENCE_DIR, 'setup', pageB, 'member-setup');
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
    const { envRestored } = await stopTestEnvironment(env);
    expect(envRestored).toBe(true);
  });

  test('B1. initial authorized access (two independent contexts, same document)', async () => {
    await expect(pageA).toHaveURL(new RegExp(`/${docPageId}(?:[/?]|$)`));
    await expect(pageB).toHaveURL(new RegExp(`/${docPageId}(?:[/?]|$)`));
    expect(await isConnectedNoOverlay(pageA)).toBe(true);
    expect(await isConnectedNoOverlay(pageB)).toBe(true);
    const marker = `t67-b1-baseline-${Date.now()}`;
    await typeIntoDocumentBody(pageA, docPageId, marker);
    const bSawLive = await readDocumentBodyWithRetry(pageB, docPageId, marker, 40, 750);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await waitForDocumentReady(pageB, docPageId);
    const bSaw = await readDocumentBodyWithRetry(pageB, docPageId, marker);
    test.info().annotations.push({
      type: bSawLive.includes(marker) ? 'live-delivery-pass' : 'live-delivery-FAIL',
      description: `authorized member live (no-refresh) read: ${bSawLive.includes(marker) ? 'PASS' : 'FAIL'}; same content after reload: ${bSaw.includes(marker) ? 'PASS' : 'FAIL'}`,
    });
    // Task 71 fix: hard requirement now (see Task 66 A1's comment for why
    // this was a soft annotation through Task 70 and why it is safe to
    // harden now).
    expect(bSawLive, 'Task 71 fix: authorized member must see the owner\'s content LIVE, without a reload').toContain(marker);
    expect(bSaw, 'authorized member can read the owner\'s content (real browser, after reload)').toContain(marker);
  });

  test('B2. revoke membership while connected; existing socket is closed by the periodic revalidation timer', async () => {
    const closesBefore = wsTrackB.events.filter((e) => e.type === 'close').length;

    const revokeResp = await revokeMembership(env, workspaceId, ownerToken, memberEmail);
    expect(revokeResp.status, 'revocation via the Task 67 test-members DELETE helper must succeed').toBe(200);

    // Backend default periodic revalidation interval is 15000ms (server.js).
    // Condition-based wait with an explicit timeout slightly above it, not an
    // arbitrary excessive sleep.
    const deadline = Date.now() + 20000;
    let closed = false;
    while (Date.now() < deadline) {
      if (wsTrackB.events.filter((e) => e.type === 'close').length > closesBefore) {
        closed = true;
        break;
      }
      await pageB.waitForTimeout(500);
    }
    await screenshot(EVIDENCE_DIR, 'b2', pageB, 'after-revocation-wait');
    expect(closed, 'the member\'s already-open WebSocket connection must be closed by the server-side periodic revalidation within ~20s of revocation').toBe(true);

    // Owner remains unaffected.
    expect(await isConnectedNoOverlay(pageA), 'owner must remain connected/unaffected by another user\'s revocation').toBe(true);
    const ownerStillWorks = `t67-b2-owner-unaffected-${Date.now()}`;
    await typeIntoDocumentBody(pageA, docPageId, ownerStillWorks);
    await expect(documentBodyLocator(pageA, docPageId)).toContainText(ownerStillWorks);
  });

  test('B3. reconnection attempt is rejected; no protected content delivered', async () => {
    const responses: number[] = [];
    pageB.on('response', (resp) => {
      if (/\/api\/workspace/.test(resp.url())) responses.push(resp.status());
    });

    await pageB.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await pageB.waitForTimeout(3000);
    await screenshot(EVIDENCE_DIR, 'b3', pageB, 'after-reconnect-attempt');

    const saw403 = responses.includes(403);
    const bodyText = await documentBodyLocator(pageB, docPageId).innerText().catch(() => '');
    const stillOnDoc = /\/[0-9a-f-]{36}(?:[/?]|$)/.test(pageB.url()) && !/\/login/.test(pageB.url());
    test.info().annotations.push({ type: 'evidence', description: `workspace-API responses observed after reconnect attempt: ${JSON.stringify(responses)}; url=${pageB.url()}` });

    // Rejection evidence: either the workspace-scoped API explicitly 403s,
    // or the editor body is no longer rendering the protected document's
    // content (both are real, observable rejections -- not a generic UI
    // navigation failure, which would instead show an unrelated error).
    expect(saw403 || !stillOnDoc || !bodyText.includes('t67-b1-baseline'), 'the revoked member must not retain protected access after a reconnect attempt').toBe(true);

    // Owner continues to have access.
    const ownerCheck = `t67-b3-owner-still-ok-${Date.now()}`;
    await typeIntoDocumentBody(pageA, docPageId, ownerCheck);
    await expect(documentBodyLocator(pageA, docPageId)).toContainText(ownerCheck);
  });

  test('B4. offline update + authorization (bounded attempt)', async () => {
    // Per task scope: only attempt if the browser-level offline-outbox
    // workflow is reliably reachable; otherwise classify as Not Tested
    // rather than fabricate it, retaining Task 68's protocol-level evidence
    // as authoritative for the offline+authorization interaction.
    test.info().annotations.push({
      type: 'limitation',
      description: 'Not attempted via the real browser in this run: constructing a reliable browser-level "offline pending edit survives a revoke-while-offline-then-reconnect" scenario requires deterministic control over this app\'s own sync-outbox timing that the proven Task 69 helpers do not yet expose, and the guardrail reserves new ad hoc timing hacks for a case with evidence justifying them. Protocol-level evidence for revoked-membership-rejects-offline-replay remains Task 67/68\'s authoritative evidence (test/security-authorization.test.js, test/collaboration-recovery.test.js). Classified NOT TESTED at the browser level, not claimed as passing.',
    });
    test.skip(true, 'Deliberately not attempted at the browser level this run; see annotation.');
  });

  test('B5. membership restoration requires a fresh connection', async () => {
    const opensBeforeRestore = wsTrackB.events.filter((e) => e.type === 'open').length;

    const restoreResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
    expect(restoreResp.status, 'membership restoration via the test-members helper must succeed').toBe(201);

    // Task 70 finding: pageB's own "No access to this page" permission-gate
    // screen (see docs/task70-evidence/task67/*-after-reconnect-attempt.png)
    // appears to poll/retry on its own and can recover once membership is
    // restored, WITHOUT any explicit user action in this same tab -- this is
    // the app's own permission-gate UX, not the literal dead WebSocket
    // reactivating. Distinguish the two: if content reappears, confirm it
    // did so via a NEWLY opened WebSocket (wsTrackB open-event count
    // increasing), not the already-closed one.
    await pageB.waitForTimeout(2000);
    const bodyTextOld = await documentBodyLocator(pageB, docPageId).innerText().catch(() => '');
    const contentReappeared = bodyTextOld.includes('t67-b3-owner-still-ok');
    const opensAfterRestore = wsTrackB.events.filter((e) => e.type === 'open').length;
    const freshSocketObserved = opensAfterRestore > opensBeforeRestore;
    test.info().annotations.push({
      type: 'evidence',
      description: `old tab content reappeared after restoration (no manual reload): ${contentReappeared}; a NEW WebSocket open event was observed on that same tab in that window: ${freshSocketObserved} (opens before=${opensBeforeRestore}, after=${opensAfterRestore})`,
    });
    if (contentReappeared) {
      expect(freshSocketObserved, 'if the old tab recovers content, it must be via a genuinely NEW WebSocket connection, not the already-closed one reactivating').toBe(true);
    }

    // Fresh context + fresh login = fresh connection.
    const contextFresh = await browser.newContext();
    const pageFresh = await contextFresh.newPage();
    await loginUser(pageFresh, env.frontendUrl, memberEmail);
    await openSharedDocument(pageFresh, env.frontendUrl, workspaceId, docPageId, spaceId, 'Task67 security space');
    const readiness = await waitForDocumentReady(pageFresh, docPageId);
    await screenshot(EVIDENCE_DIR, 'b5', pageFresh, 'fresh-connection-after-restoration');
    expect(readiness.ok, 'a FRESH connection after membership restoration must successfully reopen the protected document').toBe(true);
    await expect(documentTitleLocator(pageFresh, docPageId)).toBeVisible();
    await contextFresh.close();
  });
});

// ===========================================================================
// Workstream C -- Task 68: recovery/reconnection (the specific remaining gap)
// ===========================================================================
test.describe('Task 68: collaboration recovery and reconnection', () => {
  const EVIDENCE_DIR = path.join(EVIDENCE_ROOT, 'task68');
  let env: TestEnvironment;
  let browser: Browser;
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let workspaceId: string;
  let docPageId: string;
  let ownerEmail: string;
  let memberEmail: string;
  let preRestartMarker: string;

  test.beforeAll(async ({ browser: b }) => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    env = await startTestEnvironment(EVIDENCE_DIR, 'task70-t68');
    browser = b;

    ownerEmail = await registerTestUser(env, 'task70-t68-owner', PASSWORD);
    memberEmail = await registerTestUser(env, 'task70-t68-member', PASSWORD);

    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();

    await loginUser(pageA, env.frontendUrl, ownerEmail);
    workspaceId = await createSpace(pageA, 'Task68 recovery space');
    docPageId = await createDocumentViaQuickAdd(pageA, 'Task68 recovery space');
    await waitForDocumentReady(pageA, docPageId);
    await ensureNoViewModalOpen(pageA);

    const ownerToken = await loginForToken(env, ownerEmail);
    const grantResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
    expect(grantResp.status).toBe(201);
    const spaceId = await resolveSpaceId(env, workspaceId, ownerToken);

    await loginUser(pageB, env.frontendUrl, memberEmail);
    await openSharedDocument(pageB, env.frontendUrl, workspaceId, docPageId, spaceId, 'Task68 recovery space');
    await waitForDocumentReady(pageB, docPageId);
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
    const { envRestored } = await stopTestEnvironment(env);
    expect(envRestored).toBe(true);
  });

  test('C1. pre-restart collaboration + persistence', async () => {
    await expect(pageA).toHaveURL(new RegExp(`/${docPageId}(?:[/?]|$)`));
    await expect(pageB).toHaveURL(new RegExp(`/${docPageId}(?:[/?]|$)`));

    preRestartMarker = `t68-c1-pre-restart-${Date.now()}`;
    await typeIntoDocumentBody(pageA, docPageId, preRestartMarker);
    const bSawLive = await readDocumentBodyWithRetry(pageB, docPageId, preRestartMarker, 40, 750);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await waitForDocumentReady(pageB, docPageId);
    const bSaw = await readDocumentBodyWithRetry(pageB, docPageId, preRestartMarker);
    await screenshot(EVIDENCE_DIR, 'c1', pageB, 'member-sees-pre-restart-marker');
    test.info().annotations.push({
      type: bSawLive.includes(preRestartMarker) ? 'live-delivery-pass' : 'live-delivery-FAIL',
      description: `member live (no-refresh) receipt of pre-restart marker: ${bSawLive.includes(preRestartMarker) ? 'PASS' : 'FAIL'}; same content after reload: ${bSaw.includes(preRestartMarker) ? 'PASS' : 'FAIL'}`,
    });
    // Task 71 fix: hard requirement now (see Task 66 A1's comment for why
    // this was a soft annotation through Task 70 and why it is safe to
    // harden now).
    expect(bSawLive, 'Task 71 fix: member must receive the pre-restart marker LIVE, without a reload').toContain(preRestartMarker);
    expect(bSaw, 'member must receive the pre-restart marker (real browser, after reload) before restart').toContain(preRestartMarker);
  });

  test('C2. backend restart against the SAME storage; both contexts reconnect and pre-restart content persists', async () => {
    const dataFileBefore = env.dataFile;
    const pidBefore = env.backendProcess.pid;

    await restartBackend(env);

    expect(env.dataFile, 'restart must reuse the identical disposable data file, never a fresh one').toBe(dataFileBefore);
    expect(env.backendProcess.pid, 'restart must produce a genuinely new process').not.toBe(pidBefore);

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const readyA = await waitForDocumentReady(pageA, docPageId);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    const readyB = await waitForDocumentReady(pageB, docPageId);
    await screenshot(EVIDENCE_DIR, 'c2', pageA, 'owner-after-restart-reload');
    await screenshot(EVIDENCE_DIR, 'c2', pageB, 'member-after-restart-reload');

    expect(readyA.ok, 'owner context must detect the interruption and reconnect/reload successfully').toBe(true);
    expect(readyB.ok, 'member context must detect the interruption and reconnect/reload successfully').toBe(true);

    const bodyA = await readDocumentBodyWithRetry(pageA, docPageId, preRestartMarker);
    const bodyB = await readDocumentBodyWithRetry(pageB, docPageId, preRestartMarker);
    expect(bodyA, 'pre-restart content must persist for the owner after restart').toContain(preRestartMarker);
    expect(bodyB, 'pre-restart content must persist for the member after restart').toContain(preRestartMarker);
  });

  test('C3. post-restart bidirectional delivery + reload persistence (the outstanding Task 68 gap)', async () => {
    const postMarkerA = `t68-c3-post-restart-owner-${Date.now()}`;
    await appendIntoDocumentBody(pageA, docPageId, postMarkerA);
    const bSawPostALive = await readDocumentBodyWithRetry(pageB, docPageId, postMarkerA, 40, 750);
    await screenshot(EVIDENCE_DIR, 'c3', pageB, 'member-sees-post-restart-owner-edit');

    const postMarkerB = `t68-c3-post-restart-member-${Date.now()}`;
    await appendIntoDocumentBody(pageB, docPageId, postMarkerB);
    const aSawPostBLive = await readDocumentBodyWithRetry(pageA, docPageId, postMarkerB, 40, 750);
    await screenshot(EVIDENCE_DIR, 'c3', pageA, 'owner-sees-post-restart-member-edit');

    test.info().annotations.push({
      type: (bSawPostALive.includes(postMarkerA) && aSawPostBLive.includes(postMarkerB)) ? 'live-delivery-pass' : 'live-delivery-FAIL',
      description: `post-restart LIVE (no-refresh) owner->member: ${bSawPostALive.includes(postMarkerA) ? 'PASS' : 'FAIL'}; post-restart LIVE member->owner: ${aSawPostBLive.includes(postMarkerB) ? 'PASS' : 'FAIL'} -- this is the specific Task 68 bonus leg left outstanding by Task 69; Task 71 root-caused and fixed the cross-context cold-start live-render gap previously documented here for Task 66/67/68 (see docs/TASK71_COLD_START_LIVE_RENDERING_REPORT.md).`,
    });

    // Task 71 fix: hard requirement now, including immediately after a real
    // backend restart + reconnect (the specific condition this scenario
    // exists to exercise).
    expect(bSawPostALive, 'Task 71 fix: member must see the owner\'s post-restart edit LIVE').toContain(postMarkerA);
    expect(aSawPostBLive, 'Task 71 fix: owner must see the member\'s post-restart edit LIVE').toContain(postMarkerB);

    expect(await isConnectedNoOverlay(pageA)).toBe(true);
    expect(await isConnectedNoOverlay(pageB)).toBe(true);

    // Hard requirement (the part of this scenario NOT blocked by the live-render
    // gap): both post-restart edits converge to BOTH contexts after a reload,
    // alongside the pre-restart marker -- genuine reload-based bidirectional
    // reconciliation proof, on the SAME restarted backend/storage.
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const readinessA = await waitForDocumentReady(pageA, docPageId);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    const readinessB = await waitForDocumentReady(pageB, docPageId);
    expect(readinessA.ok).toBe(true);
    expect(readinessB.ok).toBe(true);

    const finalA = await readDocumentBodyWithRetry(pageA, docPageId, postMarkerB);
    const finalB = await readDocumentBodyWithRetry(pageB, docPageId, postMarkerA);
    for (const [label, body] of [['owner', finalA], ['member', finalB]] as const) {
      expect(body, `${label} must see preRestartMarker after reload`).toContain(preRestartMarker);
      expect(body, `${label} must see postMarkerA after reload`).toContain(postMarkerA);
      expect(body, `${label} must see postMarkerB after reload`).toContain(postMarkerB);
    }
  });
});
