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
 * Task 77.1 -- Database / DatabaseRow multi-user collaboration and
 * reconnection verification.
 *
 * Task 77 verified Document reconnection and two-client Document delivery,
 * but explicitly could NOT verify the same for Database (collabType=1) and
 * DatabaseRow (collabType=4) because no helper existed to share a Database
 * page across two independently-authenticated workspace members. This file
 * builds that missing capability and uses it.
 *
 * Why these two collab types matter specifically: they are the ONLY types
 * whose outgoing frames take the deferred `beforeSend(...).then(...)` branch
 * in AppFlowy-Web's `rawEmit` (useSyncContextLifecycle.ts) -- the exact
 * asymmetry that produced Task 75's confirmed ordering defect (a dependent
 * update overtaking its own SyncRequest, rejected by the server with a 1008
 * close). Task 76 made that transmission awaitable and Task 76.1 made the
 * *outcome* propagate (rawEmit -> Promise<boolean>, with a revert of the
 * optimistic lastBoundObjectId write on denial/failure). So Database and
 * DatabaseRow two-client + reconnect coverage is the most direct remaining
 * real-browser test of that fix chain.
 *
 * EVIDENCE DISCIPLINE (per the task spec, and per Task 71's documented trap):
 * the backend's HTTP `collab_full_sync_batch` "slow lane" PERSISTS an update
 * but never fans it out to already-connected peers (Task 71 §3, confirmed by
 * reading server.js). Therefore observing a mutation on the PEER's page
 * without any reload is, by construction, evidence of live WebSocket fan-out
 * -- the HTTP fallback cannot produce it. Each scenario below separately
 * records: (1) the writer's own UI state, (2) peer-visible-without-reload
 * (live), (3) independently backend-persisted state read over HTTP with the
 * member's own token, (4) state retained after an explicit reload. WebSocket
 * close codes (especially 1008) are tracked per page throughout.
 */

const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'docs', 'task77-1-evidence');
const PASSWORD = 'Correct horse battery staple 771';

const usePostgres = process.env.TASK77_PG_STORAGE === '1' && Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Shared helpers -- thin wrappers over the already-proven Task 69 navigation
// primitives and the Task 67 test-membership plumbing, plus the Database/row
// grid interactions proven in Task 73's database-row-detail-page.spec.ts.
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

/** Proven in Task 73: real quick-add grid creation, gated on a grid-scoped (not Document-scoped) readiness signal. */
async function createGridDatabase(page: Page, spaceLabel: string): Promise<string> {
  await hoverSpaceRow(page, spaceLabel);
  await page.getByTestId('inline-add-page').first().click();
  await page.getByTestId('add-grid-button').click();
  await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 15000 });
  const pageId = (page.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
  expect(pageId, 'database page id must be resolvable from the URL right after creation').toBeTruthy();
  return pageId as string;
}

