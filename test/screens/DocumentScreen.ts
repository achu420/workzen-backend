import {
  waitForDocumentReady,
  clickIntoDocumentBody,
  typeIntoDocumentBody,
  readDocumentBodyWithRetry,
  hoverSpaceRow,
} from '../helpers/navigation';

/**
 * Screen for managing Documents (pages) - creation, editing, persistence verification
 *
 * Task 69 note: this class's navigation/selectors were found to be built
 * on a route scheme AppFlowy-Web does not actually use
 * (`/workspace/:id/space/:id/page/:id`) and broad, ambiguous selectors
 * (`text=New`, `[role="button"]:has-text("+")`, etc.) that can silently
 * match the wrong element or multiple elements. Live reproduction
 * (docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md) confirmed the
 * real route is `/app/:workspaceId/:pageId` and the real, stable
 * testids/selectors used below. The condition-based readiness primitives
 * this class now delegates to live in `test/helpers/navigation.ts` (also
 * exercised directly by `test/e2e/core-navigation.spec.ts`, which is the
 * suite to prefer for new browser-level coverage); this class is kept
 * working for any existing caller rather than deleted outright.
 */
export class DocumentScreen extends BaseScreen {
  private baseUrl: string;

  constructor(browser: any) {
    super(browser);
    this.baseUrl = `http://localhost:${this.getBackendPort()}`;
  }

  async init(): Promise<void> {
    await super.init();
  }

  /**
   * Create a new Document page inside the given Space, via the real
   * sidebar quick-add affordance (hover the space row to reveal
   * `inline-add-page`, open the type menu, pick `add-document-button`).
   * The previous implementation's selectors (`text=New`,
   * `[role="button"]:has-text("+")`, `.create-page-btn`,
   * `.workspace-outline`) do not correspond to any element this app
   * renders -- confirmed by live DOM inspection -- so it could never
   * have actually created a page.
   *
   * Creating a Document this way opens it in a ViewModal; this method
   * closes that modal and waits for the stable full-page route before
   * returning, using the same condition-based gate the rest of this
   * class relies on.
   */
  async createPage(spaceLabel: string, title?: string): Promise<{ id: string }> {
    console.log(`[DocumentScreen] Creating new Document page in space "${spaceLabel}"...`);

    await hoverSpaceRow(this.page, spaceLabel);
    await this.page.getByTestId('inline-add-page').first().click();
    await this.page.getByTestId('add-document-button').click();
    await this.page.waitForTimeout(600); // short settle for the route/modal to mount; verified below, not relied on alone

    const pageId = await this.getCurrentDocumentId();
    if (!pageId) {
      throw new Error('Could not confirm page creation or extract its id from the URL');
    }

    const readiness = await waitForDocumentReady(this.page, pageId);
    if (!readiness.ok) {
      console.warn(`[DocumentScreen] New page ${pageId} did not reach a fully ready state:`, readiness);
    }

    if (title) {
      const titleInput = this.page.locator(`#editor-title-${pageId}`);
      if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await titleInput.click();
        await titleInput.fill(title);
        console.log(`[DocumentScreen] Set page title to "${title}"`);
      } else {
        console.warn('[DocumentScreen] Could not find title input, proceeding without explicit title');
      }
    }

