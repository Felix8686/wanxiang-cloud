import assert from 'node:assert/strict';
import { looksLikeFinanceAnalysis, resolveConversationQuery } from '../src/finance-conversation';

const timeZone = 'Asia/Shanghai';
const now = new Date('2026-09-05T06:00:00.000Z');

assert.equal(looksLikeFinanceAnalysis('哪些部分花费比较多可以优化'), true);
assert.equal(looksLikeFinanceAnalysis('为什么这个月花这么多'), true);
assert.equal(looksLikeFinanceAnalysis('晚饭25元'), false);

const context = {
  last_start: '2026-08-01',
  last_end: '2026-09-01',
  last_label: '2026年8月'
};

const inherited = resolveConversationQuery({
  action: 'analyze',
  scope: 'inherit',
  year: 0,
  month: 0,
  day: 0,
  confidence: 0.96
} as any, context, timeZone, now);
assert.ok(inherited);
assert.equal(inherited.label, '2026年8月');
assert.equal(inherited.start, '2026-08-01');
assert.equal(inherited.end, '2026-09-01');

const explicit = resolveConversationQuery({
  action: 'analyze',
  scope: 'specific_month',
  year: 2024,
  month: 2,
  day: 0,
  confidence: 0.98
} as any, null, timeZone, now);
assert.ok(explicit);
assert.equal(explicit.label, '2024年2月');
assert.equal(explicit.start, '2024-02-01');
assert.equal(explicit.end, '2024-03-01');

const fallbackMonth = resolveConversationQuery({
  action: 'analyze',
  scope: 'inherit',
  year: 0,
  month: 0,
  day: 0,
  confidence: 0.9
} as any, null, timeZone, now);
assert.ok(fallbackMonth);
assert.equal(fallbackMonth.label, '2026年9月');

const details = resolveConversationQuery({
  action: 'details',
  scope: 'specific_day',
  year: 2022,
  month: 2,
  day: 18,
  confidence: 0.99
} as any, null, timeZone, now);
assert.ok(details);
assert.equal(details.mode, 'details');
assert.equal(details.start, '2022-02-18');
assert.equal(details.end, '2022-02-19');

console.log('finance-conversation tests passed');
