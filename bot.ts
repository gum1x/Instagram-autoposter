import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import dayjs from 'dayjs';
import { fetchInstagramStats, fetchTikTokStats, StatsSnapshot, formatStats } from './stats.js';
import { cookieFilePath, createLogger, ensureEnv, writeEncryptedJson } from './utils.js';

ensureEnv(['TELEGRAM_BOT_TOKEN', 'ENCRYPTION_KEY']);
const BOT = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const db = new Database(process.env.DATABASE_URL || 'sqlite.db');
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

type AccountSetupStage = 'username'|'nickname'|'cookies';
type Session = {
  files: string[];
  platform?: 'instagram'|'tiktok'|'both';
  igAccount?: string;
  ttAccount?: string;
  when?: 'now'|'after2h'|'tomorrow'|'at'|'everyXh'|'smart';
  atISO?: string;
  everyHours?: number;
  caption?: string;
  hashtags?: string;
  expecting?: 'datetime'|'everyHours'|'caption'|'hashtags'|'settingsHashtags';
  tempCookies?: any[];
  accountSetup?: {
    platform: 'instagram'|'tiktok';
    stage: AccountSetupStage;
    username?: string;
    nickname?: string;
  };
};
const sessions = new Map<number, Session>();

BOT.start(async (ctx) => {
  ensureUserSettings.run(String(ctx.from.id), '#fyp,#viral', 3, 'both');
  await ctx.reply('👋 Ready. Choose an option:', mainMenu());
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
  sessions.set(ctx.from!.id, { files: [] });
  await ctx.answerCbQuery();
  await ctx.reply('📸 Send me photos or videos to post. When done, type "done".');
});

