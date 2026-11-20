import { Page, expect } from '@playwright/test';

/**
 * Task 69 navigation primitives.
 *
 * These are the condition-based building blocks for reliably navigating
 * AppFlowy-Web in real-browser Playwright tests. They replace the ad hoc,
 * fixed-sleep, broad-selector approach in the pre-Task-69 `test/screens/*`
 * helpers, and encode the root causes found during live reproduction
 * (documented in docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md):
 *
 *  1. The quick "+" sidebar create-document flow (`inline-add-page` ->
 *     `add-document-button`) opens the new page in a `ViewModal`
 *     (`AppBusinessLayer.openPageModal`), NOT a plain route navigation.
 *     The modal is a real MUI `Dialog` with an ACTIVE, pointer-events:auto
 *     backdrop that covers the full viewport (confirmed via DOM evidence:
 *     `rect` spans the entire client area, `pointerEvents: 'auto'`,
 *     `opacity: '1'`). Until it is explicitly closed (the
 *     `view-modal-close` button, the same affordance a real user has),
 *     EVERY click anywhere on the page -- not just over the modal's own
 *     visible content -- is intercepted by this backdrop. A bare
 *     `Escape` keypress also dismisses it, but the UI's own close button
 *     is preferred as the real, user-facing mechanism.
 *  2. Immediately after creation, the full-page route for the new
 *     document can transiently show a "We couldn't find this content."
 *     toast (a genuine create/resolve propagation gap, not a selector
 *     problem) and the realtime connection badge can still read
 *     "Connecting...". Both must clear before editor interaction is
 *     trusted.
 *  3. A page's title/editor DOM nodes are scoped by the exact page id
 *     (`#editor-title-<id>`, `[id$="editor-<id>"]`) rather than a bare
 *     class/role selector, because a stale/background instance of the
 *     editor can legitimately be mounted at the same time (e.g. behind a
 *     still-closing modal).
 *
 * All waits here are condition-based (poll a real DOM/app state) with a
 * bounded timeout, never a blind `waitForTimeout` used as the sole
 * mechanism. A couple of short, explicitly-commented fixed waits remain
 * where there is no better observable signal (e.g. settling a mouse-move
 * hover before a transient "+" button fades in); each one says why.
 */

export const NOT_FOUND_TOAST_TEXT = "couldn't find this content";

