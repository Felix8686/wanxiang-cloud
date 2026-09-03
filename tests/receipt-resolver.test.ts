import assert from 'node:assert/strict';
import { resolveVeryfiReceipt } from '../src/receipt-resolver';
import { reconcileReceipt } from '../src/receipt';

const detailed = <T>(value: T, score = 0.95, ocrScore = 0.99) => ({
  value,
  score,
  ocr_score: ocrScore,
  rotation: 0
});

const fixture: Record<string, unknown> = {
  document_type: detailed('receipt', 0.90, 0.90),
  vendor: {
    name: detailed('魏莱生鮮超市', 0.97, 0.74)
  },
  date: null,
  total: detailed(52.18, 0.92, 0.99),
  payment_method: detailed('visa', 0.60, 0.60),
  ocr_text: [
    '魏莱生鲜超市',
    '2026-09-03 10:39',
    '1.平菇 6910001',
    '0.31 11.96 3.71',
    '2.480g好麦主食烧饼红豆味 6972733',
    '1 9.90 9.90',
    '3.老豆腐 04007',
    '0.476 4.56 2.17',
    '4.精品五花肉 06013',
    '0.6052 23.96 14.50',
    '5.三全实惠装水饺1005g 6908791103099',
    '1 9.90 9.90',
    '6.红山软经典',
    '1 12.00 12.00',
    '应付 52.18',
    '实付 52.18',
    '其他扫码付'
  ].join('\n'),
  line_items: [
    { description: detailed('2.480g好麦主食烧饼红豆味 6972733'), quantity: detailed(0.31), price: detailed(11.96), total: detailed(3.71) },
    { description: detailed('3.老豆腐 04007'), quantity: detailed(1), price: detailed(9.90), total: detailed(9.90) },
    { description: detailed('4.精品五花肉 06013'), quantity: detailed(0.476), price: detailed(4.56), total: detailed(2.17) },
    { description: detailed('5.三全实惠装水饺1005g 6908791103099'), quantity: detailed(0.6052), price: detailed(23.96), total: detailed(14.50) },
    { description: detailed('16.红山软经典'), quantity: detailed(1), price: detailed(9.90), total: detailed(9.90) },
    { description: null, quantity: detailed(1), price: detailed(12.00), total: detailed(12.00) }
  ]
};

const receipt = resolveVeryfiReceipt(fixture, '2026-09-03T12:00:00');

assert.equal(receipt.is_receipt, true);
assert.equal(receipt.merchant, '魏莱生鮮超市');
assert.equal(receipt.occurred_at, '2026-09-03T10:39:00');
assert.equal(receipt.payment_method, '其他扫码付');
assert.equal(receipt.total_amount, 52.18);
assert.equal(receipt.items.length, 6);
assert.deepEqual(receipt.items.map((item) => item.name), [
  '平菇',
  '480g好麦主食烧饼红豆味',
  '老豆腐',
  '精品五花肉',
  '三全实惠装水饺1005g',
  '红山软经典'
]);
assert.deepEqual(receipt.items.map((item) => item.line_total), [3.71, 9.90, 2.17, 14.50, 9.90, 12.00]);

const reconciliation = reconcileReceipt(receipt);
assert.equal(reconciliation.ok, true);
assert.equal(reconciliation.receipt_total_fen, 5218);
assert.equal(reconciliation.items_total_fen, 5218);

console.log('receipt resolver tests passed');
