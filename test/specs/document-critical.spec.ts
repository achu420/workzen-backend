import { test, expect } from '@playwright/test';
import AuthScreen from '../screens/AuthScreen';
import WorkspaceScreen from '../screens/WorkspaceScreen';
import SpaceScreen from '../screens/SpaceScreen';
import DocumentScreen from '../screens/DocumentScreen';

test.describe('CRITICAL: Document Editing and Persistence', () => {
  let auth: AuthScreen;
  let workspace: WorkspaceScreen;
  let space: SpaceScreen;
  let doc: DocumentScreen;
  let browser: any;
  
  let wsId: string | null = null;
  let spaceId: string | null = null;

  test.beforeEach(async ({ page }) => {
    browser = await test.info().browserType.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    
    auth = new AuthScreen(page);
    workspace = new WorkspaceScreen(page);
    space = new SpaceScreen(page);
    doc = new DocumentScreen(page);

    await page.goto(auth.baseUrl);
  });

  test.afterEach(async () => {
    await browser?.close();
  });

  /**
   * CRITICAL BLOCKER TEST: This verifies if text input and persistence work  
   */
  test('should create document, type text, verify persistence after reload', async () => {
    // Setup: Auth and bootstrap  
    const email = `doc-persist-${Date.now()}@test.com`;
    await auth.signup(email, 'Password123!');
    await workspace.waitForWorkspaceReady();

    wsId = await workspace.getCurrentWorkspaceId();
    expect(wsId).toBeTruthy('Workspace should be created');

    // Setup: Space  
    await space.gotoSpaceSelection(wsId!);
    
    try {
      spaceId = await space.selectPublicSpace();
    } catch {
      const res = await space.createSpace(`Doc Test ${Date.now()}`);
      spaceId = res.id;
    }

    expect(spaceId).toBeTruthy('Should be in a space');

    // ACT: Create new page  
    const pageResult = await doc.createPage(`Test Doc ${Date.now()}`);
    console.log(`Created page with ID: ${pageResult.id || 'unknown'}`);

    // Wait for editor to load (may show Connecting)  
    await page.waitForTimeout(3000);

    // Verify editor is visible or at least "Connecting" state appears  
    const hasEditor = await doc.getDocumentContent().then(c => c.length > 0).catch(() => false);
    const isConnected = await doc.isStillConnecting();
    
    console.log(`Editor content length: ${hasEditor}, Connecting state: ${isConnected}`);

    // ACT: Type text  
    const testText = `CRITICAL TEST TEXT - ${Date.now()}\n`;
    
    try {
      await doc.typeText(testText, true); // clear first
      console.log(`Typed text: "${testText}"`);
    } catch (err) {
      console.error('Failed to type:', err);
    }

    // Verify text is visible immediately  
    const contentAfterType = await doc.getDocumentContent();
    expect(contentAfterType.includes(testText)).toBe(true, 'Text should be visible after typing');

    // CRITICAL: Reload and verify persistence  
    console.log('Reloading page to test persistence...');
    const persisted = await doc.reloadAndVerify(testText);
    
    expect(persisted).toBe(true, 
      `CRITICAL BLOCKER: Text "${testText}" should persist after reload but was lost`
    );

  });

  /**
   * Verify WebSocket connection state in document editor  
   */
  test('should establish WebSocket and show connected editor', async () => {
    const email = `doc-ws-${Date.now()}@test.com`;
    
    await auth.signup(email, 'Password123!');
    await workspace.waitForWorkspaceReady();

    wsId = await workspace.getCurrentWorkspaceId()!;
    await space.gotoSpaceSelection(wsId);
    
    try {
      spaceId = await space.selectPublicSpace();
    } catch {
      const res = await space.createSpace(`WS Test ${Date.now()}`);
      spaceId = res.id;
    }

    if (!spaceId) return;

    // Create page  
    await doc.createPage('WebSocket Test');
    
    // Wait for editor  
    await page.waitForTimeout(5000);

    // Check connection state  
    const connectingState = await doc.isStillConnecting();
    
    // Log current URL and debug info  
    console.log(`Current URL: ${page.url()}`);
    
    if (connectingState) {
      console.warn('⚠️ Document shows "Connecting" - WebSocket/collab protocol may be incomplete');
      
      // Wait a bit more to see if it resolves  
      await page.waitForTimeout(10000);
      const stillConnecting = await doc.isStillConnecting();
      
      expect(stillConnecting).toBe(false, 
        'Document stuck in "Connecting" state - WebSocket/collaboration protocol incomplete'
      );
    } else {
      console.log('✅ Editor loaded without Connecting state');
    }

    // Try typing and verify  
    const text = `Connected test: ${Date.now()}`;
    await doc.typeText(text, true);
    
    const content = await doc.getDocumentContent();
    expect(content.includes(text)).toBe(true, 'Should be able to type when connected');
  });

});