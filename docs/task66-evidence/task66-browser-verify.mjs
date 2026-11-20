// Task 66 real-browser verification: proves an already-connected second
// browser CONTEXT observes a first client's content update LIVE (no
// reload/refocus/reconnect), for Document and for the Database/
// DatabaseRow grid-cell collaboration path AppFlowy-Web's current UI
// actually exposes. Modeled directly on the proven Task 64 script
// (docs/task64-evidence/task64-browser-verify.mjs) -- same env-var
// parameterization, same .env.local backup/restore discipline, same
// login/space/grid helpers (reused verbatim where unchanged), same
// evidence-capture conventions (steps.log, results.json, screenshots,
// console/network logs per context).
//
// Env vars:
//   BACKEND_PORT, FRONTEND_PORT, EVIDENCE_DIR, DEV_KEY (optional)
// Storage mode is fixed to JSON here (disposable data file) -- the
// Postgres side of the fan-out is already proven by the automated
// protocol-level tests (test/postgres-database-multiclient.test.js,
// test/postgres-realtime-fanout-document.test.js); this script's purpose
// is REAL two-browser-context, real-UI proof, which does not need to be
// repeated per storage backend.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';

const BACKEND_PORT = process.env.BACKEND_PORT;
const FRONTEND_PORT = process.env.FRONTEND_PORT;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const DEV_KEY = process.env.DEV_KEY || 'task66-key';
const BACKEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend';
const FRONTEND_DIR = '/Volumes/work disk/Codes/Tracker/AppFlowy-Web';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://localhost:${FRONTEND_PORT}`;
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');
const ENV_LOCAL_BACKUP_PATH = path.join(EVIDENCE_DIR, 'env.local.backup');
const DATA_FILE = process.env.DATA_FILE;

