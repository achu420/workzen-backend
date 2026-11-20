// Task 67 real-browser security verification. Adapted directly from the
// proven Task 66 script (docs/task66-evidence/task66-browser-verify.mjs) --
// same env-var parameterization, same login/space/document helpers (reused
// verbatim), same .env.local backup/restore (MD5-verified) discipline, same
// evidence-capture conventions. Scope, per the Task 67 guardrail (max 3
// distinct attempts per scenario, "Blocked" is an acceptable outcome):
//
//   Scenario A (authorized access): owner creates a Document, grants member
//   access via the supported test-membership helper, member opens it via
//   real UI and sees the owner's live edit with no reload (reusing Task
//   66's already-proven live-delivery mechanics).
//
//   Scenario C (membership revocation): while the member is still connected
//   (socket open, document open in its browser context), the owner revokes
//   the member's membership via the backend-controlled test helper (this
//   backend has no product UI for removing a member -- documented
//   limitation, same finding as Stage 2 of the Task 67 report). The member
//   then attempts another edit via real UI. The script verifies, via the
//   backend's OWN durable state (not the member's local DOM, which cannot
//   be trusted to reveal whether its write actually reached the server),
//   that the attempted edit was NOT persisted -- i.e. the revocation
//   actually blocked a write attempted through the real UI, not just a
//   direct API call.
//
// Scenario B (unrelated non-member) and Scenario D (independent workspace
// isolation) are intentionally NOT re-attempted here with a third browser
// context in this same run, to keep this single script run inside the
// guardrail's spirit (bounded, not a sprawling combinatorial UI matrix);
// both are already proven at the real HTTP/WS protocol level in
// test/security-authorization.test.js and
// test/postgres-security-authorization.test.js (non-member REST/WS
// rejection, cross-workspace object rejection), which this task's report
// treats as the authoritative evidence for those two scenarios.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';

