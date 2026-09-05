import assert from 'node:assert/strict';
import { parseFinanceTextQuery } from '../src/finance';

const now = new Date('2026-09-05T06:00:00.000Z');
const timeZone = 'Asia/Shanghai';

const today = parseFinanceTextQuery('今天支出多少', timeZone, now);
assert.ok(today);
assert.equal(today.mode, 'summary');
assert.equal(today.start, '2026-09-05');
assert.equal(today.end, '2026-09-06');

const previousMonth = parseFinanceTextQuery('上个月花了多少', timeZone, now);
assert.ok(previousMonth);
assert.equal(previousMonth.label, '2026年8月');
assert.equal(previousMonth.start, '2026-08-01');
assert.equal(previousMonth.end, '2026-09-01');

const historicSummary = parseFinanceTextQuery('查一下2024年2月支出', timeZone, now);
assert.ok(historicSummary);
assert.equal(historicSummary.mode, 'summary');
assert.equal(historicSummary.start, '2024-02-01');
assert.equal(historicSummary.end, '2024-03-01');

const historicDay = parseFinanceTextQuery('查2022年2月18日支出', timeZone, now);
assert.ok(historicDay);
assert.equal(historicDay.start, '2022-02-18');
assert.equal(historicDay.end, '2022-02-19');

const historicDetails = parseFinanceTextQuery('2024年2月明细 第3页', timeZone, now);
assert.ok(historicDetails);
assert.equal(historicDetails.mode, 'details');
assert.equal(historicDetails.page, 3);
assert.equal(historicDetails.limit, 10);

assert.equal(parseFinanceTextQuery('晚饭25元', timeZone, now), null);
assert.equal(parseFinanceTextQuery('工资到账5000', timeZone, now), null);

console.log('finance-query tests passed');
