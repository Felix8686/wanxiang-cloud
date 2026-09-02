import { parseIntake } from './ai';
import type { Env, ParsedIntake, TelegramUpdate, TransactionType } from './types';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface IntakeResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

const CATEGORY_ALLOWLIST: Record<TransactionType, Set<string>> = {
  expense: new Set(['餐饮', '日用品', '交通', '其他支出']),
  income: new Set(['工资', '其他收入']),
  transfer: new Set(['转账'])
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'wanxiang-cloud', version: '0.1.0' });
    }

    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET_NOT_CONFIGURED' }, 503);
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);

      const update = await request.json<TelegramUpdate>();
      ctx.waitUntil(handleTelegramUpdate(env, update));
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/v1/intake') {
      if (!authorized(request, env)) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
      const body = await request.json<{ text?: string; source_id?: string }>();
      const text = body.text?.trim();
      if (!text) return json({ ok: false, error: 'TEXT_REQUIRED' }, 400);

      const result = await processIntake(env, text, 'api', body.source_id || crypto.randomUUID());
      return json(result, result.ok ? 200 : 422);
    }

    return json({ ok: false, error: 'NOT_FOUND' }, 404);
  }
};

async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const text = message?.text?.trim();
  if (!message || !text || !env.TELEGRAM_BOT_TOKEN) return;

  try {
    const result = await processIntake(env, text, 'telegram', String(update.update_id));
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, result.message);
  } catch (error) {
    console.error('telegram update failed', error);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, '处理失败，数据未写入。请稍后重试。');
  }
}

async function processIntake(env: Env, text: string, source: string, sourceId: string): Promise<IntakeResult> {
  const duplicate = await env.DB.prepare(
    'SELECT status FROM ingestion_log WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ status: string }>();

  if (duplicate?.status === 'success') {
    return { ok: true, message: '这条消息已经处理过，没有重复记账。', data: { duplicate: true } };
  }

  const now = localDateTime(env.APP_TIMEZONE || 'Asia/Shanghai');
  let parsed: ParsedIntake;

  try {
    parsed = await parseIntake(env, text, now);
  } catch (error) {
    await logIngestion(env, source, sourceId, 'unknown', text, 'failed', errorMessage(error));
    return { ok: false, message: 'AI 解析失败，数据未写入。' };
  }

  if (parsed.confidence < 0.55 || parsed.intent === 'unknown') {
    await logIngestion(env, source, sourceId, parsed.intent, text, 'needs_review', null);
    return { ok: false, message: '我没能可靠理解这句话，所以没有改动数据。' };
  }

  if (parsed.intent === 'spending_today') {
    const date = now.slice(0, 10);
    const row = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_fen), 0) AS total_fen FROM transactions WHERE type = 'expense' AND substr(occurred_at, 1, 10) = ?"
    ).bind(date).first<{ total_fen: number }>();

    await logIngestion(env, source, sourceId, parsed.intent, text, 'success', null);
    const total = Number(row?.total_fen || 0) / 100;
    return { ok: true, message: `今天已记录支出 ¥${total.toFixed(2)}。`, data: { total } };
  }

  if (parsed.intent === 'create_transaction') {
    if (!Number.isFinite(parsed.amount) || parsed.amount <= 0) {
      await logIngestion(env, source, sourceId, parsed.intent, text, 'failed', 'INVALID_AMOUNT');
      return { ok: false, message: '金额无法确认，所以没有记账。' };
    }

    const type = parsed.transaction_type;
    const categoryName = normalizeCategory(type, parsed.category_name);
    const accountId = await ensureAccount(env, parsed.account_name || '未指定', now);
    const categoryId = await findCategory(env, type, categoryName);
    const occurredAt = isLocalIsoLike(parsed.occurred_at) ? parsed.occurred_at : now;
    const transactionId = crypto.randomUUID();
    const amountFen = Math.round(parsed.amount * 100);

    await env.DB.prepare(
      `INSERT INTO transactions (
        id, type, amount_fen, currency, account_id, category_id, merchant, description,
        occurred_at, source, source_id, raw_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      transactionId,
      type,
      amountFen,
      parsed.currency || 'CNY',
      accountId,
      categoryId,
      parsed.merchant || null,
      parsed.description || text.slice(0, 200),
      occurredAt,
      source,
      sourceId,
      text.slice(0, 1000),
      now,
      now
    ).run();

    await logIngestion(env, source, sourceId, parsed.intent, text, 'success', null);
    const verb = type === 'expense' ? '支出' : type === 'income' ? '收入' : '转账';
    return {
      ok: true,
      message: `已记录${verb} ¥${parsed.amount.toFixed(2)} · ${categoryName}${parsed.account_name ? ` · ${parsed.account_name}` : ''}`,
      data: { transaction_id: transactionId, type, amount: parsed.amount, category: categoryName }
    };
  }

  return { ok: false, message: '未执行任何操作。' };
}

async function ensureAccount(env: Env, name: string, now: string): Promise<string> {
  const safeName = name.trim().slice(0, 80) || '未指定';
  const existing = await env.DB.prepare('SELECT id FROM accounts WHERE name = ? LIMIT 1')
    .bind(safeName).first<{ id: string }>();
  if (existing?.id) return existing.id;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO accounts (id, name, type, currency, is_active, created_at) VALUES (?, ?, 'wallet', 'CNY', 1, ?)"
  ).bind(id, safeName, now).run();

  const inserted = await env.DB.prepare('SELECT id FROM accounts WHERE name = ? LIMIT 1')
    .bind(safeName).first<{ id: string }>();
  return inserted?.id || 'account-unspecified';
}

async function findCategory(env: Env, type: TransactionType, name: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id FROM categories WHERE type = ? AND name = ? LIMIT 1')
    .bind(type, name).first<{ id: string }>();
  return row?.id || null;
}

function normalizeCategory(type: TransactionType, requested: string): string {
  if (CATEGORY_ALLOWLIST[type].has(requested)) return requested;
  if (type === 'expense') return '其他支出';
  if (type === 'income') return '其他收入';
  return '转账';
}

async function logIngestion(
  env: Env,
  source: string,
  sourceId: string,
  intent: string,
  rawText: string,
  status: string,
  error: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ingestion_log (id, source, source_id, intent, raw_text, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_id) DO UPDATE SET
       intent = excluded.intent,
       raw_text = excluded.raw_text,
       status = excluded.status,
       error_message = excluded.error_message`
  ).bind(crypto.randomUUID(), source, sourceId, intent, rawText.slice(0, 1000), status, error, new Date().toISOString()).run();
}

async function telegramSend(token: string, chatId: number, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error(`TELEGRAM_SEND_${response.status}`);
}

function authorized(request: Request, env: Env): boolean {
  if (!env.WANXIANG_API_KEY) return false;
  return request.headers.get('authorization') === `Bearer ${env.WANXIANG_API_KEY}`;
}

function localDateTime(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}

function isLocalIsoLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'UNKNOWN_ERROR';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
