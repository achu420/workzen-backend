import { Page, expect } from '@playwright/test';
import BaseScreen from './BaseScreen';

/**
 * Screen for managing Pages/Documents (creation, editing, persistence)
 */
export class PageScreen extends BaseScreen {
  private baseUrl: string;

  constructor(browser: any) {
    super(browser);
    this.baseUrl = `http://localhost:${this.getBackendPort()}`;
  }

  async init(): Promise<void> {
    await super.init();
  }

  /**
   * Navigate to space where page creation happens  
   */
  async gotoSpace(spaceId: string, workspaceId?: string): Promise<void> {
    if (workspaceId) {
      console.log(`[PageScreen] Navigating to /workspace/${workspaceId}/space/${spaceId}`);
      await this.page.goto(`${this.baseUrl}/workspace/${workspaceId}/space/${spaceId}`, { waitUntil: 'domcontentloaded' });
    } else {
      // If already in workspace, just navigate to space part  
      const currentUrl = this.page.url();
      if (currentUrl.includes('/workspace/')) {
        console.log(`[PageScreen] Navigating within workspace to space ${spaceId}`);
        await this.page.goto(`${this.baseUrl}/${currentUrl.split('/workspace')[1]}${'/space/' + spaceId}`, { waitUntil: 'domcontentloaded' });
      } else {
        throw new Error('Cannot navigate to space without workspace context');
      }
    }

    // Wait for page list or editor to load (avoid "Connecting" state if possible)  
    await this.waitForPageContentOrConnection();
  }

  /**
   * Wait until either content is visible or we're stuck in Connecting state
   */
  async waitForPageContentOrConnection(): Promise<void> {
    const timeout = 10000;
    
    // Check if there's a page list/grid or editor loaded  
    await Promise.race([
      this.page.locator('[role="list"]').or(this.page.locator('.content-editable')).or(
        this.page.locator('text=New Page').first()
      ).waitFor({ state: 'visible', timeout }),
      
      // If stuck on Connecting, capture that state  
      this.page.locator('text=Connecting').waitFor({ timeout }).then(() => {
        console.log('[PageScreen] Detected "Connecting" loading state');
      })
    ]).catch(() => {});
  }

  /**
   * Create a new page/document in the current space
   */
  async createNewPage(title?: string): Promise<{ id: string }> {
    console.log(`[PageScreen] Creating new page ${title ? `with title "${title}"` : ''}`);
    
    // Look for "Create" button, "+" icon, or "New Page" text  
    const createBtn = this.page.locator('text=Create').first()
      .or(this.page.locator('[role="button"]:has-text("+")'))
      .or(this.page.locator('[aria-label*="new page" i]'))
      .or(this.page.locator('text=New Page'))
      .first();

    if (!(await createBtn.isVisible({ timeout: 3000 }))) {
      const debug = await this.getDebugInfo();
      throw new Error(`Cannot find Create/New Page button. Debug info: ${debug}`);
    }
    
    console.log('[PageScreen] Clicking Create button...');  
    await createBtn.click();

    // Wait for editor to become active (content editable or specific container)
    const editor = await this.waitForEditorVisible({ timeout: 15000 });
    
    if (!editor) {
      throw new Error('Editor did not appear after creating page');
    }

    console.log('[PageScreen] Editor is visible, entering title...');
    
    // If title provided, fill it in  
    if (title) {
      await editor.fill(title);
      
      // Move to body content area if separate from title input
      const bodyArea = this.page.locator('.content-editable').first().or(
        this.page.locator('[data-block-id]').first()
      );
      
      if (await bodyArea.isVisible()) {
        console.log('[PageScreen] Moving focus to document body...');  
        await bodyArea.focus();
        
        // Send Enter key or click into body area  
        if (!editor.locator(bodyArea.selector).count()) {
          await bodyArea.click({ position: { x: 10, y: 10 } });
        }
      }
    }

    // Extract page ID from URL (should be /workspace/:id/space/:spaceId/page/:pageId or similar)  
    const url = this.page.url();
    
    // Try multiple patterns for AppFlowy routing  
    let match: RegExpMatchArray | null = null;
    const patterns = [
      /\/workspace\/[^/]+\/space\/[^/]+\/page\/([^?]+)/,  // standard pattern
      /\/workspace\/[^/]+\/space\/[^/]+\/pages\/([^?]+)/,  
      /\/workspace\/[^/]+\/space\/([a-zA-Z0-9_-]+)/       // fallback: space ID as page context
    ];

    for (const pattern of patterns) {
      match = url.match(pattern);
      if (match && match[1]) break;
    }

    const id = match ? match[1] : 'unknown';
    console.log(`[PageScreen] Created page with ID ${id}, URL: ${url}`);
    
    return { id };
  }

