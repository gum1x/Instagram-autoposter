import 'dotenv/config';
import { createDatabase } from './database.js';
import axios from 'axios';
import cron from 'node-cron';
import dayjs from 'dayjs';
import { postTikTok } from './puppeteer/posters.js';
import { InstagrapiClient } from './instagrapi-client.js';
import { fetchInstagramStats, fetchTikTokStats, formatStats, StatsSnapshot } from './stats.js';
import { createLogger, ensureEnv, retry, readEncryptedJson } from './utils.js';
import { storageEnsureLocalPath } from './storage.js';

const db = createDatabase();
ensureEnv(['TELEGRAM_BOT_TOKEN', 'ENCRYPTION_KEY']);
const log = createLogger('scheduler');

async function postInstagramWithInstagrapi(tgUserId: string, accountNickname: string, filePath: string, caption: string): Promise<void> {
  log.info('Starting Instagram post with instagrapi', { tgUserId, accountNickname, filePath, captionLength: caption.length });
  const ig = new InstagrapiClient();
  
  // Get account settings
  log.info('Looking up Instagram account', { tgUserId, accountNickname });
  const accountStmt = db.prepare('select cookie_path from accounts where tg_user_id=? and platform=? and nickname=?');
  const account = await accountStmt.get(tgUserId, 'instagram', accountNickname) as { cookie_path: string } | undefined;
  
  if (!account) {
    log.error('Instagram account not found', { tgUserId, accountNickname });
    throw new Error(`Instagram account "${accountNickname}" not found`);
  }
  
  // Load settings from file
  log.info('Loading account settings from file', { tgUserId, accountNickname, cookiePath: account.cookie_path });
  const settings = await readEncryptedJson(account.cookie_path);
  log.info('Account settings loaded', { tgUserId, accountNickname, settingsSize: JSON.stringify(settings).length });
  
  // Determine if it's a photo or video
  const ext = filePath.toLowerCase().split('.').pop();
  const isVideo = ['mp4', 'mov', 'avi', 'mkv'].includes(ext || '');
  log.info('Media type determined', { tgUserId, accountNickname, filePath, ext, isVideo });
  
  let result;
  log.info('Ensuring local media path', { tgUserId, accountNickname, filePath });
  const localMediaPath = await storageEnsureLocalPath(filePath);
  log.info('Local media path ready', { tgUserId, accountNickname, localMediaPath });

  if (isVideo) {
    log.info('Uploading video to Instagram', { tgUserId, accountNickname, localMediaPath, captionLength: caption.length });
    result = await ig.uploadVideo({
      settings_json: settings,
      video_path: localMediaPath,
      caption: caption
    });
  } else {
    log.info('Uploading photo to Instagram', { tgUserId, accountNickname, localMediaPath, captionLength: caption.length });
    result = await ig.uploadPhoto({
      settings_json: settings,
      photo_path: localMediaPath,
      caption: caption
    });
  }
  
  log.info('Instagram upload result', { tgUserId, accountNickname, success: result.success, media_pk: result.media_pk, media_id: result.media_id, detail: result.detail });
  
  if (!result.success) {
    log.error('Instagram upload failed', { tgUserId, accountNickname, detail: result.detail });
    
    // Check if it's a session expiration error
    if (result.detail && (result.detail.includes('login_required') || result.detail.includes('session') || result.detail.includes('expired'))) {
      throw new Error(`Instagram session expired for account "${accountNickname}". Please re-login via Telegram bot: Accounts → Add IG`);
    }
    
    throw new Error(`Instagram upload failed: ${result.detail || 'Unknown error'}`);
  }
  
  log.info('Instagram post successful', { tgUserId, accountNickname, media_pk: result.media_pk, media_id: result.media_id });
}

db.exec(`
create table if not exists posts(
  id text primary key,
  tg_user_id text,
  platform text,
  ig_account text,
  tt_account text,
  video_path text,
  caption text,
  hashtags text,
  schedule_type text,
  schedule_at text,
  every_hours integer,
  status text default 'queued',
  created_at text,
  retry_count integer default 0
);
create table if not exists settings(
  tg_user_id text primary key,
  default_hashtags text,
  default_every_hours integer,
  platform_pref text
);
create table if not exists accounts(
  id integer primary key autoincrement,
  tg_user_id text,
  platform text,
  nickname text,
  username text,
  cookie_path text,
  created_at text
);
`);

