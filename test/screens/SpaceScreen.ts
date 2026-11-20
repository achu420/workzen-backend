import { Page, expect } from '@playwright/test';
import BaseScreen from './BaseScreen';

export class SpaceScreen extends BaseScreen {
  private baseUrl: string;

  constructor(browser: any) {
    super(browser);
    this.baseUrl = `http://localhost:${this.getBackendPort()}`;
  }

  async init(): Promise<void> {
    await super.init();
    // No specific initialization needed, we navigate as needed
  }

  /**
   * Navigate to space selection page for a workspace
   */
  async gotoSpaceSelection(workspaceId: string): Promise<void> {
    const url = `${this.baseUrl}/workspace/${workspaceId}`;
    console.log(`[SpaceScreen] Navigating to ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    
    // Wait for space selection UI (should see "Public" or workspace outline)
    const hasWorkspaceOutline = await this.page.locator('text=Select a space').isVisible().catch(() => false);
    if (!hasWorkspaceOutline) {
      console.log('[SpaceScreen] Workspace loaded, checking for Public space...');
    }
  }

  /**
   * Select an existing space by name (e.g., "Public")
   */
  async selectExistingSpace(spaceName: string): Promise<string | null> {
    console.log(`[SpaceScreen] Looking for space "${spaceName}"...`);
    
    // Look for button or link with the space name
    const spaceElement = this.page.locator(`text=${spaceName}`).first();
    
    if (await spaceElement.isVisible()) {
      console.log(`[SpaceScreen] Found space "${spaceName}", clicking...`);
      await spaceElement.click();
      
      // Wait for navigation to /workspace/:id/space/:spaceId or similar
      await this.page.waitForURL(/\/workspace\/[^/]+\/space\/([^/]+)/, { timeout: 5000 });
      
      const url = this.page.url();
      const match = url.match(/\/workspace\/([^/]+)\/space\/([^/]+)/);
      if (match && match[2]) {
        console.log(`[SpaceScreen] Selected space ${match[2]} in workspace ${match[1]}`);
        return match[2];
      }
    } else {
      console.error(`[SpaceScreen] Space "${spaceName}" not found`);
      throw new Error(`Space "${spaceName}" not visible on page`);
    }
    
    return null;
  }

  /**
   * Select Public space specifically (handles different UI patterns)
   */
  async selectPublicSpace(): Promise<string | null> {
    // Try various selectors for Public space button/card
    const publicBtn = this.page.locator('[role="button"]:has-text("Public")').first();
    
    if (await publicBtn.isVisible()) {
      console.log('[SpaceScreen] Clicking Public space...');
      await publicBtn.click();
      
      // Wait for URL change to indicate space selection
      await this.page.waitForURL(/\/space\/[^/]+/, { timeout: 5000 });
      
      const url = this.page.url();
      const match = url.match(/\/workspace\/([^/]+)\/space\/([a-zA-Z0-9_-]+)/);
      return match ? match[2] : null;
    }
    
    throw new Error('Public space button not found');
  }

  /**
   * Create a new space in the current workspace
   */
  async createSpace(name: string, color?: string): Promise<{ id: string }> {
    console.log(`[SpaceScreen] Creating space "${name}"`);
    
    // Look for "Create" or "+" button near "Select a space" heading
    const createBtn = this.page.locator('text=Create').first()
      .or(this.page.locator('[role="button"]:has-text("+")'))
      .first();
    
    if (!(await createBtn.isVisible())) {
      throw new Error('Cannot find Create button for new space');
    }
    
    await createBtn.click();
    
    // Wait for dialog or form to appear
    const input = this.page.locator('[placeholder*="name" i]').first();
    if (!(await input.isVisible({ timeout: 3000 }))) {
      throw new Error('Space creation form not visible');
    }
    
    await input.fill(name);
    
    // Submit the form (look for Create button or Enter key)
    const submitBtn = this.page.locator('[role="button"]:has-text("Create")').first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
    } else {
      throw new Error('Submit/Create button not found in space creation dialog');
    }
    
    // Wait for navigation to the new space
    await this.page.waitForURL(/\/workspace\/[^/]+\/space\/([^/]+)/, { timeout: 10000 });
    
    const url = this.page.url();
    const match = url.match(/\/workspace\/([^/]+)\/space\/([a-zA-Z0-9_-]+)/);
    
    if (!match || !match[2]) {
      throw new Error(`Failed to parse space ID from URL: ${url}`);
    }
    
    console.log(`[SpaceScreen] Created and navigated to space ${match[2]} (${name})`);
    return { id: match[2] };
  }

  /**
   * Get current space ID from URL
   */
  async getCurrentSpaceId(): Promise<string | null> {
    const url = this.page.url();
    const match = url.match(/\/workspace\/[^/]+\/space\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Verify we are in a space (not at workspace root)
   */
  async verifyInSpace(): Promise<boolean> {
    const url = this.page.url();
    return url.includes('/workspace/') && url.includes('/space/');
  }

  /**
   * Get debug info about current page state  
   */
  async getDebugInfo(): Promise<string> {
    return await this.page.evaluate(() => JSON.stringify({
      title: document.title,
      url: window.location.href,
      pathname: window.location.pathname,
      localStorageKeys: Object.keys(localStorage),
      visibleText: Array.from(document.querySelectorAll('h1, h2, button')).map(el => el.textContent?.trim()).filter(Boolean)
    }));
  }
}

export default SpaceScreen;