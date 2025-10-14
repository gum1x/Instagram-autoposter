import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import * as path from 'path';
import { createDatabase, DatabaseAdapter } from './database.js';
import { v4 as uuid } from 'uuid';
import dayjs from 'dayjs';
import { fetchInstagramStats, fetchTikTokStats, StatsSnapshot, formatStats } from './stats.js';
import { cookieFilePath, createLogger, ensureEnv, writeEncryptedJson } from './utils.js';
import { storageSave } from './storage.js';
import { WebWorker } from 'puppeteer';

ensureEnv(['TELEGRAM_BOT_TOKEN', 'ENCRYPTION_KEY']);
const BOT = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const db = createDatabase();
const log = createLogger('bot');

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

// Check if username column exists (async)
(async () => {
  try {
    const accountColumns = await db.prepare(`pragma table_info(accounts)`).all() as { name: string }[];
if (!accountColumns.some((c) => c.name === 'username')) {
  db.exec(`alter table accounts add column username text;`);
}
  } catch (error) {
    console.error('Error checking account columns:', error);
  }
})();

const ensureUserSettings = db.prepare(`
insert into settings (tg_user_id, default_hashtags, default_every_hours, platform_pref)
values (?, ?, ?, ?) on conflict(tg_user_id) do nothing
`);
const updateSettings = db.prepare(`
update settings set default_hashtags=@default_hashtags, default_every_hours=@default_every_hours, platform_pref=@platform_pref
where tg_user_id=@tg_user_id
`);
const getSettings = db.prepare(`select * from settings where tg_user_id = ?`);
const addAccount = db.prepare(`insert into accounts (tg_user_id, platform, nickname, username, cookie_path, created_at) values (?,?,?,?,?,?)`);
const deleteAccount = db.prepare(`delete from accounts where tg_user_id=? and platform=? and nickname=?`);
const listAccounts = db.prepare(`select nickname, username from accounts where tg_user_id=? and platform=? order by created_at desc`);
const listAllAccounts = db.prepare(`select * from accounts where tg_user_id=? order by platform, created_at desc`);
const lastScheduledForUser = db.prepare(`
  select schedule_at from posts
   where tg_user_id=?
   order by datetime(schedule_at) desc
   limit 1
`);
const insertPost = db.prepare(`insert into posts(id,tg_user_id,platform,ig_account,tt_account,video_path,caption,hashtags,schedule_type,schedule_at,every_hours,status,created_at)
  values(?,?,?,?,?,?,?,?,?,?,?,'queued',?)`);

type AccountSetupStage = 'username'|'nickname'|'password'|'twofa'|'login'|'cookies';
type Session = {
  files: string[];
  platform?: 'instagram'|'tiktok'|'both'|'multi_ig';
  igAccount?: string;
  ttAccount?: string;
  multiAccounts?: string[];
  when?: 'now'|'after2h'|'tomorrow'|'at'|'everyXh'|'smart';
  atISO?: string;
  everyHours?: number;
  caption?: string;
  hashtags?: string;
  expecting?: 'datetime'
    | 'everyHours'
    | 'caption'
    | 'hashtags'
    | 'settingsHashtags'
    | 'bulkInterval'
    | 'bulkCaption'
    | 'bulkHashtags'
    | 'individualCaption'
    | 'individualHashtags';
  tempCookies?: any[];
  accountSetup?: {
    platform: 'instagram'|'tiktok';
    stage: AccountSetupStage;
    username?: string;
    nickname?: string;
    password?: string;
    twoFactorCode?: string;
  };
  bulkMode?: 'intervals'|'now'|'smart'|'individual';
  bulkInterval?: number;
  currentFileIndex?: number;
};
const sessions = new Map<number, Session>();

BOT.start(async (ctx) => {
  log.info('User started bot', { userId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name });
  try {
    await ensureUserSettings.run(String(ctx.from.id), '#fyp,#viral', 3, 'both');
    log.info('User settings ensured', { userId: ctx.from.id });
  } catch (error) {
    log.error('Failed to ensure user settings', {
      userId: ctx.from.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  await ctx.reply('👋 Ready. Choose an option:', mainMenu());
  log.info('Main menu sent to user', { userId: ctx.from.id });
});

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload videos', 'upload')],
    [Markup.button.callback('🗓️ Schedule', 'schedule'), Markup.button.callback('🏷️ Hashtags', 'hashtags')],
    [Markup.button.callback('👥 Accounts', 'accounts')],
    [Markup.button.callback('📊 Stats', 'stats')]
  ]);
}

BOT.action('upload', async (ctx) => {
  log.info('User clicked upload', { userId: ctx.from!.id });
  sessions.set(ctx.from!.id, { files: [] });
  await ctx.answerCbQuery();
  await ctx.reply('📸 Send me photos or videos to post. When done, type "done".');
  log.info('Upload instructions sent to user', { userId: ctx.from!.id });
});

BOT.on('video', async (ctx) => {
  log.info('User sent video', { userId: ctx.from.id, fileId: ctx.message.video.file_id, fileSize: ctx.message.video.file_size });
  try {
  const s = sessions.get(ctx.from.id) || { files: [] };
    log.info('Getting video file from Telegram', { userId: ctx.from.id, fileId: ctx.message.video.file_id });
  const file = await ctx.telegram.getFile(ctx.message.video.file_id);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const dest = path.join('uploads', `${ctx.message.video.file_id}.mp4`);
    log.info('Downloading video from Telegram', { userId: ctx.from.id, url, dest });
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
    log.info('Saving video to storage', { userId: ctx.from.id, dest, size: buf.length });
    await storageSave(dest, buf, { contentType: 'video/mp4' });
  s.files.push(dest);
  sessions.set(ctx.from.id, s);
    log.info('Video saved successfully', { userId: ctx.from.id, fileCount: s.files.length, dest });
    await ctx.reply(`✅ Success saved video (${s.files.length}). Send more or type "done".`);
  } catch (error) {
    log.error('Failed to save video', { error: error instanceof Error ? error.message : String(error), userId: ctx.from.id, fileId: ctx.message.video.file_id });
    await ctx.reply('❌ Failed to save video. Please try again.');
  }
});

BOT.on('photo', async (ctx) => {
  log.info('User sent photo', { userId: ctx.from.id, photoCount: ctx.message.photo.length });
  try {
    const s = sessions.get(ctx.from.id) || { files: [] };
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    log.info('Getting photo file from Telegram', { userId: ctx.from.id, fileId: photo.file_id, fileSize: photo.file_size });
    const file = await ctx.telegram.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const dest = path.join('uploads', `${photo.file_id}.jpg`);
    log.info('Downloading photo from Telegram', { userId: ctx.from.id, url, dest });
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    log.info('Saving photo to storage', { userId: ctx.from.id, dest, size: buf.length });
    await storageSave(dest, buf, { contentType: 'image/jpeg' });
    s.files.push(dest);
    sessions.set(ctx.from.id, s);
    log.info('Photo saved successfully', { userId: ctx.from.id, fileCount: s.files.length, dest });
    await ctx.reply(`✅ Success saved photo (${s.files.length}). Send more or type "done".`);
  } catch (error) {
    log.error('Failed to save photo', { error: error instanceof Error ? error.message : String(error), userId: ctx.from.id });
    await ctx.reply('❌ Failed to save photo. Please try again.');
  }
});

BOT.on('document', async (ctx) => {
  try {
    const document = ctx.message.document;
    
    const imageMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!imageMimeTypes.includes(document.mime_type)) {
      await ctx.reply('❌ Please send an image file (JPEG, PNG, GIF, or WebP).');
      return;
    }
    
    const s = sessions.get(ctx.from.id) || { files: [] };
    const file = await ctx.telegram.getFile(document.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    let ext = '.jpg';
    if (document.mime_type === 'image/png') ext = '.png';
    else if (document.mime_type === 'image/gif') ext = '.gif';
    else if (document.mime_type === 'image/webp') ext = '.webp';
    
    const dest = path.join('uploads', `${document.file_id}${ext}`);
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    await storageSave(dest, buf, { contentType: document.mime_type || 'application/octet-stream' });
    s.files.push(dest);
    sessions.set(ctx.from.id, s);
    await ctx.reply(`✅ Success saved image file (${s.files.length}). Send more or type "done".`);
  } catch (error) {
    await ctx.reply('❌ Failed to save image file. Please try again.');
    log.warn('Failed to save document', { error: error instanceof Error ? error.message : String(error), userId: ctx.from.id });
  }
});