BOT.on('video', async (ctx) => {
  try {
    const s = sessions.get(ctx.from.id) || { files: [] };
    const file = await ctx.telegram.getFile(ctx.message.video.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const dest = path.join('uploads', `${ctx.message.video.file_id}.mp4`);
    fs.mkdirSync('uploads', { recursive: true });
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    s.files.push(dest);
    sessions.set(ctx.from.id, s);
    await ctx.reply(`✅ Success saved video (${s.files.length}). Send more or type "done".`);
  } catch (error) {
    await ctx.reply('❌ Failed to save video. Please try again.');
    log.warn('Failed to save video', { error: error instanceof Error ? error.message : String(error), userId: ctx.from.id });
  }
});

BOT.on('photo', async (ctx) => {
  try {
    const s = sessions.get(ctx.from.id) || { files: [] };
    // Get the largest photo size
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const dest = path.join('uploads', `${photo.file_id}.jpg`);
    fs.mkdirSync('uploads', { recursive: true });
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    s.files.push(dest);
    sessions.set(ctx.from.id, s);
    await ctx.reply(`✅ Success saved photo (${s.files.length}). Send more or type "done".`);
  } catch (error) {
    await ctx.reply('❌ Failed to save photo. Please try again.');
    log.warn('Failed to save photo', { error: error instanceof Error ? error.message : String(error), userId: ctx.from.id });
  }
});

BOT.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();
  const existing = sessions.get(ctx.from.id);

  if (!existing) {
    // Nothing active for this user; ignore free-form text.
    return;
  }

  const s = existing;

  // Account setup flow
  if (s.accountSetup) {
    if (s.accountSetup.stage === 'username') {
      const username = text.replace(/^@/, '').trim();
      if (!username) {
        await ctx.reply('Please send a username (letters, numbers, underscores).');
        return;
      }
      s.accountSetup.username = username;
      s.accountSetup.stage = 'nickname';
      sessions.set(ctx.from.id, s);
      await ctx.reply('Add a nickname for quick selection (e.g., "brand_main").');
      return;
    }
    if (s.accountSetup.stage === 'nickname') {
      const nickname = text.trim() || s.accountSetup.username!;
      const normalized = ['skip', 'same'].includes(nickname.toLowerCase())
        ? s.accountSetup.username!
        : nickname;
      s.accountSetup.nickname = normalized;
      s.accountSetup.stage = 'cookies';
      sessions.set(ctx.from.id, s);
      await ctx.reply(`Paste ${s.accountSetup.platform === 'instagram' ? 'Instagram' : 'TikTok'} cookie JSON for ${normalized}.`, 
        Markup.inlineKeyboard([
          [Markup.button.callback('❓ Help - How to get cookies', 'cookie_help')]
        ])
      );
      return;
    }
    if (s.accountSetup.stage === 'cookies') {
      await saveCookies(ctx, s.accountSetup.platform, s.accountSetup.username!, s.accountSetup.nickname!, text);
      delete s.accountSetup;
      sessions.set(ctx.from.id, s);
      return;
    }
  }

  // Upload -> done flow
  if (lower === 'done' && s.files?.length && !s.expecting) {
    await ctx.reply('Choose platforms:', Markup.inlineKeyboard([
      [Markup.button.callback('Instagram', 'pf_ig'), Markup.button.callback('TikTok', 'pf_tt'), Markup.button.callback('Both', 'pf_both')]
    ]));
    return;
  }

  // Handle expected inputs
  if (s.expecting === 'datetime') {
    let d;
    const textLower = text.toLowerCase();
    
    // Handle natural language
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
      // Try parsing as ISO or standard format
      d = dayjs(text.replace(' ', 'T'));
    }
    
    if (!d.isValid()) {
      await ctx.reply('❌ Could not parse time. Try:\n• `tomorrow 9am`\n• `2025-10-13 19:30`\n• `today 6pm`');
      return;
    }
    
    // Ensure it's in the future
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
    ensureUserSettings.run(uid, '#fyp,#viral', 3, 'both');
    const settings = getSettings.get(uid) as any;
    if (lower === 'skip') {
      await ctx.reply('No changes.', mainMenu());
    } else {
      updateSettings.run({
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
    s.caption = lower === 'skip' ? '' : ctx.message.text;
    s.expecting = 'hashtags';
    sessions.set(ctx.from.id, s);
    await ctx.reply('Add hashtags (comma-separated) or type "defaults".');
    return;
  }

  if (s.expecting === 'hashtags') {
    if (lower === 'defaults') {
      const set = getSettings.get(String(ctx.from.id));
      s.hashtags = set?.default_hashtags || '#fyp,#viral';
    } else {
      s.hashtags = ctx.message.text;
    }
    s.expecting = undefined;
    sessions.set(ctx.from.id, s);
    const summary = await persistScheduledPosts(ctx.from.id, s);
    await ctx.reply(summary, mainMenu());
    sessions.delete(ctx.from.id);
    return;
  }
});

BOT.action('pf_ig', async (ctx)=>{ await selectPlatform(ctx,'instagram'); });
BOT.action('pf_tt', async (ctx)=>{ await selectPlatform(ctx,'tiktok'); });
BOT.action('pf_both', async (ctx)=>{ await selectPlatform(ctx,'both'); });

async function selectPlatform(ctx:any, p:'instagram'|'tiktok'|'both'){
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.platform = p;
  sessions.set(ctx.from.id, s);
  await ctx.answerCbQuery();

  if (p === 'instagram' || p === 'both') {
    const igs = listAccounts.all(String(ctx.from.id), 'instagram') as any[];
    if (igs.length === 0) {
      await ctx.reply('No Instagram accounts saved. Add one in Accounts → Add IG.');
    } else {
      await ctx.reply('Pick Instagram account:', Markup.inlineKeyboard(splitButtons(igs.map(r=>Markup.button.callback(r.nickname, 'igacc_'+r.nickname)))));
    }
  }
  if (p === 'tiktok' || p === 'both') {
    const tts = listAccounts.all(String(ctx.from.id), 'tiktok') as any[];
    if (tts.length === 0) {
      await ctx.reply('No TikTok accounts saved. Add one in Accounts → Add TT.');
    } else {
      await ctx.reply('Pick TikTok account:', Markup.inlineKeyboard(splitButtons(tts.map(r=>Markup.button.callback(r.nickname, 'ttacc_'+r.nickname)))));
    }
  }
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

BOT.action('w_now', async (ctx)=>{ await chooseWhen(ctx,'now'); });
BOT.action('w_2h', async (ctx)=>{ await chooseWhen(ctx,'after2h'); });
BOT.action('w_tomorrow', async (ctx)=>{ await chooseWhen(ctx,'tomorrow'); });
BOT.action('w_at', async (ctx)=>{ await chooseWhen(ctx,'at'); });
BOT.action('w_every', async (ctx)=>{ await chooseWhen(ctx,'everyXh'); });
BOT.action('w_smart', async (ctx)=>{ await chooseWhen(ctx,'smart'); });

async function chooseWhen(ctx:any, w:'now'|'after2h'|'tomorrow'|'at'|'everyXh'|'smart'){
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.when = w;
  sessions.set(ctx.from.id, s);
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
    // Set to tomorrow 9AM
    s.atISO = dayjs().add(1, 'day').hour(9).minute(0).toISOString();
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply('✅ Scheduled for tomorrow 9AM\n✍️ Send a caption (or type "skip").');
  } else if (w === 'smart') {
    // Smart scheduling: spread posts throughout optimal times
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
  const uid = String(userId);
  const settings = getSettings.get(uid) as any;
  const files = s.files || [];
  if (!files.length) {
    return '⚠️ No files queued.';
  }

  const platform = s.platform || (settings?.platform_pref as 'instagram'|'tiktok'|'both') || 'both';
  const when = s.when || 'after2h';
  const now = dayjs();
  let firstAt = now;

  if (when === 'after2h') {
    const lastRow = lastScheduledForUser.get(uid) as { schedule_at?: string } | undefined;
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
    // Smart scheduling: spread across optimal times (9AM, 1PM, 5PM, 9PM)
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
    insertPost.run(
      uuid(),
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
  }

  const firstSlot = scheduledTimes[0];
  const formatted = firstSlot ? firstSlot.format('YYYY-MM-DD HH:mm') : 'unknown time';
  return `✅ Queued ${files.length} post(s). First at ${formatted}.`;
}

BOT.action('accounts', async (ctx)=>{
  await ctx.answerCbQuery();
  await ctx.reply('Accounts:', Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add IG', 'acc_add_ig'), Markup.button.callback('➕ Add TT', 'acc_add_tt')],
    [Markup.button.callback('📋 List IG', 'acc_list_ig'), Markup.button.callback('📋 List TT', 'acc_list_tt')],
    [Markup.button.callback('↩️ Back', 'back')]
  ]));
});

BOT.action('acc_add_ig', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.accountSetup = { platform: 'instagram', stage: 'username' };
  sessions.set(ctx.from!.id, s);
  await ctx.reply('Send the Instagram username (without @).');
});
BOT.action('acc_add_tt', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = sessions.get(ctx.from!.id) || { files: [] };
  s.accountSetup = { platform: 'tiktok', stage: 'username' };
  sessions.set(ctx.from!.id, s);
  await ctx.reply('Send the TikTok username (without @).');
});