/** Create a row via the real bottom-of-grid affordance and return its row id. Does NOT open the peek. */
async function createRow(page: Page): Promise<string> {
  const before = await page.locator('[data-testid^="grid-row-"]:not([data-testid="grid-row-undefined"])').count();
  await page.getByTestId('grid-new-row').click({ timeout: 10000 }).catch(async () => {
    await page.getByText('New row', { exact: false }).first().click();
  });
  // A freshly created row auto-activates its primary cell for typing; escape
  // so later hover/click interactions are not swallowed by the active editor
  // (Task 73's own finding, reused).
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

/**
 * Each client is a separate BrowserContext; whichever one hasn't been the
 * active/foreground page for a while (every scenario alternates which
 * client acts) can be silently discarded/re-navigated by Chromium under
 * memory pressure -- confirmed live in Task 77.3 by capturing a screenshot
 * at the exact moment a real-suite `renameField`/`writeCell` call timed out:
 * the page was NOT showing the grid at all, it was showing the app's own
 * full-page bootstrap splash (three bouncing dots), i.e. the whole SPA had
 * silently reloaded from scratch, not merely lost focus. `bringToFront()`
 * alone does not wait out that reload -- it only requests the tab be
 * un-discarded, the bootstrap itself still takes several seconds. This
 * reproduced non-deterministically depending on how much memory pressure
 * the broader test run (and any other concurrent Chromium instances) had
 * created at that moment, which is why earlier isolated/short repro
 * attempts in this task never hit it. Gate every real grid interaction on
 * the grid's own readiness signal actually reappearing, re-dismissing the
 * compat banner if a reload did happen, instead of assuming the page is
 * immediately interactive right after being brought to front.
 */
async function ensureGridInteractive(page: Page, timeoutMs = 30000): Promise<void> {
  await page.bringToFront();
  const ready = await page
    .waitForSelector('[data-testid^="grid-field-header-"]', { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!ready) return; // let the caller's own, more specific wait surface the real failure
  await dismissCompatBanner(page).catch(() => {});
}

/**
 * The grid renders a sticky-header overlay (GridStickyHeader.tsx) that
 * DUPLICATES every grid-field-header-<id> node. Both copies live inside
 * `database-grid` (GridStickyHeader is mounted by GridVirtualizer, itself
 * inside the database-grid container), so `database-grid`-scoping alone does
 * NOT disambiguate them -- Task 77.1's "inGrid .first()" heuristic can
 * resolve to either copy depending on DOM mount order, and the overlay copy
 * toggles `pointer-events` between 'none' and 'auto' as the grid scrolls
 * (GridVirtualizer.tsx's shouldShowStickyHeader effect). When a preceding
 * `scrollIntoViewIfNeeded()` nudges the scroll position enough to flip that
 * flag mid-click, the overlay copy can become interactive and sit on top of
 * the real header at the exact same screen position, so Playwright's
 * actionability check picks whichever copy `.first()`/`.last()` happened to
 * resolve to and the click silently times out waiting for pointer events --
 * reproduced live in Task 77.3 (3 of 8 real-suite scenarios failing on
 * exactly this click, non-deterministically, depending on prior scroll
 * state). GridStickyHeader's own wrapper carries a stable, source-verified
 * class (`grid-sticky-header`, confirmed unique to that component) that is
 * independent of DOM mount order or scroll state -- use it to exclude the
 * overlay copy explicitly rather than guessing by position.
 * (Test-infrastructure detail; not a product defect -- the sticky overlay
 * and its toggle behavior are correct UI design.)
 */
function realGridFieldHeader(page: Page, fieldId: string) {
  // `.grid-sticky-header` is an ANCESTOR of the overlay copy, not the header
  // node itself, so a descendant-scoped Playwright locator (`.filter({has})`
  // or `database-grid`-scoping) cannot exclude it -- only an ancestor check
  // does. CSS :not() with a descendant-combinator argument is valid per
  // Selectors Level 4 and supported by the real Chromium engine Playwright
  // drives, so this reliably selects only the non-sticky copy regardless of
  // DOM mount order or scroll state.
  return page.locator(
    `[data-testid="grid-field-header-${fieldId}"]:not(.grid-sticky-header [data-testid="grid-field-header-${fieldId}"])`,
  ).first();
}

/**
 * Database-level mutation (writes the Database collab, collabType=1):
 * rename a field through its real header menu -> property-name-input.
 */
async function renameField(page: Page, fieldId: string, newName: string): Promise<void> {
  await ensureGridInteractive(page);
  const header = realGridFieldHeader(page, fieldId);
  // Observed live in Task 77.3: even with ensureGridInteractive's readiness
  // gate and the sticky-header exclusion above, the header's click can still
  // intermittently time out once in a fully-rendered, otherwise-ordinary
  // grid (confirmed via a trace screencast showing a normal, non-reloading
  // page at the moment of failure) -- consistent with a transient click
  // interception from a still-closing menu/overlay left by a PRECEDING
  // interaction, not a missing or wrong element. Retry a bounded number of
  // times against the SAME target locator (never a different element) with
  // a settling pause, rather than silently lengthening the single attempt's
  // timeout.
  // Diagnosed in Task 77.3 and left UNRESOLVED, reported honestly rather
  // than papered over: in several real-suite runs the member's page (pageB)
  // became unresponsive to ANY CDP-level call (click, even a plain
  // page.evaluate() with no app logic in it) for far longer than any
  // per-action timeout given here, while a trace screencast captured at the
  // same moment showed a perfectly normal, fully-rendered grid -- ruling out
  // a missing/wrong element or a reload-in-progress (both already fixed
  // above) and pointing at the page's renderer itself being frozen. A
  // bounded retry with a settle pause is kept because it is cheap and
  // correct, but it cannot be expected to resolve a freeze that outlasts an
  // 8s per-attempt timeout; see the Task 77.3 report §4/§18 for the
  // candidate root cause (sustained host memory/CPU pressure from this
  // session's own long-running parallel test execution) and why it was not
  // conclusively pinned down.
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

/**
 * DatabaseRow-level mutation (writes the DatabaseRow collab, collabType=4):
 * type into a grid cell through the real cell editor.
 */
async function writeCell(page: Page, rowId: string, fieldId: string, text: string): Promise<void> {
  await ensureGridInteractive(page);
  await waitForGridRowReady(page, rowId, fieldId);
  const cell = page.locator(`[data-testid="grid-cell-${rowId}-${fieldId}"]`).first();
  // See renameField's comment on the bounded-retry rationale; the same
  // transient-interception class can hit a cell click too.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
  if (lastErr) throw lastErr;
  await page.waitForTimeout(300);
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

/** Read a cell's rendered text across every matching node (sticky overlay duplicates them). */
async function readCell(page: Page, rowId: string, fieldId: string): Promise<string> {
  const texts = await page
    .locator(`[data-testid="grid-cell-${rowId}-${fieldId}"]`)
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(' | ');
}

/**
 * After a reload the grid header can be present while the virtualized rows
 * are still mounting, so waiting only on grid-field-header- leaves cell
 * locators transiently absent (observed live in this task as a scenario-D
 * selector timeout). Wait for the specific row's cell too.
 */
async function waitForGridRowReady(page: Page, rowId: string, fieldId: string, timeoutMs = 30000): Promise<boolean> {
  await page.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: timeoutMs }).catch(() => {});
  // The grid is virtualized: wait for the row container, scroll it into view,
  // THEN wait for its cell. Waiting only on the cell times out whenever the
  // row is mounted but outside the viewport (observed live in this task).
  const row = page.locator(`[data-testid="grid-row-${rowId}"]`).first();
  await row.waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => {});
  await row.scrollIntoViewIfNeeded().catch(() => {});
  return page
    .waitForSelector(`[data-testid="grid-cell-${rowId}-${fieldId}"]`, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/** Poll the peer's own DOM (no reload) for a cell value. Returns ms-to-visible, or null if never seen. */
async function awaitCellTextLive(
  page: Page,
  rowId: string,
  fieldId: string,
  expected: string,
  timeoutMs = 20000,
): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await readCell(page, rowId, fieldId)).includes(expected)) return Date.now() - started;
    await page.waitForTimeout(400);
  }
  return null;
}