BOT.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();
  log.info('User sent text message', { userId: ctx.from.id, text: text.substring(0, 100), textLength: text.length });
  const existing = sessions.get(ctx.from.id);

  if (!existing) {
    log.info('No active session for user', { userId: ctx.from.id });
    return;
  }

  const s = existing;
  log.info('Processing text in session', { userId: ctx.from.id, sessionState: s.expecting, hasFiles: s.files?.length > 0, hasAccountSetup: !!s.accountSetup });

  if (s.accountSetup) {
    log.info('Processing account setup', { userId: ctx.from.id, platform: s.accountSetup.platform, stage: s.accountSetup.stage });
    if (s.accountSetup.stage === 'username') {
      const parts = text.trim().split(/\s+/);
      log.info('Parsing account credentials', { userId: ctx.from.id, partsCount: parts.length, hasPassword: parts.length > 1, has2FA: parts.length > 2 });
      if (parts.length < 2) {
        await ctx.reply('❌ Please send: `username password 2fa_code` (or `username password skip` if no 2FA)');
        return;
      }
      
      s.accountSetup.username = parts[0].replace(/^@/, '');
      s.accountSetup.password = parts[1];
      s.accountSetup.twoFactorCode = parts[2] === 'skip' ? undefined : parts[2];
      s.accountSetup.nickname = s.accountSetup.username; // Use username as default nickname
      s.accountSetup.stage = 'login';
      sessions.set(ctx.from.id, s);
      
      log.info('Starting account login', { userId: ctx.from.id, platform: s.accountSetup.platform, username: s.accountSetup.username, has2FA: !!s.accountSetup.twoFactorCode });
      await ctx.reply('🔐 Logging in with all credentials...');
      
      if (s.accountSetup.platform === 'instagram') {
        // Use instagrapi service for Instagram login
        log.info('Using instagrapi service for Instagram login', { userId: ctx.from.id, username: s.accountSetup.username });
        const { InstagrapiClient } = await import('./instagrapi-client.js');
        const ig = new InstagrapiClient();
        
        try {
          log.info('Calling instagrapi login', { userId: ctx.from.id, username: s.accountSetup.username, has2FA: !!s.accountSetup.twoFactorCode });
          const result = await ig.login({
            username: s.accountSetup.username!,
            password: s.accountSetup.password!,
            verification_code: s.accountSetup.twoFactorCode
          });
          
          log.info('Instagrapi login result', { userId: ctx.from.id, success: result.success, hasSettings: !!result.settings, detail: result.detail });
          
          if (result.success && result.settings) {
            // Save settings JSON instead of cookies
            const file = cookieFilePath(s.accountSetup.platform, ctx.from.id, s.accountSetup.nickname!);
            log.info('Saving account settings to file', { userId: ctx.from.id, file, settingsSize: JSON.stringify(result.settings).length });
            await writeEncryptedJson(file, result.settings);
            
            // Save to database
            log.info('Saving account to database', { userId: ctx.from.id, platform: s.accountSetup.platform, nickname: s.accountSetup.nickname, username: s.accountSetup.username });
            await deleteAccount.run(String(ctx.from.id), s.accountSetup.platform, s.accountSetup.nickname!);
            await addAccount.run(String(ctx.from.id), s.accountSetup.platform, s.accountSetup.nickname!, s.accountSetup.username!, file, dayjs().toISOString());
            
            await ctx.reply(`✅ Successfully logged in and saved ${s.accountSetup.platform} account "${s.accountSetup.nickname}".`, mainMenu());
            log.info('Account setup completed with instagrapi', { platform: s.accountSetup.platform, nickname: s.accountSetup.nickname, userId: ctx.from.id });
          } else {
            log.error('Instagrapi login failed', { userId: ctx.from.id, detail: result.detail });
            await ctx.reply(`❌ Login failed: ${result.detail || 'Unknown error'}\n\nPlease try again with /add_account.`);
          }
        } catch (error) {
          log.error('Login failed during account setup', { error: error instanceof Error ? error.message : String(error), userId: ctx.from.id, username: s.accountSetup.username });
          await ctx.reply(`❌ Login failed: ${error instanceof Error ? error.message : String(error)}\n\nPlease try again with /add_account.`);
        }
      } else if (s.accountSetup.platform === 'tiktok') {
        // For TikTok, still use cookie method but with fast setup
        await ctx.reply(`⚠️ TikTok login requires cookies.\n\nPlease paste your TikTok cookies (JSON or tab-separated format from browser dev tools).\n\nAccount: @${s.accountSetup.username}\nNickname: ${s.accountSetup.nickname}`);
      s.accountSetup.stage = 'cookies';
      sessions.set(ctx.from.id, s);
      return;
    }
      
      delete s.accountSetup;
      sessions.set(ctx.from.id, s);
      return;
    }
    
    if (s.accountSetup.stage === 'cookies') {
      // Handle TikTok cookie saving
      await saveCookies(ctx, s.accountSetup.platform, s.accountSetup.username!, s.accountSetup.nickname!, text);
      delete s.accountSetup;
      sessions.set(ctx.from.id, s);
      return;
    }
  }

  if (lower === 'done' && s.files?.length && !s.expecting) {
    const fileCount = s.files.length;
    log.info('User finished uploading files', { userId: ctx.from.id, fileCount });
    
    if (fileCount === 1) {
      // Single file - use existing flow
    await ctx.reply('Choose platforms:', Markup.inlineKeyboard([
        [Markup.button.callback('Instagram', 'pf_ig'), Markup.button.callback('TikTok', 'pf_tt'), Markup.button.callback('Both', 'pf_both')],
        [Markup.button.callback('🎯 Multi-Account', 'pf_multi')]
      ]));
    } else {
      // Multiple files - offer bulk options
      await ctx.reply(`📦 **Bulk Upload Detected** (${fileCount} files)\n\nChoose scheduling option:`, Markup.inlineKeyboard([
        [Markup.button.callback('📅 Schedule All at Intervals', 'bulk_intervals'), Markup.button.callback('⚡ Post All Now', 'bulk_now')],
        [Markup.button.callback('📋 Smart Spread', 'bulk_smart'), Markup.button.callback('🔄 Individual Setup', 'bulk_individual')]
      ]));
    }
    return;
  }

  if (s.expecting === 'datetime') {
    let d;
    const textLower = text.toLowerCase();
    
    if (textLower.includes('tomorrow')) {
      d = dayjs().add(1, 'day');
      if (textLower.includes('9am') || textLower.includes('9 am')) d = d.hour(9).minute(0);
      else if (textLower.includes('12pm') || textLower.includes('12 pm') || textLower.includes('noon')) d = d.hour(12).minute(0);
      else if (textLower.includes('6pm') || textLower.includes('6 pm')) d = d.hour(18).minute(0);
      else if (textLower.includes('9pm') || textLower.includes('9 pm')) d = d.hour(21).minute(0);
    } else if (textLower.includes('today')) {
      d = dayjs();
      if (textLower.includes('9am') || textLower.includes('9 am')) d = d.hour(9).minute(0);
      else if (textLower.includes('12pm') || textLower.includes('12 pm') || textLower.includes('noon')) d = d.hour(12).minute(0);
      else if (textLower.includes('6pm') || textLower.includes('6 pm')) d = d.hour(18).minute(0);
      else if (textLower.includes('9pm') || textLower.includes('9 pm')) d = d.hour(21).minute(0);
    } else {
      d = dayjs(text.replace(' ', 'T'));
    }
    
    if (!d.isValid()) {
      await ctx.reply('❌ Could not parse time. Try:\n• `tomorrow 9am`\n• `2025-10-13 19:30`\n• `today 6pm`');
      return;
    }
    
    if (d.isBefore(dayjs())) {
      await ctx.reply('⚠️ That time is in the past. Please choose a future time.');
      return;
    }
    
    s.atISO = d.toISOString();
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply(`✅ Scheduled for ${d.format('YYYY-MM-DD HH:mm')}\n✍️ Now send a caption (or type "skip").`);
    return;
  }

  if (s.expecting === 'everyHours') {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n <= 0) {
      await ctx.reply('Please send a positive number of hours (e.g., 4).');
      return;
    }
    s.everyHours = n;
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply('✍️ Now send a caption (or type "skip").');
    return;
  }

  if (s.expecting === 'settingsHashtags') {
    const uid = String(ctx.from.id);
    await ensureUserSettings.run(uid, '#fyp,#viral', 3, 'both');
    const settings = await getSettings.get(uid) as any;
    if (lower === 'skip') {
      await ctx.reply('No changes.', mainMenu());
    } else {
      await updateSettings.run({
        tg_user_id: uid,
        default_hashtags: ctx.message.text,
        default_every_hours: settings?.default_every_hours ?? 3,
        platform_pref: settings?.platform_pref ?? 'both'
      });
      await ctx.reply(`Saved defaults: ${ctx.message.text}`, mainMenu());
    }
    sessions.delete(ctx.from.id);
    return;
  }

  if (s.expecting === 'caption') {
    console.log('Caption received for user:', ctx.from.id, 'text:', ctx.message.text);
    s.caption = lower === 'skip' ? '' : ctx.message.text;
    s.expecting = 'hashtags';
    sessions.set(ctx.from.id, s);
    await ctx.reply('Add hashtags (comma-separated) or type "defaults".');
    return;
  }

  if (s.expecting === 'hashtags') {
    console.log('Hashtags received for user:', ctx.from.id, 'text:', ctx.message.text);
    if (lower === 'defaults') {
      const set = await getSettings.get(String(ctx.from.id)) as any;
      s.hashtags = set?.default_hashtags || '#fyp,#viral';
    } else {
      s.hashtags = ctx.message.text;
    }
    s.expecting = undefined;
    sessions.set(ctx.from.id, s);
    console.log('About to persist posts for user:', ctx.from.id, 'session:', s);
    const summary = await persistScheduledPosts(ctx.from.id, s);
    await ctx.reply(summary, mainMenu());
    sessions.delete(ctx.from.id);
    return;
  }

  // Bulk upload handlers
  if (s.expecting === 'bulkInterval') {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n <= 0) {
      await ctx.reply('Please send a positive number of hours (e.g., 2, 4, 6).');
      return;
    }
    s.bulkInterval = n;
    s.expecting = 'bulkCaption';
    sessions.set(ctx.from.id, s);
    
    const fileCount = s.files.length;
    const totalHours = (fileCount - 1) * n;
    const startTime = dayjs().format('HH:mm');
    const endTime = dayjs().add(totalHours, 'hour').format('HH:mm');
    
    await ctx.reply(`📅 **Interval Scheduling** (${fileCount} files)\n\n• Every ${n} hours\n• Starts: ${startTime}\n• Ends: ${endTime}\n\n✍️ Send a caption for all posts (or type "skip"):`);
    return;
  }

  if (s.expecting === 'bulkCaption') {
    log.info('Bulk caption received', { userId: ctx.from.id, captionLength: ctx.message.text.length });
    s.caption = lower === 'skip' ? '' : ctx.message.text;
    s.expecting = 'bulkHashtags';
    sessions.set(ctx.from.id, s);
    await ctx.reply('Add hashtags (comma-separated) or type "defaults":');
    return;
  }

  if (s.expecting === 'bulkHashtags') {
    log.info('Bulk hashtags received', { userId: ctx.from.id, hashtags: ctx.message.text });
    if (lower === 'defaults') {
      const set = await getSettings.get(String(ctx.from.id)) as any;
      s.hashtags = set?.default_hashtags || '#fyp,#viral';
    } else {
      s.hashtags = ctx.message.text;
    }
    s.expecting = undefined;
    sessions.set(ctx.from.id, s);
    await scheduleBulkPosts(ctx, s);
    return;
  }

  if (s.expecting === 'individualCaption') {
    log.info('Individual caption received', { userId: ctx.from.id, fileIndex: s.currentFileIndex, captionLength: ctx.message.text.length });
    s.caption = lower === 'skip' ? '' : ctx.message.text;
    s.expecting = 'individualHashtags';
    sessions.set(ctx.from.id, s);
    await ctx.reply('Add hashtags (comma-separated) or type "defaults":');
    return;
  }

  if (s.expecting === 'individualHashtags') {
    log.info('Individual hashtags received', { userId: ctx.from.id, fileIndex: s.currentFileIndex, hashtags: ctx.message.text });
    if (lower === 'defaults') {
      const set = await getSettings.get(String(ctx.from.id)) as any;
      s.hashtags = set?.default_hashtags || '#fyp,#viral';
    } else {
      s.hashtags = ctx.message.text;
    }
    s.expecting = undefined;
    sessions.set(ctx.from.id, s);
    await scheduleIndividualPost(ctx, s);
    return;
  }
});

