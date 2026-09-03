import type { ParsedReceipt, ParsedReceiptItem } from './types';

interface ReceiptSkeleton {
  quantity: number;
  unitPrice: number | null;
  lineTotal: number;
  confidence: number;
}

const META_LINE_PATTERN = /(合计|总计|应付|实付|支付|付款|找零|优惠|折扣|小计|税|收银|交易|流水|订单|时间|日期|电话|地址|欢迎|谢谢|单价|数量|金额|会员|发票|扫码|微信|支付宝|云闪付|银行卡|现金)/;

export function resolveVeryfiReceipt(document: Record<string, unknown>, fallbackNow: string): ParsedReceipt {
  const ocrText = textValue(document.ocr_text);
  const documentTypeField = document.document_type;
  const documentType = textValue(documentTypeField).toLowerCase();
  const isReceipt = documentType === 'receipt' || documentType === 'long_receipt' || looksLikeReceiptText(ocrText);

  const rawLineItems = Array.isArray(document.line_items) ? document.line_items : [];
  const skeletons = rawLineItems
    .map(toSkeleton)
    .filter((item): item is ReceiptSkeleton => item !== null)
    .slice(0, 200);

  const resolvedNames = resolveNamesFromOcr(ocrText, skeletons);
  const items: ParsedReceiptItem[] = skeletons.map((item, index) => ({
    name: resolvedNames[index] || '',
    quantity: item.quantity,
    unit_price: item.unitPrice,
    line_total: item.lineTotal,
    category: '其他',
    confidence: item.confidence
  }));

  const vendor = objectValue(document.vendor);
  const merchant = textValue(vendor?.name ?? document.vendor_name);
  const totalField = document.total;
  const totalAmount = nonNegativeNumber(totalField, 0);
  const subtotalField = document.subtotal;
  const subtotalAmount = nullableNonNegativeNumber(subtotalField);
  const discountAmount = nonNegativeNumber(document.discount, 0);
  const taxAmount = nonNegativeNumber(document.tax, 0);
  const roundingAmount = finiteNumber(document.rounding, 0);
  const currency = (textValue(document.currency_code) || textValue(document.currency) || 'CNY').toUpperCase().slice(0, 8);

  return {
    is_receipt: isReceipt,
    merchant: cleanText(merchant, 160),
    occurred_at: extractOccurredAt(document, ocrText, fallbackNow),
    currency,
    total_amount: totalAmount,
    subtotal_amount: subtotalAmount,
    discount_amount: discountAmount,
    tax_amount: taxAmount,
    rounding_amount: roundingAmount,
    payment_method: extractPaymentMethod(ocrText),
    confidence: clampConfidence(detailedConfidence(documentTypeField) ?? (isReceipt ? 0.85 : 0)),
    total_confidence: clampConfidence(detailedConfidence(totalField) ?? (totalAmount > 0 ? 0.8 : 0)),
    items,
    rejection_reason: isReceipt ? '' : 'VERYFI_NOT_RECEIPT'
  };
}

export function resolveNamesFromOcr(ocrText: string, skeletons: ReceiptSkeleton[]): string[] {
  const lines = ocrText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const names = new Array<string>(skeletons.length).fill('');
  let cursor = 0;
  let previousAmountLine = -1;

  for (let index = 0; index < skeletons.length; index += 1) {
    const amountLine = findAmountLine(lines, cursor, skeletons[index]);
    if (amountLine < 0) continue;

    names[index] = findProductName(lines, amountLine, previousAmountLine + 1);
    previousAmountLine = amountLine;
    cursor = amountLine + 1;
  }

  const numberedCandidates = lines
    .filter((line) => /^\s*\d{1,3}\s*[.、:：]/.test(line) && isProductCandidate(line))
    .map(stripProductLine)
    .filter(Boolean);

  if (numberedCandidates.length >= skeletons.length) {
    for (let index = 0; index < names.length; index += 1) {
      if (!names[index]) names[index] = numberedCandidates[index] || '';
    }
  }

  return names;
}

function toSkeleton(value: unknown): ReceiptSkeleton | null {
  const item = objectValue(value);
  if (!item) return null;

  const lineTotal = nullableNumber(item.total ?? item.line_total ?? item.amount);
  if (lineTotal === null || lineTotal < 0 || lineTotal > 1_000_000) return null;

  const rawQuantity = nullableNumber(item.quantity);
  const quantity = rawQuantity !== null && rawQuantity > 0 && rawQuantity <= 10_000 ? rawQuantity : 1;
  const rawPrice = nullableNumber(item.price ?? item.unit_price);
  const unitPrice = rawPrice !== null && rawPrice >= 0 && rawPrice <= 1_000_000 ? rawPrice : null;
  const confidence = clampConfidence(
    detailedConfidence(item.total ?? item.line_total ?? item.amount) ??
    detailedConfidence(item.price ?? item.unit_price) ??
    0.75
  );

  return { quantity, unitPrice, lineTotal, confidence };
}

function findAmountLine(lines: string[], start: number, item: ReceiptSkeleton): number {
  let bestIndex = -1;
  let bestScore = -1;

  for (let index = Math.max(0, start); index < lines.length; index += 1) {
    const line = lines[index];
    if (!hasNumericToken(line, item.lineTotal)) continue;

    let score = 3;
    if (item.unitPrice !== null && hasNumericToken(line, item.unitPrice)) score += 2;
    if (hasNumericToken(line, item.quantity)) score += 1;
    if (isLikelyNumericLine(line)) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      if (score >= 6) break;
    }
  }

  return bestIndex;
}

