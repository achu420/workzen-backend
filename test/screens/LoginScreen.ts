import { Page, expect } from '@playwright/test';
import BaseScreen from './BaseScreen';

export class LoginScreen extends BaseScreen {
  constructor(browser: any) {
    super(browser);
  }

  async init(): Promise<void> {
    await super.init();
    
    const baseUrl = `http://localhost:${this.getBackendPort()}`;
    console.log(`[LoginScreen] Navigating to ${baseUrl}/auth/login`);
    
    await this.page.goto(`${baseUrl}/auth/login`);
    
    // Wait for auth page to load (check for email input)
    await expect(this.page.getByRole('textbox', { name: /email/i })).toBeVisible({ timeout: 10000 });
    console.log('[LoginScreen] Auth page loaded');
  }

  async signup(email?: string, password = 'password123'): Promise<void> {
    const user = email || `test${Date.now()}@example.com`;
    
    // Check if we're on login page and need to switch to signup
    const isSignupTabVisible = await this.page.getByRole('tab', { name: /sign up/i }).isVisible().catch(() => false);
    
    if (!isSignupTabVisible) {
      console.log('[LoginScreen] Switching to Sign Up tab');
      const signupLink = this.page.locator('text=Don\'t have an account?').first();
      if (await signupLink.isVisible()) await signupLink.click();
      else throw new Error('Cannot find sign up option');
    }

    console.log(`[LoginScreen] Signing up user: ${user}`);
    await this.page.fill('[name="email"]', user);
    await this.page.fill('[name="password"]', password);

    const signupBtn = this.page.getByRole('button', { name: /sign up|create/i }).first();
    console.log('[LoginScreen] Submitting sign up form...');
    await signupBtn.click({ timeout: 5000 });

    try {
      await expect(this.page.locator('text=Select a workspace')).toBeVisible({ timeout: 15000 });
      console.log('[LoginScreen] Sign up successful');
    } catch (e) {
      const error = await this.page.locator('text=Email or password is incorrect').first().textContent();
      throw new Error(`Sign up failed: ${error || 'Unknown'}`);
    }
  }

  async login(email?: string, password = 'password123'): Promise<void> {
    const user = email || `test${Date.now()}@example.com`;
    
    // Ensure we are on Login tab (not Sign Up)
    const isLoginTabVisible = await this.page.getByRole('tab', { name: /login|sign in/i }).isVisible().catch(() => false);
    
    if (!isLoginTabVisible) {
      console.log('[LoginScreen] Switching to Login tab');
      const loginLink = this.page.locator('text=Sign in').first();
      if (await loginLink.isVisible()) await loginLink.click();
      else throw new Error('Cannot find login option');
    }

    console.log(`[LoginScreen] Logging in user: ${user}`);
    await this.page.fill('[name="email"]', user);
    await this.page.fill('[name="password"]', password);

    const loginBtn = this.page.getByRole('button', { name: /sign in|login/i }).first();
    console.log('[LoginScreen] Submitting login form...');
    await loginBtn.click({ timeout: 5000 });

    try {
      await expect(this.page.locator('text=Select a workspace')).toBeVisible({ timeout: 15000 });
      console.log('[LoginScreen] Login successful');
    } catch (e) {
      const error = await this.page.locator('text=Email or password is incorrect').first().textContent();
      throw new Error(`Login failed: ${error || 'Unknown'}`);
    }
  }

  async verifyWorkspaceSelectionVisible(): Promise<boolean> {
    return await this.page.locator('text=Select a workspace').isVisible();
  }

  async selectFirstWorkspace(): Promise<string | null> {
    const workspaceCard = this.page.locator('[data-testid="workspace-card"]').first()
      .or(this.page.locator('[role="button"]:has-text("Personal")'))
      .or(this.page.locator('text=Personal'));
    
    if (await workspaceCard.isVisible()) {
      console.log('[LoginScreen] Selecting workspace...');
      await workspaceCard.click();
      
      const url = this.page.url();
      if (url.includes('/workspace/')) {
        console.log(`[LoginScreen] Selected workspace, URL: ${url}`);
        const match = url.match(/\/workspace\/([^/]+)/);
        return match ? match[1] : null;
      }
    }
    
    console.log('[LoginScreen] No workspace card found');
    return null;
  }

  async selectPublicSpace(): Promise<string | null> {
    const publicCard = this.page.locator('[role="button"]:has-text("Public")')
      .or(this.page.locator('text=Public'))
      .first();

    if (await publicCard.isVisible()) {
      console.log('[LoginScreen] Selecting Public space...');
      await publicCard.click();
      
      const url = this.page.url();
      console.log(`[LoginScreen] After space selection: ${url}`);
      
      if (url.includes('/space/')) {
        const match = url.match(/\/space\/([^/]+)/);
        return match ? match[1] : null;
      }
    }
    
    return null;
  }

  async getDebugInfo(): Promise<string> {
    return await this.page.evaluate(() => JSON.stringify({
      title: document.title,
      url: window.location.href,
      localStorageKeys: Object.keys(localStorage),
      html: document.body.innerHTML.substring(0, 2000)
    }));
  }

  async createTestUser(email?: string, password = 'password123'): Promise<{email: string}> {
    const user = email || `test${Date.now()}@example.com`;
    
    // Call backend /token endpoint directly via Node.js fetch (Node 18+)
    try {
      const res = await fetch(`http://localhost:${this.getBackendPort()}/token`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email: user, password})
      });
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to create user via API: ${text}`);
      }
    } catch (e) {
      throw new Error(`HTTP request failed: ${e.message}`);
    }
    
    return { email: user };
  }


}

export default LoginScreen;