BOT.action('pf_ig', async (ctx)=>{ await selectPlatform(ctx,'instagram'); });
BOT.action('pf_tt', async (ctx)=>{ await selectPlatform(ctx,'tiktok'); });
BOT.action('pf_both', async (ctx)=>{ await selectPlatform(ctx,'both'); });
BOT.action('pf_multi', async (ctx)=>{ await selectMultiAccount(ctx); });

// Bulk upload handlers
BOT.action('bulk_intervals', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.bulkMode = 'intervals';
  s.expecting = 'bulkInterval';
  sessions.set(ctx.from!.id, s);
  
  await ctx.reply(`📅 **Interval Scheduling**\n\nHow many hours between each post?\n\nExamples:\n• 2 = Every 2 hours\n• 6 = Every 6 hours\n• 12 = Every 12 hours`);
});

BOT.action('bulk_now', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.bulkMode = 'now';
  sessions.set(ctx.from!.id, s);
  
  await ctx.reply('Choose platforms for bulk posting:', Markup.inlineKeyboard([
    [Markup.button.callback('Instagram', 'bulk_pf_ig'), Markup.button.callback('TikTok', 'bulk_pf_tt'), Markup.button.callback('Both', 'bulk_pf_both')]
  ]));
});

BOT.action('bulk_smart', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.bulkMode = 'smart';
  sessions.set(ctx.from!.id, s);
  
  await ctx.reply('Choose platforms for smart spread:', Markup.inlineKeyboard([
    [Markup.button.callback('Instagram', 'bulk_pf_ig'), Markup.button.callback('TikTok', 'bulk_pf_tt'), Markup.button.callback('Both', 'bulk_pf_both')]
  ]));
});

BOT.action('bulk_individual', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.bulkMode = 'individual';
  sessions.set(ctx.from!.id, s);
  
  await ctx.reply('🔄 **Individual Setup**\n\nYou\'ll configure each file separately.\n\nChoose platforms:', Markup.inlineKeyboard([
    [Markup.button.callback('Instagram', 'bulk_pf_ig'), Markup.button.callback('TikTok', 'bulk_pf_tt'), Markup.button.callback('Both', 'bulk_pf_both')]
  ]));
});

// Bulk platform handlers
BOT.action('bulk_pf_ig', async (ctx)=>{ await selectBulkPlatform(ctx,'instagram'); });
BOT.action('bulk_pf_tt', async (ctx)=>{ await selectBulkPlatform(ctx,'tiktok'); });
BOT.action('bulk_pf_both', async (ctx)=>{ await selectBulkPlatform(ctx,'both'); });

async function selectMultiAccount(ctx: any) {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  
  // Get all Instagram accounts for this user
  const igAccounts = await listAccounts.all(uid, 'instagram') as any[];
  
  if (igAccounts.length < 2) {
    await ctx.reply('❌ **Multi-Account Posting**\n\nYou need at least 2 Instagram accounts to use this feature.\n\nAdd more accounts in: Accounts → Add IG', Markup.inlineKeyboard([
      [Markup.button.callback('📤 Upload Videos', 'upload')],
      [Markup.button.callback('👥 Accounts', 'accounts')],
      [Markup.button.callback('↩️ Back', 'back')]
    ]));
    return;
  }
  
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.platform = 'multi_ig';
  s.multiAccounts = [];
  sessions.set(ctx.from.id, s);
  
  // Create account selection buttons
  const buttons = [];
  for (let i = 0; i < igAccounts.length; i += 2) {
    const row = [];
    row.push(Markup.button.callback(`☐ ${igAccounts[i].nickname}`, `multi_acc_${igAccounts[i].nickname}`));
    if (i + 1 < igAccounts.length) {
      row.push(Markup.button.callback(`☐ ${igAccounts[i + 1].nickname}`, `multi_acc_${igAccounts[i + 1].nickname}`));
    }
    buttons.push(row);
  }
  
  buttons.push([Markup.button.callback('✅ Continue', 'multi_continue')]);
  buttons.push([Markup.button.callback('↩️ Back', 'upload')]);
  
  await ctx.reply(`🎯 **Multi-Account Posting**\n\nSelect Instagram accounts to post to:\n\n📋 Available accounts: ${igAccounts.length}\n☐ Selected: 0`, Markup.inlineKeyboard(buttons));
}

// Multi-account selection handlers
BOT.action(/^multi_acc_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const nickname = ctx.match[1];
  const s = sessions.get(ctx.from.id) || { files: [] };
  
  if (!s.multiAccounts) s.multiAccounts = [];
  
  const index = s.multiAccounts.indexOf(nickname);
  if (index > -1) {
    // Remove account
    s.multiAccounts.splice(index, 1);
  } else {
    // Add account
    s.multiAccounts.push(nickname);
  }
  
  sessions.set(ctx.from.id, s);
  
  // Update button text
  const isSelected = s.multiAccounts.includes(nickname);
  const buttonText = `${isSelected ? '☑️' : '☐'} ${nickname}`;
  
  // Update the message with new selection count
  const uid = String(ctx.from.id);
  const igAccounts = await listAccounts.all(uid, 'instagram') as any[];
  
  const buttons = [];
  for (let i = 0; i < igAccounts.length; i += 2) {
    const row = [];
    const isSelected1 = s.multiAccounts.includes(igAccounts[i].nickname);
    row.push(Markup.button.callback(`${isSelected1 ? '☑️' : '☐'} ${igAccounts[i].nickname}`, `multi_acc_${igAccounts[i].nickname}`));
    if (i + 1 < igAccounts.length) {
      const isSelected2 = s.multiAccounts.includes(igAccounts[i + 1].nickname);
      row.push(Markup.button.callback(`${isSelected2 ? '☑️' : '☐'} ${igAccounts[i + 1].nickname}`, `multi_acc_${igAccounts[i + 1].nickname}`));
    }
    buttons.push(row);
  }
  
  buttons.push([Markup.button.callback('✅ Continue', 'multi_continue')]);
  buttons.push([Markup.button.callback('↩️ Back', 'upload')]);
  
  await ctx.editMessageText(`🎯 **Multi-Account Posting**\n\nSelect Instagram accounts to post to:\n\n📋 Available accounts: ${igAccounts.length}\n☑️ Selected: ${s.multiAccounts.length}`, Markup.inlineKeyboard(buttons));
});

