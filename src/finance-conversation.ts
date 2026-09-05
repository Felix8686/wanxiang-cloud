import type { Env } from './types';
import { formatFinanceTelegramReply, parseFinanceTextQuery, type FinanceTextQuery } from './finance';

type ConversationAction = 'passthrough' | 'summary' | 'details' | 'analyze' | 'compare';
type ConversationScope = 'inherit' | 'today' | 'yesterday' | 'this_month' | 'last_month' | 'specific_month' | 'specific_day';

type StoredMode = 'summary' | 'details' | 'analysis' | 'compare';

interface FinanceConversationRoute {
  action: ConversationAction;
  scope: ConversationScope;
  year: number;
  month: number;
  day: number;
  confidence: number;
}

interface FinanceConversationContext {
  chat_id: string;
  last_start: string;
  last_end: string;
  last_label: string;
  last_mode: StoredMode;
  last_user_text: string | null;
  updated_at: string;
}

interface SummaryRow {
  transaction_count: number;
  expense_fen: number;
  income_fen: number;
  transfer_fen: number;
}

interface BreakdownRow {
  name: string | null;
  total_fen: number;
  transaction_count: number;
}

export interface FinanceConversationResult {
  reply: string;
  action: Exclude<ConversationAction, 'passthrough'>;
  query: FinanceTextQuery;
}

const routeSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['passthrough', 'summary', 'details', 'analyze', 'compare'] },
    scope: { type: 'string', enum: ['inherit', 'today', 'yesterday', 'this_month', 'last_month', 'specific_month', 'specific_day'] },
    year: { type: 'integer', minimum: 0, maximum: 2100 },
    month: { type: 'integer', minimum: 0, maximum: 12 },
    day: { type: 'integer', minimum: 0, maximum: 31 },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['action', 'scope', 'year', 'month', 'day', 'confidence']
} as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

function getLocalDateParts(timeZone: string, now = new Date()): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
  } catch {
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
}

function monthQuery(year: number, month: number, mode: 'summary' | 'details' = 'summary'): FinanceTextQuery {
  const next = addMonths(year, month, 1);
  return {
    mode,
    label: `${year}年${month}月`,
    start: dateString(year, month, 1),
    end: dateString(next.year, next.month, 1),
    page: 1,
    limit: 10
  };
}

