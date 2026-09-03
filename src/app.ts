import coreHandler from './index';
import { selectLargestPhoto } from './receipt';
import { enqueueReceiptJob } from './receipt-job';
import { processReceiptQueueJobV2 } from './receipt-job-v2';
import { isVeryfiConfigured } from './receipt-provider';
import type { Env, TelegramUpdate } from './types';
import type { ReceiptQueueJob } from './receipt-job';

interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

interface QueueBatchLike<T> {
  messages: QueueMessageLike<T>[];
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function getLocalNow(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date()).replace(' ', 'T');
  } catch {
    return new Date().toISOString();
  }
}

async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error(`TELEGRAM_SEND_HTTP_${response.status}`);
}

async function sendTelegramMessageSafely(env: Env, chatId: number, text: string): Promise<void> {
  try {
    await sendTelegramMessage(env, chatId, text);
  } catch (error) {
    console.error('telegram receipt reply failed', error instanceof Error ? error.message : 'unknown error');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === '/health' && method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'wanxiang-cloud',
        version: '0.3.4',
        receipt_vision: true,
        receipt_provider: 'veryfi',
        receipt_provider_configured: isVeryfiConfigured(env),
        receipt_queue_bound: !!env.RECEIPT_QUEUE,
        r2_bound: !!env.FILES,
        d1_bound: !!env.DB
      });
    }

    if (url.pathname !== '/telegram/webhook' || method !== 'POST') {
      return coreHandler.fetch(request, env);
    }

    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET_NOT_CONFIGURED' }, 503);
    }
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
    }

    const legacyRequest = request.clone();
    let update: TelegramUpdate;
    try {
      update = await request.json() as TelegramUpdate;
    } catch {
      return jsonResponse({ ok: false, error: 'INVALID_TELEGRAM_UPDATE' }, 400);
    }

    const photos = update.message?.photo;
    if (!photos || photos.length === 0) {
      return coreHandler.fetch(legacyRequest, env);
    }

    const chatId = update.message?.chat?.id;
    const messageId = update.message?.message_id;
    const photo = selectLargestPhoto(photos);
    if (!chatId || !messageId || !photo) {
      return jsonResponse({ ok: true, ignored: true });
    }

    const job: ReceiptQueueJob = {
      chatId,
      messageId,
      updateId: update.update_id,
      photo,
      caption: update.message?.caption?.trim() || '',
      localNow: getLocalNow(env.APP_TIMEZONE || 'Asia/Shanghai')
    };

    const enqueueResult = await enqueueReceiptJob(env, job);
    await sendTelegramMessageSafely(env, chatId, enqueueResult.message);

    return jsonResponse({
      ok: true,
      receipt: true,
      accepted: enqueueResult.queued,
      duplicate: enqueueResult.duplicate || false,
      in_progress: enqueueResult.inProgress || false,
      source_id: enqueueResult.sourceId
    });
  },

  async queue(batch: QueueBatchLike<ReceiptQueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        const result = await processReceiptQueueJobV2(env, job);
        await sendTelegramMessage(env, job.chatId, result.message);
        message.ack();
      } catch (error) {
        console.error('receipt queue job failed', error instanceof Error ? error.message : 'unknown error');
        message.retry();
      }
    }
  }
};
