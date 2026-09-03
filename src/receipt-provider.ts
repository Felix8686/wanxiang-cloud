import { resolveVeryfiReceipt } from './receipt-resolver';
import type { Env, ParsedReceipt, ReceiptItemCategory } from './types';

const VERYFI_ENDPOINT = 'https://api.veryfi.com/api/v8/partner/documents';
const VERYFI_TIMEOUT_MS = 90_000;
const ITEM_CATEGORIES: ReceiptItemCategory[] = [
  '食品', '饮料', '生鲜', '零食', '日用品', '清洁用品', '个护',
  '医药健康', '母婴', '宠物', '家居', '数码配件', '服饰', '其他'
];
const CATEGORY_SET = new Set<string>(ITEM_CATEGORIES);

type ReceiptProviderEnv = Env & {
  RECEIPT_PROVIDER?: string;
  VERYFI_CLIENT_ID?: string;
  VERYFI_USERNAME?: string;
  VERYFI_API_KEY?: string;
  VERYFI_BEARER_API_KEY?: string;
};

const categorySchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0 },
          category: { type: 'string', enum: ITEM_CATEGORIES }
        },
        required: ['index', 'category']
      }
    }
  },
  required: ['items']
} as const;

export async function analyzeReceiptWithProvider(
  env: Env,
  imageBytes: ArrayBuffer,
  mimeType: string,
  localNow: string
): Promise<ParsedReceipt> {
  const providerEnv = env as ReceiptProviderEnv;
  const provider = (providerEnv.RECEIPT_PROVIDER || 'veryfi').trim().toLowerCase();
  if (provider !== 'veryfi') throw new Error(`RECEIPT_PROVIDER_UNSUPPORTED:${provider}`);

  const rawDocument = await processVeryfiDocument(providerEnv, imageBytes, mimeType);
  const receipt = resolveVeryfiReceipt(rawDocument, localNow);
  if (!receipt.is_receipt || receipt.items.length === 0) return receipt;

  receipt.items = await classifyCategoriesSafely(env, receipt.items);
  return receipt;
}

export function isVeryfiConfigured(env: Env): boolean {
  const providerEnv = env as ReceiptProviderEnv;
  const hasClient = Boolean(providerEnv.VERYFI_CLIENT_ID?.trim());
  const hasBearer = Boolean(providerEnv.VERYFI_BEARER_API_KEY?.trim());
  const hasStandard = Boolean(providerEnv.VERYFI_USERNAME?.trim() && providerEnv.VERYFI_API_KEY?.trim());
  return hasClient && (hasBearer || hasStandard);
}

async function processVeryfiDocument(
  env: ReceiptProviderEnv,
  imageBytes: ArrayBuffer,
  mimeType: string
): Promise<Record<string, unknown>> {
  const clientId = env.VERYFI_CLIENT_ID?.trim();
  if (!clientId) throw new Error('VERYFI_CLIENT_ID_NOT_CONFIGURED');

  const authorization = buildAuthorization(env);
  const extension = extensionForMimeType(mimeType);
  const form = new FormData();
  form.append('file', new Blob([imageBytes], { type: mimeType }), `receipt.${extension}`);
  form.append('file_name', `receipt.${extension}`);
  form.append('async', 'false');
  form.append('bounding_boxes', 'true');
  form.append('confidence_details', 'true');
  form.append('crop_document', 'true');
  form.append('country', 'CN');
  form.append('document_type', 'receipt');
  form.append('boost_mode', 'false');
  form.append('compute', 'false');
  form.append('auto_delete', 'true');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('VERYFI_TIMEOUT'), VERYFI_TIMEOUT_MS);

  try {
    const response = await fetch(VERYFI_ENDPOINT, {
      method: 'POST',
      headers: {
        'CLIENT-ID': clientId,
        'AUTHORIZATION': authorization,
        'Accept': 'application/json'
      },
      body: form,
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`VERYFI_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('VERYFI_INVALID_RESPONSE');
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('VERYFI_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthorization(env: ReceiptProviderEnv): string {
  const bearer = env.VERYFI_BEARER_API_KEY?.trim();
  if (bearer) return `Bearer ${bearer}`;

  const username = env.VERYFI_USERNAME?.trim();
  const apiKey = env.VERYFI_API_KEY?.trim();
  if (!username) throw new Error('VERYFI_USERNAME_NOT_CONFIGURED');
  if (!apiKey) throw new Error('VERYFI_API_KEY_NOT_CONFIGURED');
  return `apikey ${username}:${apiKey}`;
}

async function classifyCategoriesSafely(env: Env, items: ParsedReceipt['items']): Promise<ParsedReceipt['items']> {
  if (!items.length) return items;

  try {
    const result = await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: [
            '你是万象云端的商品分类器，只根据已经 OCR 确认的商品名称分类。',
            '绝不能修改商品名称、数量、单价、金额，也不能增加或删除商品。',
            `category 只能从以下值选择：${ITEM_CATEGORIES.join('、')}。`,
            '不确定时选择“其他”。',
            '只输出符合 schema 的 JSON。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify(items.map((item, index) => ({ index, name: item.name })))
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: categorySchema
      },
      temperature: 0,
      max_completion_tokens: 1200
    });

    const parsed = extractJsonValue(result);
    const parsedObject = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    const classifications = Array.isArray(parsedObject?.items) ? parsedObject.items : [];
    const categoryByIndex = new Map<number, ReceiptItemCategory>();

    for (const value of classifications) {
      const row = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!row) continue;
      const index = Number(row.index);
      const category = typeof row.category === 'string' ? row.category.trim() : '';
      if (!Number.isInteger(index) || index < 0 || index >= items.length || !CATEGORY_SET.has(category)) continue;
      categoryByIndex.set(index, category as ReceiptItemCategory);
    }

    return items.map((item, index) => ({
      ...item,
      category: categoryByIndex.get(index) || '其他'
    }));
  } catch {
    return items.map((item) => ({ ...item, category: '其他' }));
  }
}

function extractJsonValue(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const root = result as Record<string, unknown>;

  const response = root.response;
  if (typeof response === 'string') return parseJsonString(response);
  if (response && typeof response === 'object') return response;

  const nestedResult = root.result;
  if (nestedResult && typeof nestedResult === 'object') {
    const extracted = extractJsonValue(nestedResult);
    if (extracted !== nestedResult || !Array.isArray(nestedResult)) return extracted;
  }

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : null;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : null;
  if (message?.parsed && typeof message.parsed === 'object') return message.parsed;
  if (typeof message?.content === 'string') return parseJsonString(message.content);

  return root;
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

function extensionForMimeType(mimeType: string): string {
  if (/png/i.test(mimeType)) return 'png';
  if (/webp/i.test(mimeType)) return 'webp';
  if (/heic|heif/i.test(mimeType)) return 'heic';
  return 'jpg';
}
