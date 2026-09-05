import { parseIntake } from './ai';
import { resolveAccountId, resolveCategoryId } from './finance-reference';
import { generateObjectKey, normalizeRelativePath, computeSha256, getSyncFileRecord, listSyncFiles } from './sync';
import { resolveTelegramReferenceTime } from './telegram-time';
import type { Env, TelegramUpdate } from './types';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token, X-Wanxiang-Path, X-Wanxiang-Base-Version, X-Wanxiang-Base-Hash, X-Wanxiang-Modified-At, X-Wanxiang-Source',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    }
  });
}

function verifyBearerToken(request: Request, env: Env, includeSyncToken = false): boolean {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const requestPath = new URL(request.url).pathname;
  const syncTokenAllowed = includeSyncToken && requestPath.startsWith('/v1/sync/');
  const configuredTokens = syncTokenAllowed
    ? [env.OBSIDIAN_SYNC_API_KEY, env.WANXIANG_API_KEY, env.API_BEARER_TOKEN]
    : [env.WANXIANG_API_KEY, env.API_BEARER_TOKEN];
  return configuredTokens.filter((value): value is string => Boolean(value)).includes(token);
}

function getBearerOrSecret(env: Env): string | undefined {
  return env.WANXIANG_API_KEY || env.API_BEARER_TOKEN;
}

function getLocalNow(timeZone: string): string {
  return resolveTelegramReferenceTime(undefined, timeZone);
}

