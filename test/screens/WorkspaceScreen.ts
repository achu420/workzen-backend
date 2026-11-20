/**
 * Screen for managing Workspaces (navigation, creation, selection)
 */
export class WorkspaceScreen extends BaseScreen {
  private baseUrl: string;

  constructor(browser: any) {
    super(browser);
    this.baseUrl = `http://localhost:${this.getBackendPort()}`;
  }

  async init(): Promise<void> {
    await super.init();
  }

  /**
   * Navigate to workspace  
   */
  async gotoWorkspace(workspaceId: string): Promise<void> {
    console.log(`[WorkspaceScreen] Navigating to /workspace/${workspaceId}`);
    
    const url = `${this.baseUrl}/workspace/${workspaceId}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for workspace content to load or sidebar to appear  
    await Promise.race([
      this.page.locator('[role="list"]').first().waitFor({ state: 'visible', timeout: 5000 }),
      this.page.locator('.workspace-sidebar').waitFor({ state: 'visible', timeout: 5000 }),  
      this.page.locator('text=Connecting').waitFor({ timeout: 5000 }).catch(() => {
        console.log('[WorkspaceScreen] Detected Connecting/loading state');
      })
    ]);
  }

  /**
   * Get current workspace ID from URL  
   */
  async getCurrentWorkspaceId(): Promise<string | null> {
    const url = this.page.url();
    const match = url.match(/\/workspace\/([^/]+)/);
    return match ? match[1] : null;
  }

  /**
   * Verify we are in the expected workspace  
   */
  async verifyWorkspace(workspaceId: string): Promise<boolean> {
    const current = await this.getCurrentWorkspaceId();
    const matches = current === workspaceId;
    
    console.log(`[WorkspaceScreen] Workspace check: ${current} == ${workspaceId} ? ${matches}`);
    return matches;
  }

  /**
   * Create a new workspace (if UI supports it)  
   */
  async createNewWorkspace(name?: string): Promise<{ id: string }> {
    console.log(`[WorkspaceScreen] Attempting to create workspace "${name || 'Untitled'}"`);
    
    // Look for "Create Workspace" or "+" button in sidebar or modal  
    const createBtn = this.page.locator('text=Create').first()
      .or(this.page.locator('[role="button"]:has-text("+")'))
      .or(this.page.locator('[aria-label*="create workspace" i]'))
      .first();

    if (!(await createBtn.isVisible({ timeout: 3000 }))) {
      console.log('[WorkspaceScreen] No create button found, assuming workspace exists or auto-created');
      return { id: 'unknown' };
    }

    await createBtn.click();

    // Fill name field if provided  
    const nameInput = this.page.locator('input[placeholder*="name" i]').first()
      .or(this.page.locator('input[name="name"]'))
      .first();

    if (await nameInput.isVisible()) {
      await nameInput.fill(name || 'Test Workspace');
    }

    // Confirm/Submit  
    const confirmBtn = this.page.locator('text=Create').first()
      .or(this.page.locator('[type="submit"]'))
      .first();

    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // Extract new workspace ID from URL  
    const url = this.page.url();
    const match = url.match(/\/workspace\/([^/]+)/);
    const id = match ? match[1] : 'unknown';

    console.log(`[WorkspaceScreen] Created workspace ${id}`);
    return { id };
  }

}

export default WorkspaceScreen;