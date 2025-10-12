import puppeteer from 'puppeteer';
import { createLogger } from './utils.js';

const log = createLogger('instagram-login');

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
      await page.setViewport({ width: 1280, height: 900 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      // Navigate to Instagram login page
      log.info('Navigating to Instagram login page');
      try {
        await page.goto('https://www.instagram.com/accounts/login/', { 
          waitUntil: 'networkidle2',
          timeout: 30000 
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
        log.info('Successfully navigated to Instagram login page');
      } catch (navError) {
        log.error('Navigation failed:', navError);
        await browser.close();
        resolve({ success: false, error: `Navigation failed: ${navError.message}` });
        return;
      }

      // Fill username
      log.info('Filling username');
      await page.waitForSelector('input[name="username"]', { timeout: 10000 });
      await page.type('input[name="username"]', credentials.username);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Fill password
      log.info('Filling password');
      await page.waitForSelector('input[name="password"]', { timeout: 10000 });
      await page.type('input[name="password"]', credentials.password);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Click login button
      log.info('Clicking login button');
      await page.click('button[type="submit"]');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if we need 2FA
      const twoFactorSelector = 'input[name="verificationCode"]';
      const twoFactorExists = await page.$(twoFactorSelector);
      
      if (twoFactorExists) {
        log.info('2FA required');
        
        if (credentials.twoFactorCode) {
          log.info('Using provided 2FA code');
          await page.type(twoFactorSelector, credentials.twoFactorCode);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Click submit for 2FA
          const submitButton = await page.$('button[type="submit"]');
          if (submitButton) {
            await submitButton.click();
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } else {
          log.info('2FA code required but not provided');
          await browser.close();
          resolve({ success: false, needs2FA: true, error: '2FA code required' });
          return;
        }
      }

      // Check for login errors
      const errorElement = await page.$('[role="alert"]');
      if (errorElement) {
        const errorText = await page.evaluate(el => el.textContent, errorElement);
        log.error('Login error detected', { error: errorText });
        await browser.close();
        resolve({ success: false, error: errorText || 'Login failed' });
        return;
      }

      // Wait for successful login (check if we're redirected to home page)
      await new Promise(resolve => setTimeout(resolve, 3000));
      const currentUrl = page.url();
      
      if (currentUrl.includes('/accounts/login')) {
        log.error('Still on login page, login may have failed');
        await browser.close();
        resolve({ success: false, error: 'Login failed - still on login page' });
        return;
      }

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
