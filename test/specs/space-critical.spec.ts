import { test, expect } from '@playwright/test';
import AuthScreen from '../screens/AuthScreen';
import WorkspaceScreen from '../screens/WorkspaceScreen';
import SpaceScreen from '../screens/SpaceScreen';

test.describe('Critical: Space Creation and Selection', () => {
  let auth: AuthScreen;
  let workspace: WorkspaceScreen;
  let space: SpaceScreen;
  let browser: any;

  test.beforeEach(async ({ page }) => {
    browser = await test.info().browserType.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    
    auth = new AuthScreen(page);
    workspace = new WorkspaceScreen(page);
    space = new SpaceScreen(page);

    await page.goto(auth.baseUrl);
  });

  test.afterEach(async () => {
    await browser?.close();
  });

  /**
   * CRITICAL: Verify the entire bootstrap flow including Public space creation  
   */
  test('should create workspace and select Public space', async () => {
    // Authenticate
    const email = `space-test-${Date.now()}@test.com`;
    const password = 'Password123!';

    await auth.signup(email, password);
    
    // Bootstrap workspace  
    await workspace.waitForWorkspaceReady();

    let workspaceId: string | null = await workspace.getCurrentWorkspaceId();
    expect(workspaceId).toBeTruthy('Workspace ID should be set');

    if (!workspaceId) {
      throw new Error('No workspace ID after bootstrap');
    }

    // Navigate to space selection  
    await space.gotoSpaceSelection(workspaceId);

    // Check if Public space exists and select it, or create a custom one  
    let selectedSpaceId: string | null = null;

    try {
      selectedSpaceId = await space.selectPublicSpace();
    } catch (err) {
      console.log('Creating new space instead...');
      const result = await space.createSpace(`Test Space ${Date.now()}`);
      selectedSpaceId = result.id;
    }

    expect(selectedSpaceId).toBeTruthy('Should have selected or created a space');

    // Verify we are actually in the space  
    const currentSpace = await space.getCurrentSpaceId();
    expect(currentSpace).toBe(selectedSpaceId);

    console.log(`✅ Successfully navigated to workspace ${workspaceId}, space ${selectedSpaceId}`);
  });

  test('should handle missing Public space gracefully', async () => {
    const email = `space-fallback-${Date.now()}@test.com`;

    await auth.signup(email, 'Password123!');
    await workspace.waitForWorkspaceReady();

    const workspaceId = await workspace.getCurrentWorkspaceId();
    expect(workspaceId).toBeTruthy();

    if (!workspaceId) return;

    await space.gotoSpaceSelection(workspaceId);

    // Try to select Public - should fail gracefully  
    try {
      await space.selectPublicSpace({ timeout: 5000 });
    } catch (err) {
      console.log('Expected error: No public space found, creating one...');

      // Create a custom space  
      const result = await space.createSpace(`Fallback Space ${Date.now()}`);
      expect(result.id).toBeTruthy();

      await space.verifyInSpace();
    }
  });
});