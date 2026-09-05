import {
  accountEnum,
  categoryEnum,
  financeReferencePrompt,
  loadFinanceReferenceCatalog,
  normalizeParsedReferenceFields
} from './finance-reference';
import type { Env, ParsedIntake } from './types';

function buildSchema(categoryNames: string[], accountNames: string[]) {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['create_transaction', 'spending_today', 'unknown'] },
      transaction_type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
      amount: { type: 'number', minimum: 0 },
      currency: { type: 'string' },
      category_name: { type: 'string', enum: categoryNames },
      account_name: { type: 'string', enum: accountNames },
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
}

export async function parseIntake(env: Env, text: string, referenceLocalNow: string): Promise<ParsedIntake> {
  const catalog = await loadFinanceReferenceCatalog(env);
  const schema = buildSchema(categoryEnum(catalog), accountEnum(catalog));
  const result = await env.AI.run(env.AI_MODEL, {
    messages: [
      {
        role: 'system',
        content: [
          '你是“万象云端”的输入解析层。你的职责仅是把用户输入转换成结构化意图，绝不能自行执行数据库操作。',
          '支持三种 intent：create_transaction（新增收支）、spending_today（查询今天总支出）、unknown。',
          '如果用户说“晚饭25元”“买菜 32.5”“工资到账5000”等，识别为 create_transaction。',
          '如果用户问“今天花了多少”“今天支出多少”，识别为 spending_today。',
          '金额单位默认人民币 CNY。',
          '分类和账户必须严格从下面的当前数据库列表中选择，禁止自行创造不存在的分类或账户。',
          '选择最符合用户真实用途的最具体分类，不要因为词义不熟就随意塞进“日用品”或“其他支出”。',
          '例如烟、香烟、卷烟、红塔山等，如果当前分类列表存在“烟酒”，应选择“烟酒”。',
          '用户没有说明支付方式/账户时，account_name 必须返回“未指定”；不要猜测微信、支付宝、银行卡或现金。',
          'merchant 只有在用户明确表达商家/店名时才填写；description 保留商品、用途或事项的原始语义，简短但不要丢掉关键信息。',
          `参考本地时间：${referenceLocalNow}。用户没有说明时间时，occurred_at 使用这个时间；“今天/昨天/刚才”等相对时间也以它为基准。`,
          financeReferencePrompt(catalog),
          '无法确定的信息使用空字符串；不要编造商家、账户、时间或消费原因。'
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
  return normalizeParsedReferenceFields(validateParsed(parsed), catalog);
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