BOT.action('multi_continue', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from.id) || { files: [] };
  
  if (!s.multiAccounts || s.multiAccounts.length === 0) {
    await ctx.reply('❌ Please select at least one account to continue.');
    return;
  }
  
  if (s.multiAccounts.length > 5) {
    await ctx.reply('❌ Maximum 5 accounts allowed for multi-posting to avoid rate limits.');
    return;
  }
  
  // Continue with scheduling flow
  await ctx.reply(`✅ **Selected ${s.multiAccounts.length} accounts:**\n\n${s.multiAccounts.map(acc => `• ${acc}`).join('\n')}\n\nWhen do you want to post?`, Markup.inlineKeyboard([
    [Markup.button.callback('⚡ Now', 'when_now'), Markup.button.callback('⏰ In 2h', 'when_after2h')],
    [Markup.button.callback('📅 Tomorrow', 'when_tomorrow'), Markup.button.callback('🕐 Custom Time', 'when_at')],
    [Markup.button.callback('↩️ Back', 'upload')]
  ]));
});

async function selectPlatform(ctx:any, p:'instagram'|'tiktok'|'both'){
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.platform = p;
  sessions.set(ctx.from.id, s);
  await ctx.answerCbQuery();

  if (p === 'instagram' || p === 'both') {
    const igs = await listAccounts.all(String(ctx.from.id), 'instagram') as any[];
    console.log('Instagram accounts query result:', igs);
    if (!Array.isArray(igs) || igs.length === 0) {
      await ctx.reply('No Instagram accounts saved. Add one in Accounts → Add IG.');
    } else {
      await ctx.reply('Pick Instagram account:', Markup.inlineKeyboard(splitButtons(igs.map(r=>Markup.button.callback(r.nickname, 'igacc_'+r.nickname)))));
    }
  }
  
  if (p === 'tiktok' || p === 'both') {
    const tts = await listAccounts.all(String(ctx.from.id), 'tiktok') as any[];
    console.log('TikTok accounts query result:', tts);
    if (!Array.isArray(tts) || tts.length === 0) {
      await ctx.reply('No TikTok accounts saved. Add one in Accounts → Add TT.');
    } else {
      await ctx.reply('Pick TikTok account:', Markup.inlineKeyboard(splitButtons(tts.map(r=>Markup.button.callback(r.nickname, 'ttacc_'+r.nickname)))));
    }
  }
}

async function selectBulkPlatform(ctx:any, p:'instagram'|'tiktok'|'both'){
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.platform = p;
  sessions.set(ctx.from.id, s);
  await ctx.answerCbQuery();

  if (p === 'instagram' || p === 'both') {
    const igs = await listAccounts.all(String(ctx.from.id), 'instagram') as any[];
    if (!Array.isArray(igs) || igs.length === 0) {
      await ctx.reply('No Instagram accounts saved. Add one in Accounts → Add IG.');
      return;
    }
  }
  if (p === 'tiktok' || p === 'both') {
    const tts = await listAccounts.all(String(ctx.from.id), 'tiktok') as any[];
    if (!Array.isArray(tts) || tts.length === 0) {
      await ctx.reply('No TikTok accounts saved. Add one in Accounts → Add TT.');
      return;
    }
  }

  // Handle different bulk modes
  if (s.bulkMode === 'now') {
    await handleBulkNow(ctx, s);
  } else if (s.bulkMode === 'smart') {
    await handleBulkSmart(ctx, s);
  } else if (s.bulkMode === 'individual') {
    await handleBulkIndividual(ctx, s);
  }
}

async function handleBulkNow(ctx: any, s: Session) {
  const fileCount = s.files.length;
  log.info('Handling bulk now upload', { userId: ctx.from.id, fileCount, platform: s.platform });
  
  // For bulk now, we'll schedule all files immediately
  s.expecting = 'bulkCaption';
  sessions.set(ctx.from.id, s);
  
  await ctx.reply(`⚡ **Bulk Post Now** (${fileCount} files)\n\nAll files will be posted immediately.\n\n✍️ Send a caption for all posts (or type "skip"):`);
}

async function handleBulkSmart(ctx: any, s: Session) {
  const fileCount = s.files.length;
  log.info('Handling bulk smart upload', { userId: ctx.from.id, fileCount, platform: s.platform });
  
  // Smart spread: distribute across optimal times (9AM, 1PM, 5PM, 9PM)
  s.expecting = 'bulkCaption';
  sessions.set(ctx.from.id, s);
  
  await ctx.reply(`🧠 **Smart Spread** (${fileCount} files)\n\nPosts will be distributed across optimal times:\n• 9AM, 1PM, 5PM, 9PM\n\n✍️ Send a caption for all posts (or type "skip"):`);
}

async function handleBulkIndividual(ctx: any, s: Session) {
  const fileCount = s.files.length;
  log.info('Handling bulk individual upload', { userId: ctx.from.id, fileCount, platform: s.platform });
  
  // Individual setup: configure each file separately
  s.currentFileIndex = 0;
  s.expecting = 'individualCaption';
  sessions.set(ctx.from.id, s);
  
  await ctx.reply(`🔄 **Individual Setup** (${fileCount} files)\n\nFile 1 of ${fileCount}\n\n✍️ Send a caption for this file (or type "skip"):`);
}

BOT.on('callback_query', async (ctx, next)=>{
  const data = (ctx.callbackQuery as any).data as string;
  if (data?.startsWith('igacc_')) {
    const nick = data.slice(6);
    const s = sessions.get(ctx.from!.id) || { files: [] };
    s.igAccount = nick;
    sessions.set(ctx.from!.id, s);
    await ctx.answerCbQuery('IG account: '+nick);
    await maybeAskWhen(ctx, s);
    return;
  }
  if (data?.startsWith('ttacc_')) {
    const nick = data.slice(6);
    const s = sessions.get(ctx.from!.id) || { files: [] };
    s.ttAccount = nick;
    sessions.set(ctx.from!.id, s);
    await ctx.answerCbQuery('TT account: '+nick);
    await maybeAskWhen(ctx, s);
    return;
  }
  await next();
});

async function maybeAskWhen(ctx:any, s:Session){
  const needsIG = (s.platform==='instagram' || s.platform==='both') && !s.igAccount;
  const needsTT = (s.platform==='tiktok' || s.platform==='both') && !s.ttAccount;
  if (!needsIG && !needsTT){
    await ctx.reply('📅 **Quick Schedule Options:**', Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Post Now', 'w_now'), Markup.button.callback('⏰ In 2 Hours', 'w_2h')],
      [Markup.button.callback('📆 Tomorrow 9AM', 'w_tomorrow'), Markup.button.callback('🔄 Every 3 Hours', 'w_every')],
      [Markup.button.callback('⚙️ Custom Time', 'w_at'), Markup.button.callback('📋 Smart Schedule', 'w_smart')]
    ]));
  }
}

BOT.action('w_now', async (ctx)=>{ 
  console.log('Post Now clicked for user:', ctx.from.id);
  await chooseWhen(ctx,'now'); 
});
BOT.action('w_2h', async (ctx)=>{ await chooseWhen(ctx,'after2h'); });
BOT.action('w_tomorrow', async (ctx)=>{ await chooseWhen(ctx,'tomorrow'); });
BOT.action('w_at', async (ctx)=>{ await chooseWhen(ctx,'at'); });
BOT.action('w_every', async (ctx)=>{ await chooseWhen(ctx,'everyXh'); });
BOT.action('w_smart', async (ctx)=>{ await chooseWhen(ctx,'smart'); });

async function chooseWhen(ctx:any, w:'now'|'after2h'|'tomorrow'|'at'|'everyXh'|'smart'){
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.when = w;
  sessions.set(ctx.from.id, s);
  console.log('chooseWhen called:', w, 'for user:', ctx.from.id, 'files:', s.files?.length);
  await ctx.answerCbQuery();
  
  if (w === 'at') {
    s.expecting = 'datetime';
    sessions.set(ctx.from.id, s);
    await ctx.reply('📅 Send a datetime like `2025-10-13 19:30` or `tomorrow 9am`');
  } else if (w === 'everyXh') {
    s.expecting = 'everyHours';
    sessions.set(ctx.from.id, s);
    await ctx.reply('⏰ How many hours between posts? (e.g., 3)');
  } else if (w === 'tomorrow') {
    s.atISO = dayjs().add(1, 'day').hour(9).minute(0).toISOString();
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply('✅ Scheduled for tomorrow 9AM\n✍️ Send a caption (or type "skip").');
  } else if (w === 'smart') {
    s.when = 'smart';
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply('🧠 **Smart Schedule:** Posts will be spread across optimal times (9AM, 1PM, 5PM, 9PM)\n✍️ Send a caption (or type "skip").');
  } else {
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply('✍️ Send a caption (or type "skip").');
  }
}