const accountColumns = await db.prepare(`pragma table_info(accounts)`).all() as { name: string }[];
if (!accountColumns.some((c) => c.name === 'username')) {
  db.exec(`alter table accounts add column username text;`);
}

const dueStmt = db.prepare(`
select * from posts
 where status='queued' and schedule_at <= ?
 order by schedule_at asc`);
const mark = db.prepare(`update posts set status=@status where id=@id`);
const incrementRetries = db.prepare(`update posts set retry_count = COALESCE(retry_count, 0) + 1 where id = ?`);
const updateScheduleAt = db.prepare(`update posts set schedule_at=? where id=?`);
const accountsForUser = db.prepare(`select platform, nickname, username from accounts where tg_user_id=? order by platform, created_at desc`);
const usersWithAccounts = db.prepare(`select distinct tg_user_id from accounts`);
const deleteCompletedPosts = db.prepare(`delete from posts where status='completed'`);
const getCompletedPostsCount = db.prepare(`select count(*) as count from posts where status='completed'`);
const STATS_DIGEST_CRON = process.env.STATS_DIGEST_CRON || '0 9 * * *';

function buildCaption(caption:string, hashtags:string){
  const tags = (hashtags||'').split(',').map(s=>s.trim()).filter(Boolean).map(h=>h.startsWith('#')?h:'#'+h).join(' ');
  return [caption||'', tags||''].filter(Boolean).join('\n');
}

