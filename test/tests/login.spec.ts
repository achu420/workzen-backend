import { test, expect } from '@playwright/test';
import LoginScreen from '../screens/LoginScreen';

test.describe('Login Flow (Phase 1)', () => {
  let screen: any;

  test.beforeEach(async ({ browser }) => {
    screen = new LoginScreen(browser);
    await screen.init();
  });

  test.afterEach(async () => {
    if (screen) await screen.cleanup().catch(() => {});
  });

  test('should sign up via browser and navigate to workspace selection', async ({ browser }) => {
    // Arrange: Browser is on login page, backend is running
    
    // Act: Perform signup flow in browser
    const email = `test${Date.now()}@example.com`;
    await screen.signup(email);

    // Assert: Should be at workspace selection screen  
    const visible = await screen.verifyWorkspaceSelectionVisible();
    expect(visible).toBe(true);
    
    // Debug info for troubleshooting  
    console.log('[Test] URL after signup:', screen.page.url());
  });

  test('should login via browser after signup', async ({ browser }) => {
    // Arrange: Create user first (via API to save time, or via separate browser tab)
    const email = `test${Date.now()}@example.com`;
    
    // Use backend manager helper to create user directly  
    await screen.createTestUser();

    // Act: Login with credentials created above
    await screen.login(email);

    // Assert: Should be at workspace selection screen
    const visible = await screen.verifyWorkspaceSelectionVisible();
    expect(visible).toBe(true);
  });

  test('should handle invalid login credentials', async ({ browser }) => {
    // Arrange: Non-existent user
    
    // Act: Try to login with fake email
    try {
      await screen.login(`fake${Date.now()}@example.com`, 'wrongpassword');
      expect.fail('Should have thrown error');
    } catch (e) {
      // Assert: Should fail gracefully
      expect(e.message).toContain('Login failed');
      
      // Should still be on login page or show error message
      const hasError = await screen.page.locator('text=Email or password is incorrect').isVisible();
      expect(hasError).toBe(true);
    }
  });

  test('should select workspace and navigate to main app', async ({ browser }) => {
    // Arrange: Login first
    const email = `test${Date.now()}@example.com`;
    await screen.signup(email);
    
    // Act: Select the "Personal" workspace (first/only one)
    const workspaceId = await screen.selectFirstWorkspace();

    // Assert
    expect(workspaceId).toBeTruthy();
    
    // URL should contain /workspace/:id  
    const url = screen.page.url();
    expect(url).toContain('/workspace/');
  });
});