async function persistScheduledPosts(userId:number, s:Session){
  console.log('persistScheduledPosts called for user:', userId, 'session:', s);
  const uid = String(userId);
  const settings = await getSettings.get(uid) as any;
  const files = s.files || [];
  console.log('Files to process:', files.length, files);
  if (!files.length) {
    return '⚠️ No files queued.';
  }

  const platform = s.platform || (settings?.platform_pref as 'instagram'|'tiktok'|'both') || 'both';
  const when = s.when || 'after2h';
  const now = dayjs();
  let firstAt = now;

  if (when === 'after2h') {
    const lastRow = await lastScheduledForUser.get(uid) as { schedule_at?: string } | undefined;
    const lastAt = lastRow?.schedule_at ? dayjs(lastRow.schedule_at) : null;
    const reference = lastAt && lastAt.isValid() && lastAt.isAfter(now) ? lastAt : now;
    firstAt = reference.add(2, 'hour');
  } else if (when === 'at' && s.atISO) {
    const custom = dayjs(s.atISO);
    if (custom.isValid()) firstAt = custom;
  } else if (when === 'tomorrow' && s.atISO) {
    firstAt = dayjs(s.atISO);
  } else if (when === 'now') {
    firstAt = now.add(1, 'minute'); // Small delay to ensure it's in the future
  }

  const defaultEvery = settings?.default_every_hours ?? 3;
  const everyH = when === 'everyXh'
    ? (s.everyHours ?? defaultEvery)
    : null;

  const scheduledTimes: dayjs.Dayjs[] = [];
  
  if (when === 'smart') {
    const optimalTimes = [9, 13, 17, 21]; // 9AM, 1PM, 5PM, 9PM
    for (let i = 0; i < files.length; i++) {
      const dayOffset = Math.floor(i / optimalTimes.length);
      const timeIndex = i % optimalTimes.length;
      const targetDay = now.add(dayOffset, 'day');
      const slot = targetDay.hour(optimalTimes[timeIndex]).minute(0).second(0);
      scheduledTimes.push(slot);
    }
  } else {
  for (let i = 0; i < files.length; i++) {
    const slot = (when === 'everyXh')
      ? firstAt.add(i * (everyH ?? defaultEvery), 'hour')
      : firstAt.add(i * 3, 'minute');
    scheduledTimes.push(slot);
    }
  }

  for (let i = 0; i < files.length; i++) {
    const slot = scheduledTimes[i];
    const postId = uuid();
    console.log('Inserting post:', {
      id: postId,
      userId: uid,
      platform,
      igAccount: s.igAccount,
      file: files[i],
      caption: s.caption,
      hashtags: s.hashtags,
      scheduleAt: slot.toISOString()
    });
    
    try {
      if (platform === 'multi_ig' && s.multiAccounts && s.multiAccounts.length > 0) {
        // Multi-account posting: create one post per account
        for (const accountNickname of s.multiAccounts) {
          const multiPostId = uuid();
          const result = await insertPost.run(
            multiPostId,
            uid,
            'instagram',
            accountNickname,
            null,
            files[i],
            s.caption ?? '',
            s.hashtags ?? '',
            when === 'everyXh' ? 'everyXh' : 'at',
            slot.toISOString(),
            everyH ?? null,
            dayjs().toISOString()
          );
          
          log.info('Multi-account post scheduled', { 
            postId: multiPostId, 
            userId: uid, 
            platform: 'instagram',
            account: accountNickname,
            file: files[i], 
            scheduleAt: slot.toISOString(),
            insertResult: result 
          });
        }
      } else {
        // Single account posting
        const result = await insertPost.run(
          postId,
      uid,
      platform,
      s.igAccount || null,
      s.ttAccount || null,
      files[i],
      s.caption ?? '',
      s.hashtags ?? '',
      when === 'everyXh' ? 'everyXh' : 'at',
      slot.toISOString(),
      everyH ?? null,
      dayjs().toISOString()
    );
        
        log.info('Post scheduled successfully', { 
          postId, 
          userId: uid, 
          platform, 
          file: files[i], 
          scheduleAt: slot.toISOString(),
          insertResult: result 
        });
      }
    } catch (error) {
      log.error('Failed to schedule post', { 
        postId, 
        userId: uid, 
        platform, 
        file: files[i], 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  const firstSlot = scheduledTimes[0];
  const formatted = firstSlot ? firstSlot.format('YYYY-MM-DD HH:mm') : 'unknown time';
  
  if (platform === 'multi_ig' && s.multiAccounts && s.multiAccounts.length > 0) {
    const totalPosts = files.length * s.multiAccounts.length;
    return `✅ Queued ${totalPosts} posts across ${s.multiAccounts.length} accounts. First at ${formatted}.`;
  } else {
  return `✅ Queued ${files.length} post(s). First at ${formatted}.`;
  }
}

async function scheduleBulkPosts(ctx: any, s: Session) {
  log.info('Scheduling bulk posts', { userId: ctx.from.id, fileCount: s.files.length, bulkMode: s.bulkMode });
  
  const uid = String(ctx.from.id);
  const files = s.files || [];
  const platform = s.platform || 'both';
  
  if (!files.length) {
    await ctx.reply('⚠️ No files to schedule.', mainMenu());
    sessions.delete(ctx.from.id);
    return;
  }

  const scheduledTimes: dayjs.Dayjs[] = [];
  const now = dayjs();

  if (s.bulkMode === 'now') {
    // Schedule all files immediately with small delays
    for (let i = 0; i < files.length; i++) {
      scheduledTimes.push(now.add(i * 2, 'minute')); // 2 minutes between posts
    }
  } else if (s.bulkMode === 'smart') {
    // Smart spread across optimal times
    const optimalTimes = [9, 13, 17, 21]; // 9AM, 1PM, 5PM, 9PM
    for (let i = 0; i < files.length; i++) {
      const dayOffset = Math.floor(i / optimalTimes.length);
      const timeIndex = i % optimalTimes.length;
      const targetDay = now.add(dayOffset, 'day');
      const slot = targetDay.hour(optimalTimes[timeIndex]).minute(0).second(0);
      scheduledTimes.push(slot);
    }
  } else if (s.bulkMode === 'intervals' && s.bulkInterval) {
    // Schedule at specified intervals
    for (let i = 0; i < files.length; i++) {
      scheduledTimes.push(now.add(i * s.bulkInterval, 'hour'));
    }
  }

  // Insert all posts
  for (let i = 0; i < files.length; i++) {
    const slot = scheduledTimes[i];
    const postId = uuid();
    
    try {
      if (platform === 'multi_ig' && s.multiAccounts && s.multiAccounts.length > 0) {
        // Multi-account posting: create one post per account
        for (const accountNickname of s.multiAccounts) {
          const multiPostId = uuid();
          await insertPost.run(
            multiPostId,
            uid,
            'instagram',
            accountNickname,
            null,
            files[i],
            s.caption ?? '',
            s.hashtags ?? '',
            'at',
            slot.toISOString(),
            null,
            dayjs().toISOString()
          );
          log.info('Multi-account bulk post inserted', { postId: multiPostId, account: accountNickname, fileIndex: i, scheduleAt: slot.toISOString() });
        }
      } else {
        // Single account posting
        await insertPost.run(
          postId,
          uid,
          platform,
          s.igAccount || null,
          s.ttAccount || null,
          files[i],
          s.caption ?? '',
          s.hashtags ?? '',
          'at',
          slot.toISOString(),
          null,
          dayjs().toISOString()
        );
        log.info('Bulk post inserted', { postId, fileIndex: i, scheduleAt: slot.toISOString() });
      }
    } catch (error) {
      log.error('Error inserting bulk post', { postId, fileIndex: i, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const firstSlot = scheduledTimes[0];
  const lastSlot = scheduledTimes[scheduledTimes.length - 1];
  const formatted = firstSlot ? firstSlot.format('YYYY-MM-DD HH:mm') : 'unknown time';
  const endFormatted = lastSlot ? lastSlot.format('YYYY-MM-DD HH:mm') : 'unknown time';
  
  if (platform === 'multi_ig' && s.multiAccounts && s.multiAccounts.length > 0) {
    const totalPosts = files.length * s.multiAccounts.length;
    await ctx.reply(`✅ **Multi-Account Bulk Upload Complete**\n\n📦 ${totalPosts} posts scheduled across ${s.multiAccounts.length} accounts\n📅 First: ${formatted}\n📅 Last: ${endFormatted}`, mainMenu());
  } else {
    await ctx.reply(`✅ **Bulk Upload Complete**\n\n📦 ${files.length} posts scheduled\n📅 First: ${formatted}\n📅 Last: ${endFormatted}`, mainMenu());
  }
  sessions.delete(ctx.from.id);
}

async function scheduleIndividualPost(ctx: any, s: Session) {
  log.info('Scheduling individual post', { userId: ctx.from.id, fileIndex: s.currentFileIndex, fileCount: s.files.length });
  
  const uid = String(ctx.from.id);
  const files = s.files || [];
  const platform = s.platform || 'both';
  const currentIndex = s.currentFileIndex || 0;
  
  if (currentIndex >= files.length) {
    await ctx.reply('✅ All posts scheduled!', mainMenu());
    sessions.delete(ctx.from.id);
    return;
  }

  // Schedule current file
  const postId = uuid();
  const scheduleAt = dayjs().add(currentIndex * 2, 'minute'); // 2 minutes between posts
  
  try {
    if (platform === 'multi_ig' && s.multiAccounts && s.multiAccounts.length > 0) {
      // Multi-account posting: create one post per account
      for (const accountNickname of s.multiAccounts) {
        const multiPostId = uuid();
        await insertPost.run(
          multiPostId,
          uid,
          'instagram',
          accountNickname,
          null,
          files[currentIndex],
          s.caption ?? '',
          s.hashtags ?? '',
          'at',
          scheduleAt.toISOString(),
          null,
          dayjs().toISOString()
        );
        log.info('Multi-account individual post inserted', { postId: multiPostId, account: accountNickname, fileIndex: currentIndex, scheduleAt: scheduleAt.toISOString() });
      }
    } else {
      // Single account posting
      await insertPost.run(
        postId,
        uid,
        platform,
        s.igAccount || null,
        s.ttAccount || null,
        files[currentIndex],
        s.caption ?? '',
        s.hashtags ?? '',
        'at',
        scheduleAt.toISOString(),
        null,
        dayjs().toISOString()
      );
      log.info('Individual post inserted', { postId, fileIndex: currentIndex, scheduleAt: scheduleAt.toISOString() });
    }
  } catch (error) {
    log.error('Error inserting individual post', { postId, fileIndex: currentIndex, error: error instanceof Error ? error.message : String(error) });
  }

  // Move to next file
  s.currentFileIndex = currentIndex + 1;
  
  if (s.currentFileIndex < files.length) {
    s.expecting = 'individualCaption';
    sessions.set(ctx.from.id, s);
    await ctx.reply(`🔄 **Individual Setup** (${files.length} files)\n\nFile ${s.currentFileIndex + 1} of ${files.length}\n\n✍️ Send a caption for this file (or type "skip"):`);
  } else {
    await ctx.reply(`✅ **Individual Setup Complete**\n\n📦 ${files.length} posts scheduled\n📅 All posts will be uploaded with 2-minute intervals`, mainMenu());
    sessions.delete(ctx.from.id);
  }
}

BOT.action('accounts', async (ctx)=>{
  await ctx.answerCbQuery();
  await ctx.reply('Accounts:', Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add IG', 'acc_add_ig'), Markup.button.callback('➕ Add TT', 'acc_add_tt')],
    [Markup.button.callback('📋 List IG', 'acc_list_ig'), Markup.button.callback('📋 List TT', 'acc_list_tt')],
    [Markup.button.callback('🔒 Revoke IG', 'acc_revoke_ig'), Markup.button.callback('🔒 Revoke TT', 'acc_revoke_tt')],
    [Markup.button.callback('↩️ Back', 'back')]
  ]));
});

BOT.action('acc_add_ig', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.accountSetup = { platform: 'instagram', stage: 'username' };
  sessions.set(ctx.from!.id, s);
  await ctx.reply('🔐 **Quick Instagram Setup**\n\nSend your Instagram credentials in this format:\n\n`username password 2fa_code`\n\nExample: `myusername mypassword 123456`\n\nIf no 2FA, use: `myusername mypassword skip`');
});
BOT.action('acc_add_tt', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.accountSetup = { platform: 'tiktok', stage: 'username' };
  sessions.set(ctx.from!.id, s);
  await ctx.reply('🔐 **Quick TikTok Setup**\n\nSend your TikTok credentials in this format:\n\n`username password 2fa_code`\n\nExample: `myusername mypassword 123456`\n\nIf no 2FA, use: `myusername mypassword skip`');
});

BOT.action('acc_list_ig', async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = await listAccounts.all(String(ctx.from!.id), 'instagram') as any[];
  await ctx.reply(rows.length? ('IG accounts:\n- '+rows.map(r=>r.nickname).join('\n- ')) : 'No IG accounts saved.');
});
BOT.action('acc_list_tt', async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = await listAccounts.all(String(ctx.from!.id), 'tiktok') as any[];
  await ctx.reply(rows.length? ('TT accounts:\n- '+rows.map(r=>r.nickname).join('\n- ')) : 'No TT accounts saved.');
});

BOT.action('acc_revoke_ig', async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = await listAccounts.all(String(ctx.from!.id), 'instagram') as any[];
  
  if (rows.length === 0) {
    await ctx.reply('No Instagram accounts found.');
    return;
  }
  
  // Create buttons for each account
  const buttons = rows.map(account => 
    [Markup.button.callback(`🔒 Revoke ${account.nickname}`, `revoke_ig_${account.nickname}`)]
  );
  buttons.push([Markup.button.callback('🔒 Revoke All IG', 'revoke_all_ig')]);
  buttons.push([Markup.button.callback('↩️ Back', 'accounts')]);
  
  await ctx.reply('Select Instagram account to revoke access:', Markup.inlineKeyboard(buttons));
});

BOT.action('acc_revoke_tt', async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = await listAccounts.all(String(ctx.from!.id), 'tiktok') as any[];
  
  if (rows.length === 0) {
    await ctx.reply('No TikTok accounts found.');
    return;
  }
  
  // Create buttons for each account
  const buttons = rows.map(account => 
    [Markup.button.callback(`🔒 Revoke ${account.nickname}`, `revoke_tt_${account.nickname}`)]
  );
  buttons.push([Markup.button.callback('🔒 Revoke All TT', 'revoke_all_tt')]);
  buttons.push([Markup.button.callback('↩️ Back', 'accounts')]);
  
  await ctx.reply('Select TikTok account to revoke access:', Markup.inlineKeyboard(buttons));
});

