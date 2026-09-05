import assert from 'node:assert/strict';
import {
  financeReferencePrompt,
  normalizeParsedReferenceFields,
  type FinanceReferenceCatalog
} from '../src/finance-reference';
import { resolveTelegramReferenceTime, telegramMessageDateToDate } from '../src/telegram-time';
import type { ParsedIntake } from '../src/types';

const catalog: FinanceReferenceCatalog = {
  categories: [
    { id: 'food', name: '餐饮', type: 'expense', parent_name: null },
    { id: 'smoke', name: '烟酒', type: 'expense', parent_name: null },
    { id: 'other-expense', name: '其他支出', type: 'expense', parent_name: null },
    { id: 'salary', name: '工资', type: 'income', parent_name: null },
    { id: 'other-income', name: '其他收入', type: 'income', parent_name: null },
    { id: 'transfer', name: '转账', type: 'transfer', parent_name: null }
  ],
  accounts: [
    { id: 'unspecified', name: '未指定', type: 'other' },
    { id: 'wechat', name: '微信', type: 'wallet' },
    { id: 'ccb', name: '建行', type: 'bank' }
  ]
};

const parsed: ParsedIntake = {
  intent: 'create_transaction',
  transaction_type: 'expense',
  amount: 10,
  currency: 'CNY',
  category_name: '烟酒',
  account_name: '微信',
  merchant: '',
  description: '硬盒红塔山一盒',
  occurred_at: '2026-09-05T21:31:00',
  confidence: 0.98
};

const normalized = normalizeParsedReferenceFields(parsed, catalog);
assert.equal(normalized.category_name, '烟酒');
assert.equal(normalized.account_name, '微信');
assert.equal(normalized.description, '硬盒红塔山一盒');

const unknownCategory = normalizeParsedReferenceFields({ ...parsed, category_name: 'AI自己编的分类' }, catalog);
assert.equal(unknownCategory.category_name, '其他支出');

const unspecifiedAccount = normalizeParsedReferenceFields({ ...parsed, account_name: '不存在的支付方式' }, catalog);
assert.equal(unspecifiedAccount.account_name, '未指定');

const prompt = financeReferencePrompt(catalog);
assert.match(prompt, /烟酒/);
assert.match(prompt, /微信/);
assert.match(prompt, /建行/);

const unixSeconds = Math.floor(Date.parse('2026-09-05T13:31:00.000Z') / 1000);
const eventDate = telegramMessageDateToDate(unixSeconds);
assert.ok(eventDate);
assert.equal(eventDate.toISOString(), '2026-09-05T13:31:00.000Z');
assert.equal(resolveTelegramReferenceTime(unixSeconds, 'Asia/Shanghai'), '2026-09-05T21:31:00');

console.log('intake-fidelity tests passed');
