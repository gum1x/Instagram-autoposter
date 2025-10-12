import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { cookieFilePath, readEncryptedJson, retry, createLogger, writeEncryptedJson } from '../utils.js';

const log = createLogger('posters');
const HEADLESS = process.env.HEADLESS === 'false' ? false : true;
const BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

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
      await page.setCookie(...(cookies as any));
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });

      await sleep(1200 + Math.random() * 800);
      await page.goto('https://www.instagram.com/create/select/', { waitUntil: 'networkidle2' });
      await page.waitForSelector('input[type="file"]', { timeout: 20000 });

      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) throw new Error('Instagram file input not found');
      await fileInput.uploadFile(resolvePath(videoPath));
      await sleep(3000);

      await clickAny(page, [
        'text=Next',
        'xpath=//div[@role="button" and normalize-space()="Next"]',
        'xpath=//button[normalize-space()="Next"]'
      ]);
      await sleep(1200);
      await clickAny(page, [
        'text=Next',
        'xpath=//div[@role="button" and normalize-space()="Next"]',
        'xpath=//button[normalize-space()="Next"]'
      ]);
      await sleep(1200);

      await typeIn(page, [
        'textarea[aria-label="Write a caption…"]',
        'textarea[aria-label="Write a caption..."]',
        'textarea[placeholder="Write a caption..."]',
        'textarea'
      ], caption || '');

      await clickAny(page, [
        'text=Share',
        'xpath=//div[@role="button" and normalize-space()="Share"]',
        'xpath=//button[normalize-space()="Share"]'
      ]);
      await sleep(6000);
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

async function clickAny(page: Page, selectors: string[]) {
  for (const raw of selectors) {
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
          await sleep(700 + Math.random() * 400);
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
          await sleep(700 + Math.random() * 400);
          return;
        }
      } else {
        const selector = raw.startsWith('css=') ? raw.slice(4) : raw;
        const el = await page.$(selector);
        if (el) {
          await el.click();
          await sleep(700 + Math.random() * 400);
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
