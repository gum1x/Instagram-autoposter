import dayjs from 'dayjs';
import { cookieFile, withBrowser } from './puppeteer/posters.js';
import { readEncryptedJson, writeEncryptedJson } from './utils.js';
import { storageTryRead } from './storage.js';

export type Platform = 'instagram' | 'tiktok';

export type StatsSnapshot = {
  platform: Platform;
  nickname: string;
  username: string;
  followers: number | null;
  engagement7: number;
  engagement30: number;
  posts7: number;
  posts30: number;
};

export async function fetchInstagramStats(userId: string, nickname: string, username?: string): Promise<StatsSnapshot> {
  const cookiesPath = cookieFile('instagram', userId, nickname);
  const settings = await loadCookies(cookiesPath, 'Instagram', nickname);
  
  if (!username) {
    throw new Error(`Missing Instagram username for ${nickname}. Re-add the account and specify the username.`);
  }

  try {
    const response = await fetch('http://127.0.0.1:8081/get_stats', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        settings_json: settings,
        username: username
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Instagram API error: ${error}`);
    }

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(`Instagram stats fetch failed: ${data.detail || 'Unknown error'}`);
    }

    return {
      platform: 'instagram',
      nickname,
      username: data.username,
      followers: data.followers,
      engagement7: data.engagement_7d,
      engagement30: data.engagement_30d,
      posts7: data.posts_7d,
      posts30: data.posts_30d
    };
  } catch (error) {
    throw new Error(`Failed to fetch Instagram stats for ${nickname}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function fetchTikTokStats(userId: string, nickname: string, username?: string): Promise<StatsSnapshot> {
  const cookiesPath = cookieFile('tiktok', userId, nickname);
  const cookies = await loadCookies(cookiesPath, 'TikTok', nickname);
  const derivedUser = (username || '').replace(/^@/, '').trim();
  if (!derivedUser) {
    throw new Error(`Missing TikTok username for ${nickname}. Re-add the account and specify the username.`);
  }

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
    }
    await page.goto(`https://www.tiktok.com/@${derivedUser}`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => {
      const g = globalThis as any;
      return typeof g !== 'undefined' && !!g?.SIGI_STATE;
    }, { timeout: 20000 });

    const stateRaw = await page.evaluate(() => {
      const g = globalThis as any;
      return JSON.stringify(g?.SIGI_STATE || {});
    });
    const state = JSON.parse(stateRaw);
    const userModule = state?.UserModule;
    const userEntry =
      userModule?.users?.[derivedUser] ||
      Object.values(userModule?.users || {})[0];
    if (!userEntry) {
      throw new Error(`Unable to load TikTok profile data for ${derivedUser}`);
    }

    const followers = userEntry.followerCount ?? null;
    const items = Object.values(state?.ItemModule || {}) as any[];
    const nowSec = dayjs().unix();
    let engagement7 = 0;
    let engagement30 = 0;
    let posts7 = 0;
    let posts30 = 0;

    for (const item of items) {
      const createTime = Number(item?.createTime);
      if (!createTime) continue;
      const total = Number(item?.stats?.diggCount ?? 0) + Number(item?.stats?.commentCount ?? 0);
      if (nowSec - createTime <= 30 * 86400) {
        engagement30 += total;
        posts30 += 1;
      }
      if (nowSec - createTime <= 7 * 86400) {
        engagement7 += total;
        posts7 += 1;
      }
    }

    return {
      platform: 'tiktok',
      nickname,
      username: derivedUser,
      followers,
      engagement7,
      engagement30,
      posts7,
      posts30
    };
  });
}

export function formatStats(stat: StatsSnapshot): string {
  const platformLabel = stat.platform === 'instagram' ? 'Instagram' : 'TikTok';
  return [
    `${platformLabel} — ${stat.nickname}`,
    `Followers: ${formatNumber(stat.followers)}`,
    `7d engagement: ${formatNumber(stat.engagement7)} (${stat.posts7} posts)`,
    `30d engagement: ${formatNumber(stat.engagement30)} (${stat.posts30} posts)`
  ].join('\n');
}

export function formatNumber(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString();
}

async function loadCookies(filePath: string, platformLabel: string, nickname: string): Promise<any> {
  try {
    const data = await readEncryptedJson<any>(filePath);
    if (platformLabel === 'Instagram') {
      // For Instagram, we expect settings object from instagrapi
      if (typeof data !== 'object' || data === null) {
        throw new Error(`Invalid settings format for ${nickname}`);
      }
      return data;
    } else {
      // For TikTok, we still expect cookies array
      if (!Array.isArray(data)) {
        throw new Error(`Invalid cookie format for ${nickname}`);
      }
      return data;
    }
  } catch (err) {
    const legacyPath = filePath.replace(/\.json\.enc$/, '.json');
    const legacyBuffer = await storageTryRead(legacyPath);
    if (!legacyBuffer) {
      throw new Error(`Missing ${platformLabel} cookies for ${nickname}`);
    }
    const legacyData = JSON.parse(legacyBuffer.toString('utf-8'));
    
    if (platformLabel === 'Instagram') {
      if (typeof legacyData !== 'object' || legacyData === null) {
        throw new Error(`Invalid legacy settings format for ${nickname}`);
      }
    } else {
      if (!Array.isArray(legacyData)) {
        throw new Error(`Invalid legacy cookie format for ${nickname}`);
      }
    }
    
    await writeEncryptedJson(filePath, legacyData);
    return legacyData;
  }
}
