-- Supabase SQL Schema for Instagram Autoposter
-- Run this in your Supabase SQL editor

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  tg_user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  ig_account TEXT,
  tt_account TEXT,
  video_path TEXT NOT NULL,
  caption TEXT,
  hashtags TEXT,
  schedule_type TEXT NOT NULL,
  schedule_at TIMESTAMPTZ NOT NULL,
  every_hours INTEGER,
  status TEXT DEFAULT 'queued',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  retry_count INTEGER DEFAULT 0
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  tg_user_id TEXT PRIMARY KEY,
  default_hashtags TEXT,
  default_every_hours INTEGER,
  platform_pref TEXT
);

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  tg_user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  nickname TEXT NOT NULL,
  username TEXT,
  cookie_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_posts_status_schedule ON posts(status, schedule_at);
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user_platform ON accounts(tg_user_id, platform);

-- Enable Row Level Security (RLS)
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- Create policies (users can only access their own data)
CREATE POLICY "Users can view own posts" ON posts FOR SELECT USING (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can insert own posts" ON posts FOR INSERT WITH CHECK (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can update own posts" ON posts FOR UPDATE USING (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can delete own posts" ON posts FOR DELETE USING (tg_user_id = current_setting('app.current_user_id'));

CREATE POLICY "Users can view own settings" ON settings FOR SELECT USING (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can insert own settings" ON settings FOR INSERT WITH CHECK (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can update own settings" ON settings FOR UPDATE USING (tg_user_id = current_setting('app.current_user_id'));

CREATE POLICY "Users can view own accounts" ON accounts FOR SELECT USING (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can insert own accounts" ON accounts FOR INSERT WITH CHECK (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can update own accounts" ON accounts FOR UPDATE USING (tg_user_id = current_setting('app.current_user_id'));
CREATE POLICY "Users can delete own accounts" ON accounts FOR DELETE USING (tg_user_id = current_setting('app.current_user_id'));