// Revoke individual account handlers
BOT.action(/^revoke_ig_(.+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const accountNickname = ctx.match[1];
  
  try {
    log.info('Revoking Instagram access', { userId: ctx.from!.id, account: accountNickname });
    
    // Find and revoke the account
    const account = await db.prepare(`
      SELECT * FROM accounts 
      WHERE tg_user_id = ? AND platform = ? AND nickname = ?
    `).get(String(ctx.from!.id), 'instagram', accountNickname);
    
    if (!account) {
      await ctx.reply(`❌ Account "${accountNickname}" not found.`);
      return;
    }
    
    // Delete session file
    if (account.cookie_path) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(account.cookie_path);
        log.info('Deleted session file', { file: account.cookie_path });
      } catch (error) {
        log.warn('Could not delete session file', { file: account.cookie_path, error: error.message });
      }
    }
    
    // Delete the account from database
    await db.prepare(`
      DELETE FROM accounts 
      WHERE id = ?
    `).run(account.id);
    
    await ctx.reply(`✅ Access revoked and account "${accountNickname}" removed.\n\nYou can add it again via Accounts → Add IG if needed.`);
    log.info('Instagram account deleted successfully', { userId: ctx.from!.id, account: accountNickname });
    
  } catch (error) {
    log.error('Failed to revoke Instagram access', { userId: ctx.from!.id, account: accountNickname, error: error.message });
    await ctx.reply(`❌ Failed to revoke access: ${error.message}`);
  }
});

BOT.action(/^revoke_tt_(.+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const accountNickname = ctx.match[1];
  
  try {
    log.info('Revoking TikTok access', { userId: ctx.from!.id, account: accountNickname });
    
    // Find and revoke the account
    const account = await db.prepare(`
      SELECT * FROM accounts 
      WHERE tg_user_id = ? AND platform = ? AND nickname = ?
    `).get(String(ctx.from!.id), 'tiktok', accountNickname);
    
    if (!account) {
      await ctx.reply(`❌ Account "${accountNickname}" not found.`);
      return;
    }
    
    // Delete session file
    if (account.cookie_path) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(account.cookie_path);
        log.info('Deleted session file', { file: account.cookie_path });
      } catch (error) {
        log.warn('Could not delete session file', { file: account.cookie_path, error: error.message });
      }
    }
    
    // Delete the account from database
    await db.prepare(`
      DELETE FROM accounts 
      WHERE id = ?
    `).run(account.id);
    
    await ctx.reply(`✅ Access revoked and account "${accountNickname}" removed.\n\nYou can add it again via Accounts → Add TT if needed.`);
    log.info('TikTok account deleted successfully', { userId: ctx.from!.id, account: accountNickname });
    
  } catch (error) {
    log.error('Failed to revoke TikTok access', { userId: ctx.from!.id, account: accountNickname, error: error.message });
    await ctx.reply(`❌ Failed to revoke access: ${error.message}`);
  }
});

