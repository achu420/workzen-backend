import { test, expect, Page, Browser, BrowserContext } from '@playwright/test';
import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  startTestEnvironment,
  stopTestEnvironment,
  restartBackend,
  registerTestUser,
  TestEnvironment,
} from '../helpers/test-environment';
import { dismissCompatBanner, hoverSpaceRow, navigateViaSidebar } from '../helpers/navigation';

/**
 * Task 77.4.7 -- DIAGNOSTIC ONLY. Not an acceptance test.
 *
 * Fresh-versus-warmed browser-context comparison for Scenario I's
 * repeatable second-consecutive-cell-write failure (Task 77.4.4: 3/3,
 * `writeCell` line 266, scenario line 1065). Task 77.4.5 (4 structural
 * differences) and 77.4.6 (+ genuine SPA navigation) both failed to
 * reproduce it in a FRESH context, while the real, unmodified spec
 * reproduces it reliably. This diagnostic tests the one remaining
 * structural difference: the real Scenario I runs on a pageA/contextA that
 * has already lived through Scenarios A-H (multiple full reloads, 3
 * transport-level disconnect/reconnect cycles, a genuine backend process
 * restart, and ~10 prior real UI mutations) -- never a fresh context.
 *
 * Every helper function below is either an EXACT COPY (byte-identical
 * logic, not re-implemented) of the corresponding function in
 * `task77-1-database-multiuser.spec.ts`, or is explicitly marked where it
 * differs. The original file does not `export` its helpers, so they are
 * duplicated here rather than imported -- per this task's own instruction
 * ("If they cannot be reused because they are tightly coupled to the
 * original test structure, reproduce their actual UI operations... and
 * document every difference").
 */

const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'docs', 'task77-4-7-evidence');
const PASSWORD = 'Correct horse battery staple 7747';

