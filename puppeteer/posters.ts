import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { cookieFilePath, readEncryptedJson, retry, createLogger, writeEncryptedJson } from '../utils.js';

const log = createLogger('posters');
const HEADLESS = process.env.HEADLESS === 'false' ? false : true;
const BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

// Cache successful selectors to speed up future attempts
const selectorCache = new Map<string, string[]>();

type Cookies = any[];

export function cookieFile(platform: string, userId: string | number, nickname: string) {
  return cookieFilePath(platform, userId, nickname);
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: BROWSER_ARGS,
    ignoreHTTPSErrors: true
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

export async function postInstagram(userId: string, nickname: string, videoPath: string, caption: string) {
  return retry(async () => {
    const filePath = cookieFile('instagram', userId, nickname);
    const cookies = loadCookies(filePath, 'Instagram', nickname);
    await ensureFileExists(videoPath);
    log.info('Posting to Instagram', { nickname, video: videoPath });

    return withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      
      // Block only Facebook redirects, allow necessary Facebook API calls
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        // Only block Facebook pages/redirects, not API calls
        if (url.includes('facebook.com/') && !url.includes('/api/') && !url.includes('/ig_xsite_')) {
          log.info('Blocked Facebook page request', { url });
          request.abort();
        } else {
          request.continue();
        }
      });
      
      await page.setCookie(...(cookies as any));
      
      // Monitor navigation to ensure we stay on Instagram
      page.on('framenavigated', (frame) => {
        const url = frame.url();
        if (url.includes('facebook.com') || url.includes('fb.com')) {
          log.warn('Detected Facebook redirect, staying on Instagram', { url });
          frame.goto('https://www.instagram.com/');
        }
      });
      
      log.info('Step 1: Navigating to Instagram homepage');
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
      log.info('Step 1: ✅ Instagram homepage loaded');

      await sleep(1000); // Faster
      
      log.info('Step 2: Navigating to create page');
      await page.goto('https://www.instagram.com/create/select/', { waitUntil: 'networkidle2' });
      log.info('Step 2: ✅ Create page loaded');
      
      // Verify we're still on Instagram
      const currentUrl = page.url();
      if (!currentUrl.includes('instagram.com')) {
        throw new Error(`Redirected away from Instagram to: ${currentUrl}`);
      }
      log.info('Step 2: ✅ Confirmed still on Instagram', { url: currentUrl });
      
      await sleep(1000); // Faster
      
      log.info('Step 3: Waiting for file input');
      await page.waitForSelector('input[type="file"]', { timeout: 30000 });
      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) throw new Error('Instagram file input not found');
      log.info('Step 3: ✅ File input found');
      
      log.info('Step 4: Uploading file', { filePath: resolvePath(videoPath) });
      await fileInput.uploadFile(resolvePath(videoPath));
      await sleep(3000); // Faster upload wait
      log.info('Step 4: ✅ File uploaded');

      // Try multiple approaches to find and click Next/Continue buttons
      log.info('Step 5: Looking for Next/Continue button');
      const nextSelectors = [
        'text=Next',
        'text=Continue',
        'xpath=//div[@role="button" and normalize-space()="Next"]',
        'xpath=//div[@role="button" and normalize-space()="Continue"]',
        'xpath=//button[normalize-space()="Next"]',
        'xpath=//button[normalize-space()="Continue"]',
        '[data-testid="next-button"]',
        'button[type="button"]',
        'div[role="button"]'
      ];
      
      try {
        await clickAny(page, nextSelectors, 'instagram-next');
        log.info('Step 5: ✅ Clicked Next button');
      } catch (e) {
        log.error('Step 5: ❌ Could not find Next button', { error: e instanceof Error ? e.message : String(e) });
        await page.screenshot({ path: 'debug-step5.png' });
        log.info('Screenshot saved as debug-step5.png');
        throw e;
      }
      
      await sleep(1500); // Faster
      
      // Try to click Next/Share again
      log.info('Step 6: Looking for Share/Next button');
      const shareSelectors = [
        'text=Share',
        'text=Next',
        'xpath=//div[@role="button" and normalize-space()="Share"]',
        'xpath=//div[@role="button" and normalize-space()="Next"]',
        'xpath=//button[normalize-space()="Share"]',
        'xpath=//button[normalize-space()="Next"]',
        '[data-testid="share-button"]',
        'button[type="button"]',
        'div[role="button"]'
      ];
      
      try {
        await clickAny(page, shareSelectors, 'instagram-share');
        log.info('Step 6: ✅ Clicked Share button');
      } catch (e) {
        log.error('Step 6: ❌ Could not find Share button', { error: e instanceof Error ? e.message : String(e) });
        await page.screenshot({ path: 'debug-step6.png' });
        log.info('Screenshot saved as debug-step6.png');
        throw e;
      }
      
      await sleep(1000); // Faster

      // Add caption
      log.info('Step 7: Adding caption', { caption });
      try {
        await typeIn(page, [
          'textarea[aria-label="Write a caption…"]',
          'textarea[aria-label="Write a caption..."]',
          'textarea[placeholder="Write a caption..."]',
          'textarea'
        ], caption || '');
        log.info('Step 7: ✅ Caption added');
      } catch (e) {
        log.error('Step 7: ❌ Could not add caption', { error: e instanceof Error ? e.message : String(e) });
        await page.screenshot({ path: 'debug-step7.png' });
        log.info('Screenshot saved as debug-step7.png');
        // Don't throw - caption is optional
      }

      await sleep(1000); // Faster

      // Final share
      log.info('Step 8: Final share');
      try {
        await clickAny(page, [
          'text=Share',
          'xpath=//div[@role="button" and normalize-space()="Share"]',
          'xpath=//button[normalize-space()="Share"]',
          '[data-testid="share-button"]'
        ], 'instagram-final-share');
        log.info('Step 8: ✅ Final share clicked');
      } catch (e) {
        log.error('Step 8: ❌ Could not find final share button', { error: e instanceof Error ? e.message : String(e) });
        await page.screenshot({ path: 'debug-step8.png' });
        log.info('Screenshot saved as debug-step8.png');
        throw e;
      }
      
      await sleep(5000); // Faster final wait
      log.info('Instagram post triggered', { nickname });
    });
  }, 3, 750);
}

