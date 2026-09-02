import type { Env, ParsedIntake } from './types';

const schema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['create_transaction', 'spending_today', 'unknown'] },
    transaction_type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string' },
    category_name: { type: 'string' },
    account_name: { type: 'string' },
    merchant: { type: 'string' },
    description: { type: 'string' },
    occurred_at: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: [
    'intent', 'transaction_type', 'amount', 'currency', 'category_name',
    'account_name', 'merchant', 'description', 'occurred_at', 'confidence'
  ]
} as const;

export async function parseIntake(env: Env, text: string, localNow: string): Promise<ParsedIntake> {
  const result = await env.AI.run(env.AI_MODEL, {
    messages: [
      {
        role: 'system',
        content: [
          '你是“万象云端”的输入解析层。你的职责仅是把用户输入转换成结构化意图，绝不能自行执行数据库操作。',
          '支持三种 intent：create_transaction（新增收支）、spending_today（查询今天总支出）、unknown。',
          '如果用户说“晚饭25元”“买菜 32.5”“工资到账5000”等，识别为 create_transaction。',
          '如果用户问“今天花了多少”“今天支出多少”，识别为 spending_today。',
          '金额单位默认人民币 CNY。未说明账户时 account_name 返回“未指定”。',
          '支出分类必须准确映射到以下之一：餐饮（如早饭、午饭、晚饭、买菜、零食、饮料、外卖等）、日用品、交通、其他支出；收入分类映射到：工资、其他收入；转账映射到：转账。',
          '对于餐饮消费（如晚饭、午餐、早餐、奶茶等），category_name 必须是“餐饮”，不要返回其他支出。',
          `当前本地时间：${localNow}。用户没有说明时间时，occurred_at 使用这个时间。`,
          'description 保留简短、可读的交易说明。无法确定的信息使用空字符串，不要编造商家或账户。'
        ].join('\n')
      },
      { role: 'user', content: text }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: schema
    }
  });

  const response = (result as { response?: unknown })?.response;
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;
  return validateParsed(parsed);
}

function validateParsed(value: unknown): ParsedIntake {
  if (!value || typeof value !== 'object') throw new Error('AI_PARSE_INVALID_OBJECT');
  const v = value as Record<string, unknown>;

  const intents = new Set(['create_transaction', 'spending_today', 'unknown']);
  const types = new Set(['expense', 'income', 'transfer']);
  if (!intents.has(String(v.intent))) throw new Error('AI_PARSE_INVALID_INTENT');
  if (!types.has(String(v.transaction_type))) throw new Error('AI_PARSE_INVALID_TRANSACTION_TYPE');

  const amount = Number(v.amount);
  const confidence = Number(v.confidence);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('AI_PARSE_INVALID_AMOUNT');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI_PARSE_INVALID_CONFIDENCE');

  return {
    intent: String(v.intent) as ParsedIntake['intent'],
    transaction_type: String(v.transaction_type) as ParsedIntake['transaction_type'],
    amount,
    currency: clean(v.currency) || 'CNY',
    category_name: clean(v.category_name),
    account_name: clean(v.account_name) || '未指定',
    merchant: clean(v.merchant),
    description: clean(v.description),
    occurred_at: clean(v.occurred_at),
    confidence
  };
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 300) : '';
}