if (!BACKEND_PORT || !FRONTEND_PORT || !EVIDENCE_DIR || !DATA_FILE) {
  throw new Error('BACKEND_PORT, FRONTEND_PORT, EVIDENCE_DIR, DATA_FILE are required');
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
  } catch { return []; }
}
function spawnBackend() {
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(BACKEND_PORT), STORAGE: 'json', DATA_FILE,
    DEV_TEST_KEY: DEV_KEY,
    CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}`,
  };
  const child = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
async function waitHealthy(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(`${url}/health`); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
async function waitFrontendReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 304) return true; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  const results = {
    documentLiveA2B: 'NOT TESTED', documentLiveB2A: 'NOT TESTED', documentPersist: 'NOT TESTED',
    gridLiveA2B: 'NOT TESTED', gridLiveB2A: 'NOT TESTED', gridPersist: 'NOT TESTED',
  };
  let backendProcess, frontendProcess, envBackupMd5;

  try {
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
    record(`Backend process started (STORAGE=json, port ${BACKEND_PORT})`, backendHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not become healthy');

    frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], {
      cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, detached: true, stdio: 'ignore',
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
      const consoleErrors = []; const networkLog = [];
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
    async function openWorkspace(page, workspaceId) {
      await page.goto(`${FRONTEND}/app/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      await dismissCompatBanner(page);
    }
    async function expandSpace(page, spaceId) {
      const spaceToggle = page.getByTestId(`space-${spaceId}`);
      if (!(await spaceToggle.first().isVisible({ timeout: 8000 }).catch(() => false))) return false;
      const expanded = await spaceToggle.first().getAttribute('data-expanded').catch(() => null);
      if (expanded !== 'true') { await spaceToggle.first().click(); await page.waitForTimeout(700); }
      return true;
    }
    async function openSidebarPage(page, pageId, spaceId, fallbackUrl) {
      await expandSpace(page, spaceId);
      const entry = page.getByTestId(`page-${pageId}`);
      if (await entry.first().isVisible({ timeout: 10000 }).catch(() => false)) {
        await entry.first().click();
        await page.waitForTimeout(1500);
        return true;
      }
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      return false;
    }
    async function waitGridLoaded(page, timeout = 15000) {
      let reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!reopened) {
        await page.waitForTimeout(1000);
        reopened = await page.locator('[data-testid^="grid-field-header-"]').first().isVisible({ timeout }).catch(() => false);
      }
      return reopened;
    }
    async function enterCellValue(page, rowId, primaryFieldId, value, { clearFirst = false } = {}) {
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
      if (clearFirst) {
        // Overwriting an EXISTING cell value: select the whole line and
        // delete it first, otherwise typing just inserts at wherever the
        // cursor landed inside the existing text (producing garbled
        // interleaved content, not a clean overwrite).
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
      }
      await page.keyboard.type(value);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      return cellTestId;
    }
    async function readCellTextWithRetry(page, testId, attempts = 10, delayMs = 800) {
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
    // A generic `[data-slate-editor="true"]` locator can match more than
    // one mounted editor instance (e.g. a background/stale page still
    // mounted behind a ViewModal overlay). Editable.tsx assigns
    // `id={`${previewId ?? ''}editor-${viewId}`}` -- an EXACT `#editor-x`
    // match misses any rendering context where `previewId` is set, so
    // match by suffix instead (`[id$="editor-${pageId}"]`), which is
    // correct for both the bare and previewId-prefixed id shapes, and use
    // a forced click (same precedent as the Grid cell helper below) since
    // an unrelated overlay can legitimately intercept a plain
    // pointer-event check even when the right element is already visible
    // underneath.
    function documentEditorLocator(page, pageId) {
      return page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first();
    }
    async function dumpEditorDiagnostics(page, tag) {
      try {
        const info = await page.evaluate(() => Array.from(document.querySelectorAll('[data-slate-editor="true"]')).map((el) => ({ id: el.id, text: (el.textContent || '').slice(0, 80) })));
        record(`DIAGNOSTIC [${tag}]: slate editors on page`, 'INFO', JSON.stringify(info));
      } catch (diagError) { record(`DIAGNOSTIC [${tag}] failed`, 'INFO', String(diagError)); }
    }
    // ROOT CAUSE FOUND (confirmed visually via screenshot evidence, not
    // guessed): a brand-new page auto-focuses its TITLE field on
    // creation. The document BODY's first (empty) paragraph has no
    // committed content yet, so clicking the generic
    // `[data-slate-editor="true"]` body-editor container (even though it
    // correctly RESOLVES to the body, confirmed by reading it separately)
    // was intermittently failing its actionability check and silently
    // falling back to a forced click that does not actually shift
    // keyboard focus away from the title -- so all typed keystrokes kept
    // landing in the title, not the body (visible directly in
    // `05-owner-typed-document.png` from an earlier run: the typed marker
    // appeared appended to "Untitled"). The fix: click the actually-
    // rendered, non-zero-size placeholder text ("Enter a / to insert a
    // block, or start typing") to focus the body's first empty paragraph
    // when the document is empty, or the first real block
    // (`[data-block-type]`, confirmed from AppFlowy-Web's own Playwright
    // helpers -- title has no such attribute) once it has content.
    async function clickIntoDocumentBody(page, pageId) {
      // The title (`data-testid="page-title-input"`, id `editor-title-
      // ${viewId}`, confirmed from real DOM evidence) intercepts pointer
      // events over the ENTIRE body area immediately after a brand-new
      // page is created, so a direct click on the body's
      // placeholder/first block times out no matter how long it is
      // retried. Sidestep this entirely: click the title (never
      // intercepted, since it IS the topmost element) and navigate down
      // into the body with ArrowDown, the same keyboard path a real user
      // takes from the title into the first body block. A bare
      // getByTestId match is not unique -- a background/stale page's
      // title can also be mounted with the same testid -- so scope by the
      // exact id this document's title carries.
      const title = page.locator(`#editor-title-${pageId}`);
      await title.waitFor({ state: 'visible', timeout: 10000 });
      await title.click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
    }
    // Always clears the body first and types the FULL replacement text,
    // rather than trying to position the cursor precisely to append --
    // Control+End is not a bound Slate shortcut in this editor (confirmed
    // empirically: it left the cursor at an unpredictable position,
    // producing garbled interleaved text on a second edit), whereas
    // Ctrl/Cmd+A -> Backspace is a standard Slate-intercepted
    // select-all-and-delete that reliably produces a deterministic empty
    // state before typing, scoped to whichever Slate editor instance
    // currently has focus (the body, not the title, since they are
    // separate editor instances). Each call is therefore a full content
    // replace, not an append -- sufficient to prove live delivery of EACH
    // individual edit, which is this scenario's actual acceptance bar.
    async function typeIntoDocument(page, pageId, text) {
      await clickIntoDocumentBody(page, pageId);
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.type(text, { delay: 20 });
      // The editor's own local Yjs state updates synchronously with typing,
      // but the sync-outbox flush to the server may be debounced rather
      // than instantaneous -- give it a moment before any caller relies on
      // the update having reached the server.
      await page.waitForTimeout(1200);
    }
    async function readDocumentTextWithRetry(page, pageId, needle, attempts = 10, delayMs = 800) {
      let text = '';
      for (let i = 0; i < attempts; i += 1) {
        const editor = documentEditorLocator(page, pageId);
        text = (await editor.innerText().catch(() => '')).trim();
        if (text.includes(needle)) return text;
        await page.waitForTimeout(delayMs);
      }
      return text;
    }

    let screenshotIndex = 0;
    async function screenshot(page, name) {
      screenshotIndex += 1;
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true });
    }

    // ===================== Shared setup: two real users, one shared workspace =====================
    const ownerEmail = `task66-owner-${Date.now()}@example.test`;
    const memberEmail = `task66-member-${Date.now()}@example.test`;
    const password = 'Correct horse 907 task66';

    const registerOwner = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    if (registerOwner.status !== 201) throw new Error(`Owner registration failed: ${registerOwner.status}`);
    const registerMember = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) });
    if (registerMember.status !== 201) throw new Error(`Member registration failed: ${registerMember.status}`);
    record('Registered two SEPARATE real user accounts (owner, member)', 'PASS', `${ownerEmail} / ${memberEmail}`);

    const contextOwner = await browser.newContext();
    const contextMember = await browser.newContext();
    const pageOwner = await contextOwner.newPage();
    const pageMember = await contextMember.newPage();
    const loggingOwner = wireLogging(pageOwner, 'owner');
    const loggingMember = wireLogging(pageMember, 'member');

    await login(pageOwner, ownerEmail, password);
    record('Owner logged in via real UI (browser context 1)', 'PASS', pageOwner.url());
    await screenshot(pageOwner, '01-owner-after-login');

    let capturedWorkspaceId = null;
    pageOwner.on('requestfinished', async (req) => {
      const url = req.url();
      const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
      if (match) capturedWorkspaceId = match[1];
    });

    await pageOwner.getByTestId('new-page-button').click();
    await pageOwner.getByTestId('new-page-create-space-button').click();
    await pageOwner.getByTestId('space-name-input').fill('Task66 fanout space');
    await pageOwner.getByTestId('create-space-submit').click();
    await pageOwner.waitForTimeout(1500);
    await pageOwner.keyboard.press('Escape').catch(() => {});
    await pageOwner.reload({ waitUntil: 'domcontentloaded' });
    await pageOwner.waitForURL(/\/app\//, { timeout: 20000 });
    await pageOwner.waitForTimeout(1200);
    await dismissCompatBanner(pageOwner);
    record('Owner created a public Space via real UI', 'PASS', `workspace=${capturedWorkspaceId}`);
    await screenshot(pageOwner, '02-owner-after-space');

    const loginOwnerLookup = await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    const { access_token: ownerToken } = await loginOwnerLookup.json();
    const addMemberResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/test-members`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}`, 'x-development-key': DEV_KEY },
      body: JSON.stringify({ email: memberEmail, role: 'member' }),
    });
    if (addMemberResp.status !== 201) throw new Error(`Adding member failed: ${addMemberResp.status} ${await addMemberResp.text()}`);
    record('Member added to owner\'s workspace via the supported test-membership helper', 'PASS');

    await login(pageMember, memberEmail, password);
    await openWorkspace(pageMember, capturedWorkspaceId);
    record('Member logged in via real UI (independent browser context 2) and opened the shared workspace', 'PASS', pageMember.url());
    await screenshot(pageMember, '03-member-after-login');

    const spaceRow = pageOwner.locator('div[aria-label="Task66 fanout space"]').first().locator('xpath=..');
    await spaceRow.waitFor({ state: 'visible', timeout: 10000 });
    async function hoverSpaceRow(page, label) {
      const row = page.locator(`div[aria-label="${label}"]`).first().locator('xpath=..');
      await row.waitFor({ state: 'visible', timeout: 10000 });
      const box = await row.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
      } else { await row.hover(); }
      await page.waitForTimeout(800);
    }

    // Resolve the space id via the backend's own pages listing (test
    // plumbing only, same convention as Task 64).
    const pagesResp0 = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/pages`, { headers: { authorization: `Bearer ${ownerToken}` } });
    const { pages: pages0 } = await pagesResp0.json();
    const spaceId = pages0.find((p) => p.title === 'Task66 fanout space')?.id || pages0[0]?.parent_view_id;

    // ===================== SCENARIO 1: Document live content fan-out =====================
    await hoverSpaceRow(pageOwner, 'Task66 fanout space');
    await pageOwner.getByTestId('inline-add-page').first().click();
    await pageOwner.getByTestId('add-document-button').click();
    await pageOwner.waitForTimeout(2000);
    const docUrl = pageOwner.url();
    const docPageId = (docUrl.match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    record('Owner created a new Document page via real UI', docPageId ? 'PASS' : 'FAIL', `pageId=${docPageId}`);
    await screenshot(pageOwner, '04-owner-new-document');

    const docMarkerOwner = `task66-doc-owner-${Date.now()}`;
    const docMarkerMember = `task66-doc-member-${Date.now()}`;
    await typeIntoDocument(pageOwner, docPageId, docMarkerOwner);
    const ownerLocalAfterType = (await documentEditorLocator(pageOwner, docPageId).innerText().catch(() => '')).trim();
    record('Owner typed text into the Document editor', ownerLocalAfterType.includes(docMarkerOwner) ? 'PASS' : 'FAIL', `typed="${docMarkerOwner}" localDomNow="${ownerLocalAfterType}"`);
    await screenshot(pageOwner, '05-owner-typed-document');

    // Diagnostic (not a pass/fail gate): read the SERVER's own durable
    // Document collab state directly via HTTP, independent of either
    // browser context's DOM, to isolate whether a marker's absence later
    // is a client-flush issue, a server-side issue, or a frontend-render
    // issue. ownerToken is resolved just above for the test-membership
    // helper call.
    async function serverDocumentTextSnapshot() {
      try {
        const resp = await fetch(`${BACKEND}/api/workspace/v1/${capturedWorkspaceId}/collab/${docPageId}?collab_type=0`, { headers: { authorization: `Bearer ${ownerToken}` } });
        const body = await resp.json();
        const doc = new Y.Doc({ guid: docPageId });
        Y.applyUpdate(doc, new Uint8Array(body.data.doc_state));
        const texts = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text).map((v) => v.toString());
        doc.destroy();
        return texts.join(' | ');
      } catch (snapshotError) { return `(snapshot failed: ${snapshotError})`; }
    }
    record('DIAGNOSTIC: server-side Document state right after owner types', 'INFO', await serverDocumentTextSnapshot());

    const docFallbackUrl = `${FRONTEND}/app/${capturedWorkspaceId}/${docPageId}`;
    await openSidebarPage(pageMember, docPageId, spaceId, docFallbackUrl);
    await dismissCompatBanner(pageMember);
    record('Member (second browser context) opened the SAME Document via the sidebar/URL', 'PASS', pageMember.url());
    await screenshot(pageMember, '06-member-opened-document');

    // Member was NOT connected before the owner's edit in this run (it just
    // opened), so this first read legitimately could be via its own
    // initial SyncRequest. The scenario's LIVE proof is the owner's edit
    // made AFTER both are confirmed open below.
    const memberSeesInitial = await readDocumentTextWithRetry(pageMember, docPageId, docMarkerOwner);
    record('Member sees the owner\'s already-typed text after opening (baseline, via initial sync)', memberSeesInitial.includes(docMarkerOwner) ? 'PASS' : 'FAIL', memberSeesInitial);
    if (!memberSeesInitial.includes(docMarkerOwner)) {
      await dumpEditorDiagnostics(pageMember, 'member-baseline-fail');
      record('DIAGNOSTIC: server-side Document state when member baseline check failed', 'INFO', await serverDocumentTextSnapshot());
    }

    // Confirm both are now live-connected to the SAME Document, then have
    // the OWNER make a SECOND edit and confirm the MEMBER sees it live,
    // with NO reload/refocus/reconnect on the member's page.
    // Each typeIntoDocument call fully replaces the editor's content
    // (clear-then-type, see the helper's own comment) rather than
    // appending -- sufficient to prove live delivery of EACH individual
    // edit, this scenario's actual acceptance bar, without depending on
    // fragile cursor-position/append behavior in this Slate editor.
    const docMarkerOwner2 = `task66-doc-owner2-${Date.now()}`;
    await typeIntoDocument(pageOwner, docPageId, docMarkerOwner2);
    record('Owner typed a SECOND marker while member is already open (no member reload yet)', 'PASS', docMarkerOwner2);
    const memberSeesLiveA2B = await readDocumentTextWithRetry(pageMember, docPageId, docMarkerOwner2);
    results.documentLiveA2B = memberSeesLiveA2B.includes(docMarkerOwner2) ? 'PASS' : 'FAIL';
    record('SCENARIO 1a RESULT: member observes owner\'s second edit LIVE, no reload', results.documentLiveA2B, memberSeesLiveA2B);
    await screenshot(pageMember, '07-member-sees-live-edit');

    await typeIntoDocument(pageMember, docPageId, docMarkerMember);
    record('Member typed text into the SAME Document (no reload/reconnect)', 'PASS', docMarkerMember);
    const ownerSeesLiveB2A = await readDocumentTextWithRetry(pageOwner, docPageId, docMarkerMember);
    results.documentLiveB2A = ownerSeesLiveB2A.includes(docMarkerMember) ? 'PASS' : 'FAIL';
    record('SCENARIO 1b RESULT: owner observes member\'s edit LIVE, no reload', results.documentLiveB2A, ownerSeesLiveB2A);
    await screenshot(pageOwner, '08-owner-sees-live-edit');

    await pageOwner.reload({ waitUntil: 'domcontentloaded' });
    await pageOwner.waitForTimeout(1500);
    await dismissCompatBanner(pageOwner);
    await pageMember.reload({ waitUntil: 'domcontentloaded' });
    await pageMember.waitForTimeout(1500);
    await dismissCompatBanner(pageMember);
    // The member's edit (docMarkerMember) was the LAST write (a full
    // content replace), so it is the content expected to persist for
    // BOTH contexts after reload.
    const ownerPersisted = await readDocumentTextWithRetry(pageOwner, docPageId, docMarkerMember);
    const memberPersisted = await readDocumentTextWithRetry(pageMember, docPageId, docMarkerMember);
    results.documentPersist = (ownerPersisted.includes(docMarkerMember) && memberPersisted.includes(docMarkerMember)) ? 'PASS' : 'FAIL';
    record('SCENARIO 1c RESULT: the last edit persisted and is visible to BOTH contexts after reload', results.documentPersist, `owner="${ownerPersisted}" member="${memberPersisted}"`);
    await screenshot(pageOwner, '09-owner-after-reload');
    await screenshot(pageMember, '10-member-after-reload');

    // ===================== SCENARIO 2: Database/DatabaseRow grid-cell live fan-out =====================
    // NOTE (recorded limitation, not an invented workflow): AppFlowy-Web's
    // current UI exposes no separate "row detail document" view -- the
    // only row/cell collaboration workflow it supports is editing a cell
    // directly in the Grid. At the protocol level, an ordinary grid cell
    // edit is carried by the DatabaseRow collab object (CollabType=4; see
    // server.js's Task 62 comments), not the Database collab object
    // (CollabType=1, which carries field/view metadata such as row_orders
    // and is also exercised by the atomic REST row-creation endpoint,
    // explicitly OUT of this task's fan-out scope). So this single
    // UI workflow is this task's real-browser proof of the DatabaseRow
    // live fan-out; the Database (CollabType=1) fan-out itself is already
    // proven at the real-protocol level by test/realtime-fanout.test.js
    // ("Task 66 fan-out (JSON, Database)") and is not re-demonstrated here
    // via browser, since no distinct Database-object-only UI action exists
    // to drive it.
    await pageOwner.goto(`${FRONTEND}/app/${capturedWorkspaceId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await pageOwner.waitForTimeout(1200);
    await dismissCompatBanner(pageOwner);
    await hoverSpaceRow(pageOwner, 'Task66 fanout space');
    await pageOwner.getByTestId('inline-add-page').first().click();
    await pageOwner.getByTestId('add-grid-button').click();
    await pageOwner.waitForTimeout(2500);
    const gridLoadedOwner = await waitGridLoaded(pageOwner);
    const gridUrl = pageOwner.url();
    const gridPageId = (gridUrl.match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    record('Owner created a Grid Database via real UI', gridLoadedOwner ? 'PASS' : 'FAIL', `pageId=${gridPageId}`);
    await screenshot(pageOwner, '11-owner-new-grid');

    const fieldHeaders = await pageOwner.locator('[data-testid^="grid-field-header-"]').all();
    const primaryFieldId = (await fieldHeaders[0].getAttribute('data-testid')).replace('grid-field-header-', '');

    const existingRowIds = new Set();
    await pageOwner.getByTestId('grid-new-row').click();
    await pageOwner.waitForTimeout(1500);
    const rowId1 = await getNewRowId(pageOwner, existingRowIds);
    existingRowIds.add(rowId1);
    const cellValue1Initial = `task66-grid-initial-${Date.now()}`;
    const cellTestId1 = await enterCellValue(pageOwner, rowId1, primaryFieldId, cellValue1Initial);
    record('Owner created row 1 with an initial cell value', 'PASS', cellValue1Initial);

    await pageOwner.getByTestId('grid-new-row').click();
    await pageOwner.waitForTimeout(1500);
    const rowId2 = await getNewRowId(pageOwner, existingRowIds);
    existingRowIds.add(rowId2);
    const cellValue2Initial = `task66-grid-row2-initial-${Date.now()}`;
    const cellTestId2 = await enterCellValue(pageOwner, rowId2, primaryFieldId, cellValue2Initial);
    record('Owner created row 2 with an initial cell value', 'PASS', cellValue2Initial);
    await screenshot(pageOwner, '12-owner-two-rows');

    const gridFallbackUrl = `${FRONTEND}/app/${capturedWorkspaceId}/${gridPageId}`;
    await openSidebarPage(pageMember, gridPageId, spaceId, gridFallbackUrl);
    await dismissCompatBanner(pageMember);
    const gridLoadedMember = await waitGridLoaded(pageMember);
    await pageMember.waitForSelector('[data-testid^="grid-row-"]', { timeout: 15000 }).catch(() => {});
    const memberSeesRow1Initial = await readCellTextWithRetry(pageMember, cellTestId1, 15, 1000);
    record('Member (second browser context) opens the SAME Grid and sees both rows (baseline, via initial sync)', (gridLoadedMember && memberSeesRow1Initial === cellValue1Initial) ? 'PASS' : 'FAIL', memberSeesRow1Initial);
    await screenshot(pageMember, '13-member-opened-grid');

    // Both now confirmed connected to the SAME Database/rows. Owner edits
    // row 1's cell to a NEW value; confirm the member sees it LIVE with no
    // reload.
    const cellValue1Live = `task66-grid-live-owner-${Date.now()}`;
    await enterCellValue(pageOwner, rowId1, primaryFieldId, cellValue1Live, { clearFirst: true });
    record('Owner overwrote row 1\'s cell value (member already open, no reload)', 'PASS', cellValue1Live);
    const memberSeesLiveCell = await readCellTextWithRetry(pageMember, cellTestId1, 15, 1000);
    results.gridLiveA2B = memberSeesLiveCell === cellValue1Live ? 'PASS' : 'FAIL';
    record('SCENARIO 2a RESULT: member observes owner\'s cell edit LIVE, no reload (DatabaseRow fan-out)', results.gridLiveA2B, memberSeesLiveCell);
    await screenshot(pageMember, '14-member-sees-live-cell');

    const cellValue2Live = `task66-grid-live-member-${Date.now()}`;
    await enterCellValue(pageMember, rowId2, primaryFieldId, cellValue2Live, { clearFirst: true });
    record('Member overwrote row 2\'s cell value (no reload/reconnect)', 'PASS', cellValue2Live);
    const ownerSeesLiveCell = await readCellTextWithRetry(pageOwner, cellTestId2, 15, 1000);
    results.gridLiveB2A = ownerSeesLiveCell === cellValue2Live ? 'PASS' : 'FAIL';
    record('SCENARIO 2b RESULT: owner observes member\'s cell edit LIVE, no reload (DatabaseRow fan-out)', results.gridLiveB2A, ownerSeesLiveCell);
    await screenshot(pageOwner, '15-owner-sees-live-cell');

    await pageOwner.reload({ waitUntil: 'domcontentloaded' });
    await pageOwner.waitForTimeout(1500);
    await dismissCompatBanner(pageOwner);
    await pageMember.reload({ waitUntil: 'domcontentloaded' });
    await pageMember.waitForTimeout(1500);
    await dismissCompatBanner(pageMember);
    await waitGridLoaded(pageOwner);
    await waitGridLoaded(pageMember);
    const ownerCell1AfterReload = await readCellTextWithRetry(pageOwner, cellTestId1, 10, 800);
    const ownerCell2AfterReload = await readCellTextWithRetry(pageOwner, cellTestId2, 10, 800);
    const memberCell1AfterReload = await readCellTextWithRetry(pageMember, cellTestId1, 10, 800);
    const memberCell2AfterReload = await readCellTextWithRetry(pageMember, cellTestId2, 10, 800);
    results.gridPersist = (ownerCell1AfterReload.includes(cellValue1Live) && ownerCell2AfterReload.includes(cellValue2Live)
      && memberCell1AfterReload.includes(cellValue1Live) && memberCell2AfterReload.includes(cellValue2Live)) ? 'PASS' : 'FAIL';
    record('SCENARIO 2c RESULT: both cell edits persisted and visible to BOTH contexts after reload', results.gridPersist,
      `owner cell1="${ownerCell1AfterReload}" cell2="${ownerCell2AfterReload}" member cell1="${memberCell1AfterReload}" cell2="${memberCell2AfterReload}"`);
    await screenshot(pageOwner, '16-owner-grid-after-reload');
    await screenshot(pageMember, '17-member-grid-after-reload');

    await writeFile(path.join(EVIDENCE_DIR, 'console-errors-owner.log'), loggingOwner.consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network-owner.log'), loggingOwner.networkLog.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'console-errors-member.log'), loggingMember.consoleErrors.join('\n'));
    await writeFile(path.join(EVIDENCE_DIR, 'network-member.log'), loggingMember.networkLog.join('\n'));

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
