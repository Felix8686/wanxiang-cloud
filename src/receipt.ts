import type {
  Env,
  ParsedReceipt,
  ParsedReceiptItem,
  ReceiptItemCategory,
  ReceiptReconciliation,
  TelegramPhotoSize
} from './types';

const DEFAULT_RECEIPT_VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const MAX_RECEIPT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_ITEMS = 200;
const RECEIPT_CONFIDENCE_MIN = 0.8;
const TOTAL_CONFIDENCE_MIN = 0.9;
const ITEM_CONFIDENCE_MIN = 0.55;
const MAX_LOW_CONFIDENCE_ITEM_RATIO = 0.25;
const RECONCILIATION_TOLERANCE_FEN = 2;

const ITEM_CATEGORIES: ReceiptItemCategory[] = [
  '食品', '饮料', '生鲜', '零食', '日用品', '清洁用品', '个护',
  '医药健康', '母婴', '宠物', '家居', '数码配件', '服饰', '其他'
];
const ITEM_CATEGORY_SET = new Set<string>(ITEM_CATEGORIES);

const receiptSchema = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean' },
    merchant: { type: 'string' },
    occurred_at: { type: 'string' },
    currency: { type: 'string' },
    total_amount: { type: 'number', minimum: 0 },
    subtotal_amount: { type: ['number', 'null'] },
    discount_amount: { type: 'number', minimum: 0 },
    tax_amount: { type: 'number', minimum: 0 },
    rounding_amount: { type: 'number' },
    payment_method: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    total_confidence: { type: 'number', minimum: 0, maximum: 1 },
    rejection_reason: { type: 'string' },
    items: {
      type: 'array',
      maxItems: MAX_RECEIPT_ITEMS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number', minimum: 0 },
          unit_price: { type: ['number', 'null'] },
          line_total: { type: 'number', minimum: 0 },
          category: { type: 'string', enum: ITEM_CATEGORIES },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['name', 'quantity', 'unit_price', 'line_total', 'category', 'confidence']
      }
    }
  },
  required: [
    'is_receipt', 'merchant', 'occurred_at', 'currency', 'total_amount', 'subtotal_amount',
    'discount_amount', 'tax_amount', 'rounding_amount', 'payment_method', 'confidence',
    'total_confidence', 'items', 'rejection_reason'
  ]
} as const;

export interface DownloadedTelegramPhoto {
  bytes: ArrayBuffer;
  mimeType: string;
  filePath: string;
}

export interface ReceiptProcessResult {
  ok: boolean;
  message: string;
  transactionId?: string;
  duplicate?: boolean;
  itemCount?: number;
}

export function selectLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return [...photos].sort((a, b) => {
    const areaDiff = b.width * b.height - a.width * a.height;
    if (areaDiff !== 0) return areaDiff;
    return (b.file_size || 0) - (a.file_size || 0);
  })[0] || null;
}

export function buildReceiptSourceId(chatId: number, photo: TelegramPhotoSize, messageId: number, updateId: number): string {
  const stablePhotoId = cleanText(photo.file_unique_id, 160) || `message_${messageId || updateId}`;
  return `receipt_${chatId}_${stablePhotoId}`;
}

