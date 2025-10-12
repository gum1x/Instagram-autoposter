import 'dotenv/config';
import { createDatabase } from './database.js';
import axios from 'axios';
import cron from 'node-cron';
import dayjs from 'dayjs';
import { postInstagram, postTikTok } from './puppeteer/posters.js';
import { fetchInstagramStats, fetchTikTokStats, formatStats, StatsSnapshot } from './stats.js';
import { createLogger, ensureEnv, retry } from './utils.js';

const db = createDatabase();
ensureEnv(['TELEGRAM_BOT_TOKEN', 'ENCRYPTION_KEY']);
const log = createLogger('scheduler');

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
  created_at text
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

const accountColumns = db.prepare(`pragma table_info(accounts)`).all() as { name: string }[];
if (!accountColumns.some((c) => c.name === 'username')) {
  db.exec(`alter table accounts add column username text;`);
}

const dueStmt = db.prepare(`
select * from posts
 where status='queued' and datetime(schedule_at) <= datetime('now')
 order by datetime(schedule_at) asc`);
const mark = db.prepare(`update posts set status=@status where id=@id`);
const incrementRetries = db.prepare(`update posts set retry_count = COALESCE(retry_count, 0) + 1 where id = ?`);
const accountsForUser = db.prepare(`select platform, nickname, username from accounts where tg_user_id=? order by platform, created_at desc`);
const usersWithAccounts = db.prepare(`select distinct tg_user_id from accounts`);
const STATS_DIGEST_CRON = process.env.STATS_DIGEST_CRON || '0 9 * * *';

function buildCaption(caption:string, hashtags:string){
  const tags = (hashtags||'').split(',').map(s=>s.trim()).filter(Boolean).map(h=>h.startsWith('#')?h:'#'+h).join(' ');
  return [caption||'', tags||''].filter(Boolean).join('\n');
}

async function tick(){
  const rows = dueStmt.all() as any[];
  for (const r of rows){
    const retryCount = r.retry_count || 0;
    const maxRetries = 3;
    
    try{
      if ((r.platform==='instagram' || r.platform==='both') && r.ig_account){
        await postInstagram(r.tg_user_id, r.ig_account, r.video_path, buildCaption(r.caption, r.hashtags));
      }
      if ((r.platform==='tiktok' || r.platform==='both') && r.tt_account){
        await postTikTok(r.tg_user_id, r.tt_account, r.video_path, buildCaption(r.caption, r.hashtags));
      }
      if (r.schedule_type === 'everyXh' && r.every_hours){
        const nextAt = dayjs(r.schedule_at).add(r.every_hours, 'hour').toISOString();
        db.prepare('update posts set schedule_at=? where id=?').run(nextAt, r.id);
        log.info('Re-scheduled recurring job', { postId: r.id, nextAt });
      } else {
        mark.run({status:'posted', id:r.id});
        log.info('Post completed', { postId: r.id, platform: r.platform });
      }
    }catch(e){
      log.error('Post failed', { postId: r.id, retryCount, error: e instanceof Error ? e.message : String(e) });
      
      if (retryCount < maxRetries) {
        incrementRetries.run(r.id);
        const retryDelay = Math.min(30 * (retryCount + 1), 120); // 30min, 60min, 90min, max 120min
        const retryAt = dayjs().add(retryDelay, 'minute').toISOString();
        db.prepare('update posts set schedule_at=? where id=?').run(retryAt, r.id);
        log.info('Post retry scheduled', { postId: r.id, retryCount: retryCount + 1, retryAt });
      } else {
        mark.run({status:'failed', id:r.id});
        log.error('Post permanently failed after max retries', { postId: r.id, retryCount });
      }
    }
  }
}

let digestRunning = false;

async function sendStatsDigest(){
  if (digestRunning) return;
  digestRunning = true;
  try{
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log.warn('Skipping stats digest; TELEGRAM_BOT_TOKEN is not set.');
      return;
    }

    const users = usersWithAccounts.all() as { tg_user_id: string }[];
    if (!users.length) return;

    for (const { tg_user_id } of users){
      const accounts = accountsForUser.all(tg_user_id) as { platform: 'instagram'|'tiktok', nickname: string, username?: string }[];
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
log.info('Scheduler started. Polling every minute...');
log.info('Stats digest active', { cron: STATS_DIGEST_CRON });
