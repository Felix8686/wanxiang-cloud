import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

export interface LocalSyncConfig {
  vaultPath: string;
  serverUrl: string;
  apiKey: string;
  dryRun?: boolean;
}

export interface CloudFileMetadata {
  id: string;
  path: string;
  object_key: string;
  content_hash: string;
  version: number;
  size_bytes: number;
  modified_at: string;
  last_source: string;
  is_deleted: number;
  deleted_at: string | null;
  updated_at: string;
}

export interface FileSyncStatus {
  path: string;
  state: 'synced' | 'local_only' | 'cloud_only' | 'modified_local' | 'modified_cloud' | 'conflict' | 'deleted_cloud' | 'ignored';
  localHash?: string;
  cloudHash?: string;
  cloudVersion?: number;
  detail?: string;
}

export interface StateDatabase {
  files: Record<string, {
    path: string;
    lastSyncedHash: string;
    lastSyncedVersion: number;
    lastSyncedAt: string;
  }>;
}

const IGNORED_PATTERNS = [
  /^\.git(\/|\\|$)/,
  /^\.obsidian(\/|\\)cache(\/|\\|$)/,
  /^\.trash(\/|\\|$)/,
  /^node_modules(\/|\\|$)/,
  /\.DS_Store$/,
  /thumbs\.db$/i,
  /~$/,
  /\.conflict-\d+\.[^.]+$/,
  /\.swp$/,
  /\.tmp$/i,
  /\.temp$/i,
  /^\.wanxiang-sync(\/|\\|$)/
];

export function isIgnoredPath(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return IGNORED_PATTERNS.some(p => p.test(norm));
}

export function computeFileSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