export async function downloadTelegramPhoto(env: Env, photo: TelegramPhotoSize): Promise<DownloadedTelegramPhoto> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
  if (photo.file_size && photo.file_size > MAX_RECEIPT_IMAGE_BYTES) throw new Error('RECEIPT_IMAGE_TOO_LARGE');

  const getFileResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(photo.file_id)}`);
  if (!getFileResponse.ok) throw new Error(`TELEGRAM_GET_FILE_HTTP_${getFileResponse.status}`);

  const payload = await getFileResponse.json() as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  const filePath = payload.result?.file_path;
  if (!payload.ok || !filePath) throw new Error('TELEGRAM_GET_FILE_FAILED');
  if (payload.result?.file_size && payload.result.file_size > MAX_RECEIPT_IMAGE_BYTES) {
    throw new Error('RECEIPT_IMAGE_TOO_LARGE');
  }

  const fileResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileResponse.ok) throw new Error(`TELEGRAM_DOWNLOAD_HTTP_${fileResponse.status}`);

  const bytes = await fileResponse.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('TELEGRAM_IMAGE_EMPTY');
  if (bytes.byteLength > MAX_RECEIPT_IMAGE_BYTES) throw new Error('RECEIPT_IMAGE_TOO_LARGE');

  const mimeType = normalizeImageMimeType(fileResponse.headers.get('content-type'), filePath);
  return { bytes, mimeType, filePath };
}

export async function analyzeReceiptImage(
  env: Env,
  imageBytes: ArrayBuffer,
  mimeType: string,
  caption: string,
  localNow: string
): Promise<ParsedReceipt> {
  const dataUri = `data:${mimeType};base64,${arrayBufferToBase64(imageBytes)}`;
  const model = env.RECEIPT_VISION_MODEL || DEFAULT_RECEIPT_VISION_MODEL;
  const userContext = caption.trim() ? `\n用户附加说明：${caption.trim().slice(0, 500)}` : '';

  const result = await env.AI.run(model, {
    messages: [
      {
        role: 'system',
        content: [
          '你是“万象云端”的购物小票视觉解析器。只做识别和结构化，不执行数据库操作。',
          '目标是识别中文或中英混合的超市、便利店、商店购物小票。',
          '先判断图片是否真的是购物小票/收据；普通照片、截图、商品包装、菜单等必须 is_receipt=false。',
          '商品必须逐行提取。折扣、满减、优惠券、税费、四舍五入不要伪装成商品行，分别放入对应字段。',
          'discount_amount 使用正数表示优惠减少的金额；tax_amount 使用正数；rounding_amount 可正可负。',
          '商品 category 只能从以下值选择：食品、饮料、生鲜、零食、日用品、清洁用品、个护、医药健康、母婴、宠物、家居、数码配件、服饰、其他。',
          'quantity 支持称重商品的小数数量。看不清 unit_price 时返回 null，但 line_total 必须是该商品实际行金额。',
          '不要猜数字。金额或商品行看不清时降低 confidence/total_confidence。',
          'occurred_at 尽量输出 YYYY-MM-DDTHH:mm:ss；确实看不清则返回空字符串。',
          'currency 默认 CNY。payment_method 看不清返回“未识别”。',
          '只输出 JSON，不输出 Markdown，不输出解释文字。',
          `当前本地时间：${localNow}。`
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `解析这张购物小票。${userContext}` },
          { type: 'image_url', image_url: { url: dataUri } }
        ]
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: receiptSchema
    },
    temperature: 0,
    max_tokens: 5000
  });

  return validateReceipt(extractJsonValue(result));
}

export function reconcileReceipt(receipt: ParsedReceipt): ReceiptReconciliation {
  const itemsTotalFen = receipt.items.reduce((sum, item) => sum + yuanToFen(item.line_total), 0);
  const discountFen = yuanToFen(receipt.discount_amount);
  const taxFen = yuanToFen(receipt.tax_amount);
  const roundingFen = yuanToFenSigned(receipt.rounding_amount);
  const expectedTotalFen = itemsTotalFen - discountFen + taxFen + roundingFen;
  const receiptTotalFen = yuanToFen(receipt.total_amount);
  const differenceFen = receiptTotalFen - expectedTotalFen;

  return {
    ok: Math.abs(differenceFen) <= RECONCILIATION_TOLERANCE_FEN,
    items_total_fen: itemsTotalFen,
    discount_fen: discountFen,
    tax_fen: taxFen,
    rounding_fen: roundingFen,
    expected_total_fen: expectedTotalFen,
    receipt_total_fen: receiptTotalFen,
    difference_fen: differenceFen
  };
}

export async function processTelegramReceipt(
  env: Env,
  input: {
    chatId: number;
    messageId: number;
    updateId: number;
    photo: TelegramPhotoSize;
    caption: string;
    localNow: string;
  }
): Promise<ReceiptProcessResult> {
  const source = 'telegram';
  const sourceId = buildReceiptSourceId(input.chatId, input.photo, input.messageId, input.updateId);

  const existingTransaction = await env.DB.prepare(
    'SELECT id FROM transactions WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string }>();
  if (existingTransaction?.id) {
    return { ok: true, duplicate: true, transactionId: existingTransaction.id, message: '这张小票已经记录过，没有重复记账。' };
  }

  const lockId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO ingestion_log (id, source, source_id, intent, raw_text, status, error_message, created_at)
    VALUES (?, ?, ?, 'receipt_image', ?, 'processing', NULL, CURRENT_TIMESTAMP)
  `).bind(lockId, source, sourceId, input.caption.trim().slice(0, 1000) || null).run();

  const lock = await env.DB.prepare(
    'SELECT id, status FROM ingestion_log WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string; status: string }>();
  if (!lock || lock.id !== lockId) {
    return { ok: true, duplicate: true, message: lock?.status === 'processing' ? '这张小票正在处理中，请稍候。' : '这张小票已经处理过，没有重复记账。' };
  }

  try {
    const downloaded = await downloadTelegramPhoto(env, input.photo);
    const receipt = await analyzeReceiptImage(env, downloaded.bytes, downloaded.mimeType, input.caption, input.localNow);

    if (!receipt.is_receipt) {
      await updateReceiptIngestion(env, source, sourceId, 'rejected', receipt.rejection_reason || 'not a shopping receipt');
      return { ok: false, message: '这张图片看起来不像购物小票，没有记账。' };
    }

    const safetyError = validateReceiptSafety(receipt);
    if (safetyError) {
      await updateReceiptIngestion(env, source, sourceId, 'rejected', safetyError);
      return { ok: false, message: `小票识别结果不够可靠，没有记账。${humanizeSafetyError(safetyError)}` };
    }

    const reconciliation = reconcileReceipt(receipt);
    if (!reconciliation.ok) {
      await updateReceiptIngestion(
        env,
        source,
        sourceId,
        'rejected',
        `amount mismatch difference_fen=${reconciliation.difference_fen}`
      );
      return { ok: false, message: '小票金额核对失败，请确认小票是否拍摄完整、清晰后再发送。' };
    }

    const transactionId = crypto.randomUUID();
    const accountId = await resolveReceiptAccountId(env, receipt.payment_method);
    const categoryId = resolveReceiptTopLevelCategory(receipt.items);
    const occurredAt = normalizeOccurredAt(receipt.occurred_at, input.localNow);
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
        input.caption.trim().slice(0, 1000) || null
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
        WHERE source = ? AND source_id = ?
      `).bind(source, sourceId)
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
    await updateReceiptIngestion(env, source, sourceId, 'failed', message.slice(0, 300));
    if (message === 'RECEIPT_IMAGE_TOO_LARGE') {
      return { ok: false, message: '小票图片太大，请重新发送一张较小或经过 Telegram 压缩的照片。' };
    }
    return { ok: false, message: '小票识别失败，数据未写入。请重新拍清晰一些再发送。' };
  }
}

export function formatReceiptSummary(receipt: ParsedReceipt, reconciliation: ReceiptReconciliation): string {
  const categoryTotals = new Map<string, number>();
  for (const item of receipt.items) {
    categoryTotals.set(item.category, (categoryTotals.get(item.category) || 0) + yuanToFen(item.line_total));
  }

  const categoryLines = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, fen]) => `${category} ¥${(fen / 100).toFixed(2)}`);

  return [
    '已识别并记录购物小票',
    '',
    `商家：${cleanText(receipt.merchant, 80) || '未识别'}`,
    `总计：¥${(reconciliation.receipt_total_fen / 100).toFixed(2)}`,
    `商品：${receipt.items.length} 项`,
    receipt.payment_method && receipt.payment_method !== '未识别' ? `支付：${cleanText(receipt.payment_method, 60)}` : '',
    '',
    '分类：',
    ...categoryLines
  ].filter((line, index, arr) => line !== '' || (index > 0 && arr[index - 1] !== '')).join('\n');
}

function validateReceipt(value: unknown): ParsedReceipt {
  if (!value || typeof value !== 'object') throw new Error('RECEIPT_AI_INVALID_OBJECT');
  const v = value as Record<string, unknown>;
  const rawItems = Array.isArray(v.items) ? v.items : [];
  const items = rawItems.slice(0, MAX_RECEIPT_ITEMS).map(validateReceiptItem);

  return {
    is_receipt: Boolean(v.is_receipt),
    merchant: cleanText(v.merchant, 160),
    occurred_at: cleanText(v.occurred_at, 40),
    currency: cleanText(v.currency, 8).toUpperCase() || 'CNY',
    total_amount: toNonNegativeNumber(v.total_amount),
    subtotal_amount: v.subtotal_amount === null || v.subtotal_amount === undefined ? null : toNonNegativeNumber(v.subtotal_amount),
    discount_amount: toNonNegativeNumber(v.discount_amount),
    tax_amount: toNonNegativeNumber(v.tax_amount),
    rounding_amount: toFiniteNumber(v.rounding_amount, 0),
    payment_method: cleanText(v.payment_method, 80) || '未识别',
    confidence: clampConfidence(v.confidence),
    total_confidence: clampConfidence(v.total_confidence),
    items,
    rejection_reason: cleanText(v.rejection_reason, 240)
  };
}

function validateReceiptItem(value: unknown): ParsedReceiptItem {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const requestedCategory = cleanText(v.category, 30);
  return {
    name: cleanText(v.name, 160),
    quantity: toPositiveNumber(v.quantity, 1),
    unit_price: v.unit_price === null || v.unit_price === undefined ? null : toNonNegativeNumber(v.unit_price),
    line_total: toNonNegativeNumber(v.line_total),
    category: (ITEM_CATEGORY_SET.has(requestedCategory) ? requestedCategory : '其他') as ReceiptItemCategory,
    confidence: clampConfidence(v.confidence)
  };
}

function validateReceiptSafety(receipt: ParsedReceipt): string | null {
  if (!receipt.is_receipt) return 'NOT_RECEIPT';
  if (!Number.isFinite(receipt.total_amount) || receipt.total_amount <= 0 || receipt.total_amount > 1_000_000) return 'INVALID_TOTAL';
  if (receipt.confidence < RECEIPT_CONFIDENCE_MIN) return 'LOW_RECEIPT_CONFIDENCE';
  if (receipt.total_confidence < TOTAL_CONFIDENCE_MIN) return 'LOW_TOTAL_CONFIDENCE';
  if (receipt.items.length === 0 || receipt.items.length > MAX_RECEIPT_ITEMS) return 'INVALID_ITEM_COUNT';

  let lowConfidenceItems = 0;
  for (const item of receipt.items) {
    if (!item.name || item.quantity <= 0 || item.quantity > 10000) return 'INVALID_ITEM';
    if (!Number.isFinite(item.line_total) || item.line_total < 0 || item.line_total > 1_000_000) return 'INVALID_ITEM_AMOUNT';
    if (item.confidence < ITEM_CONFIDENCE_MIN) lowConfidenceItems += 1;
  }
  if (lowConfidenceItems / receipt.items.length > MAX_LOW_CONFIDENCE_ITEM_RATIO) return 'TOO_MANY_LOW_CONFIDENCE_ITEMS';
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

async function updateReceiptIngestion(env: Env, source: string, sourceId: string, status: string, errorMessage: string | null): Promise<void> {
  await env.DB.prepare(`
    UPDATE ingestion_log
    SET intent = 'receipt_image', status = ?, error_message = ?
    WHERE source = ? AND source_id = ?
  `).bind(status, errorMessage, source, sourceId).run();
}

function extractJsonValue(result: unknown): unknown {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const response = record?.response;
  if (response && typeof response === 'object') return response;
  if (typeof response === 'string') return parseJsonText(response);

  const choices = Array.isArray(record?.choices) ? record?.choices as Array<Record<string, unknown>> : [];
  const message = choices[0]?.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return parseJsonText(content);
  }
  if (typeof result === 'string') return parseJsonText(result);
  throw new Error('RECEIPT_AI_EMPTY_RESPONSE');
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('RECEIPT_AI_INVALID_JSON');
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function normalizeImageMimeType(contentType: string | null, filePath: string): string {
  const normalized = (contentType || '').split(';')[0].trim().toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp'].includes(normalized)) return normalized;
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function normalizeOccurredAt(value: string, fallback: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value)) return value.slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00`;
  return fallback;
}

function yuanToFen(value: number): number {
  return Math.round(Math.max(0, value) * 100);
}

function yuanToFenSigned(value: number): number {
  return Math.round(value * 100);
}

function toNonNegativeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
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