export async function postTikTok(userId: string, nickname: string, videoPath: string, caption: string) {
  return retry(async () => {
    const filePath = cookieFile('tiktok', userId, nickname);
    const cookies = loadCookies(filePath, 'TikTok', nickname);
    await ensureFileExists(videoPath);
    log.info('Posting to TikTok', { nickname, video: videoPath });

    return withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.setCookie(...(cookies as any));
      await page.goto('https://www.tiktok.com/creator-center/upload?lang=en', { waitUntil: 'networkidle2' });
      await page.waitForSelector('input[type="file"]', { timeout: 20000 });

      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) throw new Error('TikTok file input not found');
      await fileInput.uploadFile(resolvePath(videoPath));
      await sleep(5000);

      await typeIn(page, [
        '[data-e2e="upload-caption"]',
        'textarea[data-e2e="upload-caption"]',
        'textarea'
      ], caption || '');
      await sleep(600 + Math.random() * 600);

      await page.waitForSelector('[data-e2e="post-button"], [data-e2e="publish-btn"]', { timeout: 60000 });
      await clickAny(page, [
        '[data-e2e="post-button"]',
        '[data-e2e="publish-btn"]',
        'text=Post'
      ]);
      await sleep(8000);
      log.info('TikTok post triggered', { nickname });
    });
  }, 3, 750);
}

async function clickAny(page: Page, selectors: string[], cacheKey?: string) {
  // Use cached successful selectors first
  let orderedSelectors = selectors;
  if (cacheKey && selectorCache.has(cacheKey)) {
    const cached = selectorCache.get(cacheKey)!;
    orderedSelectors = [...cached, ...selectors.filter(s => !cached.includes(s))];
    log.info('Using cached selectors', { cacheKey, cached });
  }

  for (const raw of orderedSelectors) {
    try {
      if (raw.startsWith('text=')) {
        const term = raw.slice(5);
        const clicked = await page.evaluate((text) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
          while (walker.nextNode()) {
            const element = walker.currentNode as HTMLElement;
            const label = element.innerText?.trim();
            if (label === text) {
              element.click();
              return true;
            }
          }
          return false;
        }, term);
        if (clicked) {
          // Cache successful selector
          if (cacheKey) {
            const current = selectorCache.get(cacheKey) || [];
            if (!current.includes(raw)) {
              selectorCache.set(cacheKey, [raw, ...current.slice(0, 2)]); // Keep top 3
            }
          }
          await sleep(300 + Math.random() * 200); // Faster but still human-like
          return;
        }
      } else if (raw.startsWith('xpath=')) {
        const expr = raw.slice(6);
        const clicked = await page.evaluate((xpath) => {
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = result.singleNodeValue as HTMLElement | null;
          if (el) {
            el.click();
            return true;
          }
          return false;
        }, expr);
        if (clicked) {
          if (cacheKey) {
            const current = selectorCache.get(cacheKey) || [];
            if (!current.includes(raw)) {
              selectorCache.set(cacheKey, [raw, ...current.slice(0, 2)]);
            }
          }
          await sleep(300 + Math.random() * 200);
          return;
        }
      } else {
        const selector = raw.startsWith('css=') ? raw.slice(4) : raw;
        const el = await page.$(selector);
        if (el) {
          await el.click();
          if (cacheKey) {
            const current = selectorCache.get(cacheKey) || [];
            if (!current.includes(raw)) {
              selectorCache.set(cacheKey, [raw, ...current.slice(0, 2)]);
            }
          }
          await sleep(300 + Math.random() * 200);
          return;
        }
      }
    } catch {
      // Try next selector
    }
  }
  throw new Error('Clickable element not found for selectors: ' + selectors.join(', '));
}

async function typeIn(page: Page, selectorCandidates: string[], value: string) {
  for (const selector of selectorCandidates) {
    try {
      await page.waitForSelector(selector, { timeout: 6000 });
      const success = await page.evaluate((sel, text) => {
        const element = document.querySelector(sel) as HTMLElement | null;
        if (!element) return false;
        if (typeof element.focus === 'function') element.focus();
        if ('value' in element) {
          const input = element as HTMLInputElement | HTMLTextAreaElement;
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.value = text;
        } else {
          element.textContent = text;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, selector, value || '');

      if (success) {
        await sleep(500 + Math.random() * 500);
        return;
      }
    } catch {
      // Try next selector
    }
  }
  throw new Error('Unable to fill input for selectors: ' + selectorCandidates.join(', '));
}

async function ensureFileExists(filePath: string) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Video file not found: ${resolved}`);
  }
}

function loadCookies(filePath: string, platformLabel: string, nickname: string): Cookies {
  if (!fs.existsSync(filePath)) {
    const legacyPath = filePath.replace(/\.json\.enc$/, '.json');
    if (fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as Cookies;
      writeEncryptedJson(filePath, legacy);
      log.warn('Migrated legacy cookie file to encrypted format', { platform: platformLabel, nickname });
      return legacy;
    }
    throw new Error(`Missing ${platformLabel} cookies for ${nickname}`);
  }
  return readEncryptedJson<Cookies>(filePath);
}

function resolvePath(p: string) {
  return path.isAbsolute(p) ? p : path.resolve(p);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
