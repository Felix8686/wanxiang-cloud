import type { Env } from './types';

export type FinanceQueryMode = 'summary' | 'details';

export interface FinanceTextQuery {
  mode: FinanceQueryMode;
  label: string;
  start: string;
  end: string;
  page: number;
  limit: number;
}

interface TransactionRow {
  id: string;
  type: 'expense' | 'income' | 'transfer';
  amount_fen: number;
  currency: string;
  merchant: string | null;
  description: string | null;
  occurred_at: string;
  source: string;
  category_name: string | null;
  account_name: string | null;
}

interface SummaryRow {
  transaction_count: number;
  expense_fen: number;
  income_fen: number;
  transfer_fen: number;
}

interface CategoryRow {
  category_name: string | null;
  total_fen: number;
  transaction_count: number;
}

const DEFAULT_PAGE_SIZE = 20;
const TELEGRAM_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    }
  });
}

function verifyBearerToken(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const configuredTokens = [env.WANXIANG_API_KEY, env.API_BEARER_TOKEN]
    .filter((value): value is string => Boolean(value));
  return configuredTokens.includes(token);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1
  };
}

function getLocalDateParts(timeZone: string, now = new Date()): { year: number; month: number; day: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day)
    };
  } catch {
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate()
    };
  }
}

function monthRange(year: number, month: number): { start: string; end: string; label: string } {
  const next = addMonths(year, month, 1);
  return {
    start: `${dateString(year, month, 1)}T00:00:00`,
    end: `${dateString(next.year, next.month, 1)}T00:00:00`,
    label: `${year}年${month}月`
  };
}

function dayRange(year: number, month: number, day: number, label: string): { start: string; end: string; label: string } {
  const next = addDays(year, month, day, 1);
  return {
    start: `${dateString(year, month, day)}T00:00:00`,
    end: `${dateString(next.year, next.month, next.day)}T00:00:00`,
    label
  };
}

function parsePositiveInt(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day;
}

function parseApiRange(url: URL, timeZone: string): { start: string; end: string; label: string } | null {
  const month = url.searchParams.get('month');
  if (month) {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) return null;
    const year = Number(match[1]);
    const monthNumber = Number(match[2]);
    if (monthNumber < 1 || monthNumber > 12) return null;
    return monthRange(year, monthNumber);
  }

  const date = url.searchParams.get('date');
  if (date) {
    if (!isValidDate(date)) return null;
    const [year, monthNumber, day] = date.split('-').map(Number);
    return dayRange(year, monthNumber, day, date);
  }

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from || to) {
    if (!from || !to || !isValidDate(from) || !isValidDate(to) || from > to) return null;
    const [toYear, toMonth, toDay] = to.split('-').map(Number);
    const afterTo = addDays(toYear, toMonth, toDay, 1);
    return {
      start: `${from}T00:00:00`,
      end: `${dateString(afterTo.year, afterTo.month, afterTo.day)}T00:00:00`,
      label: `${from} 至 ${to}`
    };
  }

  const local = getLocalDateParts(timeZone);
  return monthRange(local.year, local.month);
}