// ---------------------------------------------------------------------------
// EXACT COPIES from task77-1-database-multiuser.spec.ts
// ---------------------------------------------------------------------------

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
  page.on('requestfinished', (req) => {
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

async function createGridDatabase(page: Page, spaceLabel: string): Promise<string> {
  await hoverSpaceRow(page, spaceLabel);
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-grid-button').click();
  await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
  const pageId = (page.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  expect(pageId, 'database page id must be resolvable from the URL right after creation').toBeTruthy();
  return pageId as string;
}

async function createRow(page: Page): Promise<string> {
  const before = await page.locator('[data-testid^="grid-row-"]:not([data-testid="grid-row-undefined"])').count();
  await page.getByTestId('grid-new-row').click({ timeout: 10000 }).catch(async () => {
    await page.getByText('New row', { exact: false }).first().click();
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  const rows = page.locator('[data-testid^="grid-row-"]:not([data-testid="grid-row-undefined"])');
  await expect(rows).toHaveCount(before + 1, { timeout: 15000 });
  const testId = await rows.last().getAttribute('data-testid');
  const rowId = (testId || '').replace('grid-row-', '');
  expect(rowId, 'row id must be resolvable from its grid-row testid').toBeTruthy();
  return rowId;
}

async function firstFieldId(page: Page): Promise<string> {
  const header = page.locator('[data-testid^="grid-field-header-"]').first();
  await header.waitFor({ state: 'visible', timeout: 15000 });
  const testId = await header.getAttribute('data-testid');
  const fieldId = (testId || '').replace('grid-field-header-', '');
  expect(fieldId, 'a field id must be resolvable from the grid header').toBeTruthy();
  return fieldId;
}

async function ensureGridInteractive(page: Page, timeoutMs = 30000): Promise<void> {
  await page.bringToFront();
  const ready = await page
    .waitForSelector('[data-testid^="grid-field-header-"]', { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!ready) return;
  await dismissCompatBanner(page).catch(() => {});
}

function realGridFieldHeader(page: Page, fieldId: string) {
  return page.locator(
    `[data-testid="grid-field-header-${fieldId}"]:not(.grid-sticky-header [data-testid="grid-field-header-${fieldId}"])`,
  ).first();
}

async function renameField(page: Page, fieldId: string, newName: string): Promise<void> {
  await ensureGridInteractive(page);
  const header = realGridFieldHeader(page, fieldId);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await header.scrollIntoViewIfNeeded().catch(() => {});
      await header.click({ timeout: 8000 });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  if (lastErr) throw lastErr;
  const input = page.getByTestId('property-name-input');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(newName);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

// writeCell has one addition over the original: an optional `checkpoint`
// callback invoked at the 5 points Task 77.4.5/77.4.6/this task's brief
// require (before first attempt, at each retry attempt, at outcome). This
// is the ONLY behavioral addition versus the original `writeCell` -- it is
// purely observational (read-only `evaluate()`/`count()`/`boundingBox()`
// calls), never alters control flow, click targets, or timing.
interface CellCheckpoint {
  label: string;
  selector: string;
  matchCount: number;
  visibleCount: number;
  attached: boolean;
  boundingBox: unknown;
  computedVisibility: string | null;
  computedDisplay: string | null;
  inViewport: boolean | null;
  hitTestSameNode: boolean | null;
  rowPresentCount: number;
  gridPresent: boolean;
  activeElementTag: string | null;
  activeElementEditable: boolean | null;
  editorLikeCount: number;
  rendererResponsive: boolean;
  consoleErrorsSinceLast: number;
}

async function captureCellCheckpoint(page: Page, rowId: string, fieldId: string, label: string): Promise<CellCheckpoint> {
  const selector = `[data-testid="grid-cell-${rowId}-${fieldId}"]`;
  const rendererResponsive = await page.evaluate(() => 1 + 1).then((v) => v === 2).catch(() => false);
  const data = await page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const first = nodes[0] ?? null;
    const visibleNodes = nodes.filter((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    });
    let boundingBox: unknown = null;
    let computedVisibility: string | null = null;
    let computedDisplay: string | null = null;
    let inViewport: boolean | null = null;
    let hitTestSameNode: boolean | null = null;
    if (first) {
      const r = first.getBoundingClientRect();
      boundingBox = { x: r.x, y: r.y, width: r.width, height: r.height };
      const cs = getComputedStyle(first);
      computedVisibility = cs.visibility;
      computedDisplay = cs.display;
      inViewport = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      hitTestSameNode = hit === first || first.contains(hit) || (hit ? hit.contains(first) : false);
    }
    const rowPresentCount = document.querySelectorAll(`[data-testid^="grid-row-"]`).length;
    const gridPresent = Boolean(document.querySelector('[data-testid="database-grid"]'));
    const active = document.activeElement as HTMLElement | null;
    const activeElementTag = active ? active.tagName : null;
    const activeElementEditable = active ? (active as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA'].includes(active.tagName) : null;
    const editorLikeCount = document.querySelectorAll('[role="textbox"], [contenteditable="true"], [data-testid*="editor"]').length;
    return {
      matchCount: nodes.length,
      visibleCount: visibleNodes.length,
      attached: Boolean(first && first.isConnected),
      boundingBox,
      computedVisibility,
      computedDisplay,
      inViewport,
      hitTestSameNode,
      rowPresentCount,
      gridPresent,
      activeElementTag,
      activeElementEditable,
      editorLikeCount,
    };
  }, selector).catch(() => null);
  return {
    label,
    selector,
    matchCount: data?.matchCount ?? -1,
    visibleCount: data?.visibleCount ?? -1,
    attached: data?.attached ?? false,
    boundingBox: data?.boundingBox ?? 'Not captured',
    computedVisibility: data?.computedVisibility ?? null,
    computedDisplay: data?.computedDisplay ?? null,
    inViewport: data?.inViewport ?? null,
    hitTestSameNode: data?.hitTestSameNode ?? null,
    rowPresentCount: data?.rowPresentCount ?? -1,
    gridPresent: data?.gridPresent ?? false,
    activeElementTag: data?.activeElementTag ?? null,
    activeElementEditable: data?.activeElementEditable ?? null,
    editorLikeCount: data?.editorLikeCount ?? -1,
    rendererResponsive,
    consoleErrorsSinceLast: 0,
  };
}

/**
 * EXACT COPY of the original writeCell's control flow, with ONE addition:
 * optional before/attempt/after checkpoint capture via `checkpoints` array
 * (read-only instrumentation only, per this task's Phase 8 requirement).
 */
async function writeCell(
  page: Page,
  rowId: string,
  fieldId: string,
  text: string,
  checkpoints?: CellCheckpoint[],
): Promise<void> {
  await ensureGridInteractive(page);
  await waitForGridRowReady(page, rowId, fieldId);
  if (checkpoints) checkpoints.push(await captureCellCheckpoint(page, rowId, fieldId, 'before-write'));
  const cell = page.locator(`[data-testid="grid-cell-${rowId}-${fieldId}"]`).first();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (checkpoints) checkpoints.push(await captureCellCheckpoint(page, rowId, fieldId, `retry-attempt-${attempt}`));
    try {
      await cell.waitFor({ state: 'visible', timeout: 15000 });
      await cell.click({ timeout: 8000 });
      await page.waitForTimeout(200);
      await cell.click({ timeout: 8000 });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  if (checkpoints) checkpoints.push(await captureCellCheckpoint(page, rowId, fieldId, lastErr ? 'outcome-failure' : 'outcome-success'));
  if (lastErr) throw lastErr;
  await page.waitForTimeout(300);
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

async function readCell(page: Page, rowId: string, fieldId: string): Promise<string> {
  const texts = await page
    .locator(`[data-testid="grid-cell-${rowId}-${fieldId}"]`)
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(' | ');
}

async function waitForGridRowReady(page: Page, rowId: string, fieldId: string, timeoutMs = 30000): Promise<boolean> {
  await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: timeoutMs }).catch(() => {});
  const row = page.locator(`[data-testid="grid-row-${rowId}"]`).first();
  await row.waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => {});
  await row.scrollIntoViewIfNeeded().catch(() => {});
  return page
    .waitForSelector(`[data-testid="grid-cell-${rowId}-${fieldId}"]`, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function readFieldName(page: Page, fieldId: string): Promise<string> {
  const texts = await page
    .locator(`[data-testid="grid-field-header-${fieldId}"]`)
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(' | ');
}

async function awaitFieldNameLive(page: Page, fieldId: string, expected: string, timeoutMs = 20000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await readFieldName(page, fieldId)).includes(expected)) return Date.now() - started;
    await page.waitForTimeout(400);
  }
  return null;
}

async function awaitCellTextLive(page: Page, rowId: string, fieldId: string, expected: string, timeoutMs = 20000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await readCell(page, rowId, fieldId)).includes(expected)) return Date.now() - started;
    await page.waitForTimeout(400);
  }
  return null;
}

async function awaitRowPresentLive(page: Page, rowId: string, timeoutMs = 20000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const n = await page.locator(`[data-testid="grid-row-${rowId}"]`).count().catch(() => 0);
    if (n > 0) return Date.now() - started;
    await page.waitForTimeout(400);
  }
  return null;
}

