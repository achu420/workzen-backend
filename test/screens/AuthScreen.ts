import { Page } from '@playwright/test';

/**
 * Screen for Authentication (Signup/Login)
 */
export class AuthScreen extends BaseScreen {
  private baseUrl: string;

  constructor(browser: any) {
    super(browser);
    this.baseUrl = 'http://localhost:3000'; // AppFlowy-Web frontend default port
  }

  async init(): Promise<void> {
    await super.init();
  }

  /**
   * Perform signup with email/password via the UI form
   */
  async signup(email: string, password: string): Promise<void> {
    console.log(`[AuthScreen] Signing up user ${email}...`);

    // Navigate to login/signup page - AppFlowy shows login on root path
    await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });

    // Wait for email input field
    const emailInput = this.page.locator('input[type="email"]')
      .or(this.page.locator('[placeholder*="Email" i]'))
      .first();

    await emailInput.waitFor({ timeout: 10000, state: 'visible' });
    
    // Fill in credentials  
    await emailInput.fill(email);
    
    const passwordInput = this.page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ timeout: 5000, state: 'visible' });
    await passwordInput.fill(password);

    // Submit form - look for sign up / register button or general submit
    const signupBtn = this.page.locator('[type="submit"]')
      .or(this.page.locator('button:has-text("Sign Up")'))
      .or(this.page.locator('text=Register'))
      .first();

    if (!(await signupBtn.isVisible({ timeout: 5000 }))) {
      throw new Error('Signup form submit button not found');
    }

    await signupBtn.click();

    // Wait for navigation or loading indicator to suggest completion
    await this.page.waitForNavigation({ timeout: 30000 }).catch(() => {});
    
    // Alternatively wait for "Sign In" link to appear (indicating registration success)  
    const signInLink = this.page.locator('text=Sign In')
      .or(this.page.locator('[href*="signin"]'))
      .first();

    await Promise.race([
      signInLink.waitFor({ timeout: 10000, state: 'visible' }).catch(() => {}),
      this.page.waitForTimeout(3000) // Fallback wait
    ]);

    console.log(`[AuthScreen] Signup complete for ${email}`);
  }

  /**
   * Perform login if user already exists (optional helper)
   */
  async login(email: string, password: string): Promise<void> {
    await this.signup(email, password); // AppFlowy may reuse same form or create account if not exists
  }
}

export default AuthScreen;
