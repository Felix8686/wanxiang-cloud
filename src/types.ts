export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface QueueProducerLike {
  send(message: unknown): Promise<void>;
}

export interface R2ObjectHeaderLike {
  name: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectHeaderLike {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }
  ): Promise<R2ObjectHeaderLike>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<R2ObjectHeaderLike | null>;
}

export interface Env {
  DB: D1Like;
  AI: AiLike;
  FILES: R2BucketLike;
  RECEIPT_QUEUE?: QueueProducerLike;
  APP_TIMEZONE: string;
  AI_MODEL: string;
  RECEIPT_VISION_MODEL?: string;
  WANXIANG_API_KEY?: string;
  OBSIDIAN_SYNC_API_KEY?: string;
  API_BEARER_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export type IntakeIntent = 'create_transaction' | 'spending_today' | 'unknown';
export type TransactionType = 'expense' | 'income' | 'transfer';

export interface ParsedIntake {
  intent: IntakeIntent;
  transaction_type: TransactionType;
  amount: number;
  currency: string;
  category_name: string;
  account_name: string;
  merchant: string;
  description: string;
  occurred_at: string;
  confidence: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
  };
}

export type ReceiptItemCategory =
  | '食品'
  | '饮料'
  | '生鲜'
  | '零食'
  | '日用品'
  | '清洁用品'
  | '个护'
  | '医药健康'
  | '母婴'
  | '宠物'
  | '家居'
  | '数码配件'
  | '服饰'
  | '其他';

export interface ParsedReceiptItem {
  name: string;
  quantity: number;
  unit_price: number | null;
  line_total: number;
  category: ReceiptItemCategory;
  confidence: number;
}

export interface ParsedReceipt {
  is_receipt: boolean;
  merchant: string;
  occurred_at: string;
  currency: string;
  total_amount: number;
  subtotal_amount: number | null;
  discount_amount: number;
  tax_amount: number;
  rounding_amount: number;
  payment_method: string;
  confidence: number;
  total_confidence: number;
  items: ParsedReceiptItem[];
  rejection_reason: string;
}

export interface ReceiptReconciliation {
  ok: boolean;
  items_total_fen: number;
  discount_fen: number;
  tax_fen: number;
  rounding_fen: number;
  expected_total_fen: number;
  receipt_total_fen: number;
  difference_fen: number;
}

export interface ReceiptProcessResult {
  ok: boolean;
  message: string;
  transactionId?: string;
  duplicate?: boolean;
  itemCount?: number;
}

export interface SyncFileRecord {
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
  created_at: string;
  updated_at: string;
}
