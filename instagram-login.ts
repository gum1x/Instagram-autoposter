import puppeteer from 'puppeteer-extra';
// Stealth to reduce bot detection
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createLogger } from './utils.js';
import { promises as fs } from 'fs';
import path from 'path';

const log = createLogger('instagram-login');
puppeteer.use(StealthPlugin());

export interface LoginCredentials {
  username: string;
  password: string;
  twoFactorCode?: string;
}

export interface LoginResult {
  success: boolean;
  cookies?: any[];
  error?: string;
  needs2FA?: boolean;
}

// Helper: apply cookies to a page (used for session reuse)
export async function applyCookiesToPage(page: any, cookies: any[]): Promise<void> {
  if (!cookies || cookies.length === 0) return;
  try {
    await page.setCookie(...cookies);
  } catch (err) {
    log.error('Failed to apply cookies to page', { err });
  }
}

// Helper: check if we appear logged in
export async function isLoggedIn(page: any): Promise<boolean> {
  try {
    // Instagram often redirects to / if logged; presence of the profile/menu button is a signal
    await page.waitForSelector('a[href*="/accounts/"]', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function loginToInstagram(credentials: LoginCredentials): Promise<LoginResult> {
  return new Promise(async (resolve) => {
    try {
      log.info('Starting Instagram login process', { username: credentials.username });
      
      let browser;
      try {
        // Try headless first, fallback to non-headless for local development
        const isHeadless = process.env.HEADLESS !== 'false';
        log.info('Launching browser', { headless: isHeadless });
        
        browser = await puppeteer.launch({
          headless: isHeadless,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-field-trial-config',
            '--disable-back-forward-cache',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off',
            '--max_old_space_size=4096',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--disable-logging',
            '--disable-permissions-api',
            '--disable-presentation-api',
            '--disable-speech-api',
            '--disable-file-system',
            '--disable-notifications'
          ],
          timeout: 30000,
          protocolTimeout: 30000
        });
        log.info('Browser launched successfully');
      } catch (browserError) {
        log.error('Browser launch failed:', browserError);
        resolve({ success: false, error: `Browser launch failed: ${browserError.message}` });
        return;
      }

      const page = await browser.newPage();
      // Realistic UA + languages to reduce friction
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      await page.setViewport({ width: 1280, height: 900 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      // Navigate to Instagram login page
      log.info('Navigating to Instagram login page');
      try {
        // Try multiple Instagram URLs
        const urls = [
          'https://www.instagram.com/accounts/login/',
          'https://instagram.com/accounts/login/',
          'https://www.instagram.com/'
        ];
        
        let navigationSuccess = false;
        for (const url of urls) {
          try {
            log.info(`Trying URL: ${url}`);
            await page.goto(url, { 
              waitUntil: 'networkidle2',
              timeout: 30000 
            });
            navigationSuccess = true;
            log.info(`Successfully navigated to: ${url}`);
            break;
          } catch (urlError) {
            log.warn(`Failed to navigate to ${url}:`, urlError.message);
            continue;
          }
        }
        
        if (!navigationSuccess) {
          throw new Error('Failed to navigate to any Instagram URL. Check your network connection.');
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Handle cookie/consent banner if present
        try {
          const consentBtnSelectors = [
            'button:has-text("Allow essential and optional cookies")',
            'button:has-text("Only allow essential cookies")',
            'button:has-text("Accept all")',
          ];
          for (const sel of consentBtnSelectors) {
            const btn = await page.$(sel as any);
            if (btn) {
              await btn.click();
              await page.waitForTimeout(500);
              break;
            }
          }
        } catch {}
      } catch (navError) {
        log.error('Navigation failed:', navError);
        await browser.close();
        resolve({ success: false, error: `Navigation failed: ${navError.message}. Please check your network connection and try again.` });
        return;
      }

      // Fill username
      log.info('Filling username');
      try {
        await page.waitForSelector('input[name="username"]', { timeout: 15000 });
        await page.click('input[name="username"]'); // Click to focus
        await page.type('input[name="username"]', credentials.username, { delay: 100 });
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.info('Username filled successfully');
      } catch (error) {
        log.error('Failed to fill username:', error);
        await browser.close();
        resolve({ success: false, error: 'Failed to fill username field' });
        return;
      }

      // Fill password
      log.info('Filling password');
      try {
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.click('input[name="password"]'); // Click to focus
        await page.type('input[name="password"]', credentials.password, { delay: 100 });
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.info('Password filled successfully');
      } catch (error) {
        log.error('Failed to fill password:', error);
        await browser.close();
        resolve({ success: false, error: 'Failed to fill password field' });
        return;
      }

      // Click login button
      log.info('Clicking login button');
      try {
        // The submit button can be multiple in DOM; ensure we click the visible one
        await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
        const submitButtons = await page.$$('button[type="submit"]');
        if (submitButtons.length > 0) {
          await submitButtons[0].click();
        } else {
          await page.click('button[type="submit"]');
        }
        log.info('Login button clicked');
        
        // Wait longer for the page to process
        await new Promise(resolve => setTimeout(resolve, 7000));
        
        // Check for any error messages
        const errorElement = await page.$('[role="alert"]');
        if (errorElement) {
          const errorText = await page.evaluate(el => el.textContent, errorElement);
          log.error('Login error detected:', errorText);
          await browser.close();
          resolve({ success: false, error: errorText || 'Login failed - invalid credentials' });
          return;
        }
        
        // Check for CAPTCHA
        const captchaElement = await page.$('iframe[src*="recaptcha"]');
        if (captchaElement) {
          log.error('CAPTCHA detected');
          await browser.close();
          resolve({ success: false, error: 'CAPTCHA required - please try again later' });
          return;
        }
        
      } catch (error) {
        log.error('Failed to click login button:', error);
        await browser.close();
        resolve({ success: false, error: 'Failed to click login button' });
        return;
      }

      // Check if we need 2FA (include multi-input OTP variants)
      const twoFactorSelectors = [
        'input[name="verificationCode"]',
        'input[aria-label="Security code"]',
        'input[name="code"]',
        'input[autocomplete="one-time-code"]',
        'input[type="tel"][inputmode="numeric"]',
        'input[name="otp"]'
      ];
      let twoFactorSelector: string | null = null;
      for (const sel of twoFactorSelectors) {
        if (await page.$(sel)) { twoFactorSelector = sel; break; }
      }
      const multiOtpSelectors = [
        'input[data-testid="verification-code-input"] input',
        'div[role="dialog"] input[type="text"][maxlength="1"]',
        'input[name^="digit"]',
        'input[aria-label="digit"]'
      ];
      let multiOtpNodes: any[] = [];
      for (const sel of multiOtpSelectors) {
        const nodes = await page.$$(sel);
        if (nodes && nodes.length >= 4) { multiOtpNodes = nodes; break; }
      }
      const twoFactorExists = !!twoFactorSelector || multiOtpNodes.length > 0;
      
      if (twoFactorExists) {
        log.info('2FA required');
        
        if (credentials.twoFactorCode) {
          log.info('Using provided 2FA code');
          // Prefer a fast method if the UI asks (auth app or SMS)
          try {
            const methodButtons = [
              'button:has-text("Authentication app")',
              'button:has-text("Use authentication app")',
              'button:has-text("Text message")',
              'button:has-text("Send code")',
              'div[role="dialog"] button:has-text("Authentication app")',
              'div[role="dialog"] button:has-text("Text message")'
            ];
            for (const sel of methodButtons) {
              const btn = await page.$(sel as any);
              if (btn) { await btn.click(); await page.waitForTimeout(300); break; }
            }
          } catch {}
          const code = credentials.twoFactorCode.replace(/\s+/g, '').trim();
          if (multiOtpNodes.length > 0 && code.length >= multiOtpNodes.length) {
            for (let i = 0; i < multiOtpNodes.length && i < code.length; i++) {
              try { await multiOtpNodes[i].focus(); } catch {}
              await multiOtpNodes[i].type(code[i], { delay: 0 });
            }
          } else if (twoFactorSelector) {
            await page.focus(twoFactorSelector);
            await page.type(twoFactorSelector, code, { delay: 0 });
          }
          try { await page.keyboard.press('Enter'); } catch {}
          await new Promise(resolve => setTimeout(resolve, 1200));
          const submitButton = await page.$('button[type="submit"]');
          if (submitButton) {
            await submitButton.click();
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 6000 }).catch(() => {}),
              page.waitForTimeout(1200)
            ]);
          }

          // Do not auto-click other actions here; let IG process the code
        } else {
          log.info('2FA code required but not provided');
          await browser.close();
          resolve({ success: false, needs2FA: true, error: '2FA code required' });
          return;
        }
      }

      // Handle interstitials (Save login info / Turn on notifications)
      try {
        // Save your login info → Not Now / Save Info
        const saveInfoButtons = [
          'button:has-text("Not now")',
          'button:has-text("Not Now")',
          'div[role="dialog"] button:has-text("Not now")',
        ];
        for (const sel of saveInfoButtons) {
          const btn = await page.$(sel as any);
          if (btn) { await btn.click(); await page.waitForTimeout(500); break; }
        }

        // Turn on notifications dialog → Not Now
        const notifButtons = [
          'button:has-text("Not now")',
          'div[role="dialog"] button:has-text("Not Now")'
        ];
        for (const sel of notifButtons) {
          const btn = await page.$(sel as any);
          if (btn) { await btn.click(); await page.waitForTimeout(500); break; }
        }
      } catch {}

      // Check for login errors
      const errorElement = await page.$('[role="alert"], [data-testid="alert"], div[role="dialog"] [role="alert"]');
      if (errorElement) {
        const errorText = await page.evaluate(el => el.textContent, errorElement);
        log.error('Login error detected', { error: errorText });
        await browser.close();
        resolve({ success: false, error: errorText || 'Login failed' });
        return;
      }

      // Wait for successful login (check if we're redirected to home page)
      await new Promise(resolve => setTimeout(resolve, 6000));
      const currentUrl = page.url();
      
      log.info('Current URL after login attempt:', currentUrl);
      
      // Check if we're still on login page (allow two_factor as in-progress)
      if (currentUrl.includes('/accounts/login') && !/two[_-]?factor/i.test(currentUrl)) {
        // Check for specific error messages
        const errorMessages = await page.evaluate(() => {
          const alerts = document.querySelectorAll('[role="alert"], [data-testid="alert"], .x1i10hfl');
          return Array.from(alerts).map(el => el.textContent).filter(text => text && text.trim());
        });
        
        if (errorMessages.length > 0) {
          log.error('Login error messages found:', errorMessages);
          await browser.close();
          resolve({ success: false, error: errorMessages[0] || 'Login failed - invalid credentials' });
          return;
        }
        
        // Check for suspicious activity message
        const suspiciousText = await page.evaluate(() => {
          const body = document.body.textContent || '';
          return /suspicious|unusual|verify|confirm/i.test(body);
        });
        
        if (suspiciousText) {
          log.error('Suspicious activity detected');
          await browser.close();
          resolve({ success: false, error: 'Suspicious activity detected - please try again later' });
          return;
        }
        
        // Save diagnostics for analysis (screenshot + HTML)
        try {
          const dir = path.join(process.cwd(), 'temp');
          try { await fs.mkdir(dir, { recursive: true }); } catch {}
          const ts = Date.now();
          const png = path.join(dir, `ig-2fa-fail-${ts}.png`);
          const html = path.join(dir, `ig-2fa-fail-${ts}.html`);
          await page.screenshot({ path: png, fullPage: true });
          const content = await page.content();
          await fs.writeFile(html, content, 'utf8');
          log.error('Saved 2FA failure diagnostics', { png, html });
        } catch (e) { log.warn('Failed to save diagnostics', { e }); }
        await browser.close();
        resolve({ success: false, error: 'Login failed - still on login page. 2FA may be expired/invalid or a checkpoint blocked. See temp/ diagnostics.' });
        return;
      }

      // Additional success heuristic: try opening profile menu anchor
      try {
        await page.waitForSelector('a[href*="/accounts/"]', { timeout: 5000 });
      } catch {}

      log.info('Login successful, extracting cookies');
      
      // Extract cookies
      const cookies = await page.cookies();
      log.info('Extracted cookies', { count: cookies.length });

      await browser.close();
      
      resolve({ success: true, cookies });
      
    } catch (error) {
      log.error('Login process failed', { error: error instanceof Error ? error.message : String(error) });
      resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function testInstagramLogin(credentials: LoginCredentials): Promise<boolean> {
  try {
    const result = await loginToInstagram(credentials);
    return result.success;
  } catch (error) {
    log.error('Test login failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