export function computeBufferSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export class ObsidianSyncClient {
  private config: LocalSyncConfig;
  private stateFilePath: string;
  private state: StateDatabase;
  private proxyDispatcher?: ProxyAgent;

  constructor(config: LocalSyncConfig) {
    this.config = config;
    if (!fs.existsSync(this.config.vaultPath)) {
      throw new Error(`Vault path does not exist: ${this.config.vaultPath}`);
    }
    const stateDir = path.join(this.config.vaultPath, '.wanxiang-sync');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    this.stateFilePath = path.join(stateDir, 'sync-state.json');
    this.state = this.loadState();

    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (proxy) {
      try {
        this.proxyDispatcher = new ProxyAgent(proxy);
      } catch {}
    }
  }

  private loadState(): StateDatabase {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const content = fs.readFileSync(this.stateFilePath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return { files: {} };
      }
    }
    return { files: {} };
  }

  private saveState(): void {
    if (this.config.dryRun) return;
    fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  private async fetchApi(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.config.serverUrl.replace(/\/+$/, '')}${endpoint}`;
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.config.apiKey}`);
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ObsidianSyncClient/0.2.0');

    const undiciOptions: any = {
      ...options,
      headers
    };
    if (this.proxyDispatcher) {
      undiciOptions.dispatcher = this.proxyDispatcher;
    }

    const res = await (undiciFetch as any)(url, undiciOptions);
    return res as unknown as Response;
  }

  public scanLocalFiles(): Record<string, { fullPath: string; hash: string; size: number; mtime: string }> {
    const result: Record<string, { fullPath: string; hash: string; size: number; mtime: string }> = {};

    const walk = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(this.config.vaultPath, fullPath).replace(/\\/g, '/');

        if (isIgnoredPath(relPath)) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          const hash = computeFileSha256(fullPath);
          result[relPath] = {
            fullPath,
            hash,
            size: stats.size,
            mtime: stats.mtime.toISOString()
          };
        }
      }
    };

    walk(this.config.vaultPath);
    return result;
  }

  public async fetchCloudFiles(includeDeleted = false): Promise<Record<string, CloudFileMetadata>> {
    const res = await this.fetchApi(`/v1/sync/list?include_deleted=${includeDeleted}`);
    if (!res.ok) {
      throw new Error(`Failed to list cloud files: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { ok: boolean; data: { files: CloudFileMetadata[] } };
    const result: Record<string, CloudFileMetadata> = {};
    for (const file of data.data.files) {
      result[file.path] = file;
    }
    return result;
  }

  public async getStatus(): Promise<FileSyncStatus[]> {
    const localFiles = this.scanLocalFiles();
    const cloudFiles = await this.fetchCloudFiles(true);

    const allPaths = new Set([...Object.keys(localFiles), ...Object.keys(cloudFiles)]);
    const statuses: FileSyncStatus[] = [];

    for (const relPath of Array.from(allPaths).sort()) {
      const local = localFiles[relPath];
      const cloud = cloudFiles[relPath];
      const stateItem = this.state.files[relPath];

      if (local && (!cloud || cloud.is_deleted === 1)) {
        if (!stateItem) {
          statuses.push({ path: relPath, state: 'local_only', localHash: local.hash });
        } else {
          statuses.push({ path: relPath, state: 'deleted_cloud', localHash: local.hash, detail: 'Deleted on cloud but present locally' });
        }
      } else if (!local && cloud && cloud.is_deleted === 0) {
        statuses.push({ path: relPath, state: 'cloud_only', cloudHash: cloud.content_hash, cloudVersion: cloud.version });
      } else if (local && cloud && cloud.is_deleted === 0) {
        if (local.hash === cloud.content_hash) {
          statuses.push({ path: relPath, state: 'synced', localHash: local.hash, cloudHash: cloud.content_hash, cloudVersion: cloud.version });
        } else {
          const localChanged = !stateItem || stateItem.lastSyncedHash !== local.hash;
          const cloudChanged = !stateItem || stateItem.lastSyncedVersion !== cloud.version;

          if (localChanged && cloudChanged) {
            statuses.push({
              path: relPath,
              state: 'conflict',
              localHash: local.hash,
              cloudHash: cloud.content_hash,
              cloudVersion: cloud.version,
              detail: `Local edited (hash ${local.hash.slice(0, 8)}) & Cloud updated (v${cloud.version})`
            });
          } else if (localChanged) {
            statuses.push({ path: relPath, state: 'modified_local', localHash: local.hash, cloudHash: cloud.content_hash, cloudVersion: cloud.version });
          } else {
            statuses.push({ path: relPath, state: 'modified_cloud', localHash: local.hash, cloudHash: cloud.content_hash, cloudVersion: cloud.version });
          }
        }
      }
    }

    return statuses;
  }

  public async pushFile(relPath: string, options: { force?: boolean } = {}): Promise<{ success: boolean; message: string; version?: number }> {
    const fullPath = path.join(this.config.vaultPath, relPath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, message: 'Local file does not exist' };
    }

    const fileBuffer = fs.readFileSync(fullPath);
    const contentHash = computeBufferSha256(fileBuffer);
    const stats = fs.statSync(fullPath);
    const stateItem = this.state.files[relPath];

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Wanxiang-Path': relPath,
      'X-Wanxiang-Modified-At': stats.mtime.toISOString(),
      'X-Wanxiang-Source': 'obsidian_sync'
    };

    if (!options.force && stateItem) {
      headers['X-Wanxiang-Base-Version'] = stateItem.lastSyncedVersion.toString();
      headers['X-Wanxiang-Base-Hash'] = stateItem.lastSyncedHash;
    }

    if (this.config.dryRun) {
      return { success: true, message: `[DRY-RUN] Would upload ${relPath} (hash: ${contentHash.slice(0, 8)})` };
    }

    const res = await this.fetchApi('/v1/sync/file', {
      method: 'PUT',
      headers,
      body: fileBuffer
    });

    if (res.status === 409) {
      const errJson = await res.json() as { error: string; message: string };
      return { success: false, message: `CONFLICT: ${errJson.message}` };
    }

    if (!res.ok) {
      return { success: false, message: `Upload failed: ${res.status} ${await res.text()}` };
    }

    const resJson = (await res.json()) as { ok: boolean; data: { file: CloudFileMetadata } };
    const savedFile = resJson.data.file;

    this.state.files[relPath] = {
      path: relPath,
      lastSyncedHash: savedFile.content_hash,
      lastSyncedVersion: savedFile.version,
      lastSyncedAt: new Date().toISOString()
    };
    this.saveState();

    return { success: true, message: `Uploaded ${relPath} (v${savedFile.version})`, version: savedFile.version };
  }

  public async pullFile(relPath: string): Promise<{ success: boolean; message: string }> {
    const res = await this.fetchApi(`/v1/sync/file?path=${encodeURIComponent(relPath)}`);
    if (!res.ok) {
      return { success: false, message: `Download failed: ${res.status} ${await res.text()}` };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const versionStr = res.headers.get('X-Wanxiang-Version') || '1';
    const contentHash = res.headers.get('X-Wanxiang-Content-Hash') || computeBufferSha256(buffer);

    const fullPath = path.join(this.config.vaultPath, relPath);

    if (this.config.dryRun) {
      return { success: true, message: `[DRY-RUN] Would download ${relPath} (v${versionStr}) to local` };
    }

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, buffer);

    this.state.files[relPath] = {
      path: relPath,
      lastSyncedHash: contentHash,
      lastSyncedVersion: parseInt(versionStr, 10),
      lastSyncedAt: new Date().toISOString()
    };
    this.saveState();

    return { success: true, message: `Downloaded ${relPath} (v${versionStr})` };
  }

  public async deleteCloudFile(relPath: string): Promise<{ success: boolean; message: string }> {
    if (this.config.dryRun) {
      return { success: true, message: `[DRY-RUN] Would soft-delete ${relPath} on cloud` };
    }

    const res = await this.fetchApi(`/v1/sync/file?path=${encodeURIComponent(relPath)}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      return { success: false, message: `Delete failed: ${res.status} ${await res.text()}` };
    }

    delete this.state.files[relPath];
    this.saveState();

    return { success: true, message: `Soft-deleted ${relPath} on cloud` };
  }

  public async restoreCloudFile(relPath: string): Promise<{ success: boolean; message: string }> {
    if (this.config.dryRun) {
      return { success: true, message: `[DRY-RUN] Would restore ${relPath} on cloud` };
    }

    const res = await this.fetchApi('/v1/sync/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath })
    });

    if (!res.ok) {
      return { success: false, message: `Restore failed: ${res.status} ${await res.text()}` };
    }

    const resJson = (await res.json()) as { ok: boolean; data: { file: CloudFileMetadata } };
    const restoredFile = resJson.data.file;

    this.state.files[relPath] = {
      path: relPath,
      lastSyncedHash: restoredFile.content_hash,
      lastSyncedVersion: restoredFile.version,
      lastSyncedAt: new Date().toISOString()
    };
    this.saveState();

    return { success: true, message: `Restored ${relPath} (v${restoredFile.version}) on cloud` };
  }

  public async sync(): Promise<{ actions: string[]; conflicts: string[] }> {
    const statuses = await this.getStatus();
    const actions: string[] = [];
    const conflicts: string[] = [];

    for (const item of statuses) {
      if (item.state === 'synced') continue;

      if (item.state === 'local_only' || item.state === 'modified_local') {
        const res = await this.pushFile(item.path);
        if (res.success) {
          actions.push(res.message);
        } else {
          conflicts.push(`${item.path}: ${res.message}`);
        }
      } else if (item.state === 'cloud_only' || item.state === 'modified_cloud') {
        const res = await this.pullFile(item.path);
        if (res.success) {
          actions.push(res.message);
        } else {
          conflicts.push(`${item.path}: ${res.message}`);
        }
      } else if (item.state === 'conflict') {
        // Handle conflict safely: create local conflict copy if not dry-run, do NOT overwrite
        conflicts.push(item.path);
        if (!this.config.dryRun) {
          const fullPath = path.join(this.config.vaultPath, item.path);
          const ext = path.extname(item.path);
          const base = item.path.slice(0, -ext.length || undefined);
          const conflictCopyPath = path.join(this.config.vaultPath, `${base}.conflict-${Date.now()}${ext}`);
          if (fs.existsSync(fullPath)) {
            fs.copyFileSync(fullPath, conflictCopyPath);
            actions.push(`Created local conflict backup copy at ${path.relative(this.config.vaultPath, conflictCopyPath)}`);
          }
        } else {
          actions.push(`[DRY-RUN] Conflict detected on ${item.path} - would preserve local copy`);
        }
      }
    }

    return { actions, conflicts };
  }
}
