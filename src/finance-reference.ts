import type { Env, ParsedIntake, TransactionType } from './types';

export interface FinanceCategoryReference {
  id: string;
  name: string;
  type: TransactionType;
  parent_name: string | null;
}

export interface FinanceAccountReference {
  id: string;
  name: string;
  type: 'cash' | 'bank' | 'wallet' | 'credit' | 'other';
}

export interface FinanceReferenceCatalog {
  categories: FinanceCategoryReference[];
  accounts: FinanceAccountReference[];
}

export async function loadFinanceReferenceCatalog(env: Env): Promise<FinanceReferenceCatalog> {
  const [categories, accounts] = await Promise.all([
    env.DB.prepare(`
      SELECT c.id, c.name, c.type, p.name AS parent_name
      FROM categories c
      LEFT JOIN categories p ON p.id = c.parent_id
      WHERE c.is_active = 1
      ORDER BY c.type, COALESCE(p.name, ''), c.name
    `).all<FinanceCategoryReference>(),
    env.DB.prepare(`
      SELECT id, name, type
      FROM accounts
      WHERE is_active = 1
      ORDER BY name
    `).all<FinanceAccountReference>()
  ]);

  return {
    categories: categories.results,
    accounts: accounts.results
  };
}

function clean(value: string): string {
  return value.trim().slice(0, 300);
}

function exactCategory(
  catalog: FinanceReferenceCatalog,
  type: TransactionType,
  name: string
): FinanceCategoryReference | undefined {
  const target = clean(name);
  return catalog.categories.find((item) => item.type === type && item.name === target);
}

function fallbackCategory(catalog: FinanceReferenceCatalog, type: TransactionType): FinanceCategoryReference | undefined {
  const preferred = type === 'expense' ? '其他支出' : type === 'income' ? '其他收入' : '转账';
  return exactCategory(catalog, type, preferred) || catalog.categories.find((item) => item.type === type);
}

function exactAccount(catalog: FinanceReferenceCatalog, name: string): FinanceAccountReference | undefined {
  const target = clean(name);
  return catalog.accounts.find((item) => item.name === target);
}

function fallbackAccount(catalog: FinanceReferenceCatalog): FinanceAccountReference | undefined {
  return exactAccount(catalog, '未指定') || catalog.accounts[0];
}

export function normalizeParsedReferenceFields(
  parsed: ParsedIntake,
  catalog: FinanceReferenceCatalog
): ParsedIntake {
  const category = exactCategory(catalog, parsed.transaction_type, parsed.category_name)
    || fallbackCategory(catalog, parsed.transaction_type);
  const account = exactAccount(catalog, parsed.account_name) || fallbackAccount(catalog);

  return {
    ...parsed,
    category_name: category?.name || parsed.category_name,
    account_name: account?.name || '未指定'
  };
}

export function financeReferencePrompt(catalog: FinanceReferenceCatalog): string {
  const categoryLines = (['expense', 'income', 'transfer'] as TransactionType[]).map((type) => {
    const label = type === 'expense' ? '支出' : type === 'income' ? '收入' : '转账';
    const values = catalog.categories
      .filter((item) => item.type === type)
      .map((item) => item.parent_name ? `${item.parent_name} > ${item.name}` : item.name);
    return `${label}分类：${values.length ? values.join('、') : '无'}`;
  });
  const accountNames = catalog.accounts.map((item) => item.name);

  return [
    ...categoryLines,
    `账户/支付方式：${accountNames.length ? accountNames.join('、') : '未指定'}`
  ].join('\n');
}

export function categoryEnum(catalog: FinanceReferenceCatalog): string[] {
  const names = [...new Set(catalog.categories.map((item) => item.name))];
  return names.length ? names : ['其他支出', '其他收入', '转账'];
}

export function accountEnum(catalog: FinanceReferenceCatalog): string[] {
  const names = [...new Set(catalog.accounts.map((item) => item.name))];
  if (!names.includes('未指定')) names.unshift('未指定');
  return names.length ? names : ['未指定'];
}

export async function resolveCategoryId(
  env: Env,
  categoryName: string,
  transactionType: TransactionType
): Promise<string | null> {
  const row = await env.DB.prepare(`
    SELECT id
    FROM categories
    WHERE name = ? AND type = ? AND is_active = 1
    LIMIT 1
  `).bind(categoryName, transactionType).first<{ id: string }>();
  return row?.id || null;
}

export async function resolveAccountId(env: Env, accountName: string): Promise<string | null> {
  const row = await env.DB.prepare(`
    SELECT id
    FROM accounts
    WHERE name = ? AND is_active = 1
    LIMIT 1
  `).bind(accountName).first<{ id: string }>();
  return row?.id || null;
}
