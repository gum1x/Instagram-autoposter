import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';

// Database interface
export interface DatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): any;
  close?(): void;
}

// SQLite adapter (for local development)
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

// Supabase adapter (for hosting)
export class SupabaseAdapter implements DatabaseAdapter {
  private supabase: any;

  constructor(url: string, key: string) {
    this.supabase = createClient(url, key);
  }

  exec(sql: string) {
    // Supabase doesn't support raw SQL execution
    // This would need to be handled differently
    console.log('Supabase exec:', sql);
  }

  prepare(sql: string) {
    // Convert SQLite-style queries to Supabase
    return {
      run: (params: any) => this.runQuery(sql, params),
      get: (params: any) => this.getQuery(sql, params),
      all: (params: any) => {
        // Handle async operations synchronously for compatibility
        if (sql.includes('pragma table_info(accounts)')) {
          // Return mock column info for accounts table synchronously
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
        return this.allQuery(sql, params);
      }
    };
  }

  private async runQuery(sql: string, params: any) {
    try {
      // Convert SQLite queries to Supabase operations
      if (sql.includes('INSERT INTO posts')) {
        const { data, error } = await this.supabase
          .from('posts')
          .insert(this.parseInsertParams(sql, params));
        if (error) throw error;
        return { changes: data?.length || 0 };
      }
      
      if (sql.includes('UPDATE posts SET status')) {
        const { data, error } = await this.supabase
          .from('posts')
          .update({ status: params.status })
          .eq('id', params.id);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('UPDATE posts SET schedule_at')) {
        const { data, error } = await this.supabase
          .from('posts')
          .update({ schedule_at: params.schedule_at })
          .eq('id', params.id);
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (sql.includes('UPDATE posts SET retry_count')) {
        const { data, error } = await this.supabase
          .from('posts')
          .update({ retry_count: params.retry_count })
          .eq('id', params.id);
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

      // Handle pragma table_info for accounts table
      if (sql.includes('pragma table_info(accounts)')) {
        // Return mock column info for accounts table
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
    // Parse SQLite INSERT parameters into object
    // This is a simplified version - you'd need to implement proper parsing
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
      status: params[11],
      created_at: params[12],
      retry_count: params[13] || 0
    };
  }
}

// Factory function to create the right database adapter
export function createDatabase(): DatabaseAdapter {
  const dbUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (supabaseUrl && supabaseKey) {
    console.log('Using Supabase database');
    return new SupabaseAdapter(supabaseUrl, supabaseKey);
  } else if (dbUrl && dbUrl.startsWith('postgres://')) {
    console.log('Using PostgreSQL database');
    // You could add PostgreSQL support here
    throw new Error('PostgreSQL adapter not implemented yet');
  } else {
    console.log('Using SQLite database');
    return new SQLiteAdapter(dbUrl || 'sqlite.db');
  }
}