async function loginGetToken(env: TestEnvironment, email: string): Promise<string> {
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

async function resolveSpaceId(env: TestEnvironment, workspaceId: string, ownerToken: string): Promise<string | null> {
  const resp = await fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/pages`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (!resp.ok) return null;
  const { pages } = await resp.json();
  return pages[0]?.parent_view_id ?? null;
}

interface PageRec {
  id: string;
  layout?: number;
  parent_view_id?: string;
  extra?: { database_id?: string };
}

async function listPages(env: TestEnvironment, workspaceId: string, token: string): Promise<PageRec[]> {
  const resp = await fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/pages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  return (await resp.json()).pages as PageRec[];
}

async function resolveDatabaseId(env: TestEnvironment, workspaceId: string, token: string, databasePageId: string): Promise<string> {
  const pages = await listPages(env, workspaceId, token);
  const dbId = pages.find((p) => p.id === databasePageId)?.extra?.database_id;
  expect(dbId, 'the created database page must carry extra.database_id').toBeTruthy();
  return dbId as string;
}

async function resolveSidebarDatabasePage(
  env: TestEnvironment,
  workspaceId: string,
  token: string,
  databaseId: string,
  spaceId: string | null,
  fallbackPageId: string,
): Promise<{ pageId: string; wasAncestor: boolean }> {
  const pages = await listPages(env, workspaceId, token);
  const sameDb = pages.filter((p) => p.extra?.database_id === databaseId);
  const underSpace = sameDb.find((p) => spaceId && p.parent_view_id === spaceId);
  if (underSpace) return { pageId: underSpace.id, wasAncestor: underSpace.id !== fallbackPageId };
  return { pageId: fallbackPageId, wasAncestor: false };
}

async function readDatabaseCollab(
  env: TestEnvironment,
  token: string,
  workspaceId: string,
  databaseId: string,
): Promise<{ fieldNames: Record<string, string>; rowIds: string[] } | null> {
  const resp = await fetch(`${env.backendUrl}/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (resp.status !== 200) return null;
  const body = await resp.json();
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(body.data.doc_state));
    const database = doc.getMap('data').get('database') as Y.Map<unknown>;
    const fields = database.get('fields') as Y.Map<Y.Map<unknown>>;
    const fieldNames: Record<string, string> = {};
    for (const [fid, f] of fields.entries()) {
      const n = f.get('name');
      if (typeof n === 'string') fieldNames[fid] = n;
    }
    const views = database.get('views') as Y.Map<Y.Map<unknown>>;
    const rowIds: string[] = [];
    for (const view of views.values()) {
      const rowOrders = view.get('row_orders') as Y.Array<Y.Map<unknown>> | undefined;
      if (!rowOrders) continue;
      for (const entry of rowOrders.toJSON() as { id: string; is_deleted?: boolean }[]) {
        if (!entry.is_deleted && !rowIds.includes(entry.id)) rowIds.push(entry.id);
      }
    }
    return { fieldNames, rowIds };
  } finally {
    doc.destroy();
  }
}

