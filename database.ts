import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';

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

  constructor(url: string, key: string) {
    this.supabase = createClient(url, key);
  }

  exec(sql: string) {
    console.log('Supabase exec:', sql);
    // Tables are managed in Supabase - nothing to execute synchronously here.
  }

  prepare(sql: string) {
    const normalized = this.normalize(sql);
    return {
      run: (...params: any[]) => this.runQuery(sql, normalized, params),
      get: (...params: any[]) => this.getQuery(sql, normalized, params),
      all: (...params: any[]) => {
        if (/pragma table_info\\(accounts\\)/i.test(normalized)) {
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
        return this.allQuery(sql, normalized, params);
      }
    };
  }

  private normalize(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private getNamedParam(params: any[], key: string): any {
    if (!params.length) return undefined;
    const first = params[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return first[key] ?? first[`:${key}`] ?? first[`@${key}`] ?? first[`$${key}`];
    }
    return undefined;
  }

  private async runQuery(originalSql: string, normalized: string, params: any[]) {
    console.log('Supabase runQuery called', { sql: originalSql.substring(0, 120), paramsCount: params.length, sampleParams: params.slice(0, 3) });
    try {
      if (/^insert into settings\b/.test(normalized)) {
        const [tgUserId, hashtags, everyHours, platformPref] = params;
        const payload = {
          tg_user_id: tgUserId,
          default_hashtags: hashtags ?? null,
          default_every_hours: everyHours ?? null,
          platform_pref: platformPref ?? null
        };
        const { data, error } = await this.supabase
          .from('settings')
          .upsert(payload, { onConflict: 'tg_user_id', ignoreDuplicates: true })
          .select();
        if (error) throw error;
        return { changes: data?.length || 1 };
      }

      if (/^update settings set\b/.test(normalized)) {
        const payloadParam = params[0] && typeof params[0] === 'object' ? params[0] : null;
        const tgUserId = payloadParam
          ? String(payloadParam.tg_user_id ?? payloadParam[':tg_user_id'] ?? payloadParam['@tg_user_id'])
          : String(params[3]);

        const updatePayload = payloadParam
          ? {
              default_hashtags: payloadParam.default_hashtags ?? payloadParam[':default_hashtags'] ?? payloadParam['@default_hashtags'] ?? null,
              default_every_hours: payloadParam.default_every_hours ?? payloadParam[':default_every_hours'] ?? payloadParam['@default_every_hours'] ?? null,
              platform_pref: payloadParam.platform_pref ?? payloadParam[':platform_pref'] ?? payloadParam['@platform_pref'] ?? null
            }
          : {
              default_hashtags: params[0] ?? null,
              default_every_hours: params[1] ?? null,
              platform_pref: params[2] ?? null
            };

        const { data, error } = await this.supabase
          .from('settings')
          .update(updatePayload)
          .eq('tg_user_id', tgUserId)
          .select();
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (/^insert into posts\b/.test(normalized)) {
        const parsed = this.parseInsertParams(params);
        const { data, error } = await this.supabase
          .from('posts')
          .insert(parsed)
          .select();
        if (error) throw error;
        return { changes: data?.length || 1 };
      }

      if (/^insert into accounts\b/.test(normalized)) {
        const [tgUserId, platform, nickname, username, cookiePath, createdAt] = params;
        const { data, error } = await this.supabase
          .from('accounts')
          .insert({
            tg_user_id: tgUserId,
            platform,
            nickname,
            username,
            cookie_path: cookiePath,
            created_at: createdAt
          })
          .select();
        if (error) throw error;
        return { changes: data?.length || 1 };
      }

      if (/^update posts set status\b/.test(normalized)) {
        const status = this.getNamedParam(params, 'status') ?? params[0];
        const id = this.getNamedParam(params, 'id') ?? params[1];
        const { data, error } = await this.supabase
          .from('posts')
          .update({ status })
          .eq('id', id)
          .select();
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (/^update posts set schedule_at\b/.test(normalized)) {
        const scheduleAt = params[0];
        const id = params[1];
        const { data, error } = await this.supabase
          .from('posts')
          .update({ schedule_at: scheduleAt })
          .eq('id', id)
          .select();
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (/^update posts set retry_count\b/.test(normalized)) {
        const id = params[0];
        const { data: existing, error: fetchError } = await this.supabase
          .from('posts')
          .select('retry_count')
          .eq('id', id)
          .single();
        if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
        const current = existing?.retry_count ?? 0;
        const next = current + 1;
        const { data, error } = await this.supabase
          .from('posts')
          .update({ retry_count: next })
          .eq('id', id)
          .select();
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (/^delete from posts\b/.test(normalized)) {
        const tgUserId = params[0];
        let query = this.supabase.from('posts').delete().eq('tg_user_id', tgUserId);
        if (normalized.includes('status = \'queued\'')) {
          query = query.eq('status', 'queued');
        }
        const { data, error } = await query.select();
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      if (/^delete from accounts\b/.test(normalized)) {
        const [tgUserId, platform, nickname] = params;
        const { data, error } = await this.supabase
          .from('accounts')
          .delete()
          .eq('tg_user_id', tgUserId)
          .eq('platform', platform)
          .eq('nickname', nickname)
          .select();
        if (error) throw error;
        return { changes: data?.length || 0 };
      }

      console.warn('Supabase runQuery fell back to no-op for SQL:', normalized);
      return { changes: 0 };
    } catch (error) {
      console.error('Supabase runQuery error:', error);
      throw error;
    }
  }

  private async getQuery(originalSql: string, normalized: string, params: any[]) {
    try {
      if (/^select count\(\*\)/.test(normalized) && normalized.includes('from posts')) {
        const tgUserId = params[0];
        const status = normalized.includes('status') ? 'queued' : undefined;
        let query = this.supabase
          .from('posts')
          .select('id', { count: 'exact', head: true })
          .eq('tg_user_id', tgUserId);
        if (status) query = query.eq('status', status);
        const { count, error } = await query;
        if (error) throw error;
        return { count: count ?? 0 };
      }

      if (/^select \* from settings/.test(normalized)) {
        const tgUserId = params[0];
        const { data, error } = await this.supabase
          .from('settings')
          .select('*')
          .eq('tg_user_id', tgUserId)
          .maybeSingle();
        if (error) throw error;
        return data ?? null;
      }

      if (/^select schedule_at from posts/.test(normalized)) {
        const tgUserId = params[0];
        const { data, error } = await this.supabase
          .from('posts')
          .select('schedule_at')
          .eq('tg_user_id', tgUserId)
          .order('schedule_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        return data ?? null;
      }

      if (/^select cookie_path from accounts/.test(normalized)) {
        const [tgUserId, platform, nickname] = params;
        const { data, error } = await this.supabase
          .from('accounts')
          .select('cookie_path')
          .eq('tg_user_id', tgUserId)
          .eq('platform', platform)
          .eq('nickname', nickname)
          .maybeSingle();
        if (error) throw error;
        return data ?? null;
      }

      if (/^select .* from accounts/.test(normalized) && normalized.includes('limit 1')) {
        // Generic single-account lookup
        const [tgUserId, platform, nickname] = params;
        let query = this.supabase.from('accounts').select('*');
        if (tgUserId !== undefined) query = query.eq('tg_user_id', tgUserId);
        if (platform !== undefined) query = query.eq('platform', platform);
        if (nickname !== undefined) query = query.eq('nickname', nickname);
        const { data, error } = await query.limit(1).maybeSingle();
        if (error) throw error;
        return data ?? null;
      }

      console.warn('Supabase getQuery fell back to null for SQL:', normalized);
      return null;
    } catch (error) {
      console.error('Supabase getQuery error:', error);
      throw error;
    }
  }

  private async allQuery(originalSql: string, normalized: string, params: any[]) {
    try {
      if (/^select \* from posts/.test(normalized)) {
        let query = this.supabase.from('posts').select('*');
        if (normalized.includes('status=\'queued\'')) {
          query = query.eq('status', 'queued');
        }
        if (normalized.includes('tg_user_id=?')) {
          query = query.eq('tg_user_id', params[0]);
        }
        if (normalized.includes('schedule_at <= now()')) {
          query = query.lte('schedule_at', new Date().toISOString());
        } else if (normalized.includes('schedule_at <= ?')) {
          const cutoff = params.find((p) => typeof p === 'string' && p.includes('T')) ?? new Date().toISOString();
          query = query.lte('schedule_at', cutoff);
        }
        if (normalized.includes('order by schedule_at asc')) {
          query = query.order('schedule_at', { ascending: true });
        } else if (normalized.includes('order by schedule_at desc')) {
          query = query.order('schedule_at', { ascending: false });
        }
        const { data, error } = await query;
        if (error) throw error;
        return data ?? [];
      }

      if (/^select nickname, username from accounts/.test(normalized)) {
        const [tgUserId, platform] = params;
        const { data, error } = await this.supabase
          .from('accounts')
          .select('nickname, username')
          .eq('tg_user_id', tgUserId)
          .eq('platform', platform)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return data ?? [];
      }

      if (/^select \* from accounts/.test(normalized)) {
        const [tgUserId] = params;
        const query = this.supabase
          .from('accounts')
          .select('*')
          .eq('tg_user_id', tgUserId)
          .order('platform', { ascending: true })
          .order('created_at', { ascending: false });
        const { data, error } = await query;
        if (error) throw error;
        return data ?? [];
      }

      if (/^select platform, nickname, username from accounts/.test(normalized)) {
        const [tgUserId] = params;
        const { data, error } = await this.supabase
          .from('accounts')
          .select('platform, nickname, username')
          .eq('tg_user_id', tgUserId)
          .order('platform', { ascending: true })
          .order('created_at', { ascending: false });
        if (error) throw error;
        return data ?? [];
      }

      if (/^select distinct tg_user_id from accounts/.test(normalized)) {
        const { data, error } = await this.supabase
          .from('accounts')
          .select('tg_user_id', { distinct: true });
        if (error) throw error;
        return data ?? [];
      }

      if (/^select .* from settings/.test(normalized)) {
        const tgUserId = params[0];
        const { data, error } = await this.supabase
          .from('settings')
          .select('*')
          .eq('tg_user_id', tgUserId);
        if (error) throw error;
        return data ?? [];
      }

      console.warn('Supabase allQuery fell back to empty array for SQL:', normalized);
      return [];
    } catch (error) {
      console.error('Supabase allQuery error:', error);
      throw error;
    }
  }

  private parseInsertParams(params: any[]) {
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
      status: 'queued',
      created_at: params[11],
      retry_count: 0
    };
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