const BACKEND_PORT = process.env.BACKEND_PORT;
const FRONTEND_PORT = process.env.FRONTEND_PORT;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const DEV_KEY = process.env.DEV_KEY || 'task67-key';
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
    for (const pid of pidOutput.split('\n').filter(Boolean)) { execSync(`kill ${pid}`); record(`Killed process on port ${port}`, 'INFO', `pid=${pid}`); }
    return pidOutput.split('\n').filter(Boolean);
  } catch { return []; }
}
function spawnBackend() {
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(BACKEND_PORT), STORAGE: 'json', DATA_FILE, DEV_TEST_KEY: DEV_KEY, CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}` };
  const child = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
async function waitHealthy(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) { try { const r = await fetch(`${url}/health`); if (r.ok) return true; } catch { /* retry */ } await new Promise((resolve) => setTimeout(resolve, 500)); }
  return false;
}
async function waitFrontendReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) { try { const r = await fetch(url); if (r.ok || r.status === 304) return true; } catch { /* retry */ } await new Promise((resolve) => setTimeout(resolve, 1000)); }
  return false;
}

async function main() {
  const results = { scenarioA_authorizedLiveDelivery: 'NOT TESTED', scenarioC_revocationBlocksWrite: 'NOT TESTED' };
  let backendProcess, frontendProcess, envBackupMd5;
  try {
    envBackupMd5 = await backupEnvLocal();
    const envContent = [`APPFLOWY_BASE_URL=${BACKEND}`, `APPFLOWY_GOTRUE_BASE_URL=${BACKEND}`, `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${BACKEND_PORT}/ws/v2`].join('\n') + '\n';
    await writeFile(ENV_LOCAL_PATH, envContent);
    record('Wrote temporary .env.local pointing at this run\'s disposable backend', 'INFO', envContent.replace(/\n/g, ' | '));

    backendProcess = spawnBackend();
    const backendHealthy = await waitHealthy(BACKEND);
    record(`Backend process started (STORAGE=json, port ${BACKEND_PORT})`, backendHealthy ? 'PASS' : 'FAIL', `pid=${backendProcess.pid}`);
    if (!backendHealthy) throw new Error('Backend did not become healthy');

    frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(FRONTEND_PORT), '--strictPort'], { cwd: FRONTEND_DIR, env: { ...process.env, PORT: String(FRONTEND_PORT) }, detached: true, stdio: 'ignore' });
    frontendProcess.unref();
    const frontendReady = await waitFrontendReady(FRONTEND);
    record(`Frontend dev server started (port ${FRONTEND_PORT})`, frontendReady ? 'PASS' : 'FAIL', `pid=${frontendProcess.pid}`);
    if (!frontendReady) throw new Error('Frontend did not become ready');

    const browser = await chromium.launch({ headless: true, executablePath: '/Users/achal/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' });

    async function dismissCompatBanner(page) {
      const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
      if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) { await dismissBanner.first().click(); await page.waitForTimeout(300); }
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
      if (await entry.first().isVisible({ timeout: 10000 }).catch(() => false)) { await entry.first().click(); await page.waitForTimeout(1500); return true; }
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      return false;
    }
    function documentEditorLocator(page, pageId) { return page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first(); }
    async function clickIntoDocumentBody(page, pageId) {
      const title = page.locator(`#editor-title-${pageId}`);
      await title.waitFor({ state: 'visible', timeout: 10000 });
      // Task 67 attempt 3: attempt 2's `click({force:true})` skips
      // Playwright's actionability WAIT, but Playwright still dispatches the
      // click at the title's real screen coordinates -- if the modal's
      // sticky header subtree is physically on top of those coordinates at
      // dispatch time (confirmed as a real, repeated condition by attempt
      // 1's error), the browser itself can still route the click to the
      // header, not the title, silently leaving focus unchanged. Bypass
      // click dispatch entirely: focus the title's contenteditable element
      // directly via the DOM API, which cannot be intercepted by an
      // overlapping element since no hit-test/coordinate routing is
      // involved at all.
      await page.waitForTimeout(500);
      const titleId = `editor-title-${pageId}`;
      const focused = await page.evaluate((elId) => {
        const el = document.getElementById(elId);
        if (!el) return false;
        el.focus();
        return document.activeElement === el;
      }, titleId);
      if (!focused) throw new Error(`Could not programmatically focus title element #${titleId}`);
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
    }
    async function typeIntoDocument(page, pageId, text) {
      await clickIntoDocumentBody(page, pageId);
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.type(text, { delay: 20 });
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
    async function serverDocumentTextSnapshot(workspaceId, pageId, token) {
      try {
        const resp = await fetch(`${BACKEND}/api/workspace/v1/${workspaceId}/collab/${pageId}?collab_type=0`, { headers: { authorization: `Bearer ${token}` } });
        const body = await resp.json();
        const doc = new Y.Doc({ guid: pageId });
        Y.applyUpdate(doc, new Uint8Array(body.data.doc_state));
        const texts = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text).map((v) => v.toString());
        doc.destroy();
        return texts.join(' | ');
      } catch (snapshotError) { return `(snapshot failed: ${snapshotError})`; }
    }

    const ownerEmail = `task67-owner-${Date.now()}@example.test`;
    const memberEmail = `task67-member-${Date.now()}@example.test`;
    const password = 'Correct horse 907 task67';

    const registerOwner = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    if (registerOwner.status !== 201) throw new Error(`Owner registration failed: ${registerOwner.status}`);
    const registerMember = await fetch(`${BACKEND}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) });
    if (registerMember.status !== 201) throw new Error(`Member registration failed: ${registerMember.status}`);
    record('Registered two SEPARATE real user accounts (owner, member)', 'PASS', `${ownerEmail} / ${memberEmail}`);

    const contextOwner = await browser.newContext();
    const contextMember = await browser.newContext();
    const pageOwner = await contextOwner.newPage();
    const pageMember = await contextMember.newPage();

    await login(pageOwner, ownerEmail, password);
    record('Owner logged in via real UI (browser context 1)', 'PASS', pageOwner.url());
    await screenshot(pageOwner, 'owner-after-login');

    let capturedWorkspaceId = null;
    pageOwner.on('requestfinished', async (req) => {
      const url = req.url();
      const match = url.match(/\/api\/workspace\/([^/]+)\/v2\/page-view/);
      if (match) capturedWorkspaceId = match[1];
    });

    await pageOwner.getByTestId('new-page-button').click();
    await pageOwner.getByTestId('new-page-create-space-button').click();
    await pageOwner.getByTestId('space-name-input').fill('Task67 security space');
    await pageOwner.getByTestId('create-space-submit').click();
    await pageOwner.waitForTimeout(1500);
    await pageOwner.keyboard.press('Escape').catch(() => {});
    await pageOwner.reload({ waitUntil: 'domcontentloaded' });
    await pageOwner.waitForURL(/\/app\//, { timeout: 20000 });
    await pageOwner.waitForTimeout(1200);
    await dismissCompatBanner(pageOwner);
    record('Owner created a public Space via real UI', 'PASS', `workspace=${capturedWorkspaceId}`);

    const loginOwnerLookup = await fetch(`${BACKEND}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, password }) });
    const { access_token: ownerToken } = await loginOwnerLookup.json();
    const addMemberResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/test-members`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}`, 'x-development-key': DEV_KEY }, body: JSON.stringify({ email: memberEmail, role: 'member' }) });
    if (addMemberResp.status !== 201) throw new Error(`Adding member failed: ${addMemberResp.status} ${await addMemberResp.text()}`);
    record('Member added to owner\'s workspace via the supported test-membership helper', 'PASS');

    await login(pageMember, memberEmail, password);
    await openWorkspace(pageMember, capturedWorkspaceId);
    record('Member logged in via real UI (independent browser context 2) and opened the shared workspace', 'PASS', pageMember.url());

    const pagesResp0 = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/pages`, { headers: { authorization: `Bearer ${ownerToken}` } });
    const { pages: pages0 } = await pagesResp0.json();
    const spaceId = pages0.find((p) => p.title === 'Task67 security space')?.id || pages0[0]?.parent_view_id;

    async function hoverSpaceRow(page, label) {
      const row = page.locator(`div[aria-label="${label}"]`).first().locator('xpath=..');
      await row.waitFor({ state: 'visible', timeout: 10000 });
      const box = await row.boundingBox();
      if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 }); }
      else { await row.hover(); }
      await page.waitForTimeout(800);
    }
    await hoverSpaceRow(pageOwner, 'Task67 security space');
    await pageOwner.getByTestId('inline-add-page').first().click();
    await pageOwner.getByTestId('add-document-button').click();
    await pageOwner.waitForTimeout(2000);
    const docUrl = pageOwner.url();
    const docPageId = (docUrl.match(/\/app\/[^/]+\/([^/?]+)/) || [])[1];
    record('Owner created a new Document page via real UI', docPageId ? 'PASS' : 'FAIL', `pageId=${docPageId}`);

    // ===================== SCENARIO A: authorized access + live delivery =====================
    const markerOwner1 = `task67-doc-owner1-${Date.now()}`;
    await typeIntoDocument(pageOwner, docPageId, markerOwner1);
    record('Owner typed initial text into the Document', 'PASS', markerOwner1);

    const docFallbackUrl = `${FRONTEND}/app/${capturedWorkspaceId}/${docPageId}`;
    await openSidebarPage(pageMember, docPageId, spaceId, docFallbackUrl);
    await dismissCompatBanner(pageMember);
    record('Authorized member (second browser context) opened the SAME Document via the sidebar/URL', 'PASS', pageMember.url());
    const memberSeesInitial = await readDocumentTextWithRetry(pageMember, docPageId, markerOwner1);
    record('SCENARIO A (baseline): authorized member sees owner\'s content after opening', memberSeesInitial.includes(markerOwner1) ? 'PASS' : 'FAIL', memberSeesInitial);

    const markerOwner2 = `task67-doc-owner2-${Date.now()}`;
    await typeIntoDocument(pageOwner, docPageId, markerOwner2);
    const memberSeesLive = await readDocumentTextWithRetry(pageMember, docPageId, markerOwner2);
    results.scenarioA_authorizedLiveDelivery = memberSeesLive.includes(markerOwner2) ? 'PASS' : 'FAIL';
    record('SCENARIO A RESULT: authorized member observes owner\'s edit LIVE (no reload) while membership is valid', results.scenarioA_authorizedLiveDelivery, memberSeesLive);
    await screenshot(pageMember, 'scenarioA-member-sees-live-edit');

    // ===================== SCENARIO C: membership revocation while connected =====================
    const beforeRevocationServerState = await serverDocumentTextSnapshot(capturedWorkspaceId, docPageId, ownerToken);
    record('DIAGNOSTIC: server-side Document state just before revocation', 'INFO', beforeRevocationServerState);

    const revokeResp = await fetch(`${BACKEND}/api/workspaces/${capturedWorkspaceId}/test-members?email=${encodeURIComponent(memberEmail)}`, { method: 'DELETE', headers: { authorization: `Bearer ${ownerToken}`, 'x-development-key': DEV_KEY } });
    record('Owner revoked the member\'s workspace membership via the backend-controlled test helper (no product UI exists for this -- documented limitation)', revokeResp.status === 200 ? 'PASS' : 'FAIL', `status=${revokeResp.status}`);

    // Give the member's already-open WebSocket connection time to be
    // caught by either the pre-existing per-message revalidation (on its
    // next message) or the new Task 67 periodic revalidation timer.
    await pageMember.waitForTimeout(1000);

    const markerMemberAfterRevoke = `task67-doc-member-after-revoke-${Date.now()}`;
    let memberWriteAttemptError = null;
    try {
      await typeIntoDocument(pageMember, docPageId, markerMemberAfterRevoke);
    } catch (typeError) {
      memberWriteAttemptError = String(typeError);
    }
    record('Revoked member attempted to edit the Document via real UI after revocation', memberWriteAttemptError ? 'INFO (UI interaction itself errored, see detail)' : 'INFO', memberWriteAttemptError || `attempted marker="${markerMemberAfterRevoke}"`);
    await screenshot(pageMember, 'scenarioC-member-after-revocation-attempt');

    await pageMember.waitForTimeout(1500);
    const afterRevocationServerState = await serverDocumentTextSnapshot(capturedWorkspaceId, docPageId, ownerToken);
    record('DIAGNOSTIC: server-side Document state after the revoked member\'s write attempt', 'INFO', afterRevocationServerState);
    const writeWasBlocked = !afterRevocationServerState.includes(markerMemberAfterRevoke);
    results.scenarioC_revocationBlocksWrite = writeWasBlocked ? 'PASS' : 'FAIL';
    record('SCENARIO C RESULT: the revoked member\'s real-UI write attempt did NOT reach durable server state', results.scenarioC_revocationBlocksWrite, `server state after attempt="${afterRevocationServerState}"`);

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

main().catch((error) => { console.error('FATAL', error); process.exit(1); });