// Revoke all accounts handlers
BOT.action('revoke_all_ig', async (ctx)=>{
  await ctx.answerCbQuery();
  
  try {
    log.info('Revoking all Instagram access', { userId: ctx.from!.id });
    
    const accounts = await db.prepare(`
      SELECT * FROM accounts 
      WHERE tg_user_id = ? AND platform = ?
    `).all(String(ctx.from!.id), 'instagram');
    
    if (accounts.length === 0) {
      await ctx.reply('No Instagram accounts found.');
      return;
    }
    
    let revokedCount = 0;
    const fs = await import('fs/promises');
    
    for (const account of accounts) {
      // Delete session file
      if (account.cookie_path) {
        try {
          await fs.unlink(account.cookie_path);
          log.info('Deleted session file', { file: account.cookie_path });
        } catch (error) {
          log.warn('Could not delete session file', { file: account.cookie_path, error: error.message });
        }
      }
      
      // Delete the account from database
      await db.prepare(`
        DELETE FROM accounts 
        WHERE id = ?
      `).run(account.id);
      
      revokedCount++;
    }
    
    await ctx.reply(`✅ Removed ${revokedCount} Instagram account(s).\n\nYou can add them again via Accounts → Add IG if needed.`);
    log.info('All Instagram accounts deleted successfully', { userId: ctx.from!.id, count: revokedCount });
    
  } catch (error) {
    log.error('Failed to revoke all Instagram access', { userId: ctx.from!.id, error: error.message });
    await ctx.reply(`❌ Failed to revoke all access: ${error.message}`);
  }
});

BOT.action('revoke_all_tt', async (ctx)=>{
  await ctx.answerCbQuery();
  
  try {
    log.info('Revoking all TikTok access', { userId: ctx.from!.id });
    
    const accounts = await db.prepare(`
      SELECT * FROM accounts 
      WHERE tg_user_id = ? AND platform = ?
    `).all(String(ctx.from!.id), 'tiktok');
    
    if (accounts.length === 0) {
      await ctx.reply('No TikTok accounts found.');
      return;
    }
    
    let revokedCount = 0;
    const fs = await import('fs/promises');
    
    for (const account of accounts) {
      // Delete session file
      if (account.cookie_path) {
        try {
          await fs.unlink(account.cookie_path);
          log.info('Deleted session file', { file: account.cookie_path });
        } catch (error) {
          log.warn('Could not delete session file', { file: account.cookie_path, error: error.message });
        }
      }
      
      // Delete the account from database
      await db.prepare(`
        DELETE FROM accounts 
        WHERE id = ?
      `).run(account.id);
      
      revokedCount++;
    }
    
    await ctx.reply(`✅ Removed ${revokedCount} TikTok account(s).\n\nYou can add them again via Accounts → Add TT if needed.`);
    log.info('All TikTok accounts deleted successfully', { userId: ctx.from!.id, count: revokedCount });
    
  } catch (error) {
    log.error('Failed to revoke all TikTok access', { userId: ctx.from!.id, error: error.message });
    await ctx.reply(`❌ Failed to revoke all access: ${error.message}`);
  }
});

async function saveCookies(ctx:any, platform:'instagram'|'tiktok', username:string, nickname:string, rawInput:string){
  try{
    let cookies;
    
    try {
      cookies = JSON.parse(rawInput);
      console.log('Parsed as JSON:', cookies.length, 'cookies');
    } catch {
      console.log('JSON parsing failed, trying tab-separated format');
      console.log('Raw input length:', rawInput.length);
      console.log('Raw input preview:', rawInput.substring(0, 200));
      cookies = parseTabSeparatedCookies(rawInput);
      console.log('Parsed as tab-separated:', cookies.length, 'cookies');
    }
    
    const validation = validateCookies(cookies, platform);
    if (!validation.valid) {
      const s = sessions.get(ctx.from.id) || { files: [] };
      s.tempCookies = cookies;
      sessions.set(ctx.from.id, s);
      await ctx.reply(`⚠️ **Cookie validation warning:**\n\n${validation.warnings.join('\n')}\n\nDo you want to save anyway?`, 
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Save anyway', 'save_cookies_anyway'), Markup.button.callback('❌ Cancel', 'cancel_cookie_save')]
        ])
      );
      return;
    }
    
    const file = cookieFilePath(platform, ctx.from.id, nickname);
    await writeEncryptedJson(file, cookies);
    await deleteAccount.run(String(ctx.from.id), platform, nickname);
    await addAccount.run(String(ctx.from.id), platform, nickname, username, file, dayjs().toISOString());
    await ctx.reply(`✅ Saved cookies for ${platform} account "${nickname}".`, mainMenu());
    log.info('Saved account cookies', { platform, nickname, userId: ctx.from.id });
  }catch(e){
    await ctx.reply('Invalid cookie format. Please paste either JSON or tab-separated cookies from browser dev tools.');
    log.warn('Failed to save cookies', { platform, nickname, error: e instanceof Error ? e.message : String(e) });
  }
}

function validateCookies(cookies: any[], platform: 'instagram'|'tiktok'): {valid: boolean, warnings: string[]} {
  const warnings: string[] = [];
  
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { valid: false, warnings: ['No cookies found in the input'] };
  }
  
  const cookieNames = cookies.map(c => c.name?.toLowerCase() || '');
  
  if (platform === 'instagram') {
    const essentialCookies = ['sessionid', 'csrftoken', 'ds_user_id'];
    const missingEssential = essentialCookies.filter(name => !cookieNames.includes(name));
    
    if (missingEssential.length > 0) {
      warnings.push(`Missing essential Instagram cookies: ${missingEssential.join(', ')}`);
    }
    
    const wrongDomains = cookies.filter(c => c.domain && !c.domain.includes('instagram.com'));
    if (wrongDomains.length > 0) {
      warnings.push(`Found cookies for non-Instagram domains: ${wrongDomains.map(c => c.domain).join(', ')}`);
    }
    
    const now = Date.now() / 1000;
    const expiredCookies = cookies.filter(c => c.expires && c.expires < now);
    if (expiredCookies.length > 0) {
      warnings.push(`${expiredCookies.length} cookies appear to be expired`);
    }
    
    const oldCookies = cookies.filter(c => c.expires && c.expires < now + (30 * 24 * 60 * 60)); // 30 days
    if (oldCookies.length > cookies.length * 0.5) {
      warnings.push('Many cookies expire soon - you may need fresh ones');
    }
    
  } else if (platform === 'tiktok') {
    const essentialCookies = ['sessionid', 'ttwid'];
    const missingEssential = essentialCookies.filter(name => !cookieNames.includes(name));
    
    if (missingEssential.length > 0) {
      warnings.push(`Missing essential TikTok cookies: ${missingEssential.join(', ')}`);
    }
    
    const wrongDomains = cookies.filter(c => c.domain && !c.domain.includes('tiktok.com'));
    if (wrongDomains.length > 0) {
      warnings.push(`Found cookies for non-TikTok domains: ${wrongDomains.map(c => c.domain).join(', ')}`);
    }
  }
  
  return { valid: warnings.length === 0, warnings };
}

function parseTabSeparatedCookies(input: string): any[] {
  const lines = input.trim().split('\n');
  const cookies = [];
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    let parts = line.split('\t');
    if (parts.length < 2) {
      parts = line.split(/\s{2,}/); // Split by 2 or more consecutive spaces
    }
    
    if (parts.length < 2) continue;
    
    const name = parts[0].trim();
    const value = parts[1].trim();
    const domain = parts[2]?.trim() || '.instagram.com';
    const path = parts[3]?.trim() || '/';
    const expires = parts[4]?.trim();
    const httpOnly = parts[6]?.includes('✓') || false;
    const secure = parts[7]?.includes('✓') || false;
    const sameSite = parts[8]?.trim() || 'None';
    
    cookies.push({
      name,
      value,
      domain,
      path,
      expires: expires && expires !== 'Session' ? new Date(expires).getTime() / 1000 : undefined,
      httpOnly,
      secure,
      sameSite
    });
  }
  
  return cookies;
}

BOT.action('schedule', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid = String(ctx.from!.id);
  
  const upcomingPostsStmt = db.prepare(`
    SELECT id, platform, ig_account, tt_account, caption, schedule_at, status, schedule_type, every_hours
    FROM posts 
    WHERE tg_user_id = ? AND status = 'queued' 
    ORDER BY datetime(schedule_at) ASC 
    LIMIT 10
  `);
  const upcomingPosts = await upcomingPostsStmt.all(uid) as any[];
  
  if (upcomingPosts.length === 0) {
    await ctx.reply('📅 **No scheduled posts**\n\nTo schedule posts:\n1. Click "📤 Upload videos"\n2. Choose your schedule options\n3. Posts will appear here', 
      Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload Videos', 'upload')],
        [Markup.button.callback('↩️ Back', 'back')]
      ])
    );
  } else {
    let message = '📅 **Upcoming Posts:**\n\n';
    upcomingPosts.forEach((post, i) => {
      const time = dayjs(post.schedule_at).format('MMM DD, HH:mm');
      const platform = post.platform === 'both' ? 'IG+TT' : post.platform.toUpperCase();
      const account = post.platform === 'both' ? `${post.ig_account}+${post.tt_account}` : (post.ig_account || post.tt_account);
      const recurring = post.schedule_type === 'everyXh' ? ` (every ${post.every_hours}h)` : '';
      message += `${i+1}. **${time}**${recurring}\n   ${platform} → ${account}\n   ${post.caption ? post.caption.substring(0, 30) + '...' : 'No caption'}\n\n`;
    });
    
    await ctx.reply(message, 
      Markup.inlineKeyboard([
        [Markup.button.callback('📤 Upload More', 'upload'), Markup.button.callback('🗑️ Clear All', 'clear_schedule')],
        [Markup.button.callback('↩️ Back', 'back')]
      ])
    );
  }
});
BOT.action('hashtags', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.expecting = 'settingsHashtags';
  s.files = [];
  s.platform = undefined;
  s.igAccount = undefined;
  s.ttAccount = undefined;
  s.when = undefined;
  s.caption = undefined;
  s.hashtags = undefined;
  sessions.set(ctx.from!.id, s);
  await ctx.reply('Send default hashtags (comma-separated). Type "skip" to leave unchanged.');
});
BOT.action('back', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply('Main menu:', mainMenu()); });

