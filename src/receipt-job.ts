import {
  analyzeReceiptImage,
  buildReceiptSourceId,
  downloadTelegramPhoto,
  formatReceiptSummary,
  reconcileReceipt
} from './receipt';
import type {
  Env,
  ParsedReceipt,
  ParsedReceiptItem,
  ReceiptProcessResult,
  TelegramPhotoSize
} from './types';

export interface ReceiptQueueJob {
  chatId: number;
  messageId: number;
  updateId: number;
  photo: TelegramPhotoSize;
  caption: string;
  localNow: string;
}

export interface ReceiptEnqueueResult {
  queued: boolean;
  duplicate?: boolean;
  inProgress?: boolean;
  message: string;
  sourceId: string;
}

const STALE_PROCESSING_SECONDS = 240;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 120_000;
const RECEIPT_CONFIDENCE_MIN = 0.8;
const TOTAL_CONFIDENCE_MIN = 0.9;
const ITEM_CONFIDENCE_MIN = 0.55;
const MAX_LOW_CONFIDENCE_ITEM_RATIO = 0.25;

export async function enqueueReceiptJob(env: Env, job: ReceiptQueueJob): Promise<ReceiptEnqueueResult> {
  if (!env.RECEIPT_QUEUE) {
    return {
      queued: false,
      message: '小票处理队列尚未配置，请稍后再试。',
      sourceId: buildReceiptSourceId(job.chatId, job.photo, job.messageId, job.updateId)
    };
  }

  const source = 'telegram';
  const sourceId = buildReceiptSourceId(job.chatId, job.photo, job.messageId, job.updateId);

  const existingTransaction = await env.DB.prepare(
    'SELECT id FROM transactions WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string }>();

  if (existingTransaction?.id) {
    return {
      queued: false,
      duplicate: true,
      message: '这张小票已经记录过，没有重复记账。',
      sourceId
    };
  }

  const existing = await env.DB.prepare(
    'SELECT id, status, created_at FROM ingestion_log WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string; status: string; created_at: string }>();

  if (existing && ['queued', 'processing'].includes(existing.status) && !isStale(existing.created_at)) {
    return {
      queued: false,
      inProgress: true,
      message: '这张小票正在识别中，请稍候。',
      sourceId
    };
  }

  if (existing?.status === 'parsed') {
    return {
      queued: false,
      duplicate: true,
      message: '这张小票已经处理过，没有重复记账。',
      sourceId
    };
  }

  const queueId = crypto.randomUUID();
  const rawText = job.caption.trim().slice(0, 1000) || null;

  if (existing) {
    await env.DB.prepare(`
      UPDATE ingestion_log
      SET id = ?, intent = 'receipt_image', raw_text = ?, status = 'queued',
          error_message = NULL, created_at = CURRENT_TIMESTAMP
      WHERE source = ? AND source_id = ?
    `).bind(queueId, rawText, source, sourceId).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO ingestion_log (id, source, source_id, intent, raw_text, status, error_message, created_at)
      VALUES (?, ?, ?, 'receipt_image', ?, 'queued', NULL, CURRENT_TIMESTAMP)
    `).bind(queueId, source, sourceId, rawText).run();
  }

  try {
    await env.RECEIPT_QUEUE.send(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE ingestion_log
      SET status = 'failed', error_message = ?
      WHERE id = ? AND source = ? AND source_id = ?
    `).bind(`QUEUE_SEND_FAILED: ${message}`.slice(0, 300), queueId, source, sourceId).run();
    return {
      queued: false,
      message: '小票任务提交失败，请稍后重新发送。',
      sourceId
    };
  }

  return {
    queued: true,
    message: '已收到小票，正在识别。',
    sourceId
  };
}

export async function processReceiptQueueJob(env: Env, job: ReceiptQueueJob): Promise<ReceiptProcessResult> {
  const source = 'telegram';
  const sourceId = buildReceiptSourceId(job.chatId, job.photo, job.messageId, job.updateId);

  const existingTransaction = await env.DB.prepare(
    'SELECT id FROM transactions WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string }>();

  if (existingTransaction?.id) {
    return {
      ok: true,
      duplicate: true,
      transactionId: existingTransaction.id,
      message: '这张小票已经记录过，没有重复记账。'
    };
  }

  const lockId = crypto.randomUUID();
  const lock = await acquireProcessingLock(env, source, sourceId, lockId, job.caption);
  if (!lock.acquired) {
    return {
      ok: true,
      duplicate: true,
      message: lock.status === 'processing' || lock.status === 'queued'
        ? '这张小票正在处理中，请稍候。'
        : '这张小票已经处理过，没有重复记账。'
    };
  }

  try {
    const downloaded = await withTimeout(
      downloadTelegramPhoto(env, job.photo),
      DOWNLOAD_TIMEOUT_MS,
      'TELEGRAM_DOWNLOAD_TIMEOUT'
    );

    const receipt = await withTimeout(
      analyzeReceiptImage(env, downloaded.bytes, downloaded.mimeType, job.caption, job.localNow),
      AI_TIMEOUT_MS,
      'RECEIPT_AI_TIMEOUT'
    );

    if (!receipt.is_receipt) {
      await finishAttempt(env, lockId, source, sourceId, 'rejected', receipt.rejection_reason || 'not a shopping receipt');
      return { ok: false, message: '这张图片看起来不像购物小票，没有记账。' };
    }

    const safetyError = validateReceiptSafety(receipt);
    if (safetyError) {
      await finishAttempt(env, lockId, source, sourceId, 'rejected', safetyError);
      return { ok: false, message: `小票识别结果不够可靠，没有记账。${humanizeSafetyError(safetyError)}` };
    }

    const reconciliation = reconcileReceipt(receipt);
    if (!reconciliation.ok) {
      await finishAttempt(
        env,
        lockId,
        source,
        sourceId,
        'rejected',
        `amount mismatch difference_fen=${reconciliation.difference_fen}`
      );
      return { ok: false, message: '小票金额核对失败，请确认小票是否拍摄完整、清晰后再发送。' };
    }

    if (!await stillOwnLock(env, lockId, source, sourceId)) {
      throw new Error('RECEIPT_PROCESSING_LOCK_LOST');
    }

    const transactionId = crypto.randomUUID();
    const accountId = await resolveReceiptAccountId(env, receipt.payment_method);
    const categoryId = resolveReceiptTopLevelCategory(receipt.items);
    const occurredAt = normalizeOccurredAt(receipt.occurred_at, job.localNow);
    const merchant = cleanText(receipt.merchant, 160) || '未识别商家';
    const description = `购物小票 · ${merchant} · ${receipt.items.length}项`;

    const statements = [
      env.DB.prepare(`
        INSERT INTO transactions (
          id, type, amount_fen, currency, account_id, category_id, merchant, description,
          occurred_at, source, source_id, raw_text, created_at, updated_at
        ) VALUES (?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        transactionId,
        reconciliation.receipt_total_fen,
        receipt.currency || 'CNY',
        accountId,
        categoryId,
        merchant,
        description,
        occurredAt,
        source,
        sourceId,
        job.caption.trim().slice(0, 1000) || null
      ),
      ...receipt.items.map((item) => env.DB.prepare(`
        INSERT INTO transaction_items (
          id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        crypto.randomUUID(),
        transactionId,
        item.name,
        item.quantity,
        item.unit_price === null ? null : yuanToFen(item.unit_price),
        yuanToFen(item.line_total),
        item.category,
        item.confidence
      )),
      env.DB.prepare(`
        UPDATE ingestion_log
        SET intent = 'receipt_image', status = 'parsed', error_message = NULL
        WHERE id = ? AND source = ? AND source_id = ? AND status = 'processing'
      `).bind(lockId, source, sourceId)
    ];

    await env.DB.batch(statements);

    return {
      ok: true,
      transactionId,
      itemCount: receipt.items.length,
      message: formatReceiptSummary(receipt, reconciliation)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishAttempt(env, lockId, source, sourceId, 'failed', message.slice(0, 300));

    if (message === 'RECEIPT_IMAGE_TOO_LARGE') {
      return { ok: false, message: '小票图片太大，请重新发送一张较小或经过 Telegram 压缩的照片。' };
    }
    if (message === 'RECEIPT_AI_TIMEOUT') {
      return { ok: false, message: '小票识别超时，本次没有记账。请稍后重新发送这张小票。' };
    }
    if (message === 'TELEGRAM_DOWNLOAD_TIMEOUT') {
      return { ok: false, message: '下载小票图片超时，本次没有记账。请稍后重新发送。' };
    }

    return { ok: false, message: '小票识别失败，数据未写入。请稍后重新发送或拍清晰一些。' };
  }
}

async function acquireProcessingLock(
  env: Env,
  source: string,
  sourceId: string,
  lockId: string,
  caption: string
): Promise<{ acquired: boolean; status?: string }> {
  const existing = await env.DB.prepare(
    'SELECT id, status, created_at FROM ingestion_log WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string; status: string; created_at: string }>();

  if (!existing) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO ingestion_log (id, source, source_id, intent, raw_text, status, error_message, created_at)
      VALUES (?, ?, ?, 'receipt_image', ?, 'processing', NULL, CURRENT_TIMESTAMP)
    `).bind(lockId, source, sourceId, caption.trim().slice(0, 1000) || null).run();
  } else if (
    existing.status === 'queued' ||
    existing.status === 'failed' ||
    existing.status === 'rejected' ||
    (existing.status === 'processing' && isStale(existing.created_at))
  ) {
    await env.DB.prepare(`
      UPDATE ingestion_log
      SET id = ?, intent = 'receipt_image', raw_text = ?, status = 'processing',
          error_message = NULL, created_at = CURRENT_TIMESTAMP
      WHERE source = ? AND source_id = ? AND id = ?
    `).bind(
      lockId,
      caption.trim().slice(0, 1000) || null,
      source,
      sourceId,
      existing.id
    ).run();
  } else {
    return { acquired: false, status: existing.status };
  }

  const owner = await env.DB.prepare(
    'SELECT id, status FROM ingestion_log WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string; status: string }>();

  return {
    acquired: owner?.id === lockId && owner.status === 'processing',
    status: owner?.status
  };
}

async function stillOwnLock(env: Env, lockId: string, source: string, sourceId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id, status FROM ingestion_log WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string; status: string }>();
  return row?.id === lockId && row.status === 'processing';
}

async function finishAttempt(
  env: Env,
  lockId: string,
  source: string,
  sourceId: string,
  status: 'failed' | 'rejected',
  errorMessage: string | null
): Promise<void> {
  await env.DB.prepare(`
    UPDATE ingestion_log
    SET intent = 'receipt_image', status = ?, error_message = ?
    WHERE id = ? AND source = ? AND source_id = ? AND status = 'processing'
  `).bind(status, errorMessage, lockId, source, sourceId).run();
}

function isStale(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt.endsWith('Z') ? createdAt : `${createdAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp >= STALE_PROCESSING_SECONDS * 1000;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function validateReceiptSafety(receipt: ParsedReceipt): string | null {
  if (!receipt.is_receipt) return 'NOT_RECEIPT';
  if (!Number.isFinite(receipt.total_amount) || receipt.total_amount <= 0 || receipt.total_amount > 1_000_000) return 'INVALID_TOTAL';
  if (receipt.confidence < RECEIPT_CONFIDENCE_MIN) return 'LOW_RECEIPT_CONFIDENCE';
  if (receipt.total_confidence < TOTAL_CONFIDENCE_MIN) return 'LOW_TOTAL_CONFIDENCE';
  if (receipt.items.length === 0 || receipt.items.length > 200) return 'INVALID_ITEM_COUNT';

  let lowConfidenceItems = 0;
  for (const item of receipt.items) {
    if (!item.name || item.quantity <= 0 || item.quantity > 10000) return 'INVALID_ITEM';
    if (!Number.isFinite(item.line_total) || item.line_total < 0 || item.line_total > 1_000_000) return 'INVALID_ITEM_AMOUNT';
    if (item.confidence < ITEM_CONFIDENCE_MIN) lowConfidenceItems += 1;
  }

  if (lowConfidenceItems / receipt.items.length > MAX_LOW_CONFIDENCE_ITEM_RATIO) {
    return 'TOO_MANY_LOW_CONFIDENCE_ITEMS';
  }
  return null;
}

async function resolveReceiptAccountId(env: Env, paymentMethod: string): Promise<string> {
  const method = paymentMethod.trim();
  if (!method || method === '未识别') return 'account-unspecified';

  const candidates = [method];
  if (/支付宝/.test(method)) candidates.push('支付宝');
  if (/微信/.test(method)) candidates.push('微信');
  if (/现金/.test(method)) candidates.push('现金');

  for (const candidate of candidates) {
    const row = await env.DB.prepare('SELECT id FROM accounts WHERE name LIKE ? LIMIT 1')
      .bind(`%${candidate}%`).first<{ id: string }>();
    if (row?.id) return row.id;
  }
  return 'account-unspecified';
}

function resolveReceiptTopLevelCategory(items: ParsedReceiptItem[]): string {
  let foodFen = 0;
  let dailyFen = 0;
  let otherFen = 0;

  for (const item of items) {
    const fen = yuanToFen(item.line_total);
    if (['食品', '饮料', '生鲜', '零食'].includes(item.category)) foodFen += fen;
    else if (['日用品', '清洁用品', '个护', '家居'].includes(item.category)) dailyFen += fen;
    else otherFen += fen;
  }

  if (foodFen >= dailyFen && foodFen >= otherFen) return 'cat-expense-food';
  if (dailyFen >= foodFen && dailyFen >= otherFen) return 'cat-expense-daily';
  return 'cat-expense-other';
}

function normalizeOccurredAt(value: string, fallback: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value)) return value.slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00`;
  return fallback;
}

function yuanToFen(value: number): number {
  return Math.round(Math.max(0, value) * 100);
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function humanizeSafetyError(code: string): string {
  switch (code) {
    case 'LOW_RECEIPT_CONFIDENCE':
    case 'LOW_TOTAL_CONFIDENCE':
    case 'TOO_MANY_LOW_CONFIDENCE_ITEMS':
      return '请把小票铺平、保证光线充足并重新拍摄。';
    case 'INVALID_ITEM_COUNT':
    case 'INVALID_ITEM':
    case 'INVALID_ITEM_AMOUNT':
      return '商品明细存在无法确认的内容，请重新拍清晰一些。';
    default:
      return '请重新拍摄完整小票。';
  }
}
