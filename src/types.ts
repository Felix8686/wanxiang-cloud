export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Like {
  prepare(query: string): D1StatementLike;
}

export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  DB: D1Like;
  AI: AiLike;
  APP_TIMEZONE: string;
  AI_MODEL: string;
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

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}
