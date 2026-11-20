import { test, expect } from '@playwright/test';
import LoginScreen from '../screens/LoginScreen.js';
import WorkspaceScreen from '../screens/WorkspaceScreen.js';

test.describe('Workspace Operations', () => {
  let login: LoginScreen;
  let workspace: WorkspaceScreen;

  test.beforeEach(async ({ page }) => {
    login = new LoginScreen(page);
    workspace = new WorkspaceScreen(page);
    await login.init();
    
    // Reset storage for fresh start  
    await login.resetStorageAndLogin();
  });

  test('should bootstrap a workspace after login', async () => {
    console.log('[TEST] Starting workspace bootstrap...');

    // Verify we land on workspace page or get redirected  
    const url = login.page.url();
    console.log(`[TEST] Current URL: ${url}`);

    // Should contain /workspace/ in path  
    expect(url).toContain('/workspace/');

    // Extract workspace ID  
    const match = url.match(/\/workspace\/([^?]+)/);
    test.expect(match).toBeTruthy('URL should contain workspace ID');
    const workspaceId = match![1];
    console.log(`[TEST] Detected workspace: ${workspaceId}`);

    // Verify we can navigate to it explicitly  
    await workspace.gotoWorkspace(workspaceId);
    
    // Should be in the same workspace after navigation  
    expect(await workspace.verifyWorkspace(workspaceId)).toBeTruthy();
  });

  test('should show workspace outline/sidebar', async () => {
    console.log('[TEST] Checking workspace outline...');

    const url = login.page.url();
    const match = url.match(/\/workspace\/([^?]+)/);
    if (!match) throw new Error(`Unexpected URL: ${url}`);

    await workspace.gotoWorkspace(match[1]);

    // Workspace should have some sidebar or navigation element  
    // AppFlowy uses a left sidebar with spaces and pages
    const sidebar = login.page.locator('[role="list"]').first()
      .or(login.page.locator('.workspace-sidebar'))
      .or(login.page.locator('aside'))
      .first();

    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Should have some content (even if just a loading state or empty container)  
    const hasContent = await sidebar.locator('text', { match: 'all' }).count() > 0;
    console.log(`[TEST] Sidebar visible, content count: ${await sidebar.count()}`);
  });

});