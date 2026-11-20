import { Page, Browser } from '@playwright/test';
import BackendManager from '../helpers/backend-manager';

export class BaseScreen {
  protected browser: Browser;
  protected page: Page;
  protected backendInstance: any = null;
  
  constructor(browser: Browser) {
    this.browser = browser;
  }

  async init(): Promise<void> {
    // Start isolated backend
    console.log('[BaseScreen] Starting test backend...');
    this.backendInstance = await BackendManager.start();
    
    // Create new page with custom headers to talk to our isolated backend
    this.page = await this.browser.newPage();
    
    // Add request interception to rewrite all API calls to our test backend port
    await this.page.route('**/*', async (route, request) => {
      const url = request.url();
      if (url.startsWith(this.page.viewport()?.width ? 'http' : 'http')) {
        // Replace localhost:3000 or any other port with our test backend port
        const newUrl = url.replace(/localhost:\d+|127\.0\.0\.1:\d+/g, `localhost:${this.backendInstance.port}`);
        await route.continue({ url: newUrl });
      } else {
        await route.continue();
      }
    });

    console.log(`[BaseScreen] Test backend running on port ${this.backendInstance.port}`);
  }

  async cleanup(): Promise<void> {
    if (this.page) await this.page.close().catch(() => {});
    if (this.backendInstance) BackendManager.stop(this.backendInstance);
  }

  getBackendPort(): number {
    return this.backendInstance?.port || 45300;
  }

  getDataFile(): string {
    return this.backendInstance?.dataFile || '/tmp/test.json';
  }

  // Helper: Make API call directly to backend (bypassing frontend)
  async apiRequest(path: string, options?: RequestInit): Promise<any> {
    const port = this.getBackendPort();
    const resp = await fetch(`http://localhost:${port}${path}`, { 
      ...options, 
      headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } 
    });
    
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }
    
    return resp.json().catch(() => ({}));
  }

  // Helper: Create test user via API
  async createTestUser(password = 'password123'): Promise<{ userId: string; accessToken: string }> {
    const port = this.getBackendPort();
    const email = `test${Date.now()}@example.com`;
    
    const resp = await fetch(`http://localhost:${port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username: email, password })
    });

    if (!resp.ok) throw new Error('User creation failed');
    const data = await resp.json();
    
    // Verify token to get user ID
    const profileResp = await fetch(`http://localhost:${port}/api/user/verify/${data.access_token}`);
    const profileData = await profileResp.json();
    
    return { userId: profileData.data.user_id, accessToken: data.access_token };
  }

  // Helper: Create public space via API
  async createPublicSpace(accessToken: string, workspaceId: string): Promise<{ viewId: string }> {
    const port = this.getBackendPort();
    const resp = await fetch(`http://localhost:${port}/api/workspace/${workspaceId}/spaces`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}` 
      },
      body: JSON.stringify({ name: "Public Space", icon: "folder", permissions: [{id:"owner"}] })
    });

    if (!resp.ok) throw new Error('Space creation failed');
    return (await resp.json()).data;
  }

  // Helper: Create document via API  
  async createDocument(accessToken: string, workspaceId: string): Promise<{ viewId: string }> {
    const port = this.getBackendPort();
    const resp = await fetch(`http://localhost:${port}/api/workspace/${workspaceId}/v2/page-view/document/default`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}` 
      },
      body: JSON.stringify({})
    });

    if (!resp.ok) throw new Error('Document creation failed');
    return (await resp.json()).data;
  }

  // Helper: Check persistence in JSON file
  async verifyPersistence(): Promise<boolean> {
    const state = BackendManager.getStorageState(this.getDataFile());
    console.log('[BaseScreen] Storage keys:', Object.keys(state));
    
    // Check if any pages exist (indicates document was created/persisted)
    return !!(state.pages && Object.keys(state.pages).length > 0);
  }

  async navigateTo(path: string): Promise<void> {
    await this.page.goto(`${this.browser.context().browserName() === 'chromium' ? '' : ''}${path}`);
  }
}

export default BaseScreen;