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

  const getFileResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(photo.file_id)}`
  );
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

  // Workers AI's native vision examples pass the image through the top-level
  // `image` field. Structured-output responses may arrive as
  // choices[0].message.parsed, so extraction below supports both the native
  // response shape and JSON-mode response wrappers.
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
          '只输出符合指定 schema 的 JSON，不输出 Markdown，不输出解释文字。',
          `当前本地时间：${localNow}。`
        ].join('\n')
      },
      {
        role: 'user',
        content: `解析这张购物小票。${userContext}`
      }
    ],
    image: dataUri,
    response_format: {
      type: 'json_schema',
      json_schema: receiptSchema
    },
    chat_template_kwargs: {
      enable_thinking: false
    },
    temperature: 0,
    max_completion_tokens: 5000
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
    subtotal_amount: v.subtotal_amount === null || v.subtotal_amount === undefined
      ? null
      : toNonNegativeNumber(v.subtotal_amount),
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

export function extractJsonValue(result: unknown): unknown {
  if (typeof result === 'string') return parseJsonText(result);
  if (!result || typeof result !== 'object') {
    logAiResultShape(result);
    throw new Error('RECEIPT_AI_EMPTY_RESPONSE');
  }

  const record = result as Record<string, unknown>;

  // Some structured-output adapters return the parsed object directly.
  if ('is_receipt' in record && 'items' in record) return record;

  // Workers AI JSON mode may return { response: {...} } or a JSON string.
  const response = record.response;
  if (response && typeof response === 'object') return response;
  if (typeof response === 'string' && response.trim()) return parseJsonText(response);

  // REST-like wrappers are accepted defensively even though the Worker binding
  // normally returns the inner result directly.
  const nestedResult = record.result;
  if (nestedResult && typeof nestedResult === 'object') {
    try {
      return extractJsonValue(nestedResult);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RECEIPT_AI_EMPTY_RESPONSE') throw error;
    }
  }
  if (typeof nestedResult === 'string' && nestedResult.trim()) return parseJsonText(nestedResult);

  const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : [];
  const message = choices[0]?.message;
  if (message && typeof message === 'object') {
    const messageRecord = message as Record<string, unknown>;

    // Cloudflare structured-output examples expose the validated object here.
    const parsed = messageRecord.parsed;
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof parsed === 'string' && parsed.trim()) return parseJsonText(parsed);

    const content = messageRecord.content;
    if (typeof content === 'string' && content.trim()) return parseJsonText(content);
    if (Array.isArray(content)) {
      const text = content
        .map((part) => part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined)
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
        .trim();
      if (text) return parseJsonText(text);
    }
  }

  logAiResultShape(result);
  throw new Error('RECEIPT_AI_EMPTY_RESPONSE');
}

function logAiResultShape(result: unknown): void {
  const shape = describeAiResultShape(result);
  // Deliberately log only types/key names. Never log response content,
  // receipt text, image bytes/data URI, file paths, or credentials.
  console.warn('receipt AI response shape', JSON.stringify(shape));
}

export function describeAiResultShape(result: unknown): Record<string, unknown> {
  if (result === null) return { type: 'null' };
  if (Array.isArray(result)) return { type: 'array', length: result.length };
  if (typeof result !== 'object') return { type: typeof result };

  const record = result as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : [];
  const message = choices[0]?.message;
  const messageRecord = message && typeof message === 'object' ? message as Record<string, unknown> : null;

  return {
    type: 'object',
    topKeys: Object.keys(record).slice(0, 20),
    responseType: record.response === null ? 'null' : typeof record.response,
    resultType: record.result === null ? 'null' : typeof record.result,
    choicesLength: choices.length,
    firstChoiceKeys: choices[0] ? Object.keys(choices[0]).slice(0, 20) : [],
    messageKeys: messageRecord ? Object.keys(messageRecord).slice(0, 20) : [],
    parsedType: messageRecord?.parsed === null ? 'null' : typeof messageRecord?.parsed,
    contentType: Array.isArray(messageRecord?.content) ? 'array' : typeof messageRecord?.content
  };
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