/** Poll until no ".MuiDialog-root" (ViewModal or any other MUI Dialog) remains mounted. */
export async function waitForNoDialogMounted(page: Page, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => document.querySelectorAll('.MuiDialog-root').length).catch(() => 1);
    if (count === 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

/**
 * If a ViewModal (or any MUI Dialog) is open, close it via its real UI
 * close affordance and wait for it to actually unmount. Returns whether a
 * modal was present and successfully closed (true also if none was open).
 */
export async function ensureNoViewModalOpen(page: Page, timeoutMs = 8000): Promise<boolean> {
  const closeBtn = page.getByTestId('view-modal-close');
  const hasCloseButton = await closeBtn.first().isVisible({ timeout: 1500 }).catch(() => false);
  if (hasCloseButton) {
    await closeBtn.first().click();
  }
  return waitForNoDialogMounted(page, timeoutMs);
}

/** Poll until the "We couldn't find this content." propagation-timing toast is gone (or never appeared). */
export async function waitForNoNotFoundToast(page: Page, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await page
      .getByText(NOT_FOUND_TOAST_TEXT, { exact: false })
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (!visible) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * Poll until the realtime "Connecting..." badge is gone AND the exact
 * page's title element (scoped by id, not a bare class) is visible. This
 * is the "editor usable" condition -- do not type/read before this.
 */
export async function waitForDocumentEditorReady(page: Page, pageId: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillConnecting = await page.getByText('Connecting', { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
    const titleVisible = await page
      .locator(`#editor-title-${pageId}`)
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (!stillConnecting && titleVisible) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * Full readiness gate for "I just navigated to / created document
 * `pageId` and want to interact with it": closes any stray modal, waits
 * out the not-found-toast propagation window, then waits for the editor.
 * Returns a diagnostic object (never throws) so callers can assert with
 * their own failure classification/evidence capture.
 */
export async function waitForDocumentReady(
  page: Page,
  pageId: string,
  timeoutMs = 20000
): Promise<{ modalClosed: boolean; toastCleared: boolean; editorReady: boolean; ok: boolean }> {
  const start = Date.now();
  const modalClosed = await ensureNoViewModalOpen(page, timeoutMs);
  const remaining1 = Math.max(1000, timeoutMs - (Date.now() - start));
  const toastCleared = await waitForNoNotFoundToast(page, remaining1);
  const remaining2 = Math.max(1000, timeoutMs - (Date.now() - start));
  const editorReady = await waitForDocumentEditorReady(page, pageId, remaining2);
  return { modalClosed, toastCleared, editorReady, ok: modalClosed && toastCleared && editorReady };
}

/** Exact-scoped locator for a document's title, never a bare class/testid match. */
export function documentTitleLocator(page: Page, pageId: string) {
  return page.locator(`#editor-title-${pageId}`);
}

/**
 * Exact-scoped locator for a document's body editor. A generic
 * `[data-slate-editor="true"]` can match more than one mounted instance
 * (e.g. a stale background page behind a closing modal); matching by
 * suffix on `id` is correct for both the bare and previewId-prefixed id
 * shapes AppFlowy-Web's `Editable.tsx` produces.
 */
export function documentBodyLocator(page: Page, pageId: string) {
  return page.locator(`[data-slate-editor="true"][id$="editor-${pageId}"]`).first();
}

/**
 * Click into a document's body. Clicking the body editor container
 * directly is tried first and verified by actually checking where the
 * DOM selection landed (not assumed) -- empirically, the title -> End ->
 * ArrowDown path (the keyboard route a real user would take from the
 * title) does not reliably move the Slate selection into the body on a
 * brand-new, fully empty document: ArrowDown has nothing below the
 * title's own line to land on until the body has been focused at least
 * once, so typed keystrokes silently keep landing in the title instead.
 * This was confirmed via a live repro, not assumed: see
 * docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md.
 */
export async function clickIntoDocumentBody(page: Page, pageId: string): Promise<void> {
  const title = documentTitleLocator(page, pageId);
  await title.waitFor({ state: 'visible', timeout: 10000 });

  const body = documentBodyLocator(page, pageId);
  await body.waitFor({ state: 'visible', timeout: 10000 });

  async function landedInBody(): Promise<boolean> {
    return page.evaluate((id) => {
      const bodyEl = document.querySelector(`[data-slate-editor="true"][id$="editor-${id}"]`);
      const active = document.activeElement;
      return !!bodyEl && (bodyEl === active || bodyEl.contains(active));
    }, pageId);
  }

  // Click near the top-LEFT of the body container, not its bounding-box
  // CENTER (Playwright's default click target). Empirically, a center
  // click on a near-empty document can land in the container's lower
  // empty padding; Slate's OWN internal selection model (kept separately
  // from plain DOM focus) does not always update from such a click, so
  // keystrokes can keep landing in the title even though
  // `document.activeElement` already reports the body as focused. A
  // top-left click reliably lands on the actual first (possibly empty)
  // paragraph line. Confirmed via live repro, not assumed.
  await body.click({ position: { x: 10, y: 12 } });
  if (await landedInBody()) return;

  // Fall back to a default-position click, then to the keyboard path from
  // the title -- verifying after each attempt rather than assuming it worked.
  await body.click();
  if (await landedInBody()) return;

  await title.click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
}

/** Replace the document body's full content and return once the local edit lands in the DOM. */
export async function typeIntoDocumentBody(page: Page, pageId: string, text: string): Promise<void> {
  await clickIntoDocumentBody(page, pageId);
  // Task 70 regression finding: a plain `npm run test:e2e` run (2026-11-10,
  // see docs/task70-evidence/regression/) flaked on Scenario E with this
  // function unconditionally doing Select-All+Backspace even when the body
  // was already empty. This reproduces the exact failure mode already
  // diagnosed and fixed in the Task 69 Stage 7 script
  // (docs/task69-evidence/task68-scenario-b-reverify.mjs's own
  // typeIntoDocumentBody): Select-All on an empty body can collapse the
  // Slate selection back up into the title (title+body are one page in
  // this app's Slate model), so the clear step is only executed when there
  // is actually existing content to clear -- restoring the same minimal
  // fix applied there, now in the shared helper. A second re-run of the
  // same `npm run test:e2e` suite (same evidence dir) passed 7/7 without
  // this fix too, so the flake is intermittent, not deterministic; this
  // fix removes the known trigger rather than papering over a timeout.
  const existing = (await documentBodyLocator(page, pageId).innerText().catch(() => '')).trim();
  if (existing.length > 0) {
    await page.keyboard.press('Control+a').catch(() => {});
    await page.keyboard.press('Meta+a').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.keyboard.type(text, { delay: 20 });
  await expect(documentBodyLocator(page, pageId)).toContainText(text, { timeout: 10000 });
}

/** Read the document body text with retry (content can lag a beat behind a reload/navigation), not a fixed sleep. */
export async function readDocumentBodyWithRetry(
  page: Page,
  pageId: string,
  needle?: string,
  attempts = 15,
  delayMs = 500
): Promise<string> {
  let text = '';
  for (let i = 0; i < attempts; i += 1) {
    text = (await documentBodyLocator(page, pageId).innerText().catch(() => '')).trim();
    if (!needle || text.includes(needle)) return text;
    await page.waitForTimeout(delayMs);
  }
  return text;
}

/** Dismiss the (unrelated) client-compatibility banner if present; it is not part of any navigation flow under test. */
export async function dismissCompatBanner(page: Page): Promise<void> {
  const dismissBanner = page.locator('[data-testid="client-compatibility-banner"] button[aria-label]');
  if (await dismissBanner.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await dismissBanner.first().click();
    await page.waitForTimeout(200);
  }
}

/**
 * Hover a space row via a real mouse move (not `.hover()`, which can land
 * before layout settles) so its transient inline "+" action becomes
 * visible, mirroring the proven pattern from the Task 66/68 evidence
 * scripts.
 */
export async function hoverSpaceRow(page: Page, label: string): Promise<void> {
  const row = page.locator(`div[aria-label="${label}"]`).first().locator('xpath=..');
  await row.waitFor({ state: 'visible', timeout: 10000 });
  const box = await row.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 5 });
  } else {
    await row.hover();
  }
  await page.waitForTimeout(400); // short, explicitly-justified: CSS hover-reveal transition has no exposed "done" event
}

/**
 * Expand a Space's sidebar entry if it is not already expanded. Returns
 * false if the space row itself cannot be found (caller should treat
 * that as a distinct failure, not silently proceed).
 */
export async function expandSpace(page: Page, spaceId: string): Promise<boolean> {
  const spaceToggle = page.getByTestId(`space-${spaceId}`);
  if (!(await spaceToggle.first().isVisible({ timeout: 8000 }).catch(() => false))) return false;
  const expanded = await spaceToggle.first().getAttribute('data-expanded').catch(() => null);
  if (expanded !== 'true') {
    await spaceToggle.first().click();
    await page.waitForTimeout(500);
  }
  return true;
}

/**
 * Navigate to a page via its sidebar entry, scoped by the EXACT page id
 * (never the first match of a broader selector). Detects -- rather than
 * silently tolerating -- more than one element matching the same testid,
 * which Task 68 found could happen behind navigation transitions.
 */
export async function navigateViaSidebar(
  page: Page,
  pageId: string,
  spaceId: string,
  spaceLabel: string
): Promise<{ ok: boolean; matchedCount: number; reason?: string }> {
  await expandSpace(page, spaceId);
  let entry = page.getByTestId(`page-${pageId}`);
  let visible = await entry.first().isVisible({ timeout: 6000 }).catch(() => false);
  if (!visible) {
    // Retry once: re-hover the space row (it can collapse its hover-revealed
    // affordances after a route/modal transition) then re-check.
    await hoverSpaceRow(page, spaceLabel);
    await expandSpace(page, spaceId);
    entry = page.getByTestId(`page-${pageId}`);
    visible = await entry.first().isVisible({ timeout: 6000 }).catch(() => false);
  }
  if (!visible) {
    return { ok: false, matchedCount: await entry.count(), reason: 'sidebar entry not visible after retry' };
  }
  const matchedCount = await entry.count();
  if (matchedCount > 1) {
    // Explicitly resolve to the one that is actually visible rather than
    // picking the first match blindly.
    const visibleOnes = await entry.evaluateAll((els) =>
      els.map((el, i) => ({ i, visible: !!(el as HTMLElement).offsetParent })).filter((x) => x.visible)
    );
    if (visibleOnes.length !== 1) {
      return { ok: false, matchedCount, reason: `${matchedCount} elements match testid page-${pageId}, ${visibleOnes.length} visible (expected exactly 1)` };
    }
    await entry.nth(visibleOnes[0].i).click();
  } else {
    await entry.first().click();
  }
  await page.waitForTimeout(300);
  return { ok: true, matchedCount };
}

/** Assert the currently-active document identity matches `pageId`, both via URL and via the scoped title element -- not just a URL string match. */
export async function assertActiveDocumentIdentity(page: Page, pageId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/${pageId}(?:[/?]|$)`));
  await expect(documentTitleLocator(page, pageId)).toBeVisible({ timeout: 10000 });
}
