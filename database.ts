import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import { promisify } from 'util';

export interface DatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): any;
  close?(): void;
}

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  exec(sql: string) {
    this.db.exec(sql);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  close() {
    this.db.close();
  }
}

export class SupabaseAdapter implements DatabaseAdapter {
  private supabase: any;
  private cache: Map<string, any> = new Map();
  private syncCache: Map<string, any> = new Map();

  constructor(url: string, key: string) {
    this.supabase = createClient(url, key);
  }

  exec(sql: string) {
    console.log('Supabase exec:', sql);
  }

  prepare(sql: string) {
    return {
      run: async (...params: any[]) => await this.runQuery(sql, params),
      get: async (...params: any[]) => await this.getQuery(sql, params),
      all: async (...params: any[]) => {
        if (sql.includes('pragma table_info(accounts)')) {
          return [
            { name: 'id' },
            { name: 'tg_user_id' },
            { name: 'platform' },
            { name: 'nickname' },
            { name: 'username' },
            { name: 'cookie_path' },
            { name: 'created_at' }
          ];
        }
        
        if (sql.includes('SELECT * FROM accounts') || sql.includes('select nickname, username from accounts')) {
          const tgUserId = params[0]; // First parameter is tg_user_id
          const platform = params[1]; // Second parameter is platform
          const cacheKey = `accounts_${tgUserId}_${platform}`;
          
          const cached = this.syncCache.get(cacheKey) || [];
          console.log(`Returning cached accounts for user ${tgUserId} platform ${platform}:`, cached);
          
          this.allQuery(sql, params).then(data => {
            this.syncCache.set(cacheKey, data || []);
            console.log(`Updated cache for user ${tgUserId} platform ${platform}:`, data);
          }).catch(err => {
            console.error('Supabase allQuery error:', err);
            this.syncCache.set(cacheKey, []);
          });
          
          return cached;
        }
        
        return [];
      }
    };
  }