/**
 * Read the field header's rendered name. The sticky-header overlay
 * duplicates the node, so check EVERY match rather than guessing which copy
 * React updated first.
 */
async function readFieldName(page: Page, fieldId: string): Promise<string> {
  const texts = await page
    .locator(`[data-testid="grid-field-header-${fieldId}"]`)
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.join(' | ');
}

/** Poll the peer's own DOM (no reload) for a renamed field header. */
async function awaitFieldNameLive(page: Page, fieldId: string, expected: string, timeoutMs = 20000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await readFieldName(page, fieldId)).includes(expected)) return Date.now() - started;
    await page.waitForTimeout(400);
  }
  return null;
}

/** Poll the peer's own DOM (no reload) for a newly fanned-out row id. */
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

/**
 * Quick-add grid creation lands the browser on the newly created VIEW page,
 * whose parent is the Database page that the sidebar actually renders -- so
 * the view page's own sidebar entry is hidden until its parent is expanded
 * (confirmed live in this task from the member's own page list + rendered
 * sidebar testids). Both pages carry the same extra.database_id, i.e. the
 * same Database collab object. Resolve the ancestor the sidebar DOES render
 * so both clients can navigate the real sidebar route, which Task 70 proved
 * is the path that actually receives live pushes.
 */
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

// --- Independent, non-UI backend-state readers (persisted-state evidence) ---

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

/** Read one cell's persisted value out of the DatabaseRow collab (collabType=4). */
async function readRowCell(
  env: TestEnvironment,
  token: string,
  workspaceId: string,
  rowId: string,
  fieldId: string,
): Promise<string> {
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

/**
 * Open the shared Database page as a (non-owner) member, via the real
 * sidebar entry first -- the path Task 70 proved is required for live
 * delivery (a raw deep-link load rendered identity but did not receive live
 * pushes) -- falling back to the direct route, and gating on a GRID-scoped
 * readiness signal rather than the Document-scoped one that made Task 70's
 * A4 attempt bail out.
 */
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
    // The member's sidebar can legitimately not yet list a page whose
    // workspace membership was granted moments earlier (the sidebar's page
    // list is fetched, not pushed). Reload-and-retry a bounded number of
    // times before falling back -- the sidebar route is the navigation path
    // Task 70 proved is required for live delivery, so falling back to a raw
    // deep link silently would invalidate the live-delivery evidence.
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
    // Fallback, explicitly recorded in the evidence so any live-delivery
    // result obtained on this path is interpreted with that caveat.
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

interface WsLog {
  events: Array<{ type: 'open' | 'close'; url: string; code?: number; reason?: string; t: number }>;
}

/** Real network-level WebSocket lifecycle tracking, including close codes (1008 etc.). */
function trackWebSockets(page: Page): WsLog {
  const log: WsLog = { events: [] };
  page.on('websocket', (ws) => {
    log.events.push({ type: 'open', url: ws.url(), t: Date.now() });
    ws.on('close', () => log.events.push({ type: 'close', url: ws.url(), t: Date.now() }));
  });
  return log;
}

/** Capture the app's own console output so a 1008 close reason (logged by the client) is observable. */
function trackConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/1008|1003|SyncRequest|WebSocket|Connection closed/i.test(t)) lines.push(`${Date.now()} ${t}`);
  });
  return lines;
}

function closeCodesFrom(lines: string[]): string[] {
  return lines.filter((l) => /code:\s*\d+/i.test(l));
}

const evidence: Record<string, unknown> = {};
const EVIDENCE_FILE = () => (usePostgres ? 'results-postgres' : 'results-json');
async function saveEvidence(name: string = EVIDENCE_FILE()) {
  // Written after EVERY test, not only in afterAll: an afterAll that is cut
  // short (hook timeout, killed worker) otherwise loses the whole run's
  // evidence, which happened live in this task.
  await writeFile(path.join(EVIDENCE_DIR, `${name}.json`), JSON.stringify(evidence, null, 2)).catch(() => {});
}

