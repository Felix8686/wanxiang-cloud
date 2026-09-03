import coreHandler from './index';
import { processTelegramReceipt, selectLargestPhoto } from './receipt';
import type { Env, TelegramUpdate, TelegramPhotoSize } from './types';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
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

async function handleReceiptPhoto(
  env: Env,
  input: {
    chatId: number;
    messageId: number;
    updateId: number;
    photo: TelegramPhotoSize;
    caption: string;
  }
): Promise<void> {
  const result = await processTelegramReceipt(env, {
    ...input,
    localNow: getLocalNow(env.APP_TIMEZONE || 'Asia/Shanghai')
  });

  try {
    await sendTelegramMessage(env, input.chatId, result.message);
  } catch (error) {
    console.error('telegram receipt reply failed', error instanceof Error ? error.message : 'unknown error');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === '/health' && method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'wanxiang-cloud',
        version: '0.3.0',
        receipt_vision: true,
        receipt_vision_model: env.RECEIPT_VISION_MODEL || '@cf/google/gemma-4-26b-a4b-it',
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

    const task = handleReceiptPhoto(env, {
      chatId,
      messageId,
      updateId: update.update_id,
      photo,
      caption: update.message?.caption?.trim() || ''
    });

    if (ctx?.waitUntil) {
      ctx.waitUntil(task);
      return jsonResponse({ ok: true, receipt: true, accepted: true });
    }

    await task;
    return jsonResponse({ ok: true, receipt: true, accepted: true });
  }
};