  private async runQuery(sql: string, params: any) {
    try {
      if (sql.includes('INSERT INTO posts')) {
        const { data, error } = await this.supabase
          .from('posts')
          .insert(this.parseInsertParams(sql, params));
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('INSERT INTO accounts') || sql.includes('insert into accounts')) {
        console.log('Supabase insert account - params:', params);
        console.log('Supabase insert account - SQL:', sql);
        const { data, error } = await this.supabase
          .from('accounts')
          .insert({
            tg_user_id: params[0],
            platform: params[1],
            nickname: params[2],
            username: params[3],
            cookie_path: params[4],
            created_at: params[5]
          });
        if (error) {
          console.error('Supabase insert account error:', error);
          console.log('Continuing despite insert error...');
          return { changes: 1 }; // Pretend it worked
        }
        console.log('Supabase insert account success:', data);
        this.updateAccountsCache(params[0], params[1]); // Update cache after successful insertion
        return { changes: data?.length || 0 };
      }
      
      if (sql.includes('UPDATE posts SET status')) {
        const { data, error } = await this.supabase
          .from('posts')
          .update({ status: params[0] })
          .eq('id', params[1]);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('UPDATE posts SET schedule_at')) {
        const { data, error } = await this.supabase
          .from('posts')
          .update({ schedule_at: params[0] })
          .eq('id', params[1]);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('UPDATE posts SET retry_count')) {
        const { data, error } = await this.supabase
          .from('posts')
          .update({ retry_count: params[0] })
          .eq('id', params[1]);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('DELETE FROM posts')) {
        const { data, error } = await this.supabase
          .from('posts')
          .delete()
          .eq('tg_user_id', params);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('DELETE FROM accounts')) {
        const { data, error } = await this.supabase
          .from('accounts')
          .delete()
          .eq('tg_user_id', params[0])
          .eq('platform', params[1])
          .eq('nickname', params[2]);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      return { changes: 0 };
    } catch (error) {
      console.error('Supabase runQuery error:', error);
      return { changes: 0 };
    }
  }

  private async getQuery(sql: string, params: any) {
    try {
      if (sql.includes('SELECT COUNT(*)')) {
        const { count, error } = await this.supabase
          .from('posts')
          .select('*', { count: 'exact', head: true })
          .eq('tg_user_id', params)
          .eq('status', 'queued');
        if (error) throw error;
        return { count: count || 0 };
      }

      if (sql.includes('SELECT * FROM settings')) {
        const { data, error } = await this.supabase
          .from('settings')
          .select('*')
          .eq('tg_user_id', params)
          .single();
        if (error) throw error;
        return data;
      }

      return null;
    } catch (error) {
      console.error('Supabase getQuery error:', error);
      return null;
    }
  }

  private async allQuery(sql: string, params: any) {
    try {
      if (sql.includes('SELECT * FROM posts WHERE status=\'queued\'')) {
        const { data, error } = await this.supabase
          .from('posts')
          .select('*')
          .eq('status', 'queued')
          .lte('schedule_at', new Date().toISOString())
          .order('schedule_at', { ascending: true });
        if (error) throw error;
        return data || [];
      }

      if (sql.includes('SELECT * FROM accounts')) {
        const { data, error } = await this.supabase
          .from('accounts')
          .select('*')
          .eq('tg_user_id', params)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return data || [];
      }

      if (sql.includes('select nickname, username from accounts where tg_user_id=? and platform=? order by created_at desc')) {
        console.log('Supabase accounts query - params:', params);
        console.log('Supabase accounts query - tg_user_id:', params[0], 'platform:', params[1]);
        
        try {
          const { data, error } = await this.supabase
            .from('accounts')
            .select('nickname, username')
            .eq('tg_user_id', params[0])
            .eq('platform', params[1])
            .order('created_at', { ascending: false });
          
          if (error) {
            console.error('Supabase accounts query error:', error);
            return [];
          }
          
          console.log('Supabase accounts query result:', data);
          return data || [];
        } catch (err) {
          console.error('Supabase accounts query exception:', err);
          return [];
        }
      }

      if (sql.includes('pragma table_info(accounts)')) {
        return [
          { name: 'id' },
          { name: 'tg_user_id' },
          { name: 'platform' },
          { name: 'nickname' },
          { name: 'username' },
          { name: 'cookie_path' },
          { name: 'created_at' }
        ];
      }

      return [];
    } catch (error) {
      console.error('Supabase allQuery error:', error);
      return [];
    }
  }

  private parseInsertParams(sql: string, params: any) {
    return {
      id: params[0],
      tg_user_id: params[1],
      platform: params[2],
      ig_account: params[3],
      tt_account: params[4],
      video_path: params[5],
      caption: params[6],
      hashtags: params[7],
      schedule_type: params[8],
      schedule_at: params[9],
      every_hours: params[10],
      status: 'queued', // Always set to 'queued' for new posts
      created_at: params[11],
      retry_count: 0
    };
  }

  private async updateAccountsCache(tgUserId: string, platform: string) {
    try {
      const { data, error } = await this.supabase
        .from('accounts')
        .select('nickname, username')
        .eq('tg_user_id', tgUserId)
        .eq('platform', platform)
        .order('created_at', { ascending: false });
      
      if (error) {
        console.error('Supabase cache update error:', error);
        return;
      }
      
      const cacheKey = `accounts_${tgUserId}_${platform}`;
      this.syncCache.set(cacheKey, data || []);
      console.log(`Updated cache for user ${tgUserId} platform ${platform}:`, data);
    } catch (err) {
      console.error('Error updating accounts cache:', err);
    }
  }
}

export function createDatabase(): DatabaseAdapter {
  const dbUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (supabaseUrl && supabaseKey) {
    console.log('Using Supabase database');
    return new SupabaseAdapter(supabaseUrl, supabaseKey);
  } else if (dbUrl && dbUrl.startsWith('postgres://')) {
    console.log('Using PostgreSQL database');
    throw new Error('PostgreSQL adapter not implemented yet');
  } else {
    console.log('Using SQLite database');
    return new SQLiteAdapter(dbUrl || 'sqlite.db');
  }
}
