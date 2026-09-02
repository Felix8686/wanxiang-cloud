import type { Env, SyncFileRecord } from './types';

export function normalizeRelativePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (!normalized || normalized.includes('..') || normalized.startsWith('.')) {
    throw new Error('INVALID_PATH');
  }
  return normalized;
}

export function generateObjectKey(relativePath: string): string {
  const norm = normalizeRelativePath(relativePath);
  if (norm.startsWith('attachments/')) {
    return norm;
  }
  if (norm.endsWith('.md')) {
    return norm.startsWith('notes/') ? norm : `notes/${norm}`;
  }
  return `attachments/${norm}`;
}

export async function computeSha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  let u8: Uint8Array;
  if (typeof data === 'string') {
    u8 = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    u8 = data;
  } else {
    u8 = new Uint8Array(data);
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', u8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getSyncFileRecord(db: Env['DB'], path: string): Promise<SyncFileRecord | null> {
  const norm = normalizeRelativePath(path);
  const stmt = db.prepare('SELECT * FROM sync_files WHERE path = ?').bind(norm);
  const record = await stmt.first<SyncFileRecord>();
  return record || null;
}

export async function listSyncFiles(db: Env['DB'], includeDeleted = false): Promise<SyncFileRecord[]> {
  const query = includeDeleted
    ? 'SELECT * FROM sync_files ORDER BY path ASC'
    : 'SELECT * FROM sync_files WHERE is_deleted = 0 ORDER BY path ASC';
  const res = await db.prepare(query).all<SyncFileRecord>();
  return res.results || [];
}