async function tick(){
  log.info('Scheduler tick - checking for due posts');
  const nowIso = dayjs().toISOString();
  const rows = await dueStmt.all(nowIso) as any[];
  log.info('Found due posts', { count: rows.length, posts: rows.map(r => ({ id: r.id, platform: r.platform, schedule_at: r.schedule_at })) });
  
  for (const r of rows){
    log.info('Processing post', {
      id: r.id,
      platform: r.platform,
      ig_account: r.ig_account,
      tt_account: r.tt_account,
      file: r.video_path,
      schedule_at: r.schedule_at,
      retry_count: r.retry_count
    });
    
    const retryCount = r.retry_count || 0;
    const maxRetries = 3;
    
    try{
      if ((r.platform==='instagram' || r.platform==='both') && r.ig_account){
        log.info('Posting to Instagram', { postId: r.id, account: r.ig_account, file: r.video_path });
        await postInstagramWithInstagrapi(r.tg_user_id, r.ig_account, r.video_path, buildCaption(r.caption, r.hashtags));
        log.info('Instagram post completed', { postId: r.id, account: r.ig_account });
      }
      if ((r.platform==='tiktok' || r.platform==='both') && r.tt_account){
        log.info('Posting to TikTok', { postId: r.id, account: r.tt_account, file: r.video_path });
        const localMediaPath = await storageEnsureLocalPath(r.video_path);
        await postTikTok(r.tg_user_id, r.tt_account, localMediaPath, buildCaption(r.caption, r.hashtags));
        log.info('TikTok post completed', { postId: r.id, account: r.tt_account });
      }
      if (r.schedule_type === 'everyXh' && r.every_hours){
        const nextAt = dayjs(r.schedule_at).add(r.every_hours, 'hour').toISOString();
        log.info('Re-scheduling recurring post', { postId: r.id, currentAt: r.schedule_at, nextAt, everyHours: r.every_hours });
        await updateScheduleAt.run(nextAt, r.id);
        log.info('Re-scheduled recurring job', { postId: r.id, nextAt });
      } else {
        log.info('Marking post as completed', { postId: r.id, platform: r.platform });
        await mark.run({status:'completed', id:r.id});
        log.info('Post marked as completed', { postId: r.id, platform: r.platform });
        
        // Clean up completed posts immediately to prevent duplicates
        await cleanupCompletedPosts();
      }
    }catch(e){
      log.error('Post failed', { postId: r.id, retryCount, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      
      if (retryCount < maxRetries) {
        await incrementRetries.run(r.id);
        const retryDelay = Math.min(30 * (retryCount + 1), 120); // 30min, 60min, 90min, max 120min
        const retryAt = dayjs().add(retryDelay, 'minute').toISOString();
        log.info('Scheduling retry', { postId: r.id, retryCount: retryCount + 1, retryDelay, retryAt });
        await updateScheduleAt.run(retryAt, r.id);
        log.info('Post retry scheduled', { postId: r.id, retryCount: retryCount + 1, retryAt });
      } else {
        log.error('Post permanently failed after max retries', { postId: r.id, retryCount, maxRetries });
        await mark.run({status:'failed', id:r.id});
        log.error('Post permanently failed after max retries', { postId: r.id, retryCount });
      }
    }
  }
}

let digestRunning = false;
let cleanupRunning = false;

async function cleanupCompletedPosts(){
  if (cleanupRunning) return;
  cleanupRunning = true;
  
  try {
    log.info('Starting cleanup of completed posts');
    
    // Count completed posts before cleanup
    const beforeCount = await getCompletedPostsCount.get() as { count: number };
    log.info('Completed posts count before cleanup', { count: beforeCount.count });
    
    if (beforeCount.count === 0) {
      log.info('No completed posts to clean up');
      return;
    }
    
    // Delete completed posts
    const result = await deleteCompletedPosts.run();
    log.info('Cleanup completed', { deletedCount: result.changes });
    
    // Verify cleanup
    const afterCount = await getCompletedPostsCount.get() as { count: number };
    log.info('Completed posts count after cleanup', { count: afterCount.count });
    
  } catch (error) {
    log.error('Cleanup failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    cleanupRunning = false;
  }
}

async function sendStatsDigest(){
  if (digestRunning) return;
  digestRunning = true;
  try{
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log.warn('Skipping stats digest; TELEGRAM_BOT_TOKEN is not set.');
      return;
    }

    const users = await usersWithAccounts.all() as { tg_user_id: string }[];
    if (!users.length) return;

    for (const { tg_user_id } of users){
      const accounts = await accountsForUser.all(tg_user_id) as { platform: 'instagram'|'tiktok', nickname: string, username?: string }[];
      if (!accounts.length) continue;

      const successes: StatsSnapshot[] = [];
      const failures: string[] = [];

      for (const acc of accounts){
        try{
          if (acc.platform === 'instagram'){
            successes.push(await fetchInstagramStats(tg_user_id, acc.nickname, acc.username || undefined));
          } else if (acc.platform === 'tiktok'){
            successes.push(await fetchTikTokStats(tg_user_id, acc.nickname, acc.username || undefined));
          }
        }catch(err){
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${acc.platform} (${acc.nickname}): ${message}`);
        }
      }

      if (!successes.length && !failures.length) continue;

      const sections: string[] = [];
      if (successes.length){
        sections.push(successes.map(formatStats).join('\n\n'));
      }
      if (failures.length){
        sections.push('Issues:\n- ' + failures.join('\n- '));
      }

      const text = `📈 Daily stats digest\n\n${sections.join('\n\n')}`;
      try{
        await retry(() => axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: tg_user_id,
          text
        }), 3, 1000);
      }catch(err){
        log.error('Failed to send stats digest', { tg_user_id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    digestRunning = false;
  }
}

cron.schedule('* * * * *', tick);
cron.schedule(STATS_DIGEST_CRON, () => {
  sendStatsDigest().catch((err)=>{
    log.error('Stats digest job failed', { error: err instanceof Error ? err.message : String(err) });
  });
});
// Clean up completed posts every 5 minutes
cron.schedule('*/5 * * * *', () => {
  cleanupCompletedPosts().catch((err)=>{
    log.error('Cleanup job failed', { error: err instanceof Error ? err.message : String(err) });
  });
});
log.info('Scheduler started. Polling every minute...');
log.info('Stats digest active', { cron: STATS_DIGEST_CRON });
log.info('Cleanup job active', { cron: '*/5 * * * *' });
