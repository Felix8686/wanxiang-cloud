import assert from 'node:assert/strict';
import { buildReceiptSourceId, describeAiResultShape, extractJsonValue, reconcileReceipt } from '../src/receipt';
import type { ParsedReceipt, TelegramPhotoSize } from '../src/types';

function receipt(overrides: Partial<ParsedReceipt> = {}): ParsedReceipt {
  return {
    is_receipt: true,
    merchant: '测试超市',
    occurred_at: '2026-09-03T12:00:00',
    currency: 'CNY',
    total_amount: 30,
    subtotal_amount: 30,
    discount_amount: 0,
    tax_amount: 0,
    rounding_amount: 0,
    payment_method: '支付宝',
    confidence: 0.98,
    total_confidence: 0.99,
    rejection_reason: '',
    items: [
      { name: '牛奶', quantity: 1, unit_price: 12, line_total: 12, category: '食品', confidence: 0.95 },
      { name: '洗衣液', quantity: 1, unit_price: 18, line_total: 18, category: '清洁用品', confidence: 0.95 }
    ],
    ...overrides
  };
}

{
  const result = reconcileReceipt(receipt());
  assert.equal(result.ok, true);
  assert.equal(result.items_total_fen, 3000);
  assert.equal(result.receipt_total_fen, 3000);
  assert.equal(result.difference_fen, 0);
}

{
  const result = reconcileReceipt(receipt({
    total_amount: 27,
    subtotal_amount: 30,
    discount_amount: 3
  }));
  assert.equal(result.ok, true);
  assert.equal(result.expected_total_fen, 2700);
}

{
  const result = reconcileReceipt(receipt({ total_amount: 29.95 }));
  assert.equal(result.ok, false);
  assert.equal(result.difference_fen, -5);
}

{
  const result = reconcileReceipt(receipt({
    total_amount: 30.01,
    rounding_amount: 0.01
  }));
  assert.equal(result.ok, true);
  assert.equal(result.expected_total_fen, 3001);
}

{
  const photo: TelegramPhotoSize = {
    file_id: 'downloadable',
    file_unique_id: 'stable-photo-id',
    width: 1280,
    height: 720
  };
  assert.equal(
    buildReceiptSourceId(12345, photo, 99, 88),
    'receipt_12345_stable-photo-id'
  );
}

{
  const parsed = receipt();
  assert.deepEqual(
    extractJsonValue({ choices: [{ message: { parsed } }] }),
    parsed
  );
}

{
  const parsed = receipt({ merchant: 'JSON Mode 超市' });
  assert.deepEqual(extractJsonValue({ response: parsed }), parsed);
}

{
  const parsed = receipt({ merchant: 'Content 超市' });
  assert.deepEqual(
    extractJsonValue({ choices: [{ message: { content: JSON.stringify(parsed) } }] }),
    parsed
  );
}

{
  const shape = describeAiResultShape({
    id: 'not-sensitive',
    choices: [{ message: { parsed: receipt(), content: null } }]
  });
  assert.deepEqual(shape.topKeys, ['id', 'choices']);
  assert.equal(shape.choicesLength, 1);
  assert.equal(shape.parsedType, 'object');
  assert.equal(shape.contentType, 'object');
  assert.equal(Object.prototype.hasOwnProperty.call(shape, 'content'), false);
}

console.log('receipt reconciliation tests: PASS');
