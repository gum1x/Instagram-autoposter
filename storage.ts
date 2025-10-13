import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type SaveOptions = {
  contentType?: string;
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

let supabaseClient: SupabaseClient | null = null;

function isSupabaseEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_KEY && SUPABASE_BUCKET);
}

function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    if (!isSupabaseEnabled()) {
      throw new Error('Supabase storage is not configured.');
    }
    supabaseClient = createClient(SUPABASE_URL!, SUPABASE_KEY!);
  }
  return supabaseClient;
}

function normalizeKey(key: string): string {
  return key.replace(/^\.?\/*/, '').replace(/\\/g, '/');
}

function localPathFromKey(key: string): string {
  if (path.isAbsolute(key)) {
    return key;
  }
  return path.resolve(normalizeKey(key));
}

async function uploadToSupabase(key: string, data: Buffer, options?: SaveOptions): Promise<void> {
  const client = getSupabase();
  const { error } = await client.storage
    .from(SUPABASE_BUCKET!)
    .upload(normalizeKey(key), data, { upsert: true, contentType: options?.contentType || 'application/octet-stream' });

  if (error) {
    throw new Error(`Supabase upload failed for ${key}: ${error.message}`);
  }
}

async function downloadFromSupabase(key: string): Promise<Buffer> {
  const client = getSupabase();
  const { data, error } = await client.storage.from(SUPABASE_BUCKET!).download(normalizeKey(key));
  if (error) {
    throw new Error(`Supabase download failed for ${key}: ${error.message}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function storageSave(key: string, data: Buffer, options?: SaveOptions): Promise<string> {
  const localPath = localPathFromKey(key);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fs.promises.writeFile(localPath, data);

  if (isSupabaseEnabled()) {
    await uploadToSupabase(key, data, options);
  }

  return key;
}

export async function storageRead(key: string): Promise<Buffer> {
  const localPath = localPathFromKey(key);
  try {
    return await fs.promises.readFile(localPath);
  } catch (err) {
    if (isSupabaseEnabled()) {
      const data = await downloadFromSupabase(key);
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      await fs.promises.writeFile(localPath, data);
      return data;
    }
    throw err;
  }
}

export async function storageTryRead(key: string): Promise<Buffer | null> {
  try {
    return await storageRead(key);
  } catch {
    return null;
  }
}

export async function storageEnsureLocalPath(key: string): Promise<string> {
  await storageRead(key);
  return localPathFromKey(key);
}

export async function storageExists(key: string): Promise<boolean> {
  const localPath = localPathFromKey(key);
  try {
    await fs.promises.access(localPath, fs.constants.F_OK);
    return true;
  } catch {
    if (!isSupabaseEnabled()) {
      return false;
    }
    const data = await storageTryRead(key);
    return data !== null;
  }
}

export function storageAbsolutePath(key: string): string {
  return localPathFromKey(key);
}

export function storageUsesSupabase(): boolean {
  return isSupabaseEnabled();
}