function dayQuery(year: number, month: number, day: number, label: string, mode: 'summary' | 'details' = 'summary'): FinanceTextQuery {
  const next = addDays(year, month, day, 1);
  return {
    mode,
    label,
    start: dateString(year, month, day),
    end: dateString(next.year, next.month, next.day),
    page: 1,
    limit: 10
  };
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function looksLikeFinanceAnalysis(text: string): boolean {
  return /(优化|建议|能省|可以省|省钱|节省|哪些.*(多|高)|哪里.*(多|高)|花得.*多|花费.*多|消费.*多|太多|比较|相比|对比|为什么|原因|占比|结构|异常|值不值|合理不合理)/.test(text);
}

function looksLikeContextualFollowup(text: string): boolean {
  return /(哪些|哪个|哪里|怎么|为什么|呢|那|这些|这个|刚才|可以|能不能|多不多|高不高)/.test(text);
}

function hasFinanceSignal(text: string): boolean {
  return /(钱|花|支出|收入|消费|账|财务|预算|省|金额|分类)/.test(text);
}

async function loadFinanceContext(env: Env, chatId: string): Promise<FinanceConversationContext | null> {
  try {
    return await env.DB.prepare(`
      SELECT chat_id, last_start, last_end, last_label, last_mode, last_user_text, updated_at
      FROM finance_chat_context
      WHERE chat_id = ? AND updated_at >= datetime('now', '-24 hours')
    `).bind(chatId).first<FinanceConversationContext>();
  } catch (error) {
    console.error('finance context load failed', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

export async function rememberFinanceContext(
  env: Env,
  chatId: string,
  query: FinanceTextQuery,
  userText: string,
  mode: StoredMode = query.mode
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO finance_chat_context (
        chat_id, last_start, last_end, last_label, last_mode, last_user_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        last_start = excluded.last_start,
        last_end = excluded.last_end,
        last_label = excluded.last_label,
        last_mode = excluded.last_mode,
        last_user_text = excluded.last_user_text,
        updated_at = CURRENT_TIMESTAMP
    `).bind(chatId, query.start, query.end, query.label, mode, userText.slice(0, 500)).run();
  } catch (error) {
    console.error('finance context save failed', error instanceof Error ? error.message : 'unknown error');
  }
}

function cleanRoute(value: unknown): FinanceConversationRoute | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const actions = new Set<ConversationAction>(['passthrough', 'summary', 'details', 'analyze', 'compare']);
  const scopes = new Set<ConversationScope>(['inherit', 'today', 'yesterday', 'this_month', 'last_month', 'specific_month', 'specific_day']);
  const action = String(input.action) as ConversationAction;
  const scope = String(input.scope) as ConversationScope;
  const year = Number(input.year);
  const month = Number(input.month);
  const day = Number(input.day);
  const confidence = Number(input.confidence);
  if (!actions.has(action) || !scopes.has(scope)) return null;
  if (![year, month, day, confidence].every(Number.isFinite)) return null;
  if (confidence < 0 || confidence > 1) return null;
  return { action, scope, year, month, day, confidence };
}

async function classifyFinanceConversation(
  env: Env,
  text: string,
  context: FinanceConversationContext | null,
  timeZone: string,
  now: Date
): Promise<FinanceConversationRoute | null> {
  const local = getLocalDateParts(timeZone, now);
  const contextText = context
    ? `最近一次财务查询：${context.last_label}，范围 ${context.last_start} 至 ${context.last_end}，模式 ${context.last_mode}。`
    : '没有可继承的最近财务查询。';

  try {
    const result = await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: [
            '你是“万象助手”的财务对话路由层。只负责理解用户想做什么，不得自行编造金额或执行数据库操作。',
            'action 规则：',
            '- passthrough：新增记账（如“晚饭25元”“工资到账5000”）、与财务无关的聊天、或不能可靠判断。',
            '- summary：询问某时间段总支出/收入/结余/统计。',
            '- details：询问账单、明细、具体记录。',
            '- analyze：询问哪些类别花得多、哪里可以优化、消费结构、是否合理、为什么支出高等分析。',
            '- compare：要求与上月、之前、另一周期进行比较。',
            'scope 规则：明确日期/月就用 specific_day/specific_month；今天/昨天/本月/上月分别使用对应 scope。',
            '如果用户是在承接上一轮说“哪些部分花得多可以优化”“那哪些能省”“为什么这么高”“跟上个月比呢”，使用 inherit。',
            '如果需要财务分析但用户没有明确时间且没有上下文，默认 this_month。',
            'specific_month 必须填写 year/month；specific_day 必须填写 year/month/day；其他 scope 不需要的数字填 0。',
            `当前本地日期：${dateString(local.year, local.month, local.day)}。`,
            contextText
          ].join('\n')
        },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_schema', json_schema: routeSchema }
    });

    const response = (result as { response?: unknown })?.response;
    const parsed = typeof response === 'string' ? JSON.parse(response) : response;
    return cleanRoute(parsed);
  } catch (error) {
    console.error('finance conversation classify failed', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

export function resolveConversationQuery(
  route: FinanceConversationRoute,
  context: Pick<FinanceConversationContext, 'last_start' | 'last_end' | 'last_label'> | null,
  timeZone: string,
  now = new Date()
): FinanceTextQuery | null {
  const mode: 'summary' | 'details' = route.action === 'details' ? 'details' : 'summary';
  const local = getLocalDateParts(timeZone, now);

  if (route.scope === 'inherit' && context) {
    return {
      mode,
      label: context.last_label,
      start: context.last_start,
      end: context.last_end,
      page: 1,
      limit: 10
    };
  }

  if (route.scope === 'today') return dayQuery(local.year, local.month, local.day, '今天', mode);
  if (route.scope === 'yesterday') {
    const previous = addDays(local.year, local.month, local.day, -1);
    return dayQuery(previous.year, previous.month, previous.day, '昨天', mode);
  }
  if (route.scope === 'this_month' || (route.scope === 'inherit' && !context)) {
    return monthQuery(local.year, local.month, mode);
  }
  if (route.scope === 'last_month') {
    const previous = addMonths(local.year, local.month, -1);
    return monthQuery(previous.year, previous.month, mode);
  }
  if (route.scope === 'specific_month') {
    if (route.year < 2000 || route.month < 1 || route.month > 12) return null;
    return monthQuery(route.year, route.month, mode);
  }
  if (route.scope === 'specific_day') {
    if (!isValidDate(route.year, route.month, route.day)) return null;
    return dayQuery(route.year, route.month, route.day, `${route.year}年${route.month}月${route.day}日`, mode);
  }
  return null;
}

async function getAnalysisData(env: Env, query: FinanceTextQuery): Promise<{
  transaction_count: number;
  expense: number;
  income: number;
  net: number;
  categories: Array<{ name: string; amount: number; share_pct: number; count: number }>;
  top_merchants: Array<{ name: string; amount: number; count: number }>;
}> {
  const summary = await env.DB.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_fen ELSE 0 END), 0) AS expense_fen,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_fen ELSE 0 END), 0) AS income_fen,
      COALESCE(SUM(CASE WHEN type = 'transfer' THEN amount_fen ELSE 0 END), 0) AS transfer_fen
    FROM transactions
    WHERE substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?
  `).bind(query.start, query.end).first<SummaryRow>();

  const categories = await env.DB.prepare(`
    SELECT COALESCE(c.name, '未指定') AS name, SUM(t.amount_fen) AS total_fen, COUNT(*) AS transaction_count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.type = 'expense'
      AND substr(t.occurred_at, 1, 10) >= ?
      AND substr(t.occurred_at, 1, 10) < ?
    GROUP BY COALESCE(c.name, '未指定')
    ORDER BY total_fen DESC
    LIMIT 10
  `).bind(query.start, query.end).all<BreakdownRow>();

  const merchants = await env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(merchant), ''), NULLIF(TRIM(description), ''), '未指定') AS name,
      SUM(amount_fen) AS total_fen,
      COUNT(*) AS transaction_count
    FROM transactions
    WHERE type = 'expense'
      AND substr(occurred_at, 1, 10) >= ?
      AND substr(occurred_at, 1, 10) < ?
    GROUP BY COALESCE(NULLIF(TRIM(merchant), ''), NULLIF(TRIM(description), ''), '未指定')
    ORDER BY total_fen DESC
    LIMIT 8
  `).bind(query.start, query.end).all<BreakdownRow>();

  const expenseFen = Number(summary?.expense_fen || 0);
  const incomeFen = Number(summary?.income_fen || 0);
  return {
    transaction_count: Number(summary?.transaction_count || 0),
    expense: expenseFen / 100,
    income: incomeFen / 100,
    net: (incomeFen - expenseFen) / 100,
    categories: categories.results.map((row) => {
      const fen = Number(row.total_fen || 0);
      return {
        name: row.name || '未指定',
        amount: fen / 100,
        share_pct: expenseFen > 0 ? Number(((fen / expenseFen) * 100).toFixed(1)) : 0,
        count: Number(row.transaction_count || 0)
      };
    }),
    top_merchants: merchants.results.map((row) => ({
      name: row.name || '未指定',
      amount: Number(row.total_fen || 0) / 100,
      count: Number(row.transaction_count || 0)
    }))
  };
}

function extractAiText(result: unknown): string | null {
  const response = (result as { response?: unknown })?.response;
  if (typeof response === 'string' && response.trim()) return response.trim();
  return null;
}

function fallbackAnalysisReply(label: string, data: Awaited<ReturnType<typeof getAnalysisData>>): string {
  const lines = [`📊 ${label}支出分析`, `总支出：¥${data.expense.toFixed(2)}`];
  for (const [index, item] of data.categories.slice(0, 3).entries()) {
    lines.push(`${index + 1}. ${item.name} ¥${item.amount.toFixed(2)}（${item.share_pct}%）`);
  }
  const broad = data.categories.find((item) => item.name === '其他支出' || item.name === '未指定');
  if (broad && broad.share_pct >= 30) {
    lines.push(`建议：${broad.name}占比偏高且分类较宽，先细分这部分，再判断哪些支出真正可以压缩。`);
  } else {
    lines.push('建议：优先检查占比最高的 1–2 类，再结合具体明细判断是否值得压缩。');
  }
  return lines.join('\n');
}

async function buildAnalysisReply(env: Env, query: FinanceTextQuery, userText: string): Promise<string> {
  const data = await getAnalysisData(env, query);
  if (data.transaction_count === 0) return `${query.label}没有可分析的财务记录。`;

  try {
    const result = await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: [
            '你是“万象助手”的个人财务分析层。你只能根据提供的真实数据库统计回答，不得编造金额、原因或消费动机。',
            '把“花得多”与“浪费”区分开：金额大不等于应该削减。',
            '如果“其他支出”或“未指定”占比较高，优先指出分类过宽，需要先细分，而不是武断地要求节省。',
            '回答中文、简洁、最多给3个重点；金额和百分比必须直接来自数据。',
            '用户问“哪些部分可以优化”时，先指出支出占比最高的类别，再给可执行的核查建议。'
          ].join('\n')
        },
        {
          role: 'user',
          content: `用户问题：${userText}\n时间范围：${query.label}\n真实统计数据：${JSON.stringify(data)}`
        }
      ]
    });
    return extractAiText(result) || fallbackAnalysisReply(query.label, data);
  } catch (error) {
    console.error('finance analysis generation failed', error instanceof Error ? error.message : 'unknown error');
    return fallbackAnalysisReply(query.label, data);
  }
}

function previousPeriod(query: FinanceTextQuery): FinanceTextQuery {
  const start = new Date(`${query.start}T00:00:00Z`);
  const end = new Date(`${query.end}T00:00:00Z`);
  const durationMs = Math.max(24 * 60 * 60 * 1000, end.getTime() - start.getTime());
  const previousEnd = new Date(start.getTime());
  const previousStart = new Date(start.getTime() - durationMs);

  const isCalendarMonth = query.start.endsWith('-01') && query.end.endsWith('-01');
  let label = '上一周期';
  if (isCalendarMonth) {
    const y = previousStart.getUTCFullYear();
    const m = previousStart.getUTCMonth() + 1;
    label = `${y}年${m}月`;
  }

  return {
    mode: 'summary',
    label,
    start: previousStart.toISOString().slice(0, 10),
    end: previousEnd.toISOString().slice(0, 10),
    page: 1,
    limit: 10
  };
}

async function getCompactSummary(env: Env, query: FinanceTextQuery): Promise<{ expense: number; income: number; net: number; count: number }> {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_fen ELSE 0 END), 0) AS expense_fen,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_fen ELSE 0 END), 0) AS income_fen,
      0 AS transfer_fen
    FROM transactions
    WHERE substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?
  `).bind(query.start, query.end).first<SummaryRow>();
  const expense = Number(row?.expense_fen || 0) / 100;
  const income = Number(row?.income_fen || 0) / 100;
  return { expense, income, net: income - expense, count: Number(row?.transaction_count || 0) };
}

async function buildComparisonReply(env: Env, query: FinanceTextQuery): Promise<string> {
  const previous = previousPeriod(query);
  const [currentData, previousData] = await Promise.all([
    getCompactSummary(env, query),
    getCompactSummary(env, previous)
  ]);
  const diff = currentData.expense - previousData.expense;
  const pct = previousData.expense > 0 ? (diff / previousData.expense) * 100 : null;
  const direction = diff > 0 ? '增加' : diff < 0 ? '减少' : '持平';
  const pctText = pct === null ? '' : `（${Math.abs(pct).toFixed(1)}%）`;
  return [
    `📊 ${query.label} vs ${previous.label}`,
    `${query.label}支出：¥${currentData.expense.toFixed(2)}`,
    `${previous.label}支出：¥${previousData.expense.toFixed(2)}`,
    `支出${direction}：¥${Math.abs(diff).toFixed(2)}${pctText}`
  ].join('\n');
}

export async function handleFinanceConversationTelegram(
  env: Env,
  chatId: string,
  text: string,
  now = new Date()
): Promise<FinanceConversationResult | null> {
  const timeZone = env.APP_TIMEZONE || 'Asia/Shanghai';
  const context = await loadFinanceContext(env, chatId);
  const deterministic = parseFinanceTextQuery(text, timeZone, now);
  const analytical = looksLikeFinanceAnalysis(text);
  const contextual = Boolean(context && looksLikeContextualFollowup(text));

  if (deterministic && !analytical && !contextual) return null;
  if (!context && !analytical && !hasFinanceSignal(text)) return null;

  const route = await classifyFinanceConversation(env, text, context, timeZone, now);
  if (!route || route.action === 'passthrough' || route.confidence < 0.55) return null;

  const query = resolveConversationQuery(route, context, timeZone, now);
  if (!query) return null;

  let reply: string;
  let storedMode: StoredMode;
  if (route.action === 'summary' || route.action === 'details') {
    query.mode = route.action === 'details' ? 'details' : 'summary';
    reply = await formatFinanceTelegramReply(env, query);
    storedMode = query.mode;
  } else if (route.action === 'analyze') {
    reply = await buildAnalysisReply(env, query, text);
    storedMode = 'analysis';
  } else {
    reply = await buildComparisonReply(env, query);
    storedMode = 'compare';
  }

  await rememberFinanceContext(env, chatId, query, text, storedMode);
  return { reply, action: route.action, query };
}
