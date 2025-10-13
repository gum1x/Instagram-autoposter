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
  const cookies = await loadCookies(cookiesPath, 'Instagram', nickname);
  const derivedUser = username || cookies.find((c: any) => c.name === 'ds_user')?.value;
  if (!derivedUser) {
    throw new Error(`Missing Instagram username for ${nickname}. Re-add the account and specify the username.`);
  }

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setCookie(...cookies);
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
    await page.goto(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${derivedUser}`, { waitUntil: 'networkidle2' });

    const raw = await page.evaluate(() => (globalThis.document?.body?.innerText) || '');
    const payload = JSON.parse(raw);
    const user = payload?.data?.user;
    if (!user) {
      throw new Error(`Unable to load Instagram profile data for ${derivedUser}`);
    }

    const followers = user.edge_followed_by?.count ?? null;
    const edges = Array.isArray(user.edge_owner_to_timeline_media?.edges)
      ? user.edge_owner_to_timeline_media.edges
      : [];

    const now = dayjs();
    let engagement7 = 0;
    let engagement30 = 0;
    let posts7 = 0;
    let posts30 = 0;

    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.taken_at_timestamp) continue;
      const takenAt = dayjs.unix(node.taken_at_timestamp);
      const likes = node.edge_media_preview_like?.count ?? 0;
      const comments = node.edge_media_to_comment?.count ?? 0;
      const total = likes + comments;

      if (now.diff(takenAt, 'day', true) <= 30) {
        engagement30 += total;
        posts30 += 1;
      }
      if (now.diff(takenAt, 'day', true) <= 7) {
        engagement7 += total;
        posts7 += 1;
      }
    }

    return {
      platform: 'instagram',
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
    await page.setCookie(...cookies);
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

async function loadCookies(filePath: string, platformLabel: string, nickname: string): Promise<any[]> {
  try {
    return await readEncryptedJson<any[]>(filePath);
  } catch (err) {
    const legacyPath = filePath.replace(/\.json\.enc$/, '.json');
    const legacyBuffer = await storageTryRead(legacyPath);
    if (!legacyBuffer) {
      throw new Error(`Missing ${platformLabel} cookies for ${nickname}`);
    }
    const legacyCookies = JSON.parse(legacyBuffer.toString('utf-8'));
    await writeEncryptedJson(filePath, legacyCookies);
    return legacyCookies;
  }
}
