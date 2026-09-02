# Wanxiang Cloud v0.1 Architecture

## Goal

先跑通一条最小但真实的云端闭环：电脑关机时，Telegram 仍可把自然语言收支写入 Cloudflare D1，并查询当天支出。

## Runtime ownership

- Cloudflare = 主运行环境与主数据源。
- D1 = 结构化主库。
- Workers AI = 云端自然语言理解层。
- Worker = 唯一业务规则与数据库写入层。
- Telegram = 第一版远程入口。
- Obsidian / Hermes = 后续本地工作副本与轻量执行端，不是云端系统宿主。

## Request flow

```text
Telegram message
  -> /telegram/webhook
  -> webhook secret verification
  -> Workers AI structured parsing
  -> Worker validation + allowlist rules
  -> D1 transaction/query
  -> Telegram reply
```

Generic API:

```text
POST /v1/intake
  -> Bearer API key
  -> same parse/validate/write pipeline
```

## Safety boundary

AI never receives direct D1 authority. It only returns a structured proposal:

- intent
- transaction type
- amount
- category
- account
- description
- occurred_at
- confidence

Worker code validates that proposal before any write. Low-confidence or invalid input results in no database mutation.

## D1 tables

- `accounts`: payment/account sources.
- `categories`: controlled transaction categories.
- `transactions`: financial ledger; money is stored as integer fen.
- `events`: reserved for later life-management reminders/events.
- `ingestion_log`: deduplication and intake audit trail.

## v0.1 supported intents

1. Create a transaction, for example: `晚饭25元`.
2. Query today's spending, for example: `今天花了多少钱`.
3. Unknown/low-confidence input: do nothing and ask the user to rephrase.

## Not in v0.1

- R2 attachments/Markdown storage.
- Obsidian synchronization.
- Historical ledger import.
- Cron reminders.
- Queues.
- General life-management event creation.
- Production environment.

These are intentionally deferred until the first cloud ledger loop passes real-device validation.