  /**
   * Wait for editor to be visible (handles various editor implementations)  
   */
  async waitForEditorVisible(options?: { timeout?: number }): Promise<Locator | null> {
    const timeout = options?.timeout || 10000;
    
    // Try multiple selectors that might represent the rich text editor  
    const candidates = [
      this.page.locator('[contenteditable="true"]').first(),
      this.page.locator('.content-editable').first(),
      this.page.locator('.editor-content').first(),  
      this.page.locator('.Slate-editor').first(),  // Slate.js based
      this.page.locator('[data-block-id]').first(), // AppFlowy block editor
      this.page.locator('div[role="textbox"]').first()
    ];

    for (const candidate of candidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout });  
        console.log(`[PageScreen] Found editor with selector: ${candidate.selector}`);
        return candidate;
      } catch (e) {
        // Try next candidate
      }
    }

    console.error('[PageScreen] No editor found after waiting');
    const debug = await this.getDebugInfo();
    throw new Error(`No contenteditable or editor element found. Debug: ${debug}`);
  }

  /**
   * Type text into the current document (editor)  
   */
  async typeInEditor(text: string, position?: 'start' | 'end'): Promise<void> {
    console.log(`[PageScreen] Typing "${text}" at position ${position || 'current'}...`);
    
    const editor = await this.waitForEditorVisible({ timeout: 5000 });
    if (!editor) throw new Error('No editor visible for typing');

    // Ensure focus is in the editor  
    await editor.click();
    
    // Clear existing content if position is start (optional, depends on use case)
    if (position === 'start') {
      await this.page.keyboard.press('Control+A');  // Select all
      await this.page.keyboard.press('Backspace');
    } else if (position === 'end') {
      await this.page.keyboard.press('End');
    }


  /**
   * Verify document content exists  
   */
  async verifyContentExists(expectedText?: string): Promise<boolean> {
    const editor = await this.waitForEditorVisible({ timeout: 5000 });
    
    if (expectedText) {
      // Check for specific text content  
      const found = await this.page.locator(`text=${expectedText}`).isVisible();
      console.log(`[PageScreen] Content check "${expectedText}": ${found ? 'FOUND' : 'NOT FOUND'}`);
      return found;
    } else {
      // Just check if editor has any content  
      const text = await editor.textContent();
      return text && text.length > 0;
    }
  }

  /**
   * Check if document is stuck in "Connecting" state or empty (unloaded)
   */
  async isConnecting(): Promise<boolean> {
    // Look for loading indicators or "Connecting..." text  
    const connectingText = await this.page.locator('text=Connecting').count();
    
    if (connectingText > 0) {
      console.log('[PageScreen] Document is in Connecting state');
      return true;
    }

    // Check for empty contentEditable which might indicate unconnected state  
    const editor = await this.waitForEditorVisible({ timeout: 2000 }).catch(() => null);
    
    if (editor) {
      const text = await editor.textContent();
      if (!text || text.trim() === '') {
        console.log('[PageScreen] Editor visible but empty (may be unconnected or not loaded)');
        return true;  // Conservative: consider empty as not connected  
      }
    }

    return false;
  }

  /**
   * Reload page and verify content persists (test for durability against backend)  

  /**
   * Get current page ID from URL  
   */
  async getCurrentPageId(): Promise<string | null> {
    const url = this.page.url();
    
    // AppFlowy patterns: /workspace/:id/space/:spaceId/page/:pageId or just space context
    const match1 = url.match(/\/workspace\/[^/]+\/space\/[^/]+\/page\/([^?]+)/);
    const match2 = url.match(/\/workspace\/[^/]+\/space\/([a-zA-Z0-9_-]+)/);  // Space ID fallback
    
    return match1 ? match1[1] : (match2 ? match2[1] : null);
  }

  /**
   * Get debug info about editor state  
   */
  async getEditorDebugInfo(): Promise<string> {
    const html = await this.page.locator('[contenteditable="true"]').first().innerHTML();
    
    return JSON.stringify({
      url: this.page.url(),
      contentEditableHTML: html.substring(0, 1000),  // Truncate large HTML  
      localStorageKeys: Object.keys(localStorage)
    });
  }

  /**
   * Generic debug info for troubleshooting  
   */
  async getDebugInfo(): Promise<string> {
    const editorContent = await this.page.locator('[contenteditable="true"]').first().textContent();
    
    return JSON.stringify({
      title: document.title,
      url: window.location.href,  
      pathname: window.location.pathname,
      localStorageKeys: Object.keys(localStorage),
      visibleHeadings: Array.from(document.querySelectorAll('h1, h2')).map(el => el.textContent?.trim()).filter(Boolean),
      editorContentPreview: (editorContent || '').substring(0, 500)
    });
  }

}

export default PageScreen;
   */
  async reloadAndVerifyPersistence(expectedContent: string): Promise<boolean> {
    console.log(`[PageScreen] Reloading page to test persistence of "${expectedContent}"...`);
    
    const url = this.page.url();
    await this.page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for editor to reload  
    await this.waitForEditorVisible({ timeout: 15000 });
    
    console.log(`[PageScreen] Checking if "${expectedContent}" persists...`);
    
    const exists = await this.verifyContentExists(expectedContent);
    
    if (exists) {
      console.log('[PageScreen] Content persisted successfully after reload');
    } else {
      console.error('[PageScreen] Content LOST on reload!');  
      const debug = await this.getDebugInfo();
      throw new Error(`Persistence check failed: "${expectedContent}" not found after reload. Debug: ${debug}`);
    }

    return exists;
  }
    // Type the text with some delay between characters to simulate real typing
    await editor.fill(text);  // fill() clears and types, good for controlled tests
    
    console.log(`[PageScreen] Typed: "${text}"`);
  }