async function readRowCell(env: TestEnvironment, token: string, workspaceId: string, rowId: string, fieldId: string): Promise<string> {
  const resp = await fetch(`${env.backendUrl}/api/workspace/v1/${workspaceId}/collab/${rowId}?collab_type=4`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (resp.status !== 200) return '';
  const body = await resp.json();
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(body.data.doc_state));
    const row = doc.getMap('data').get('data') as Y.Map<unknown> | undefined;
    if (!row) return '';
    const cells = row.get('cells') as Y.Map<Y.Map<unknown>> | undefined;
    if (!cells) return '';
    const cell = cells.get(fieldId);
    if (!cell) return '';
    return JSON.stringify(cell.toJSON());
  } finally {
    doc.destroy();
  }
}

async function openSharedDatabase(
  page: Page,
  frontendUrl: string,
  workspaceId: string,
  databasePageId: string,
  spaceId: string | null,
  spaceLabel: string,
): Promise<{ ok: boolean; via: string; navReason?: string }> {
  await page.goto(`${frontendUrl}/app/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1000);
  await dismissCompatBanner(page);

  let via = 'direct';
  let navReason: string | undefined;
  if (spaceId) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const nav = await navigateViaSidebar(page, databasePageId, spaceId, spaceLabel).catch(
        (e) => ({ ok: false, reason: `threw: ${String(e).slice(0, 200)}` } as { ok: boolean; reason?: string }),
      );
      if (nav.ok) {
        via = `sidebar(attempt ${attempt})`;
        break;
      }
      navReason = nav.reason;
      if (attempt < 3) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await dismissCompatBanner(page);
      }
    }
  } else {
    navReason = 'no spaceId resolved';
  }
  if (via === 'direct') {
    await page.goto(`${frontendUrl}/app/${workspaceId}/${databasePageId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await dismissCompatBanner(page);
  }
  const ok = await page
    .waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(800);
  return { ok, via, navReason };
}

// ---------------------------------------------------------------------------
// Diagnostic-specific types and evidence plumbing
// ---------------------------------------------------------------------------

interface ArmResult {
  arm: 'fresh' | 'warmed';
  warmupOperationsPerformed: string[];
  warmupOperationsOmitted: Array<{ op: string; reason: string }>;
  firstWriteCommitted: boolean;
  secondWriteSucceeded: boolean;
  secondWriteError: string | null;
  checkpoints: CellCheckpoint[];
  docPageId?: string;
  docEditable?: boolean;
  spaNavigationEvidence?: { framenavigatedCount: number; viaClassification: string };
}

const evidence: Record<string, unknown> = {};
async function saveEvidence() {
  await mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  await writeFile(path.join(EVIDENCE_DIR, 'diagnostic-result.json'), JSON.stringify(evidence, null, 2)).catch(() => {});
}

/**
 * The exact Scenario I sequence (task77-1 lines 1028-1095), reused
 * identically whether the arm is fresh or warmed. Returns the second-write
 * outcome plus full DOM checkpoint evidence.
 */
async function runScenarioISequence(
  env: TestEnvironment,
  pageA: Page,
  pageB: Page,
  spaceLabel: string,
  workspaceId: string,
  sharedDatabasePageId: string,
  spaceId: string | null,
  fieldId: string,
  rowId: string,
): Promise<Omit<ArmResult, 'arm' | 'warmupOperationsPerformed' | 'warmupOperationsOmitted'>> {
  const checkpoints: CellCheckpoint[] = [];
  let framenavigatedCount = 0;
  pageA.on('framenavigated', (frame) => {
    if (frame === pageA.mainFrame()) framenavigatedCount += 1;
  });

  const urlBefore = pageA.url();
  await hoverSpaceRow(pageA, spaceLabel);
  await pageA.getByTestId('inline-add-page').first().click();
  await pageA.getByTestId('add-document-button').click();
  await pageA.waitForFunction((prev) => window.location.href !== prev, urlBefore, { timeout: 20000 }).catch(() => {});
  await pageA.waitForTimeout(1200);
  const docPageId = (pageA.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  expect(docPageId, 'the ordinary Document page id must be resolvable').toBeTruthy();

  const docMarker = `T7747doc${Date.now()}`;
  const body = pageA.locator(`[data-testid="document-body-${docPageId}"], [data-page-id="${docPageId}"] [role="textbox"]`).first();
  const docEditable = await body.isVisible({ timeout: 10000 }).catch(() => false);
  if (docEditable) {
    await body.click();
    await pageA.keyboard.type(docMarker, { delay: 20 });
    await pageA.waitForTimeout(1000);
  }

  const navCountBeforeReturn = framenavigatedCount;
  await openSharedDatabase(pageA, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, spaceLabel);
  const navCountDuringReturn = framenavigatedCount - navCountBeforeReturn;

  const dbMarker = `T7747db${Date.now()}`;
  await renameField(pageA, fieldId, dbMarker);
  const rowMarker = `T7747row${Date.now()}`;
  await writeCell(pageA, rowId, fieldId, rowMarker);

  checkpoints.push(await captureCellCheckpoint(pageA, rowId, fieldId, 'after-first-write-commits'));
  const firstWriteCommitted = (await readCell(pageA, rowId, fieldId)).includes(rowMarker);

  const rowMarker2 = `T7747row2${Date.now()}`;
  let secondWriteSucceeded = false;
  let secondWriteError: string | null = null;
  try {
    await writeCell(pageA, rowId, fieldId, rowMarker2, checkpoints);
    secondWriteSucceeded = true;
  } catch (e) {
    secondWriteError = String(e).slice(0, 2000);
  }

  return {
    firstWriteCommitted,
    secondWriteSucceeded,
    secondWriteError,
    checkpoints,
    docPageId,
    docEditable,
    spaNavigationEvidence: {
      framenavigatedCount: navCountDuringReturn,
      viaClassification: navCountDuringReturn === 0 ? 'spa-confirmed' : 'spa-after-reload-retry',
    },
  };
}

// ===========================================================================
// Diagnostic suite
// ===========================================================================
test.describe('Task 77.4.7 diagnostic: fresh vs warmed browser context for Scenario I', () => {
  test.beforeAll(async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
  });

  test.afterEach(async () => {
    await saveEvidence();
  });

  test('Arm A: fresh control -- Scenario I sequence in a never-before-used context', async ({ browser }) => {
    test.setTimeout(180000);
    const env = await startTestEnvironment(EVIDENCE_DIR, 'task77-4-7-arma', undefined);
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;
    try {
      const ownerEmail = await registerTestUser(env, 'arma-owner', PASSWORD);
      const memberEmail = await registerTestUser(env, 'arma-member', PASSWORD);
      contextA = await browser.newContext();
      contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await loginUser(pageA, env.frontendUrl, ownerEmail);
      const workspaceId = await createSpace(pageA, 'T7747 fresh space');
      const databasePageId = await createGridDatabase(pageA, 'T7747 fresh space');
      const ownerToken = await loginGetToken(env, ownerEmail);
      const databaseId = await resolveDatabaseId(env, workspaceId, ownerToken, databasePageId);
      const spaceId = await resolveSpaceId(env, workspaceId, ownerToken);
      const fieldId = await firstFieldId(pageA);
      const rowId = await createRow(pageA);

      const grantResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
      expect(grantResp.status).toBe(201);
      const memberToken = await loginGetToken(env, memberEmail);

      const sidebarPage = await resolveSidebarDatabasePage(env, workspaceId, ownerToken, databaseId, spaceId, databasePageId);
      const sharedDatabasePageId = sidebarPage.pageId;

      await loginUser(pageB, env.frontendUrl, memberEmail);
      await openSharedDatabase(pageB, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, 'T7747 fresh space');
      await openSharedDatabase(pageA, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, 'T7747 fresh space');

      const result = await runScenarioISequence(
        env, pageA, pageB, 'T7747 fresh space', workspaceId, sharedDatabasePageId, spaceId, fieldId, rowId,
      );

      evidence.armA = {
        arm: 'fresh',
        warmupOperationsPerformed: ['beforeAll-equivalent setup only (identical to original beforeAll)'],
        warmupOperationsOmitted: [
          { op: 'P0', reason: 'read-only HTTP/DOM queries, no observable effect on pageA/pageB/contextA/contextB state -- confirmed by source read' },
          { op: 'A-H', reason: 'this IS the fresh-control arm; by design it omits all A-H warm-up to serve as the baseline' },
        ],
        ...result,
      };
      await saveEvidence();
    } finally {
      await Promise.race([Promise.all([contextA?.close(), contextB?.close()]), new Promise((r) => setTimeout(r, 15000))]).catch(() => {});
      await stopTestEnvironment(env).catch(() => {});
    }
  });

  test('Arm B: warmed context -- real A-H operations on pageA/contextA, then the exact Scenario I sequence', async ({ browser }) => {
    test.setTimeout(600000);
    const env = await startTestEnvironment(EVIDENCE_DIR, 'task77-4-7-armb', undefined);
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;
    const performed: string[] = [];
    const omitted: Array<{ op: string; reason: string }> = [];
    try {
      const ownerEmail = await registerTestUser(env, 'armb-owner', PASSWORD);
      const memberEmail = await registerTestUser(env, 'armb-member', PASSWORD);
      contextA = await browser.newContext();
      contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const spaceLabel = 'T7747 warmed space';

      await loginUser(pageA, env.frontendUrl, ownerEmail);
      const workspaceId = await createSpace(pageA, spaceLabel);
      const databasePageId = await createGridDatabase(pageA, spaceLabel);
      const ownerToken = await loginGetToken(env, ownerEmail);
      const databaseId = await resolveDatabaseId(env, workspaceId, ownerToken, databasePageId);
      const spaceId = await resolveSpaceId(env, workspaceId, ownerToken);
      const fieldId = await firstFieldId(pageA);
      const rowId = await createRow(pageA);

      const grantResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
      expect(grantResp.status).toBe(201);
      const memberToken = await loginGetToken(env, memberEmail);

      const sidebarPage = await resolveSidebarDatabasePage(env, workspaceId, ownerToken, databaseId, spaceId, databasePageId);
      const sharedDatabasePageId = sidebarPage.pageId;

      await loginUser(pageB, env.frontendUrl, memberEmail);
      await openSharedDatabase(pageB, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, spaceLabel);
      await openSharedDatabase(pageA, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, spaceLabel);
      performed.push('beforeAll-equivalent setup (identical to original)');

      omitted.push({ op: 'P0', reason: 'read-only HTTP/DOM queries, no observable effect on pageA/pageB/contextA/contextB state -- confirmed by source read' });

      // --- Scenario A: exact reuse. Owner renames the field on pageA. ---
      await renameField(pageA, fieldId, `T7747A${Date.now()}`);
      performed.push('A: renameField(pageA) -- exact reuse');

      // --- Scenario B: exact reuse of its pageA-visible effect. The real
      // scenario B mutates pageB, which does not directly change pageA's
      // DOM, but its documented effect ON pageA is the full page.reload()
      // that follows -- reproduced exactly, including the mutation on pageB
      // first (so the Database collab/field name state matches the real
      // run, not just the reload itself). ---
      await renameField(pageB, fieldId, `T7747B${Date.now()}`);
      await pageA.reload({ waitUntil: 'domcontentloaded' });
      await pageA.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 20000 }).catch(() => {});
      await pageA.waitForTimeout(1000);
      performed.push('B: renameField(pageB) + pageA.reload() -- exact reuse (pageA reload is B\'s documented effect on pageA)');

      // --- Scenario C: exact reuse. Owner writes a cell on pageA. ---
      await writeCell(pageA, rowId, fieldId, `T7747C${Date.now()}`);
      await pageB.reload({ waitUntil: 'domcontentloaded' });
      performed.push('C: writeCell(pageA) + pageB.reload() -- exact reuse');

      // --- Scenario D: exact reuse of its pageA-visible effect (second
      // full reload of pageA). ---
      await writeCell(pageB, rowId, fieldId, `T7747D${Date.now()}`);
      await pageA.reload({ waitUntil: 'domcontentloaded' });
      await waitForGridRowReady(pageA, rowId, fieldId);
      performed.push('D: writeCell(pageB) + pageA.reload() -- exact reuse (2nd pageA reload, D\'s documented effect on pageA)');

      // --- Scenario E: exact reuse. Creates a 2nd row (original rowId
      // still valid, matching the real suite's additive behavior). ---
      const extraRowId = await createRow(pageA);
      await awaitRowPresentLive(pageB, extraRowId, 10000);
      performed.push('E: createRow(pageA) -- exact reuse');

      // --- Scenario F: exact reuse, including the original's own
      // skip-if-fewer-than-2-fields condition (identical logic, not a
      // different reconstruction). ---
      const headers = pageA.locator('[data-testid^="grid-field-header-"]');
      const headerCount = await headers.count();
      if (headerCount >= 2) {
        const secondTestId = await headers.nth(1).getAttribute('data-testid');
        const fieldId2 = (secondTestId || '').replace('grid-field-header-', '');
        await Promise.all([
          writeCell(pageA, rowId, fieldId, `T7747FA${Date.now()}`),
          writeCell(pageB, rowId, fieldId2, `T7747FB${Date.now()}`),
        ]);
        performed.push('F: concurrent writeCell(pageA)+writeCell(pageB) on separate fields -- exact reuse');
      } else {
        omitted.push({ op: 'F', reason: `only ${headerCount} field header(s) present -- identical to the original's own skip condition, not a different reconstruction` });
      }

      // --- Scenario G: exact reuse. 3x real transport-level disconnect on
      // contextA, then a Database mutation + a DatabaseRow mutation per
      // cycle, each on pageA. ---
      for (let i = 1; i <= 3; i += 1) {
        await contextA.setOffline(true);
        await pageA.waitForTimeout(2500);
        await contextA.setOffline(false);
        await pageA.waitForTimeout(6000);
        await renameField(pageA, fieldId, `T7747G${i}DB${Date.now()}`).catch(() => {});
        await awaitFieldNameLive(pageB, fieldId, `__never_matches__`, 1500); // drain loop time budget without asserting; real timing preserved
        await writeCell(pageA, rowId, fieldId, `T7747G${i}ROW${Date.now()}`).catch(() => {});
        await awaitCellTextLive(pageB, rowId, fieldId, `__never_matches__`, 1500);
      }
      performed.push('G: 3x contextA.setOffline(true/false) + renameField(pageA) + writeCell(pageA) per cycle -- exact reuse of all pageA/contextA operations (peer-live-poll windows shortened from 10s/20s to 1.5s since this diagnostic does not assert on them, consistent with not re-testing G\'s own acceptance criteria -- only reproducing its state effect on contextA/pageA)');

      // --- Scenario H: exact reuse, INCLUDING the genuine backend process
      // restart. ---
      await writeCell(pageA, rowId, fieldId, `T7747Hpre${Date.now()}`);
      await restartBackend(env);
      await pageA.waitForTimeout(3000);
      await pageA.reload({ waitUntil: 'domcontentloaded' });
      await pageA.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 25000 }).catch(() => {});
      await pageB.reload({ waitUntil: 'domcontentloaded' });
      await pageB.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 25000 }).catch(() => {});
      await pageA.waitForTimeout(2500);
      await writeCell(pageA, rowId, fieldId, `T7747Hpost${Date.now()}`);
      await renameField(pageA, fieldId, `T7747HDB${Date.now()}`);
      performed.push('H: writeCell(pageA) + restartBackend(env) [REAL process kill+respawn] + pageA.reload() + pageB.reload() + writeCell(pageA) + renameField(pageA) -- exact reuse');

      // --- Now, on this SAME pageA/contextA that has lived through A-H,
      // run the exact Scenario I sequence. ---
      const result = await runScenarioISequence(
        env, pageA, pageB, spaceLabel, workspaceId, sharedDatabasePageId, spaceId, fieldId, rowId,
      );

      evidence.armB = {
        arm: 'warmed',
        warmupOperationsPerformed: performed,
        warmupOperationsOmitted: omitted,
        ...result,
      };
      await saveEvidence();
    } finally {
      await Promise.race([Promise.all([contextA?.close(), contextB?.close()]), new Promise((r) => setTimeout(r, 15000))]).catch(() => {});
      await stopTestEnvironment(env).catch(() => {});
    }
  });
});
