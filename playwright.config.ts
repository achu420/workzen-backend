import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for AppFlowy Independent Backend Critical Path Tests
 * 
 * This configuration sets up browser automation to verify the critical collaboration
 * protocol implementation: authentication, workspace bootstrap, space creation, and
 * document persistence with Yjs sync.
 */
export default defineConfig({
  // Task 69: real-browser E2E navigation/persistence suite lives here.
  testDir: './test/e2e',
  // Each spec file in this suite manages its own disposable backend +
  // frontend lifecycle (test/helpers/test-environment.ts) and mutates
  // AppFlowy-Web/.env.local for its duration -- running spec FILES in
  // parallel would race on that shared file, so keep worker count at 1.
  // Tests within a single file still each use their own disposable
  // user/space/document.
  workers: 1,
  fullyParallel: false,

  // Timeout settings - AppFlowy has heavy initialization (Yjs, WASM)
  timeout: 120_000,        // 2 minutes per test step
  expect: {
    timeout: 30_000,       // 30 seconds for individual assertions
  },

  // Global setup/teardown not needed - each screen manages its own isolated backend
  
  use: {
    headless: true,        // Run in headless mode by default
    
    // Desktop viewport (standard resolution)  
    viewport: { width: 1920, height: 1080 },

    // Tracing and screenshots for debugging failures
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    
    // Video recording only on failure to save disk space
    video: 'retain-on-failure',
    
    // Screenshot on timeout (helps debug)
    actionTimeout: 10_000,
    
    // Ignore HTTP errors during navigation (we handle auth flows manually)  
    ignoreHTTPSErrors: true,

    // Base URL not set here - AuthScreen sets it to localhost:3000 (AppFlowy-Web default)
  },

  // Run on Chromium only for speed/reliability in CI
  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        headless: true,
      },
    },
  ],

  // Reporter configuration - HTML report + terminal output  
  reporter: [
    ['html', { open: 'never' }], // Don't auto-open in browser
    ['list'],
  ],

  // Web server for AppFlowy-Web (optional - assumes manual start on port 3000)
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:3000',
  //   cwd: '../AppFlowy-Web',
  //   timeout: 60_000,
  // },
});
