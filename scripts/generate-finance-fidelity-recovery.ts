import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type TransactionType = 'expense' | 'income' | 'transfer';
type PaymentStatus = 'resolved' | 'ambiguous' | 'missing';

interface PaymentRecovery {
  status: PaymentStatus;
  name?: string | null;
  candidates?: string[];
}

interface RecoveryRecord {
  transaction_id: string;
  transaction_type: TransactionType;
  category_name?: string | null;
  payment_method?: PaymentRecovery | null;
  expected_current_category: string | null;
  expected_current_account: string | null;
  evidence?: unknown;
}

interface RecoveryManifest {
  schema_version: 1;
  run_id: string;
  records: RecoveryRecord[];
}

interface PlannedRecord {
  record: RecoveryRecord;
  targetCategory: string | null;
  targetAccount: string | null;
  categoryChanged: boolean;
  accountChanged: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function cleanName(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(`${field} must be a string or null`);
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (cleaned.length > 120) fail(`${field} is too long`);
  return cleaned;
}

function sql(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function stableId(prefix: string, value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

function inferAccountType(name: string): 'cash' | 'bank' | 'wallet' | 'credit' | 'other' {
  if (/现金/.test(name)) return 'cash';
  if (/(支付宝|微信|扫码|云闪付|Pay|钱包)/i.test(name)) return 'wallet';
  if (/(信用卡|花呗|白条)/.test(name)) return 'credit';
  if (/(银行|建行|工行|农行|中行|交行|招行|邮储|浦发|民生|兴业|光大|平安|银行卡|储蓄卡)/.test(name)) return 'bank';
  return 'other';
}

function validateManifest(input: unknown): RecoveryManifest {
  if (!input || typeof input !== 'object') fail('manifest must be an object');
  const value = input as Record<string, unknown>;
  if (value.schema_version !== 1) fail('schema_version must be 1');
  if (typeof value.run_id !== 'string' || !/^[A-Za-z0-9._-]{3,80}$/.test(value.run_id)) {
    fail('run_id must contain only letters, numbers, dot, underscore or dash');
  }
  if (!Array.isArray(value.records) || value.records.length === 0) fail('records must be a non-empty array');

  const ids = new Set<string>();
  const records: RecoveryRecord[] = value.records.map((raw, index) => {
    if (!raw || typeof raw !== 'object') fail(`records[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    if (typeof row.transaction_id !== 'string' || !row.transaction_id.trim()) fail(`records[${index}].transaction_id missing`);
    const id = row.transaction_id.trim();
    if (ids.has(id)) fail(`duplicate transaction_id: ${id}`);
    ids.add(id);

    const transactionType = row.transaction_type;
    if (!['expense', 'income', 'transfer'].includes(String(transactionType))) {
      fail(`records[${index}].transaction_type invalid`);
    }

    if (!Object.prototype.hasOwnProperty.call(row, 'expected_current_category')) {
      fail(`records[${index}].expected_current_category is required`);
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'expected_current_account')) {
      fail(`records[${index}].expected_current_account is required`);
    }

    let payment: PaymentRecovery | null = null;
    if (row.payment_method !== undefined && row.payment_method !== null) {
      if (typeof row.payment_method !== 'object') fail(`records[${index}].payment_method invalid`);
      const p = row.payment_method as Record<string, unknown>;
      const status = String(p.status) as PaymentStatus;
      if (!['resolved', 'ambiguous', 'missing'].includes(status)) fail(`records[${index}].payment_method.status invalid`);
      const name = cleanName(p.name, `records[${index}].payment_method.name`);
      if (status === 'resolved' && !name) fail(`records[${index}] resolved payment requires name`);
      payment = {
        status,
        name,
        candidates: Array.isArray(p.candidates) ? p.candidates.filter((item): item is string => typeof item === 'string') : undefined
      };
    }

    return {
      transaction_id: id,
      transaction_type: transactionType as TransactionType,
      category_name: cleanName(row.category_name, `records[${index}].category_name`),
      payment_method: payment,
      expected_current_category: cleanName(row.expected_current_category, `records[${index}].expected_current_category`),
      expected_current_account: cleanName(row.expected_current_account, `records[${index}].expected_current_account`),
      evidence: row.evidence
    };
  });

  return { schema_version: 1, run_id: value.run_id, records };
}

function plan(manifest: RecoveryManifest): PlannedRecord[] {
  return manifest.records.map((record) => {
    const targetCategory = cleanName(record.category_name, 'category_name');
    const targetAccount = record.payment_method?.status === 'resolved'
      ? cleanName(record.payment_method.name, 'payment_method.name')
      : null;
    return {
      record,
      targetCategory,
      targetAccount,
      categoryChanged: Boolean(targetCategory && targetCategory !== record.expected_current_category),
      accountChanged: Boolean(targetAccount && targetAccount !== record.expected_current_account)
    };
  }).filter((item) => item.categoryChanged || item.accountChanged);
}

function buildApplySql(manifest: RecoveryManifest, planned: PlannedRecord[]): string {
  const lines: string[] = [
    `-- Generated finance fidelity recovery plan`,
    `-- run_id=${manifest.run_id}`,
    `-- planned_updates=${planned.length}`,
    `-- This file is intentionally guarded by expected current category/account names.`,
    ''
  ];

  const categories = new Map<string, TransactionType>();
  const accounts = new Set<string>();
  for (const item of planned) {
    if (item.targetCategory) categories.set(`${item.record.transaction_type}\u0000${item.targetCategory}`, item.record.transaction_type);
    if (item.targetAccount) accounts.add(item.targetAccount);
  }

  for (const [key, type] of categories) {
    const name = key.split('\u0000')[1];
    const id = stableId(`restored-cat-${type}`, `${type}:${name}`);
    lines.push(
      `INSERT OR IGNORE INTO categories (id, name, type, parent_id, is_active, created_at)`,
      `VALUES (${sql(id)}, ${sql(name)}, ${sql(type)}, NULL, 1, CURRENT_TIMESTAMP);`
    );
  }
  if (categories.size) lines.push('');

  for (const name of accounts) {
    const id = stableId('restored-account', name);
    const type = inferAccountType(name);
    lines.push(
      `INSERT OR IGNORE INTO accounts (id, name, type, currency, is_active, created_at)`,
      `VALUES (${sql(id)}, ${sql(name)}, ${sql(type)}, 'CNY', 1, CURRENT_TIMESTAMP);`
    );
  }
  if (accounts.size) lines.push('');

  for (const item of planned) {
    const r = item.record;
    const evidence = r.evidence === undefined ? null : JSON.stringify(r.evidence);
    lines.push(
      `-- ${r.transaction_id}`,
      `INSERT OR IGNORE INTO finance_fidelity_recovery_log (`,
      `  run_id, transaction_id, old_category_id, old_account_id,`,
      `  target_category_name, target_account_name, category_changed, account_changed, evidence_json`,
      `)`,
      `SELECT`,
      `  ${sql(manifest.run_id)}, t.id, t.category_id, t.account_id,`,
      `  ${sql(item.targetCategory)}, ${sql(item.targetAccount)}, ${item.categoryChanged ? 1 : 0}, ${item.accountChanged ? 1 : 0}, ${sql(evidence)}`,
      `FROM transactions t`,
      `LEFT JOIN categories c ON c.id = t.category_id`,
      `LEFT JOIN accounts a ON a.id = t.account_id`,
      `WHERE t.id = ${sql(r.transaction_id)}`,
      `  AND COALESCE(c.name, '') = ${sql(r.expected_current_category || '')}`,
      `  AND COALESCE(a.name, '') = ${sql(r.expected_current_account || '')};`
    );

    if (item.categoryChanged && item.targetCategory) {
      lines.push(
        `UPDATE transactions`,
        `SET category_id = (SELECT id FROM categories WHERE name = ${sql(item.targetCategory)} AND type = ${sql(r.transaction_type)} LIMIT 1)`,
        `WHERE id = ${sql(r.transaction_id)}`,
        `  AND EXISTS (SELECT 1 FROM finance_fidelity_recovery_log l WHERE l.run_id = ${sql(manifest.run_id)} AND l.transaction_id = ${sql(r.transaction_id)});`
      );
    }
    if (item.accountChanged && item.targetAccount) {
      lines.push(
        `UPDATE transactions`,
        `SET account_id = (SELECT id FROM accounts WHERE name = ${sql(item.targetAccount)} LIMIT 1)`,
        `WHERE id = ${sql(r.transaction_id)}`,
        `  AND EXISTS (SELECT 1 FROM finance_fidelity_recovery_log l WHERE l.run_id = ${sql(manifest.run_id)} AND l.transaction_id = ${sql(r.transaction_id)});`
      );
    }
    lines.push('');
  }

  lines.push(
    `-- Verification: this count MUST equal ${planned.length}.`,
    `SELECT COUNT(*) AS journaled_rows FROM finance_fidelity_recovery_log WHERE run_id = ${sql(manifest.run_id)};`,
    `SELECT category_changed, account_changed, COUNT(*) AS rows`,
    `FROM finance_fidelity_recovery_log WHERE run_id = ${sql(manifest.run_id)}`,
    `GROUP BY category_changed, account_changed ORDER BY category_changed, account_changed;`,
    ''
  );
  return lines.join('\n');
}

function buildRollbackSql(manifest: RecoveryManifest): string {
  return [
    `-- Roll back transaction category/account links for run_id=${manifest.run_id}.`,
    `-- Recovery-created taxonomy rows are intentionally left in place; they are harmless and may be shared by later records.`,
    `UPDATE transactions`,
    `SET category_id = (`,
    `      SELECT l.old_category_id FROM finance_fidelity_recovery_log l`,
    `      WHERE l.run_id = ${sql(manifest.run_id)} AND l.transaction_id = transactions.id`,
    `    ),`,
    `    account_id = (`,
    `      SELECT l.old_account_id FROM finance_fidelity_recovery_log l`,
    `      WHERE l.run_id = ${sql(manifest.run_id)} AND l.transaction_id = transactions.id`,
    `    )`,
    `WHERE EXISTS (`,
    `  SELECT 1 FROM finance_fidelity_recovery_log l`,
    `  WHERE l.run_id = ${sql(manifest.run_id)} AND l.transaction_id = transactions.id`,
    `);`,
    `SELECT COUNT(*) AS rolled_back_rows FROM finance_fidelity_recovery_log WHERE run_id = ${sql(manifest.run_id)};`,
    ''
  ].join('\n');
}

function parseArgs(argv: string[]): { manifest: string; outDir: string } {
  let manifest = '';
  let outDir = 'finance-fidelity-recovery-out';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') manifest = argv[++i] || '';
    else if (argv[i] === '--out-dir') outDir = argv[++i] || outDir;
  }
  if (!manifest) fail('Usage: tsx scripts/generate-finance-fidelity-recovery.ts --manifest <file.json> [--out-dir <dir>]');
  return { manifest, outDir };
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = resolve(args.manifest);
const outputDir = resolve(args.outDir);
const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
const planned = plan(manifest);
const ambiguous = manifest.records.filter((record) => record.payment_method?.status === 'ambiguous');
const missing = manifest.records.filter((record) => record.payment_method?.status === 'missing');

mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'apply.sql'), buildApplySql(manifest, planned), 'utf8');
writeFileSync(resolve(outputDir, 'rollback.sql'), buildRollbackSql(manifest), 'utf8');
writeFileSync(resolve(outputDir, 'summary.json'), JSON.stringify({
  schema_version: 1,
  run_id: manifest.run_id,
  source_manifest: manifestPath,
  total_manifest_records: manifest.records.length,
  planned_updates: planned.length,
  category_changes: planned.filter((item) => item.categoryChanged).length,
  account_changes: planned.filter((item) => item.accountChanged).length,
  ambiguous_payment_records: ambiguous.map((item) => ({
    transaction_id: item.transaction_id,
    candidates: item.payment_method?.candidates || []
  })),
  missing_payment_records: missing.map((item) => item.transaction_id),
  guard: 'Every update is journaled only when transaction id + expected current category + expected current account all match.',
  read_only_generation: true
}, null, 2), 'utf8');

console.log(JSON.stringify({
  ok: true,
  run_id: manifest.run_id,
  planned_updates: planned.length,
  category_changes: planned.filter((item) => item.categoryChanged).length,
  account_changes: planned.filter((item) => item.accountChanged).length,
  ambiguous_payment_records: ambiguous.length,
  missing_payment_records: missing.length,
  output_dir: outputDir
}, null, 2));