export function parseFinanceTextQuery(text: string, timeZone: string, now = new Date()): FinanceTextQuery | null {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const financeKeyword = /(支出|收入|花了多少|花费|消费|账单|账目|财务|统计|明细|记录)/;
  if (!financeKeyword.test(normalized)) return null;

  const mode: FinanceQueryMode = /(明细|账单|账目|记录)/.test(normalized) ? 'details' : 'summary';
  const pageMatch = /第\s*(\d+)\s*页/.exec(normalized);
  const page = pageMatch ? Math.max(1, Number.parseInt(pageMatch[1], 10)) : 1;
  const local = getLocalDateParts(timeZone, now);

  if (/今天|今日/.test(normalized)) {
    const range = dayRange(local.year, local.month, local.day, '今天');
    return { mode, ...range, page, limit: TELEGRAM_PAGE_SIZE };
  }

  if (/昨天|昨日/.test(normalized)) {
    const previous = addDays(local.year, local.month, local.day, -1);
    const range = dayRange(previous.year, previous.month, previous.day, '昨天');
    return { mode, ...range, page, limit: TELEGRAM_PAGE_SIZE };
  }

  if (/上个月|上月/.test(normalized)) {
    const previous = addMonths(local.year, local.month, -1);
    const range = monthRange(previous.year, previous.month);
    return { mode, ...range, page, limit: TELEGRAM_PAGE_SIZE };
  }

  if (/这个月|本月|当月/.test(normalized)) {
    const range = monthRange(local.year, local.month);
    return { mode, ...range, page, limit: TELEGRAM_PAGE_SIZE };
  }

  const cnMonth = /(20\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月/.exec(normalized);
  if (cnMonth) {
    const range = monthRange(Number(cnMonth[1]), Number(cnMonth[2]));
    return { mode, ...range, page, limit: TELEGRAM_PAGE_SIZE };
  }

  const isoMonth = /(20\d{2})[-/.](1[0-2]|0?[1-9])(?:\b|月)/.exec(normalized);
  if (isoMonth) {
    const range = monthRange(Number(isoMonth[1]), Number(isoMonth[2]));
    return { mode, ...range, page, limit: TELEGRAM_PAGE_SIZE };
  }

  return null;
}

async function getSummary(env: Env, start: string, end: string): Promise<{
  transaction_count: number;
  expense_fen: number;
  income_fen: number;
  transfer_fen: number;
  net_fen: number;
  top_expense_categories: CategoryRow[];
}> {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_fen ELSE 0 END), 0) AS expense_fen,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_fen ELSE 0 END), 0) AS income_fen,
      COALESCE(SUM(CASE WHEN type = 'transfer' THEN amount_fen ELSE 0 END), 0) AS transfer_fen
    FROM transactions
    WHERE occurred_at >= ? AND occurred_at < ?
  `).bind(start, end).first<SummaryRow>();

  const categories = await env.DB.prepare(`
    SELECT
      COALESCE(c.name, '未指定') AS category_name,
      SUM(t.amount_fen) AS total_fen,
      COUNT(*) AS transaction_count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.type = 'expense' AND t.occurred_at >= ? AND t.occurred_at < ?
    GROUP BY COALESCE(c.name, '未指定')
    ORDER BY total_fen DESC, category_name ASC
    LIMIT 10
  `).bind(start, end).all<CategoryRow>();

  const expenseFen = Number(row?.expense_fen || 0);
  const incomeFen = Number(row?.income_fen || 0);
  return {
    transaction_count: Number(row?.transaction_count || 0),
    expense_fen: expenseFen,
    income_fen: incomeFen,
    transfer_fen: Number(row?.transfer_fen || 0),
    net_fen: incomeFen - expenseFen,
    top_expense_categories: categories.results.map((item) => ({
      category_name: item.category_name || '未指定',
      total_fen: Number(item.total_fen || 0),
      transaction_count: Number(item.transaction_count || 0)
    }))
  };
}

async function getTransactions(
  env: Env,
  start: string,
  end: string,
  page: number,
  limit: number,
  type?: 'expense' | 'income' | 'transfer'
): Promise<{ items: TransactionRow[]; total: number; page: number; limit: number; pages: number }> {
  const where = ["t.occurred_at >= ?", "t.occurred_at < ?"];
  const binds: unknown[] = [start, end];
  if (type) {
    where.push('t.type = ?');
    binds.push(type);
  }

  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM transactions t
    WHERE ${where.join(' AND ')}
  `).bind(...binds).first<{ total: number }>();

  const total = Number(countRow?.total || 0);
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * limit;

  const data = await env.DB.prepare(`
    SELECT
      t.id,
      t.type,
      t.amount_fen,
      t.currency,
      t.merchant,
      t.description,
      t.occurred_at,
      t.source,
      c.name AS category_name,
      a.name AS account_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.occurred_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all<TransactionRow>();

  return {
    items: data.results.map((item) => ({ ...item, amount_fen: Number(item.amount_fen) })),
    total,
    page: safePage,
    limit,
    pages
  };
}

function yuan(fen: number): number {
  return Number((fen / 100).toFixed(2));
}

function yuanText(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  return `${sign}¥${(Math.abs(fen) / 100).toFixed(2)}`;
}

function transactionTypeLabel(type: TransactionRow['type']): string {
  if (type === 'income') return '收入';
  if (type === 'transfer') return '转账';
  return '支出';
}

function shortDate(occurredAt: string): string {
  return occurredAt.slice(5, 10).replace('-', '/');
}

export async function formatFinanceTelegramReply(env: Env, query: FinanceTextQuery): Promise<string> {
  if (query.mode === 'summary') {
    const summary = await getSummary(env, query.start, query.end);
    const netPrefix = summary.net_fen > 0 ? '+' : '';
    const lines = [
      `📊 ${query.label}财务统计`,
      `支出：${yuanText(summary.expense_fen)}`,
      `收入：${yuanText(summary.income_fen)}`,
      `结余：${netPrefix}${yuanText(summary.net_fen)}`,
      `记录：${summary.transaction_count} 笔`
    ];
    const top = summary.top_expense_categories[0];
    if (top) lines.push(`支出最多：${top.category_name || '未指定'} ${yuanText(top.total_fen)}`);
    return lines.join('\n');
  }

  const list = await getTransactions(env, query.start, query.end, query.page, query.limit);
  if (list.total === 0) return `🧾 ${query.label}没有找到财务记录。`;

  const lines = [`🧾 ${query.label}明细（第${list.page}/${list.pages}页，共${list.total}笔）`];
  for (const item of list.items) {
    const description = item.description || item.merchant || '未填写';
    lines.push(`${shortDate(item.occurred_at)} ${transactionTypeLabel(item.type)} ${yuanText(item.amount_fen)} · ${item.category_name || '未指定'} · ${description}`);
  }
  if (list.page < list.pages) lines.push(`发送“${query.label}明细 第${list.page + 1}页”查看下一页。`);
  return lines.join('\n');
}

export async function handleFinanceApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const isTransactions = url.pathname === '/v1/transactions';
  const isStats = url.pathname === '/v1/stats' || url.pathname === '/v1/summary';

  if (!isTransactions && !isStats) return null;
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      }
    });
  }
  if (method !== 'GET') return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!verifyBearerToken(request, env)) return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);

  const range = parseApiRange(url, env.APP_TIMEZONE || 'Asia/Shanghai');
  if (!range) {
    return jsonResponse({
      ok: false,
      error: 'INVALID_DATE_RANGE',
      message: '使用 month=YYYY-MM、date=YYYY-MM-DD，或同时提供 from=YYYY-MM-DD&to=YYYY-MM-DD。'
    }, 400);
  }

  if (isStats) {
    const summary = await getSummary(env, range.start, range.end);
    return jsonResponse({
      ok: true,
      data: {
        range,
        transaction_count: summary.transaction_count,
        expense_fen: summary.expense_fen,
        expense: yuan(summary.expense_fen),
        income_fen: summary.income_fen,
        income: yuan(summary.income_fen),
        transfer_fen: summary.transfer_fen,
        transfer: yuan(summary.transfer_fen),
        net_fen: summary.net_fen,
        net: yuan(summary.net_fen),
        top_expense_categories: summary.top_expense_categories.map((item) => ({
          category: item.category_name || '未指定',
          total_fen: item.total_fen,
          total: yuan(item.total_fen),
          transaction_count: item.transaction_count
        }))
      }
    });
  }

  const page = parsePositiveInt(url.searchParams.get('page'), 1);
  const limit = parsePositiveInt(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const typeParam = url.searchParams.get('type');
  const allowedTypes = new Set(['expense', 'income', 'transfer']);
  if (typeParam && !allowedTypes.has(typeParam)) {
    return jsonResponse({ ok: false, error: 'INVALID_TRANSACTION_TYPE' }, 400);
  }

  const list = await getTransactions(
    env,
    range.start,
    range.end,
    page,
    limit,
    typeParam as 'expense' | 'income' | 'transfer' | undefined
  );

  return jsonResponse({
    ok: true,
    data: {
      range,
      items: list.items.map((item) => ({
        ...item,
        amount: yuan(item.amount_fen),
        category_name: item.category_name || '未指定',
        account_name: item.account_name || '未指定'
      })),
      pagination: {
        total: list.total,
        page: list.page,
        limit: list.limit,
        pages: list.pages,
        has_next: list.page < list.pages,
        has_previous: list.page > 1
      }
    }
  });
}

export async function handleFinanceIntakeQuery(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/intake' || request.method.toUpperCase() !== 'POST') return null;

  let body: { text?: string };
  try {
    body = await request.clone().json() as { text?: string };
  } catch {
    return null;
  }
  if (!body.text || typeof body.text !== 'string') return null;

  const query = parseFinanceTextQuery(body.text, env.APP_TIMEZONE || 'Asia/Shanghai');
  if (!query) return null;
  if (!verifyBearerToken(request, env)) return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);

  const message = await formatFinanceTelegramReply(env, query);
  return jsonResponse({
    ok: true,
    message,
    data: {
      finance_query: true,
      mode: query.mode,
      range: { label: query.label, start: query.start, end: query.end },
      page: query.page,
      limit: query.limit
    }
  });
}