function findProductName(lines: string[], amountLine: number, lowerBound: number): string {
  const current = lines[amountLine] || '';
  if (isProductCandidate(current) && !isLikelyNumericLine(current)) {
    const cleaned = stripProductLine(current);
    if (cleaned) return cleaned;
  }

  for (let index = amountLine - 1; index >= Math.max(0, lowerBound); index -= 1) {
    if (!isProductCandidate(lines[index])) continue;
    const cleaned = stripProductLine(lines[index]);
    if (cleaned) return cleaned;
  }
  return '';
}

function isProductCandidate(line: string): boolean {
  if (!/[\p{L}\p{Script=Han}]/u.test(line)) return false;
  if (META_LINE_PATTERN.test(line)) return false;
  if (isLikelyNumericLine(line)) return false;
  return true;
}

function isLikelyNumericLine(line: string): boolean {
  const withoutNumbers = line
    .replace(/[¥￥$]?\s*[-+]?\d+(?:[.,]\d+)?/g, '')
    .replace(/[xX×*]/g, '')
    .replace(/[=：:|/\\\-]/g, '')
    .replace(/\s+/g, '');
  return withoutNumbers.length <= 2;
}

function stripProductLine(line: string): string {
  return cleanText(
    line
      .replace(/^\s*\d{1,3}\s*[.、:：]\s*/, '')
      .replace(/\s+\d{5,18}\s*$/, '')
      .replace(/\s{2,}/g, ' '),
    160
  );
}

function hasNumericToken(line: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const candidates = new Set([
    value.toFixed(2),
    value.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''),
    String(value)
  ]);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`).test(line)) return true;
  }
  return false;
}

function extractOccurredAt(document: Record<string, unknown>, ocrText: string, fallbackNow: string): string {
  const structuredDate = textValue(document.date);
  const structuredTime = textValue(document.time);
  const structured = normalizeDateTime(structuredDate, structuredTime);
  if (structured) return structured;

  const fullMatch = ocrText.match(/(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/);
  if (fullMatch) {
    return `${fullMatch[1]}-${pad(fullMatch[2])}-${pad(fullMatch[3])}T${pad(fullMatch[4])}:${pad(fullMatch[5])}:${pad(fullMatch[6] || '00')}`;
  }

  const dateMatch = ocrText.match(/(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})日?/);
  const timeMatch = ocrText.match(/(?:^|\s)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?(?:\s|$)/m);
  if (dateMatch) {
    const hh = timeMatch?.[1] || '12';
    const mm = timeMatch?.[2] || '00';
    const ss = timeMatch?.[3] || '00';
    return `${dateMatch[1]}-${pad(dateMatch[2])}-${pad(dateMatch[3])}T${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  return normalizeFallback(fallbackNow);
}

function normalizeDateTime(date: string, time: string): string {
  if (!date) return '';
  const iso = date.match(/^(20\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const hh = iso[4] || time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/)?.[1] || '12';
    const mm = iso[5] || time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/)?.[2] || '00';
    const ss = iso[6] || time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/)?.[3] || '00';
    return `${iso[1]}-${iso[2]}-${iso[3]}T${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }
  return '';
}

function extractPaymentMethod(ocrText: string): string {
  const lines = ocrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = [
    '其他扫码付', '微信支付', '支付宝', '云闪付', '扫码付', '微信', '现金', '银行卡', '借记卡', '信用卡'
  ];

  for (const method of preferred) {
    const line = lines.find((candidate) => candidate.includes(method));
    if (line) return method;
  }

  for (const line of lines) {
    const match = line.match(/(?:支付方式|付款方式|支付)\s*[:：]?\s*([^\s]{2,24})/);
    if (match?.[1] && !/^visa$/i.test(match[1])) return cleanText(match[1], 80);
  }

  return '未识别';
}

function looksLikeReceiptText(text: string): boolean {
  if (!text) return false;
  const hasSettlement = /(合计|总计|应付|实付|付款|支付)/.test(text);
  const moneyCount = text.match(/\d+[.,]\d{2}/g)?.length || 0;
  return hasSettlement && moneyCount >= 2;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrap(value: unknown): unknown {
  const object = objectValue(value);
  if (object && Object.prototype.hasOwnProperty.call(object, 'value')) return object.value;
  return value;
}

function textValue(value: unknown): string {
  const unwrapped = unwrap(value);
  return typeof unwrapped === 'string' ? unwrapped.trim() : '';
}

function nullableNumber(value: unknown): number | null {
  const unwrapped = unwrap(value);
  if (unwrapped === null || unwrapped === undefined || unwrapped === '') return null;
  const parsed = Number(unwrapped);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = nullableNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function nullableNonNegativeNumber(value: unknown): number | null {
  const parsed = nullableNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = nullableNumber(value);
  return parsed !== null ? parsed : fallback;
}

function detailedConfidence(value: unknown): number | null {
  const object = objectValue(value);
  if (!object) return null;
  const scores = [Number(object.score), Number(object.ocr_score)].filter((score) => Number.isFinite(score));
  return scores.length ? Math.max(...scores) : null;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function cleanText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function pad(value: string): string {
  return value.padStart(2, '0').slice(-2);
}

function normalizeFallback(value: string): string {
  const match = value.match(/^(20\d{2}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::(\d{2}))?/);
  if (match) return `${match[1]}T${match[2]}:${match[3] || '00'}`;
  return value;
}