BOT.action('acc_list_ig', async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = listAccounts.all(String(ctx.from!.id), 'instagram') as any[];
  await ctx.reply(rows.length? ('IG accounts:\n- '+rows.map(r=>r.nickname).join('\n- ')) : 'No IG accounts saved.');
});
BOT.action('acc_list_tt', async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = listAccounts.all(String(ctx.from!.id), 'tiktok') as any[];
  await ctx.reply(rows.length? ('TT accounts:\n- '+rows.map(r=>r.nickname).join('\n- ')) : 'No TT accounts saved.');
});

async function saveCookies(ctx:any, platform:'instagram'|'tiktok', username:string, nickname:string, rawInput:string){
  try{
    let cookies;
    
    // Try to parse as JSON first
    try {
      cookies = JSON.parse(rawInput);
    } catch {
      // If JSON fails, try parsing as tab-separated cookie format
      cookies = parseTabSeparatedCookies(rawInput);
    }
    
    // Validate cookies
    const validation = validateCookies(cookies, platform);
    if (!validation.valid) {
      // Store cookies temporarily in session for the "save anyway" option
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeEncryptedJson(file, cookies);
    deleteAccount.run(String(ctx.from.id), platform, nickname);
    addAccount.run(String(ctx.from.id), platform, nickname, username, file, dayjs().toISOString());
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
    // Check for essential Instagram cookies
    const essentialCookies = ['sessionid', 'csrftoken', 'ds_user_id'];
    const missingEssential = essentialCookies.filter(name => !cookieNames.includes(name));
    
    if (missingEssential.length > 0) {
      warnings.push(`Missing essential Instagram cookies: ${missingEssential.join(', ')}`);
    }
    
    // Check for suspicious domains
    const wrongDomains = cookies.filter(c => c.domain && !c.domain.includes('instagram.com'));
    if (wrongDomains.length > 0) {
      warnings.push(`Found cookies for non-Instagram domains: ${wrongDomains.map(c => c.domain).join(', ')}`);
    }
    
    // Check for expired cookies
    const now = Date.now() / 1000;
    const expiredCookies = cookies.filter(c => c.expires && c.expires < now);
    if (expiredCookies.length > 0) {
      warnings.push(`${expiredCookies.length} cookies appear to be expired`);
    }
    
    // Check for very old cookies (might be stale)
    const oldCookies = cookies.filter(c => c.expires && c.expires < now + (30 * 24 * 60 * 60)); // 30 days
    if (oldCookies.length > cookies.length * 0.5) {
      warnings.push('Many cookies expire soon - you may need fresh ones');
    }
    
  } else if (platform === 'tiktok') {
    // Check for essential TikTok cookies
    const essentialCookies = ['sessionid', 'ttwid'];
    const missingEssential = essentialCookies.filter(name => !cookieNames.includes(name));
    
    if (missingEssential.length > 0) {
      warnings.push(`Missing essential TikTok cookies: ${missingEssential.join(', ')}`);
    }
    
    // Check for suspicious domains
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
    
    // Split by tab and extract cookie data
    const parts = line.split('\t');
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
  
  // Get upcoming posts
  const upcomingPosts = db.prepare(`
    SELECT id, platform, ig_account, tt_account, caption, schedule_at, status, schedule_type, every_hours
    FROM posts 
    WHERE tg_user_id = ? AND status = 'queued' 
    ORDER BY datetime(schedule_at) ASC 
    LIMIT 10
  `).all(uid) as any[];
  
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeEncryptedJson(file, s.tempCookies);
    deleteAccount.run(String(ctx.from.id), s.accountSetup.platform, s.accountSetup.nickname);
    addAccount.run(String(ctx.from.id), s.accountSetup.platform, s.accountSetup.nickname, s.accountSetup.username!, file, dayjs().toISOString());
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
  
  // Count queued posts
  const count = db.prepare(`SELECT COUNT(*) as count FROM posts WHERE tg_user_id = ? AND status = 'queued'`).get(uid) as {count: number};
  
  if (count.count === 0) {
    await ctx.reply('No scheduled posts to clear.', Markup.inlineKeyboard([
      [Markup.button.callback('↩️ Back', 'back')]
    ]));
    return;
  }
  
  await ctx.reply(`🗑️ **Clear ${count.count} scheduled posts?**\n\nThis will delete all queued posts permanently.`, 
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, Clear All', 'confirm_clear'), Markup.button.callback('❌ Cancel', 'schedule')]
    ])
  );
});

BOT.action('confirm_clear', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from!.id);
  
  const deleted = db.prepare(`DELETE FROM posts WHERE tg_user_id = ? AND status = 'queued'`).run(uid);
  
  await ctx.reply(`✅ Cleared ${deleted.changes} scheduled posts.`, Markup.inlineKeyboard([
    [Markup.button.callback('📤 Upload Videos', 'upload'), Markup.button.callback('↩️ Back', 'back')]
  ]));
});

BOT.action('stats', async (ctx)=>{
  await ctx.answerCbQuery();
  const uid = String(ctx.from!.id);
  const accounts = listAllAccounts.all(uid) as any[];
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


BOT.launch().then(()=>log.info('Bot online'));
process.once('SIGINT', ()=>BOT.stop('SIGINT'));
process.once('SIGTERM', ()=>BOT.stop('SIGTERM'));
