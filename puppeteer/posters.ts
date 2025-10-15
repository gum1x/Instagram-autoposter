import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, ElementHandle } from 'puppeteer';
import path from 'path';
import { cookieFilePath, readEncryptedJson, retry, createLogger, writeEncryptedJson } from '../utils.js';
import { storageEnsureLocalPath, storageTryRead } from '../storage.js';

const log = createLogger('posters');
const HEADLESS = process.env.HEADLESS === 'false' ? false : true;
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--memory-pressure-off',
  '--disable-blink-features=AutomationControlled'
];

const selectorCache = new Map<string, string[]>();

puppeteer.use(StealthPlugin());

type Cookies = any[];

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1365, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 }
];

const TIMEZONES = ['America/New_York', 'Europe/London', 'America/Los_Angeles'];

export function cookieFile(platform: string, userId: string | number, nickname: string) {
  return cookieFilePath(platform, userId, nickname);
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: BROWSER_ARGS,
    defaultViewport: null,
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
    const cookies = await loadCookies(filePath, 'Instagram', nickname);
    const localVideoPath = await storageEnsureLocalPath(videoPath);
    log.info('Posting to Instagram', { nickname, video: videoPath, localPath: localVideoPath });

    return withBrowser(async (browser) => {
      const page = await newPreparedPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        if (url.includes('facebook.com/') && !url.includes('/api/') && !url.includes('/ig_xsite_')) {
          log.info('Blocked Facebook page request', { url });
          request.abort();
        } else {
          request.continue();
        }
      });

      await page.setCookie(...(cookies as any));

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

      await humanWait(page, 900, 1600);
      await humanScroll(page);

      log.info('Step 2: Navigating to create page');
      await page.goto('https://www.instagram.com/create/select/', { waitUntil: 'networkidle2' });
      log.info('Step 2: ✅ Create page loaded');

      const currentUrl = page.url();
      if (!currentUrl.includes('instagram.com')) {
        throw new Error(`Redirected away from Instagram to: ${currentUrl}`);
      }
      log.info('Step 2: ✅ Confirmed still on Instagram', { url: currentUrl });

      await humanWait(page, 900, 1600);

      log.info('Step 3: Waiting for file input');
      await page.waitForSelector('input[type="file"]', { timeout: 30000 });
      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) throw new Error('Instagram file input not found');
      log.info('Step 3: ✅ File input found');

      log.info('Step 4: Uploading file', { filePath: resolvePath(localVideoPath) });
      await fileInput.uploadFile(resolvePath(localVideoPath));
      await humanWait(page, 2600, 3800);
      log.info('Step 4: ✅ File uploaded');

      log.info('Step 5: Looking for Next/Continue button');
      const nextSelectors = [
        'button:has-text("Next")',
        'div[role="button"]:has-text("Next")',
        'button:has-text("Continue")',
        'div[role="button"]:has-text("Continue")',
        '[data-testid="next-button"]',
        'button[type="button"]',
        'div[role="button"]',
        'text=Next',
        'text=Continue',
        'xpath=//div[@role="button" and normalize-space()="Next"]',
        'xpath=//div[@role="button" and normalize-space()="Continue"]',
        'xpath=//button[normalize-space()="Next"]',
        'xpath=//button[normalize-space()="Continue"]'
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

      await humanWait(page, 900, 1500);

      log.info('Step 6: Looking for Share/Next button');
      const shareSelectors = [
        'button:has-text("Share")',
        'div[role="button"]:has-text("Share")',
        'button:has-text("Next")',
        'div[role="button"]:has-text("Next")',
        '[data-testid="share-button"]',
        'button[type="button"]',
        'div[role="button"]',
        'text=Share',
        'text=Next',
        'xpath=//div[@role="button" and normalize-space()="Share"]',
        'xpath=//div[@role="button" and normalize-space()="Next"]',
        'xpath=//button[normalize-space()="Share"]',
        'xpath=//button[normalize-space()="Next"]'
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

      await humanWait(page, 900, 1500);

      log.info('Step 7: Adding caption', { caption });
      try {
        await typeIn(page, [
          'textarea[aria-label="Write a caption…"]',
          'textarea[aria-label="Write a caption..."]',
          'textarea[placeholder="Write a caption..."]',
          'textarea[data-testid="post-caption"]',
          'textarea',
          'div[contenteditable="true"]'
        ], caption || '');
        log.info('Step 7: ✅ Caption added');
      } catch (e) {
        log.error('Step 7: ❌ Could not add caption', { error: e instanceof Error ? e.message : String(e) });
        await page.screenshot({ path: 'debug-step7.png' });
        log.info('Screenshot saved as debug-step7.png');
      }

      await humanWait(page, 900, 1500);

      log.info('Step 8: Final share');
      try {
        await clickAny(page, [
          'button:has-text("Share")',
          'div[role="button"]:has-text("Share")',
          '[data-testid="share-button"]',
          'button[type="button"]',
          'div[role="button"]',
          'text=Share',
          'xpath=//div[@role="button" and normalize-space()="Share"]',
          'xpath=//button[normalize-space()="Share"]'
        ], 'instagram-final-share');
        log.info('Step 8: ✅ Final share clicked');
      } catch (e) {
        log.error('Step 8: ❌ Could not find final share button', { error: e instanceof Error ? e.message : String(e) });
        await page.screenshot({ path: 'debug-step8.png' });
        log.info('Screenshot saved as debug-step8.png');
        throw e;
      }

      await humanWait(page, 4200, 6200);
      log.info('Instagram post triggered', { nickname });
    });
  }, 3, 750);
}