    console.log(`[DocumentScreen] Created page ${pageId} at ${this.page.url()}`);
    return { id: pageId };
  }

  /**
   * Navigate to a specific document via its real, stable full-page route
   * (`/app/:workspaceId/:pageId` -- confirmed by live DOM inspection, NOT
   * the previously-assumed `/workspace/:id/space/:id/page/:id`, which
   * does not exist in AppFlowy-Web's router), then wait on the
   * condition-based readiness gate (modal closed, propagation toast
   * cleared, editor actually mounted) instead of a fixed timeout/race.
   */
  async navigateToDocument(workspaceId: string, _spaceId: string, docId: string): Promise<void> {
    const url = `${this.frontendBaseUrl()}/app/${workspaceId}/${docId}`;
    console.log(`[DocumentScreen] Navigating to ${url}`);

    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    const readiness = await waitForDocumentReady(this.page, docId);
    if (!readiness.ok) {
      console.warn(`[DocumentScreen] Document ${docId} did not reach a ready state:`, readiness);
    }
  }

  /**
   * Get current document ID from URL (real route shape: `/app/:workspaceId/:pageId`).
   */
  async getCurrentDocumentId(): Promise<string | null> {
    const url = this.page.url();
    const match = url.match(/\/app\/[^/]+\/([^/?]+)/);
    return match ? match[1] : null;
  }

  /**
   * The frontend's own base URL (distinct from `this.baseUrl`, which
   * points at the backend). Falls back to the conventional local dev
   * port if the page hasn't navigated anywhere yet.
   */
  private frontendBaseUrl(): string {
    try {
      const current = new URL(this.page.url());
      if (current.origin && current.origin !== 'null') return current.origin;
    } catch {
      /* page has no URL yet */
    }
    return 'http://localhost:3000';
  }

  /**
   * Type text into the document editor's BODY (not title), scoped to the
   * exact page id so a stale/background editor instance can never be hit
   * by accident. `.ProseMirror` (the previous selector here) does not
   * exist in this app at all -- AppFlowy-Web's editor is Slate-based
   * (`[data-slate-editor="true"]`), confirmed by live DOM inspection.
   */
  async typeText(text: string, clearFirst = true): Promise<void> {
    const pageId = await this.getCurrentDocumentId();
    if (!pageId) throw new Error('typeText: no current document id resolvable from the URL');
    console.log(`[DocumentScreen] Typing into document ${pageId}: "${text}"`);

    if (clearFirst) {
      await typeIntoDocumentBody(this.page, pageId, text);
    } else {
      await clickIntoDocumentBody(this.page, pageId);
      await this.page.keyboard.type(text, { delay: 20 });
    }

    console.log('[DocumentScreen] Finished typing');
  }

  /**
   * Get the current document's BODY content, scoped by exact page id
   * (never a bare `.ProseMirror`/`[contenteditable]` match, which can
   * resolve to the wrong element or nothing at all in this app).
   */
  async getDocumentContent(): Promise<string> {
    const pageId = await this.getCurrentDocumentId();
    if (!pageId) return '';
    return readDocumentBodyWithRetry(this.page, pageId);
  }

  /**
   * Verify text exists in document (retries internally -- content can lag
   * a beat behind an edit/navigation; this is not a blind pass/fail on a
   * single read).
   */
  async verifyTextExists(expected: string): Promise<boolean> {
    const pageId = await this.getCurrentDocumentId();
    if (!pageId) return false;
    const content = await readDocumentBodyWithRetry(this.page, pageId, expected);
    const found = content.includes(expected);

    console.log(`[DocumentScreen] Verification "${expected}" in content? ${found}`);
    return found;
  }

  /**
   * Refresh page and verify persistence (critical test for storage
   * backend). Uses the condition-based readiness gate (modal closed,
   * not-found-toast cleared, editor mounted) after reload instead of a
   * single `.ProseMirror`/"Connecting" race, which never matched this
   * app's real DOM.
   */
  async reloadAndVerify(textToFind: string): Promise<boolean> {
    const pageId = await this.getCurrentDocumentId();
    if (!pageId) {
      console.error('[DocumentScreen] reloadAndVerify: no current document id resolvable from the URL');
      return false;
    }
    console.log(`[DocumentScreen] Reloading to verify persistence of "${textToFind}" on document ${pageId}...`);

    await this.page.reload({ waitUntil: 'domcontentloaded' });
    const readiness = await waitForDocumentReady(this.page, pageId);
    if (!readiness.editorReady) {
      console.error('[DocumentScreen] Editor not available after reload', readiness);
      return false;
    }

    const content = await readDocumentBodyWithRetry(this.page, pageId, textToFind);

    if (content.includes(textToFind)) {
      console.log(`[DocumentScreen] Persistence verified: "${textToFind}" found`);
      return true;
    } else {
      console.error(`[DocumentScreen] Persistence FAILED: Expected to find "${textToFind}", got: ${JSON.stringify(content)}`);
      return false;
    }
  }

  /**
   * Check if the realtime connection badge still shows "Connecting".
   */
  async isStillConnecting(): Promise<boolean> {
    const connecting = this.page.getByText('Connecting', { exact: false });
    return await connecting.isVisible().catch(() => false);
  }
}