// ===========================================================================
// Phase 1/2/4/5 -- JSON storage (default) or Postgres when TASK77_PG_STORAGE=1
// ===========================================================================
test.describe(`Task 77.1: Database/DatabaseRow multi-user collaboration (${usePostgres ? 'postgres' : 'json'})`, () => {
  let env: TestEnvironment;
  let browserRef: Browser;
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let wsA: WsLog;
  let wsB: WsLog;
  let consoleA: string[];
  let consoleB: string[];

  let workspaceId: string;
  let spaceId: string | null;
  let databasePageId: string;
  let databaseId: string;
  let ownerToken: string;
  let memberToken: string;
  let memberEmail: string;
  let fieldId: string;
  let rowId: string;
  let sharedDatabasePageId: string;

  const spaceLabel = 'T771 db space';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300000);
    browserRef = browser;
    await mkdir(EVIDENCE_DIR, { recursive: true });
    env = await startTestEnvironment(
      EVIDENCE_DIR,
      'task77-1',
      usePostgres ? { storage: 'postgres', databaseUrl: process.env.DATABASE_URL } : undefined,
    );

    const ownerEmail = await registerTestUser(env, 'task771-owner', PASSWORD);
    memberEmail = await registerTestUser(env, 'task771-member', PASSWORD);

    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    wsA = trackWebSockets(pageA);
    wsB = trackWebSockets(pageB);
    consoleA = trackConsole(pageA);
    consoleB = trackConsole(pageB);

    // Owner: create the space, the Database, and one row.
    await loginUser(pageA, env.frontendUrl, ownerEmail);
    workspaceId = await createSpace(pageA, spaceLabel);
    databasePageId = await createGridDatabase(pageA, spaceLabel);
    ownerToken = await loginGetToken(env, ownerEmail);
    databaseId = await resolveDatabaseId(env, workspaceId, ownerToken, databasePageId);
    spaceId = await resolveSpaceId(env, workspaceId, ownerToken);
    fieldId = await firstFieldId(pageA);
    rowId = await createRow(pageA);

    // Grant the second, independently-registered user real workspace membership.
    const grantResp = await grantMembership(env, workspaceId, ownerToken, memberEmail);
    expect(grantResp.status, 'membership grant via the Task 67 test-members helper must succeed').toBe(201);
    memberToken = await loginGetToken(env, memberEmail);

    // Navigate BOTH clients to the sidebar-rendered Database page for the
    // same database_id, so neither side depends on a raw deep link.
    const sidebarPage = await resolveSidebarDatabasePage(env, workspaceId, ownerToken, databaseId, spaceId, databasePageId);
    sharedDatabasePageId = sidebarPage.pageId;

    await loginUser(pageB, env.frontendUrl, memberEmail);
    const opened = await openSharedDatabase(pageB, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, spaceLabel);
    // Move the owner onto the same page, via the same real sidebar route.
    const openedOwner = await openSharedDatabase(pageA, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, spaceLabel);

    evidence.setup = {
      storage: env.storage,
      workspaceId,
      createdDatabaseViewPageId: databasePageId,
      sharedDatabasePageId,
      sidebarPageWasAncestor: sidebarPage.wasAncestor,
      databaseId,
      fieldId,
      rowId,
      memberOpenedDatabase: opened,
      ownerOpenedDatabase: openedOwner,
    };
    expect(opened.ok, 'the non-owner member must be able to open the shared Database page through the real UI').toBe(true);
  });

  test.afterAll(async () => {
    evidence.wsA = wsA?.events ?? [];
    evidence.wsB = wsB?.events ?? [];
    evidence.consoleA_closeCodes = closeCodesFrom(consoleA ?? []);
    evidence.consoleB_closeCodes = closeCodesFrom(consoleB ?? []);
    await saveEvidence(usePostgres ? 'results-postgres' : 'results-json');
    await Promise.race([
      Promise.all([contextA?.close(), contextB?.close()]),
      new Promise((r) => setTimeout(r, 15000)),
    ]).catch(() => {});
    if (env) {
      const { envRestored } = await stopTestEnvironment(env);
      expect(envRestored, 'the frontend .env.local must be restored byte-for-byte').toBe(true);
    }
  });

  test.afterEach(async () => {
    await saveEvidence();
  });

  // ---- Phase 0 discovery, asserted rather than assumed --------------------
  test('P0. a non-owner member can read the shared Database and DatabaseRow collab objects', async () => {
    const dbAsMember = await readDatabaseCollab(env, memberToken, workspaceId, databaseId);
    const cellAsMember = await fetch(`${env.backendUrl}/api/workspace/v1/${workspaceId}/collab/${rowId}?collab_type=4`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    // Does the backend list the Database page for the member at all, and
    // does the member's rendered sidebar contain its entry? Distinguishes a
    // backend page-visibility issue from a frontend sidebar-rendering one.
    const memberPagesResp = await fetch(`${env.backendUrl}/api/workspaces/${workspaceId}/pages`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    const memberPages = memberPagesResp.ok ? (await memberPagesResp.json()).pages : [];
    const sidebarTestIds = await pageB
      .locator('[data-testid^="page-"], [data-testid^="space-"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid).filter(Boolean))
      .catch(() => [] as (string | undefined)[]);

    evidence.p0 = {
      memberCanReadDatabaseCollab: Boolean(dbAsMember),
      memberSeesRowInRowOrders: dbAsMember?.rowIds.includes(rowId) ?? false,
      memberRowCollabStatus: cellAsMember.status,
      memberPagesApiStatus: memberPagesResp.status,
      memberPageIdsFromApi: memberPages.map((p: { id: string; layout?: number; parent_view_id?: string; name?: string }) => ({
        id: p.id,
        layout: p.layout,
        parent: p.parent_view_id,
        name: p.name,
      })),
      memberApiListsDatabasePage: memberPages.some((p: { id: string }) => p.id === databasePageId),
      memberSidebarTestIds: sidebarTestIds,
      expectedSidebarEntry: `page-${databasePageId}`,
      expectedSpaceEntry: `space-${spaceId}`,
    };
    expect(dbAsMember, 'a workspace member must be able to read the Database collab (collabType=1)').toBeTruthy();
    expect(dbAsMember!.rowIds, 'the member must see the owner-created row in row_orders').toContain(rowId);
    expect(cellAsMember.status, 'a workspace member must be able to read the DatabaseRow collab (collabType=4)').toBe(200);
  });

  // ---- Phase 2: two-client Database / DatabaseRow live collaboration ------
  test('A. Database-level mutation, owner -> member (field rename)', async () => {
    test.setTimeout(180000);
    const newName = `T771A-${Date.now()}`;
    await renameField(pageA, fieldId, newName);

    const writerUi = await readFieldName(pageA, fieldId);
    const liveMs = await awaitFieldNameLive(pageB, fieldId, newName);
    const persisted = await readDatabaseCollab(env, memberToken, workspaceId, databaseId);

    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 20000 }).catch(() => {});
    await pageB.waitForTimeout(1000);
    const afterReload = await readFieldName(pageB, fieldId);

    evidence.scenarioA = {
      marker: newName,
      writerUiContains: writerUi.includes(newName),
      peerLiveNoReloadMs: liveMs,
      backendPersistedFieldName: persisted?.fieldNames[fieldId],
      peerAfterReloadContains: afterReload.includes(newName),
    };

    expect(writerUi, 'writer UI must reflect its own field rename').toContain(newName);
    expect(liveMs, 'member must observe the owner field rename LIVE (no reload) -- the HTTP slow lane cannot fan out to a peer').not.toBeNull();
    expect(persisted?.fieldNames[fieldId], 'the rename must be persisted in the Database collab on the backend').toBe(newName);
    expect(afterReload, 'the rename must survive a member-side reload').toContain(newName);
  });

  test('B. Database-level mutation, member -> owner (field rename)', async () => {
    test.setTimeout(180000);
    const newName = `T771B-${Date.now()}`;
    await renameField(pageB, fieldId, newName);

    const writerUi = await readFieldName(pageB, fieldId);
    const liveMs = await awaitFieldNameLive(pageA, fieldId, newName);
    const persisted = await readDatabaseCollab(env, ownerToken, workspaceId, databaseId);

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 20000 }).catch(() => {});
    await pageA.waitForTimeout(1000);
    const afterReload = await readFieldName(pageA, fieldId);

    evidence.scenarioB = {
      marker: newName,
      writerUiContains: writerUi.includes(newName),
      peerLiveNoReloadMs: liveMs,
      backendPersistedFieldName: persisted?.fieldNames[fieldId],
      peerAfterReloadContains: afterReload.includes(newName),
    };

    expect(writerUi, 'writer UI must reflect its own field rename').toContain(newName);
    expect(liveMs, 'owner must observe the member field rename LIVE (no reload)').not.toBeNull();
    expect(persisted?.fieldNames[fieldId], 'the member-initiated rename must be persisted in the Database collab').toBe(newName);
    expect(afterReload, 'the rename must survive an owner-side reload').toContain(newName);
  });

  test('C. DatabaseRow cell update, owner -> member', async () => {
    test.setTimeout(180000);
    const marker = `T771C${Date.now()}`;
    await writeCell(pageA, rowId, fieldId, marker);

    const writerUi = await readCell(pageA, rowId, fieldId);
    const liveMs = await awaitCellTextLive(pageB, rowId, fieldId, marker);
    const persisted = await readRowCell(env, memberToken, workspaceId, rowId, fieldId);

    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await waitForGridRowReady(pageB, rowId, fieldId);
    await pageB.waitForTimeout(800);
    const afterReload = await readCell(pageB, rowId, fieldId);

    evidence.scenarioC = {
      marker,
      writerUiContains: writerUi.includes(marker),
      peerLiveNoReloadMs: liveMs,
      backendPersistedCellContains: persisted.includes(marker),
      peerAfterReloadContains: afterReload.includes(marker),
    };

    expect(writerUi, 'writer UI must reflect its own cell edit').toContain(marker);
    expect(liveMs, 'member must observe the owner cell edit LIVE (no reload)').not.toBeNull();
    expect(persisted, 'the cell edit must be persisted in the DatabaseRow collab on the backend').toContain(marker);
    expect(afterReload, 'the cell edit must survive a member-side reload').toContain(marker);
  });

  test('D. DatabaseRow cell update, member -> owner', async () => {
    test.setTimeout(180000);
    const marker = `T771D${Date.now()}`;
    await writeCell(pageB, rowId, fieldId, marker);

    const writerUi = await readCell(pageB, rowId, fieldId);
    const liveMs = await awaitCellTextLive(pageA, rowId, fieldId, marker);
    const persisted = await readRowCell(env, ownerToken, workspaceId, rowId, fieldId);

    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await waitForGridRowReady(pageA, rowId, fieldId);
    await pageA.waitForTimeout(800);
    const afterReload = await readCell(pageA, rowId, fieldId);

    evidence.scenarioD = {
      marker,
      writerUiContains: writerUi.includes(marker),
      peerLiveNoReloadMs: liveMs,
      backendPersistedCellContains: persisted.includes(marker),
      peerAfterReloadContains: afterReload.includes(marker),
    };

    expect(writerUi, 'writer UI must reflect its own cell edit').toContain(marker);
    expect(liveMs, 'owner must observe the member cell edit LIVE (no reload)').not.toBeNull();
    expect(persisted, 'the member cell edit must be persisted in the DatabaseRow collab').toContain(marker);
    expect(afterReload, 'the member cell edit must survive an owner-side reload').toContain(marker);
  });

  // ---- Phase 2 extra: row creation fans out (Database row_orders) ---------
  test('E. row creation fans out live (Database row_orders), owner -> member', async () => {
    test.setTimeout(180000);
    const newRowId = await createRow(pageA);
    const liveMs = await awaitRowPresentLive(pageB, newRowId);
    const persisted = await readDatabaseCollab(env, memberToken, workspaceId, databaseId);

    evidence.scenarioE = {
      newRowId,
      peerLiveNoReloadMs: liveMs,
      backendRowOrdersContains: persisted?.rowIds.includes(newRowId) ?? false,
    };

    expect(liveMs, 'member must observe a newly created row LIVE (no reload) -- this is the exact "New row" Database write from the Task 74/75 defect').not.toBeNull();
    expect(persisted?.rowIds, 'the new row must be persisted into the Database collab row_orders').toContain(newRowId);
  });

  // ---- Phase 5: concurrent edits on separate cells ------------------------
  test('F. concurrent edits to separate row cells converge on both clients', async () => {
    test.setTimeout(180000);
    // Need a second field to have two independently-editable cells in one row.
    const headers = pageA.locator('[data-testid^="grid-field-header-"]');
    const count = await headers.count();
    if (count < 2) {
      test.info().annotations.push({
        type: 'limitation',
        description: `Only ${count} field header(s) present; a two-separate-cell concurrent edit needs 2. NOT TESTED rather than fabricated.`,
      });
      evidence.scenarioF = { result: 'NOT TESTED', reason: `only ${count} field(s) available` };
      test.skip(true, 'fewer than two fields available for a separate-cell concurrent edit');
      return;
    }
    const secondTestId = await headers.nth(1).getAttribute('data-testid');
    const fieldId2 = (secondTestId || '').replace('grid-field-header-', '');

    const markerA = `T771FA${Date.now()}`;
    const markerB = `T771FB${Date.now()}`;

    // Fire both edits without awaiting the first, so they genuinely overlap.
    await Promise.all([writeCell(pageA, rowId, fieldId, markerA), writeCell(pageB, rowId, fieldId2, markerB)]);

    const aSeesB = await awaitCellTextLive(pageA, rowId, fieldId2, markerB, 25000);
    const bSeesA = await awaitCellTextLive(pageB, rowId, fieldId, markerA, 25000);

    const persistedA = await readRowCell(env, ownerToken, workspaceId, rowId, fieldId);
    const persistedB = await readRowCell(env, ownerToken, workspaceId, rowId, fieldId2);

    evidence.scenarioF = {
      markerA,
      markerB,
      ownerSawMemberCellMs: aSeesB,
      memberSawOwnerCellMs: bSeesA,
      bothPersisted: persistedA.includes(markerA) && persistedB.includes(markerB),
    };

    expect(aSeesB, 'owner must converge on the member concurrent edit (separate cell)').not.toBeNull();
    expect(bSeesA, 'member must converge on the owner concurrent edit (separate cell)').not.toBeNull();
    expect(persistedA, 'the owner concurrent edit must persist').toContain(markerA);
    expect(persistedB, 'the member concurrent edit must persist').toContain(markerB);
  });

  // ---- Phase 3: reconnection ---------------------------------------------
  test('G. repeated disconnect/reconnect cycles (Database + DatabaseRow), 3x each', async () => {
    test.setTimeout(420000);
    const cycles: Array<Record<string, unknown>> = [];

    for (let i = 1; i <= 3; i += 1) {
      // Genuine transport-level disconnect: take the browser offline, which
      // closes the live WebSocket, then restore it and let the app's own
      // reconnect logic run. No production code is touched.
      await contextA.setOffline(true);
      await pageA.waitForTimeout(2500);
      await contextA.setOffline(false);
      await pageA.waitForTimeout(6000);

      // Database-level mutation after reconnect.
      const dbMarker = `T771G${i}DB${Date.now()}`;
      await renameField(pageA, fieldId, dbMarker).catch(() => {});
      // Shortened polling window (not a weakened assertion): with the
      // Database-level fan-out limitation this task identified, each of these
      // polls otherwise burns its full window 3x and blows the test budget.
      const dbLive = await awaitFieldNameLive(pageB, fieldId, dbMarker, 10000);
      const dbPersisted = (await readDatabaseCollab(env, ownerToken, workspaceId, databaseId))?.fieldNames[fieldId];

      // DatabaseRow-level mutation after the same reconnect.
      const rowMarker = `T771G${i}ROW${Date.now()}`;
      await writeCell(pageA, rowId, fieldId, rowMarker).catch(() => {});
      const rowLive = await awaitCellTextLive(pageB, rowId, fieldId, rowMarker, 20000);
      const rowPersisted = await readRowCell(env, ownerToken, workspaceId, rowId, fieldId);

      cycles.push({
        cycle: i,
        databaseMarker: dbMarker,
        databaseLiveMs: dbLive,
        databasePersisted: dbPersisted === dbMarker,
        rowMarker,
        rowLiveMs: rowLive,
        rowPersisted: rowPersisted.includes(rowMarker),
      });
    }

    evidence.scenarioG = { cycles, consoleA_closeCodes: closeCodesFrom(consoleA) };

    // Order matters: persistence and DatabaseRow live delivery are asserted
    // FIRST so that the known Database-level fan-out limitation (see the
    // Task 77.1 report) cannot mask them by aborting the test early.
    for (const c of cycles) {
      expect(c.databasePersisted, `cycle ${c.cycle}: the post-reconnect Database mutation must persist`).toBe(true);
      expect(c.rowPersisted, `cycle ${c.cycle}: the post-reconnect DatabaseRow mutation must persist`).toBe(true);
      expect(c.rowLiveMs, `cycle ${c.cycle}: the post-reconnect DatabaseRow mutation must reach the peer LIVE`).not.toBeNull();
    }
    for (const c of cycles) {
      expect(c.databaseLiveMs, `cycle ${c.cycle}: the post-reconnect Database mutation must reach the peer LIVE`).not.toBeNull();
    }
  });

  test('H. genuine backend process restart; Database + DatabaseRow still sync and persist', async () => {
    test.setTimeout(300000);
    const preMarker = `T771Hpre${Date.now()}`;
    await writeCell(pageA, rowId, fieldId, preMarker);
    expect(await readRowCell(env, ownerToken, workspaceId, rowId, fieldId)).toContain(preMarker);

    // Real process boundary: kill and respawn `node server.js` against the
    // SAME port and SAME storage (JSON data file or DATABASE_URL).
    await restartBackend(env);
    await pageA.waitForTimeout(3000);
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 25000 }).catch(() => {});
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('[data-testid^="grid-field-header-"]', { timeout: 25000 }).catch(() => {});
    await pageA.waitForTimeout(2500);

    const preSurvived = await readCell(pageA, rowId, fieldId);

    const postMarker = `T771Hpost${Date.now()}`;
    await writeCell(pageA, rowId, fieldId, postMarker);
    const postLive = await awaitCellTextLive(pageB, rowId, fieldId, postMarker, 25000);
    const postPersisted = await readRowCell(env, ownerToken, workspaceId, rowId, fieldId);

    const dbPostMarker = `T771HDB${Date.now()}`;
    await renameField(pageA, fieldId, dbPostMarker);
    const dbPostLive = await awaitFieldNameLive(pageB, fieldId, dbPostMarker, 25000);
    const dbPostPersisted = (await readDatabaseCollab(env, ownerToken, workspaceId, databaseId))?.fieldNames[fieldId];

    evidence.scenarioH = {
      preMarker,
      preSurvivedRestart: preSurvived.includes(preMarker),
      postMarker,
      postRestartRowLiveMs: postLive,
      postRestartRowPersisted: postPersisted.includes(postMarker),
      dbPostMarker,
      postRestartDatabaseLiveMs: dbPostLive,
      postRestartDatabasePersisted: dbPostPersisted === dbPostMarker,
    };

    expect(preSurvived, 'pre-restart cell content must survive a genuine backend process restart').toContain(preMarker);
    expect(postPersisted, 'a post-restart DatabaseRow edit must persist').toContain(postMarker);
    expect(postLive, 'a post-restart DatabaseRow edit must reach the peer LIVE').not.toBeNull();
    expect(dbPostPersisted, 'a post-restart Database mutation must persist').toBe(dbPostMarker);
    // Asserted last: known Database-level fan-out limitation (see report).
    expect(dbPostLive, 'a post-restart Database mutation must reach the peer LIVE').not.toBeNull();
  });

  // ---- Phase 4: multi-object session -------------------------------------
  test('I. multi-object session: Document + Database + DatabaseRow in one connection, no cross-object interference', async () => {
    test.setTimeout(240000);
    // Create an ordinary Document in the same space/workspace, so this
    // browser session has a Document (collabType=0), a Database
    // (collabType=1) and a DatabaseRow (collabType=4) all live -- exactly the
    // multiplexing shape that produced Task 71's stolen-binding 1008.
    const urlBefore = pageA.url();
    await hoverSpaceRow(pageA, spaceLabel);
    await pageA.getByTestId('inline-add-page').first().click();
    await pageA.getByTestId('add-document-button').click();
    // Wait for the route to actually change -- reading page.url() after a
    // fixed timeout can otherwise return the PREVIOUS page id, which silently
    // invalidated this scenario's Document leg on an earlier run.
    await pageA.waitForFunction((prev) => window.location.href !== prev, urlBefore, { timeout: 20000 }).catch(() => {});
    await pageA.waitForTimeout(1200);
    const docPageId = (pageA.url().match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    expect(docPageId, 'the ordinary Document page id must be resolvable').toBeTruthy();
    expect(docPageId, 'the ordinary Document must be a DIFFERENT page from the database view').not.toBe(sharedDatabasePageId);

    const docMarker = `T771Idoc${Date.now()}`;
    const body = pageA.locator(`[data-testid="document-body-${docPageId}"], [data-page-id="${docPageId}"] [role="textbox"]`).first();
    const docEditable = await body.isVisible({ timeout: 10000 }).catch(() => false);
    if (docEditable) {
      await body.click();
      await pageA.keyboard.type(docMarker, { delay: 20 });
      await pageA.waitForTimeout(1000);
    }

    // Now go back to the Database and alternate mutations across object types.
    await openSharedDatabase(pageA, env.frontendUrl, workspaceId, sharedDatabasePageId, spaceId, spaceLabel);

    const dbMarker = `T771Idb${Date.now()}`;
    await renameField(pageA, fieldId, dbMarker);
    const rowMarker = `T771Irow${Date.now()}`;
    await writeCell(pageA, rowId, fieldId, rowMarker);
    // Reverse order for the second pass.
    const rowMarker2 = `T771Irow2${Date.now()}`;
    await writeCell(pageA, rowId, fieldId, rowMarker2);
    const dbMarker2 = `T771Idb2${Date.now()}`;
    await renameField(pageA, fieldId, dbMarker2);

    const dbLive = await awaitFieldNameLive(pageB, fieldId, dbMarker2, 25000);
    const rowLive = await awaitCellTextLive(pageB, rowId, fieldId, rowMarker2, 25000);
    const dbPersisted = (await readDatabaseCollab(env, ownerToken, workspaceId, databaseId))?.fieldNames[fieldId];
    const rowPersisted = await readRowCell(env, ownerToken, workspaceId, rowId, fieldId);
    const rowCollabHasDbMarker = rowPersisted.includes(dbMarker2);

    evidence.scenarioI = {
      docPageId,
      docEditable,
      docMarker: docEditable ? docMarker : null,
      dbMarker2,
      rowMarker2,
      peerDatabaseLiveMs: dbLive,
      peerRowLiveMs: rowLive,
      databasePersisted: dbPersisted === dbMarker2,
      rowPersisted: rowPersisted.includes(rowMarker2),
      noCrossObjectLeakage: !rowCollabHasDbMarker,
      consoleA_closeCodes: closeCodesFrom(consoleA),
    };

    expect(dbPersisted, 'the Database mutation must persist in a multi-object session').toBe(dbMarker2);
    expect(rowPersisted, 'the DatabaseRow mutation must persist in a multi-object session').toContain(rowMarker2);
    expect(rowCollabHasDbMarker, 'a Database-level value must never leak into the DatabaseRow collab object').toBe(false);
    expect(rowLive, 'the DatabaseRow mutation must still reach the peer LIVE in a multi-object session').not.toBeNull();
    // Asserted last: known Database-level fan-out limitation (see report).
    expect(dbLive, 'the Database mutation must still reach the peer LIVE in a multi-object session').not.toBeNull();
  });
});