export async function postTikTok(userId: string, nickname: string, videoPath: string, caption: string) {
  return retry(async () => {
    const filePath = cookieFile('tiktok', userId, nickname);
    const cookies = await loadCookies(filePath, 'TikTok', nickname);
    const localVideoPath = await storageEnsureLocalPath(videoPath);
    log.info('Posting to TikTok', { nickname, video: videoPath, localPath: localVideoPath });

    return withBrowser(async (browser) => {
      const page = await newPreparedPage(browser);
      await page.setCookie(...(cookies as any));
      await page.goto('https://www.tiktok.com/creator-center/upload?lang=en', { waitUntil: 'networkidle2' });
      await page.waitForSelector('input[type="file"]', { timeout: 20000 });

      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) throw new Error('TikTok file input not found');
      await fileInput.uploadFile(resolvePath(localVideoPath));
      await humanWait(page, 4200, 6000);

      await typeIn(page, [
        '[data-e2e="upload-caption"]',
        'textarea[data-e2e="upload-caption"]',
        'textarea'
      ], caption || '');
      await humanWait(page, 650, 1450);

      await page.waitForSelector('[data-e2e="post-button"], [data-e2e="publish-btn"]', { timeout: 60000 });
      await clickAny(page, [
        '[data-e2e="post-button"]',
        '[data-e2e="publish-btn"]',
        'text=Post'
      ], 'tiktok-post');
      await humanWait(page, 7000, 9000);
      log.info('TikTok post triggered', { nickname });
    });
  }, 3, 750);
}