function fallbackCategoryName(type: 'expense' | 'income' | 'transfer'): string {
  if (type === 'income') return '其他收入';
  if (type === 'transfer') return '转账';
  return '其他支出';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token, X-Wanxiang-Path, X-Wanxiang-Base-Version, X-Wanxiang-Base-Hash, X-Wanxiang-Modified-At, X-Wanxiang-Source',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
        }
      });
    }

    // Health check
    if (url.pathname === '/health' && method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'wanxiang-cloud',
        version: '0.2.0',
        r2_bound: !!env.FILES,
        d1_bound: !!env.DB
      });
    }

    // ==========================================
    // v0.2: R2 & Obsidian Sync API endpoints
    // ==========================================

    // 1. GET /v1/sync/list
    if (url.pathname === '/v1/sync/list' && method === 'GET') {
      if (!verifyBearerToken(request, env, true)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';
      const files = await listSyncFiles(env.DB, includeDeleted);
      return jsonResponse({ ok: true, data: { files } });
    }

    // 2. GET /v1/sync/metadata
    if (url.pathname === '/v1/sync/metadata' && method === 'GET') {
      if (!verifyBearerToken(request, env, true)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }
      const pathParam = url.searchParams.get('path');
      if (!pathParam) {
        return jsonResponse({ ok: false, error: 'PATH_REQUIRED' }, 400);
      }
      let normPath: string;
      try {
        normPath = normalizeRelativePath(pathParam);
      } catch {
        return jsonResponse({ ok: false, error: 'INVALID_PATH' }, 400);
      }
      const record = await getSyncFileRecord(env.DB, normPath);
      if (!record) {
        return jsonResponse({ ok: false, error: 'FILE_NOT_FOUND' }, 404);
      }
      return jsonResponse({ ok: true, data: { file: record } });
    }

    // 3. GET /v1/sync/file
    if (url.pathname === '/v1/sync/file' && method === 'GET') {
      if (!verifyBearerToken(request, env, true)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }
      const pathParam = url.searchParams.get('path');
      if (!pathParam) {
        return jsonResponse({ ok: false, error: 'PATH_REQUIRED' }, 400);
      }
      let normPath: string;
      try {
        normPath = normalizeRelativePath(pathParam);
      } catch {
        return jsonResponse({ ok: false, error: 'INVALID_PATH' }, 400);
      }
      const record = await getSyncFileRecord(env.DB, normPath);
      if (!record || record.is_deleted === 1) {
        return jsonResponse({ ok: false, error: 'FILE_NOT_FOUND_OR_DELETED' }, 404);
      }
      const object = await env.FILES.get(record.object_key);
      if (!object) {
        return jsonResponse({ ok: false, error: 'R2_OBJECT_NOT_FOUND' }, 404);
      }

      const headers = new Headers();
      headers.set('Content-Type', record.path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
      headers.set('X-Wanxiang-Path', record.path);
      headers.set('X-Wanxiang-Version', record.version.toString());
      headers.set('X-Wanxiang-Content-Hash', record.content_hash);
      headers.set('X-Wanxiang-Modified-At', record.modified_at);

      return new Response(object.body as unknown as BodyInit, {
        status: 200,
        headers
      });
    }

    // 4. PUT /v1/sync/file (Upload / Update)
    if (url.pathname === '/v1/sync/file' && (method === 'PUT' || method === 'POST')) {
      if (!verifyBearerToken(request, env, true)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }

      const pathHeader = request.headers.get('X-Wanxiang-Path') || url.searchParams.get('path');
      const baseVersionHeader = request.headers.get('X-Wanxiang-Base-Version');
      const baseHashHeader = request.headers.get('X-Wanxiang-Base-Hash');
      const modifiedAtHeader = request.headers.get('X-Wanxiang-Modified-At') || new Date().toISOString();
      const sourceHeader = request.headers.get('X-Wanxiang-Source') || 'local';

      if (!pathHeader) {
        return jsonResponse({ ok: false, error: 'PATH_REQUIRED' }, 400);
      }

      let normPath: string;
      try {
        normPath = normalizeRelativePath(pathHeader);
      } catch {
        return jsonResponse({ ok: false, error: 'INVALID_PATH' }, 400);
      }

      const fileBuffer = await request.arrayBuffer();
      const contentHash = await computeSha256(fileBuffer);
      const sizeBytes = fileBuffer.byteLength;
      const objectKey = generateObjectKey(normPath);

      // Check existing D1 record for conflict
      const existing = await getSyncFileRecord(env.DB, normPath);

      if (existing && existing.is_deleted === 0) {
        // If content is identical, no-op success
        if (existing.content_hash === contentHash) {
          return jsonResponse({
            ok: true,
            message: 'FILE_UNCHANGED',
            data: { file: existing }
          });
        }

        // Conflict check: if caller provided a base_version or base_hash, verify it matches current cloud version
        if (baseVersionHeader && parseInt(baseVersionHeader, 10) !== existing.version) {
          return jsonResponse({
            ok: false,
            error: 'CONFLICT',
            message: `Cloud version (${existing.version}) is ahead of base version (${baseVersionHeader})`,
            data: {
              current_cloud: existing,
              client_base_version: parseInt(baseVersionHeader, 10)
            }
          }, 409);
        }

        if (baseHashHeader && baseHashHeader !== existing.content_hash) {
          return jsonResponse({
            ok: false,
            error: 'CONFLICT',
            message: `Cloud content hash (${existing.content_hash}) differs from client base hash (${baseHashHeader})`,
            data: {
              current_cloud: existing,
              client_base_hash: baseHashHeader
            }
          }, 409);
        }
      }

      // Store in R2
      await env.FILES.put(objectKey, fileBuffer, {
        customMetadata: {
          path: normPath,
          content_hash: contentHash,
          modified_at: modifiedAtHeader,
          source: sourceHeader
        }
      });

      const nextVersion = existing ? existing.version + 1 : 1;
      const fileId = existing ? existing.id : crypto.randomUUID();
      const nowIso = new Date().toISOString();

      // Upsert into D1
      await env.DB.prepare(`
        INSERT INTO sync_files (
          id, path, object_key, content_hash, version, size_bytes, modified_at, last_source, is_deleted, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          object_key = excluded.object_key,
          content_hash = excluded.content_hash,
          version = excluded.version,
          size_bytes = excluded.size_bytes,
          modified_at = excluded.modified_at,
          last_source = excluded.last_source,
          is_deleted = 0,
          deleted_at = NULL,
          updated_at = excluded.updated_at
      `).bind(
        fileId,
        normPath,
        objectKey,
        contentHash,
        nextVersion,
        sizeBytes,
        modifiedAtHeader,
        sourceHeader,
        nowIso,
        nowIso
      ).run();

      const updatedRecord = await getSyncFileRecord(env.DB, normPath);

      return jsonResponse({
        ok: true,
        message: 'FILE_SAVED',
        data: { file: updatedRecord }
      });
    }

    // 5. DELETE /v1/sync/file (Soft Delete / Tombstone)
    if (url.pathname === '/v1/sync/file' && method === 'DELETE') {
      if (!verifyBearerToken(request, env, true)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }

      const pathParam = url.searchParams.get('path');
      if (!pathParam) {
        return jsonResponse({ ok: false, error: 'PATH_REQUIRED' }, 400);
      }

      let normPath: string;
      try {
        normPath = normalizeRelativePath(pathParam);
      } catch {
        return jsonResponse({ ok: false, error: 'INVALID_PATH' }, 400);
      }

      const existing = await getSyncFileRecord(env.DB, normPath);
      if (!existing || existing.is_deleted === 1) {
        return jsonResponse({ ok: true, message: 'ALREADY_DELETED_OR_NOT_FOUND' });
      }

      const nowIso = new Date().toISOString();
      const nextVersion = existing.version + 1;

      // Soft delete: update D1 record to is_deleted=1 with deleted_at timestamp (do NOT delete R2 object)
      await env.DB.prepare(`
        UPDATE sync_files
        SET is_deleted = 1, deleted_at = ?, version = ?, updated_at = ?
        WHERE path = ?
      `).bind(nowIso, nextVersion, nowIso, normPath).run();

      const updated = await getSyncFileRecord(env.DB, normPath);

      return jsonResponse({
        ok: true,
        message: 'FILE_SOFT_DELETED',
        data: { file: updated }
      });
    }

    // 6. POST /v1/sync/restore (Restore Soft-Deleted File)
    if (url.pathname === '/v1/sync/restore' && method === 'POST') {
      if (!verifyBearerToken(request, env, true)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }

      let body: { path?: string } = {};
      try {
        body = await request.json();
      } catch {}

      const pathParam = body.path || url.searchParams.get('path');
      if (!pathParam) {
        return jsonResponse({ ok: false, error: 'PATH_REQUIRED' }, 400);
      }

      let normPath: string;
      try {
        normPath = normalizeRelativePath(pathParam);
      } catch {
        return jsonResponse({ ok: false, error: 'INVALID_PATH' }, 400);
      }

      const existing = await getSyncFileRecord(env.DB, normPath);
      if (!existing) {
        return jsonResponse({ ok: false, error: 'FILE_NOT_FOUND' }, 404);
      }
      if (existing.is_deleted === 0) {
        return jsonResponse({ ok: true, message: 'FILE_ALREADY_ACTIVE', data: { file: existing } });
      }

      // Verify R2 object still exists
      const r2Obj = await env.FILES.head(existing.object_key);
      if (!r2Obj) {
        return jsonResponse({ ok: false, error: 'R2_OBJECT_MISSING_CANNOT_RESTORE' }, 500);
      }

      const nowIso = new Date().toISOString();
      const nextVersion = existing.version + 1;

      await env.DB.prepare(`
        UPDATE sync_files
        SET is_deleted = 0, deleted_at = NULL, version = ?, updated_at = ?
        WHERE path = ?
      `).bind(nextVersion, nowIso, normPath).run();

      const updated = await getSyncFileRecord(env.DB, normPath);

      return jsonResponse({
        ok: true,
        message: 'FILE_RESTORED',
        data: { file: updated }
      });
    }

    // ==========================================
    // v0.1: Intakes & Telegram Webhook (Core)
    // ==========================================

    // POST /v1/intake
    if (url.pathname === '/v1/intake' && method === 'POST') {
      if (!verifyBearerToken(request, env)) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }

      try {
        const body = (await request.json()) as {
          text?: string;
          source?: string;
          source_id?: string;
          reference_time?: string;
        };

        if (!body.text || typeof body.text !== 'string') {
          return jsonResponse({ ok: false, error: 'TEXT_REQUIRED' }, 400);
        }

        const source = body.source || 'manual_api';
        const sourceId = body.source_id || crypto.randomUUID();

        // 1. Idempotency Check
        const existingTx = await env.DB.prepare(
          'SELECT id FROM transactions WHERE source = ? AND source_id = ?'
        )
          .bind(source, sourceId)
          .first<{ id: string }>();

        if (existingTx) {
          return jsonResponse({
            ok: true,
            message: '这条消息已经处理过，没有重复记账。',
            data: { duplicate: true, transaction_id: existingTx.id }
          });
        }

        // 2. AI Parsing. For Telegram, reference_time is the message's own server timestamp,
        // not the later Worker processing time after a reconnect or queue delay.
        const referenceLocalNow = body.reference_time || getLocalNow(env.APP_TIMEZONE || 'Asia/Shanghai');
        const parsed = await parseIntake(env, body.text, referenceLocalNow);

        // 3. Log Ingestion
        const logId = crypto.randomUUID();
        const logStatus = parsed.intent === 'unknown' ? 'failed' : 'parsed';
        await env.DB.prepare(`
          INSERT INTO ingestion_log (
            id, source, source_id, raw_text, intent, status, error_message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(source, source_id) DO UPDATE SET
            intent = excluded.intent,
            raw_text = excluded.raw_text,
            status = excluded.status,
            error_message = excluded.error_message
        `)
          .bind(
            logId,
            source,
            sourceId,
            body.text,
            parsed.intent,
            logStatus,
            parsed.intent === 'unknown' ? 'unrecognized intake text' : null
          )
          .run();

        // 4. Intent Execution
        if (parsed.intent === 'unknown' || parsed.confidence < 0.5) {
          return jsonResponse({
            ok: false,
            error: 'UNRECOGNIZED_INTAKE',
            message: '未能准确理解您的记账内容，请尝试更清晰的描述（例如：晚饭25元）。'
          }, 422);
        }

        if (parsed.intent === 'spending_today') {
          const referenceDate = referenceLocalNow.slice(0, 10);
          const queryRes = await env.DB.prepare(`
            SELECT SUM(amount_fen) as total_fen FROM transactions
            WHERE type = 'expense' AND substr(occurred_at, 1, 10) = ?
          `).bind(referenceDate).first<{ total_fen: number | null }>();

          const totalFen = queryRes?.total_fen || 0;
          const totalYuan = (totalFen / 100).toFixed(2);

          return jsonResponse({
            ok: true,
            message: `今天已记录支出 ¥${totalYuan}。`,
            data: { total: totalFen / 100 }
          });
        }

        if (parsed.intent === 'create_transaction') {
          const accountId = await resolveAccountId(env, parsed.account_name)
            || await resolveAccountId(env, '未指定');
          if (!accountId) throw new Error('ACCOUNT_NOT_CONFIGURED');

          const categoryId = await resolveCategoryId(env, parsed.category_name, parsed.transaction_type)
            || await resolveCategoryId(env, fallbackCategoryName(parsed.transaction_type), parsed.transaction_type);
          if (!categoryId) throw new Error('CATEGORY_NOT_CONFIGURED');

          const amountFen = Math.round(parsed.amount * 100);
          const txId = crypto.randomUUID();

          await env.DB.prepare(`
            INSERT INTO transactions (
              id, type, amount_fen, currency, account_id, category_id,
              merchant, description, raw_text, source, source_id, occurred_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `)
            .bind(
              txId,
              parsed.transaction_type,
              amountFen,
              parsed.currency,
              accountId,
              categoryId,
              parsed.merchant || null,
              parsed.description || parsed.category_name,
              body.text,
              source,
              sourceId,
              parsed.occurred_at
            )
            .run();

          const typeLabel = parsed.transaction_type === 'income' ? '收入' : parsed.transaction_type === 'transfer' ? '转账' : '支出';
          const msg = `已记录${typeLabel} ¥${parsed.amount.toFixed(2)} · ${parsed.category_name} · ${parsed.account_name}`;

          return jsonResponse({
            ok: true,
            message: msg,
            data: {
              transaction_id: txId,
              type: parsed.transaction_type,
              amount: parsed.amount,
              category: parsed.category_name,
              account: parsed.account_name,
              merchant: parsed.merchant || null,
              occurred_at: parsed.occurred_at
            }
          });
        }

        return jsonResponse({ ok: false, error: 'UNHANDLED_INTENT' }, 400);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ ok: false, error: 'INTERNAL_ERROR', details: message }, 500);
      }
    }

    // POST /telegram/webhook
    if (url.pathname === '/telegram/webhook' && method === 'POST') {
      const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        return jsonResponse({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET_NOT_CONFIGURED' }, 503);
      }
      if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
        return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
      }

      try {
        const update = (await request.json()) as TelegramUpdate;
        const text = update?.message?.text?.trim();
        const chatId = update?.message?.chat?.id;

        if (!text || !chatId) {
          return jsonResponse({ ok: true, ignored: true });
        }

        const referenceTime = resolveTelegramReferenceTime(
          update.message?.date,
          env.APP_TIMEZONE || 'Asia/Shanghai'
        );

        // Delegate to intake handler logic
        const intakeReq = new Request('https://worker.local/v1/intake', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getBearerOrSecret(env)}`
          },
          body: JSON.stringify({
            text,
            source: 'telegram',
            source_id: `tg_${update.message?.message_id || update.update_id}`,
            reference_time: referenceTime
          })
        });

        const intakeRes = await this.fetch(intakeReq, env);
        const intakeJson = (await intakeRes.json()) as { ok: boolean; message?: string; error?: string };

        const replyText = intakeJson.message || intakeJson.error || '已处理请求。';

        // Deliver to Telegram if bot token configured
        if (env.TELEGRAM_BOT_TOKEN) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: replyText
            })
          });
        }

        return jsonResponse({ ok: true });
      } catch (err: unknown) {
        return jsonResponse({ ok: false, error: 'WEBHOOK_PROCESS_FAILED' }, 500);
      }
    }

    return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404);
  }
};