BOT.action('login_help', async (ctx) => {
  await ctx.answerCbQuery();
  const helpText = `🔐 **Instagram Login Process:**

**What happens:**
1. You provide your username and password
2. The bot logs into Instagram on the server (headlessly)
3. If 2FA is enabled, you'll be prompted for the code via Telegram
4. Once logged in, cookies are saved for future use

**Security:**
- Your password is only used for initial login
- After login, only cookies are stored (encrypted)
- Login happens on the server, not your device
- Your credentials are not stored permanently

**2FA Support:**
- If your account has 2FA enabled, you'll be prompted via Telegram
- Enter the 6-digit code from your authenticator app
- The bot will handle the rest automatically

**Troubleshooting:**
- Make sure your username/password are correct
- Check if your account is locked or restricted
- Ensure 2FA codes are entered quickly (they expire)
- The login process runs on the server, so no browser window will open`;
  
  await ctx.reply(helpText, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Got it', 'back_to_setup')]
  ]));
});

BOT.action('back_to_setup', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id);
  if (!s?.accountSetup) {
    await ctx.reply('Main menu:', mainMenu());
    return;
  }

  if (s.accountSetup.platform === 'instagram') {
    await ctx.reply('🔐 **Quick Instagram Setup**\n\nSend your Instagram credentials in this format:\n\n`username password 2fa_code`\n\nExample: `myusername mypassword 123456`\n\nIf no 2FA, use: `myusername mypassword skip`');
  } else if (s.accountSetup.platform === 'tiktok') {
    await ctx.reply('🔐 **Quick TikTok Setup**\n\nSend your TikTok credentials in this format:\n\n`username password 2fa_code`\n\nExample: `myusername mypassword 123456`\n\nIf no 2FA, use: `myusername mypassword skip`');
  } else {
    await ctx.reply('Main menu:', mainMenu());
  }
});

BOT.action('cookie_help', async (ctx) => {
  await ctx.answerCbQuery();
  const helpText = `🍪 **How to get Instagram/TikTok cookies:**

**Method 1 - Browser Developer Tools (EASIEST):**
1. Open Instagram/TikTok in your browser
2. Press F12 (or right-click → Inspect)
3. Go to "Application" tab (Chrome) or "Storage" tab (Firefox)
4. Click "Cookies" → select your site
5. **Copy ALL cookies as tab-separated text** (just select and copy the whole table)

**Method 2 - Browser Extension:**
1. Install "Cookie Editor" extension
2. Go to Instagram/TikTok
3. Click extension → "Export" → "JSON"
4. Copy the JSON

**Method 3 - Manual Copy:**
1. Right-click → Inspect → Network tab
2. Refresh page
3. Find any request → Headers → Copy "Cookie" header
4. Convert to JSON format

**✅ Supported formats:**
- Tab-separated cookies (from browser dev tools)
- JSON format
- Both work automatically!

**⚠️ Important:**
- Keep cookies private (they contain login info)
- Cookies expire, you'll need to refresh them
- Use incognito mode for testing

**Need help?** Send me a message!`;

  await ctx.reply(helpText, Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Back to cookie input', 'back_to_cookies')]
  ]));
});

BOT.action('back_to_cookies', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id);
  if (s?.accountSetup) {
    await ctx.reply(`Paste ${s.accountSetup.platform === 'instagram' ? 'Instagram' : 'TikTok'} cookie JSON for ${s.accountSetup.nickname}.`, 
      Markup.inlineKeyboard([
        [Markup.button.callback('❓ Help - How to get cookies', 'cookie_help')]
      ])
    );
  }
});

BOT.action('save_cookies_anyway', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id);
  if (s?.accountSetup && s.tempCookies) {
    const file = cookieFilePath(s.accountSetup.platform, ctx.from.id, s.accountSetup.nickname);
    await writeEncryptedJson(file, s.tempCookies);
    await deleteAccount.run(String(ctx.from.id), s.accountSetup.platform, s.accountSetup.nickname);
    await addAccount.run(String(ctx.from.id), s.accountSetup.platform, s.accountSetup.nickname, s.accountSetup.username!, file, dayjs().toISOString());
    await ctx.reply(`✅ Saved cookies for ${s.accountSetup.platform} account "${s.accountSetup.nickname}" (with warnings).`, mainMenu());
    log.info('Saved account cookies with warnings', { platform: s.accountSetup.platform, nickname: s.accountSetup.nickname, userId: ctx.from.id });
    delete s.accountSetup;
    delete s.tempCookies;
    sessions.set(ctx.from.id, s);
  }
});

BOT.action('cancel_cookie_save', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id);
  if (s?.accountSetup) {
    await ctx.reply(`Paste ${s.accountSetup.platform === 'instagram' ? 'Instagram' : 'TikTok'} cookie JSON for ${s.accountSetup.nickname}.`, 
      Markup.inlineKeyboard([
        [Markup.button.callback('❓ Help - How to get cookies', 'cookie_help')]
      ])
    );
  }
});

BOT.action('clear_schedule', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from!.id);
  
  const countRow = await db.prepare(`SELECT COUNT(*) as count FROM posts WHERE tg_user_id = ? AND status = 'queued'`).get(uid) as {count: number};
  const count = countRow?.count ?? 0;
  
  if (count === 0) {
    await ctx.reply('No scheduled posts to clear.', Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'back')]]));
    return;
  }
  
  await ctx.reply(`🗑️ **Clear ${count} scheduled posts?**\n\nThis will delete all queued posts permanently.`, 
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, Clear All', 'confirm_clear'), Markup.button.callback('❌ Cancel', 'schedule')]
    ])
  );
});

BOT.action('confirm_clear', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from!.id);
  
  const deleteStmt = db.prepare(`DELETE FROM posts WHERE tg_user_id = ? AND status = 'queued'`);
  const deleted = await deleteStmt.run(uid);
  
  await ctx.reply(`✅ Cleared ${deleted?.changes ?? 0} scheduled posts.`, Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload Videos', 'upload'), Markup.button.callback('↩️ Back', 'back')]
  ]));
});

BOT.action('stats', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid = String(ctx.from!.id);
  const accounts = await listAllAccounts.all(uid) as any[];
  if (accounts.length === 0) {
    await ctx.reply('No accounts saved yet. Add one under Accounts → Add IG/TT.', mainMenu());
    return;
  }

  await ctx.reply('⏳ Fetching stats... give me a moment.', Markup.removeKeyboard());

  const ok: StatsSnapshot[] = [];
  const errs: string[] = [];

  for (const account of accounts) {
    try {
      if (account.platform === 'instagram') {
        ok.push(await fetchInstagramStats(uid, account.nickname, account.username || undefined));
      } else if (account.platform === 'tiktok') {
        ok.push(await fetchTikTokStats(uid, account.nickname, account.username || undefined));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errs.push(`${account.platform} (${account.nickname}): ${message}`);
    }
  }

  const sections: string[] = [];
  if (ok.length) {
    sections.push('📊 Account stats:\n' + ok.map(formatStats).join('\n\n'));
  }
  if (errs.length) {
    sections.push('⚠️ Issues:\n- ' + errs.join('\n- '));
  }

  const text = sections.join('\n\n') || 'No stats available right now.';
  await ctx.reply(text, mainMenu());
});

function splitButtons(btns:any[], perRow=3){
  const rows:any[] = [];
  for (let i=0;i<btns.length;i+=perRow) rows.push(btns.slice(i,i+perRow));
  return rows;
}


// Add global error handler
BOT.catch((err, ctx) => {
  log.error('Unhandled bot error', { 
    error: err instanceof Error ? err.message : String(err), 
    userId: ctx?.from?.id,
    updateType: ctx?.updateType,
    stack: err instanceof Error ? err.stack : undefined
  });
});

BOT.launch().then(()=>log.info('Bot online')).catch(err=>log.error('Bot launch failed', err));

let isShuttingDown = false;
let botStarted = false;

// Wait a bit before setting up signal handlers to avoid immediate shutdown
setTimeout(() => {
  botStarted = true;
  // Add port binding for Render
  const PORT = process.env.PORT || 3000;
  log.info(`Bot started on port ${PORT}`);
}, 2000);

process.once('SIGINT', async ()=>{
  if (!isShuttingDown && botStarted) {
    isShuttingDown = true;
    log.info('Received SIGINT, shutting down gracefully...');
    await BOT.stop('SIGINT');
    process.exit(0);
  }
});
process.once('SIGTERM', async ()=>{
  if (!isShuttingDown && botStarted) {
    isShuttingDown = true;
    log.info('Received SIGTERM, shutting down gracefully...');
    await BOT.stop('SIGTERM');
    process.exit(0);
  }
});