async function clickAny(page: Page, selectors: string[], cacheKey?: string) {
  let orderedSelectors = selectors;
  if (cacheKey && selectorCache.has(cacheKey)) {
    const cached = selectorCache.get(cacheKey)!;
    orderedSelectors = [...cached, ...selectors.filter((s) => !cached.includes(s))];
    log.info('Using cached selectors', { cacheKey, cached });
  }

  for (const raw of orderedSelectors) {
    try {
      let handle: ElementHandle<Element> | null = null;
      if (raw.startsWith('text=')) {
        const term = raw.slice(5);
        const nodes = await (page as any).$x(`//*[normalize-space()=${JSON.stringify(term)}]`);
        handle = nodes[0] ?? null;
      } else if (raw.startsWith('xpath=')) {
        const expr = raw.slice(6);
        const nodes = await (page as any).$x(expr);
        handle = nodes[0] ?? null;
      } else {
        const selector = raw.startsWith('css=') ? raw.slice(4) : raw;
        handle = await page.$(selector);
      }

      if (handle) {
        await humanClick(page, handle);
        if (cacheKey) rememberSelector(cacheKey, raw);
        await handle.dispose();
        return;
      }
    } catch (error) {
      log.debug?.('clickAny selector failed', { selector: raw, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new Error('Clickable element not found for selectors: ' + selectors.join(', '));
}

async function typeIn(page: Page, selectorCandidates: string[], value: string) {
  for (const selector of selectorCandidates) {
    try {
      await page.waitForSelector(selector, { timeout: 6000, visible: true });
      const handle = await page.$(selector);
      if (!handle) continue;

      await humanClick(page, handle);
      await clearField(page);

      if (value) {
        await typeLikeHuman(page, value);
      }

      await handle.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await humanWait(page, 450, 900);
      await handle.dispose();
      return;
    } catch (error) {
      log.debug?.('typeIn selector failed', { selector, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new Error('Unable to fill input for selectors: ' + selectorCandidates.join(', '));
}

async function loadCookies(filePath: string, platformLabel: string, nickname: string): Promise<Cookies> {
  try {
    return await readEncryptedJson<Cookies>(filePath);
  } catch (err) {
    const legacyPath = filePath.replace(/\.json\.enc$/, '.json');
    const legacyBuffer = await storageTryRead(legacyPath);
    if (!legacyBuffer) {
      throw new Error(`Missing ${platformLabel} cookies for ${nickname}`);
    }
    const legacy = JSON.parse(legacyBuffer.toString('utf-8')) as Cookies;
    await writeEncryptedJson(filePath, legacy);
    log.warn('Migrated legacy cookie file to encrypted format', { platform: platformLabel, nickname });
    return legacy;
  }
}

function resolvePath(p: string) {
  return path.isAbsolute(p) ? p : path.resolve(p);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function newPreparedPage(browser: Browser) {
  const page = await browser.newPage();
  await preparePage(page);
  return page;
}

async function preparePage(page: Page) {
  const viewport = randomChoice(VIEWPORTS);
  await page.setViewport({
    ...viewport,
    deviceScaleFactor: Number((1 + Math.random() * 0.5).toFixed(2))
  });

  const userAgent = randomChoice(USER_AGENTS);
  await page.setUserAgent(userAgent);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-CH-UA-Platform': userAgent.includes('Windows') ? '"Windows"' : '"macOS"',
    'Upgrade-Insecure-Requests': '1'
  });

  await page.setJavaScriptEnabled(true);
  await page.setBypassCSP(true);
  await page.emulateTimezone(randomChoice(TIMEZONES));
  await page.setDefaultNavigationTimeout(45000 + Math.floor(Math.random() * 15000));

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    const navigatorProto = Object.getPrototypeOf(navigator);
    if (navigatorProto && !Object.prototype.hasOwnProperty.call(navigatorProto, 'languages')) {
      Object.defineProperty(navigatorProto, 'languages', { get: () => ['en-US', 'en'] });
    }
    const permissions = (navigator.permissions as unknown as { query?: (parameters: PermissionDescriptor) => Promise<PermissionStatus> });
    if (permissions && permissions.query) {
      const originalQuery = permissions.query.bind(permissions);
      permissions.query = (parameters: PermissionDescriptor) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: 'denied' } as PermissionStatus)
          : originalQuery(parameters)
      );
    }
    Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
      value: function (...args: unknown[]) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return HTMLCanvasElement.prototype.toDataURL.apply(this, args as [string, number?]);
      }
    });
  });
}

async function humanClick(page: Page, handle: ElementHandle<Element>) {
  const box = await handle.boundingBox();
  if (!box) return;
  const offsetX = randomBetween(box.width * 0.2, box.width * 0.8);
  const offsetY = randomBetween(box.height * 0.2, box.height * 0.8);
  await page.mouse.move(box.x + offsetX, box.y + offsetY, { steps: randomInt(8, 16) });
  await humanWait(page, 120, 320);
  await handle.click({ delay: randomInt(60, 180) });
  await humanWait(page, 420, 820);
}

async function typeLikeHuman(page: Page, text: string) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomInt(70, 160) });
    if (Math.random() < 0.03) {
      await humanWait(page, 200, 350);
    }
  }
}

async function clearField(page: Page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  if (process.platform === 'darwin') {
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Meta');
  }
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
}

async function humanWait(page: Page, min: number, max: number) {
  const duration = randomInt(min, max);
  await sleep(duration);
  if (Math.random() < 0.2) {
    await humanScroll(page);
  }
}

async function humanScroll(page: Page) {
  if (Math.random() > 0.6) return;
  const distance = randomInt(50, 300);
  await page.mouse.wheel({ deltaY: distance });
  await sleep(randomInt(200, 500));
}

function rememberSelector(cacheKey: string, selector: string) {
  const current = selectorCache.get(cacheKey) || [];
  if (!current.includes(selector)) {
    selectorCache.set(cacheKey, [selector, ...current].slice(0, 3));
  }
}

function randomChoice<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number) {
  return Math.floor(randomBetween(min, max));
}
