-- Complete SQL schema for Supabase PostgreSQL
-- Run this in your Supabase SQL Editor

-- Drop existing tables if they exist (optional - only if you want to start fresh)
DROP TABLE IF EXISTS posts CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;

-- Create posts table
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  tg_user_id TEXT,
  platform TEXT,
  ig_account TEXT,
  tt_account TEXT,
  video_path TEXT,
  caption TEXT,
  hashtags TEXT,
  schedule_type TEXT,
  schedule_at TEXT,
  every_hours INTEGER,
  status TEXT DEFAULT 'queued',
  created_at TEXT,
  retry_count INTEGER DEFAULT 0
);

-- Create settings table
CREATE TABLE settings (
  tg_user_id TEXT PRIMARY KEY,
  default_hashtags TEXT,
  default_every_hours INTEGER,
  platform_pref TEXT
);

-- Create accounts table
CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  tg_user_id TEXT,
  platform TEXT,
  nickname TEXT,
  username TEXT,
  cookie_path TEXT,
  created_at TEXT
);

-- Create indexes for better performance
CREATE INDEX idx_posts_tg_user_id ON posts(tg_user_id);
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_schedule_at ON posts(schedule_at);
CREATE INDEX idx_accounts_tg_user_id ON accounts(tg_user_id);
CREATE INDEX idx_accounts_platform ON accounts(platform);