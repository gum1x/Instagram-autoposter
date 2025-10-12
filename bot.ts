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
  when?: 'now'|'after2h'|'at'|'everyXh';
  atISO?: string;
  everyHours?: number;
  caption?: string;
  hashtags?: string;
  expecting?: 'datetime'|'everyHours'|'caption'|'hashtags'|'settingsHashtags';
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
  await ctx.reply('Send me 1 or more videos. When done, type "done".');
});

BOT.on('video', async (ctx) => {
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
  await ctx.reply(`✅ Saved (${s.files.length}). Send more or type "done".`);
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
      await ctx.reply(`Paste ${s.accountSetup.platform === 'instagram' ? 'Instagram' : 'TikTok'} cookie JSON for ${normalized}.`);
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
    const d = dayjs(text.replace(' ', 'T'));
    if (!d.isValid()) {
      await ctx.reply('Could not parse time. Try `YYYY-MM-DD HH:mm`.');
      return;
    }
    s.atISO = d.toISOString();
    s.expecting = 'caption';
    sessions.set(ctx.from.id, s);
    await ctx.reply('✍️ Now send a caption (or type "skip").');
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
    await ctx.reply('When to post?', Markup.inlineKeyboard([
      [Markup.button.callback('Now', 'w_now'), Markup.button.callback('+2h', 'w_2h')],
      [Markup.button.callback('Pick time', 'w_at'), Markup.button.callback('Every X hours', 'w_every')]
    ]));
  }
}

BOT.action('w_now', async (ctx)=>{ await chooseWhen(ctx,'now'); });
BOT.action('w_2h', async (ctx)=>{ await chooseWhen(ctx,'after2h'); });
BOT.action('w_at', async (ctx)=>{ await chooseWhen(ctx,'at'); });
BOT.action('w_every', async (ctx)=>{ await chooseWhen(ctx,'everyXh'); });

async function chooseWhen(ctx:any, w:'now'|'after2h'|'at'|'everyXh'){
  const s = sessions.get(ctx.from.id) || { files: [] };
  s.when = w;
  sessions.set(ctx.from.id, s);
  await ctx.answerCbQuery();
  if (w === 'at') {
    s.expecting = 'datetime';
    sessions.set(ctx.from.id, s);
    await ctx.reply('Send a datetime like `2025-10-11 19:30`.');
  } else if (w === 'everyXh') {
    s.expecting = 'everyHours';
    sessions.set(ctx.from.id, s);
    await ctx.reply('How many hours between posts? (e.g., 3)');
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
  }

  const defaultEvery = settings?.default_every_hours ?? 3;
  const everyH = when === 'everyXh'
    ? (s.everyHours ?? defaultEvery)
    : null;

  const scheduledTimes: dayjs.Dayjs[] = [];
  for (let i = 0; i < files.length; i++) {
    const slot = (when === 'everyXh')
      ? firstAt.add(i * (everyH ?? defaultEvery), 'hour')
      : firstAt.add(i * 3, 'minute');
    scheduledTimes.push(slot);
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

async function saveCookies(ctx:any, platform:'instagram'|'tiktok', username:string, nickname:string, rawJson:string){
  try{
    const cookies = JSON.parse(rawJson);
    const file = cookieFilePath(platform, ctx.from.id, nickname);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeEncryptedJson(file, cookies);
    deleteAccount.run(String(ctx.from.id), platform, nickname);
    addAccount.run(String(ctx.from.id), platform, nickname, username, file, dayjs().toISOString());
    await ctx.reply(`✅ Saved cookies for ${platform} account “${nickname}”.`, mainMenu());
    log.info('Saved account cookies', { platform, nickname, userId: ctx.from.id });
  }catch(e){
    await ctx.reply('Invalid JSON. Try again.');
    log.warn('Failed to save cookies', { platform, nickname, error: e instanceof Error ? e.message : String(e) });
  }
}

BOT.action('schedule', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply('Use the Upload flow to set schedule per batch.'); });
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
