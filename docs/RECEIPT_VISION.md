# v0.3 Telegram 小票图片识别

## 目标

用户在 Telegram 中直接发送购物小票照片。万象云端在 Cloudflare 内完成图片下载、视觉识别、逐商品分类、金额核对和 D1 入账，不依赖本机 Hermes 常驻。

## 当前链路（v0.3.1）

```text
Telegram photo
  -> /telegram/webhook
  -> verify webhook secret
  -> select largest PhotoSize
  -> Cloudflare Queue: wanxiang-receipt-dev
  -> immediate Telegram acknowledgement

Queue consumer
  -> Telegram getFile / file download
  -> Workers AI Vision
  -> Worker 结构校验
  -> confidence checks
  -> 金额 reconciliation
  -> D1 transactions + transaction_items
  -> Telegram 最终摘要回复
```

原有纯文字 Telegram 消息继续委托给 `src/index.ts`。v0.3 HTTP/Queue 入口层为 `src/app.ts`，小票异步任务编排为 `src/receipt-job.ts`，Vision/OCR 和金额核对基础逻辑在 `src/receipt.ts`。

## 为什么改用 Queue

第一张真实小票暴露了旧实现的问题：Webhook 先把 `ingestion_log` 写成 `processing`，随后把整个 Vision 任务放入 HTTP `ctx.waitUntil()`。Cloudflare HTTP `waitUntil()` 在响应结束后只有 30 秒延长期，超过后未完成任务会被取消，因此出现了 `processing` 永久无终态。

v0.3.1 将长任务移入 Cloudflare Queues。Queue consumer 有更长执行窗口，适合 Telegram 下载 + Vision OCR 这类可能超过 30 秒的异步工作。

## Cloudflare 资源

现有：

- Worker：`wanxiang-cloud-dev`
- D1：`wanxiang-cloud-dev`
- Workers AI binding：`AI`
- R2 binding：`FILES`（小票照片不存 R2）

新增：

- Queue：`wanxiang-receipt-dev`
- Producer binding：`RECEIPT_QUEUE`
- Consumer：同一个 `wanxiang-cloud-dev` Worker
- `max_batch_size=1`
- `max_batch_timeout=1`
- `max_retries=2`

## Vision 模型

默认：

```text
@cf/google/gemma-4-26b-a4b-it
```

通过：

```text
RECEIPT_VISION_MODEL
```

配置。

模型只负责识别和返回结构化数据，不直接写数据库。最终入账由 Worker 校验后执行。

## Telegram 图片处理

Webhook 支持 `message.photo`：

1. 选择 Telegram 返回的最大尺寸 `PhotoSize`；
2. 使用现有 `TELEGRAM_BOT_TOKEN` 调用 `getFile`；
3. 下载 Telegram 压缩后的图片；
4. 超过大小限制安全拒绝；
5. 图片进入 Workers AI Vision；
6. 原图不写入 R2、D1、Git 或本地磁盘；
7. `file_id` / Telegram file URL 不长期保存。

如果消息带 caption，例如：

```text
今天在永辉买的，支付宝
```

会作为附加上下文交给 Vision 层，并可作为有限长度 `raw_text` 保存。

## 任务状态机

小票任务通过 `ingestion_log.status` 表示：

```text
queued
  -> processing
      -> parsed
      -> rejected
      -> failed
```

定义：

- `queued`：任务已成功写入 Cloudflare Queue；
- `processing`：Queue consumer 已取得处理锁；
- `parsed`：transaction + items 成功写入；
- `rejected`：非小票、置信度不足或金额核对失败；
- `failed`：下载、模型、超时或基础设施错误。

任何真实任务都不应长期停留在 `processing`。

### 超时

- Telegram 图片下载：30 秒；
- Workers AI Vision：120 秒；
- `processing` 超过 240 秒视为 stale。

下载或 AI 超时必须进入 `failed`，且不得创建 transaction。

### stale 恢复

同一张小票此前如果处于：

- `failed`
- `rejected`
- stale `processing`

用户重新发送时允许安全重新处理。

如果已经成功 `parsed`，则继续执行幂等保护，不允许重复交易。

## 幂等

小票 `source_id` 主要由：

```text
receipt_<chatId>_<file_unique_id>
```

生成。

用于防止：

- Telegram webhook 重试；
- Queue 至少一次投递造成重复；
- 用户重复发送已经成功入账的同一图片。

正式写 D1 前，consumer 还会验证自己仍持有 processing lock。

现有数据库：

```text
UNIQUE(source, source_id)
```

继续作为最后一道重复交易保护。

## AI 结构化输出

Receipt：

```text
merchant
occurred_at
currency
total_amount
subtotal_amount
discount_amount
tax_amount
rounding_amount
payment_method
confidence
total_confidence
items[]
```

Item：

```text
name
quantity
unit_price
line_total
category
confidence
```

## 商品分类

允许：

- 食品
- 饮料
- 生鲜
- 零食
- 日用品
- 清洁用品
- 个护
- 医药健康
- 母婴
- 宠物
- 家居
- 数码配件
- 服饰
- 其他

商品明细分类与现有交易顶层分类并存。

## D1 模型

Migration：

```text
migrations/0003_transaction_items.sql
```

一张小票：

```text
transactions: 1 行
transaction_items: N 行
```

`transaction_items`：

```text
id
transaction_id
name
quantity
unit_price_fen
line_total_fen
category
confidence
created_at
```

## 金额核对

Worker 计算：

```text
sum(item.line_total)
- discount
+ tax
+ rounding
```

与 `receipt.total_amount` 比较。

允许误差：

```text
<= 2 分
```

超过误差：

- 不创建 transaction；
- 不创建 transaction_items；
- ingestion -> `rejected`；
- Telegram 提示重新拍摄/确认。

## 置信度门槛

当前 MVP：

- receipt confidence >= 0.80
- total confidence >= 0.90
- item 低置信阈值 = 0.55
- 低置信商品最多占 25%

识别不确定时默认拒绝自动入账。

## 非小票图片

Vision prompt 要求区分购物小票与：

- 普通照片
- 截图
- 商品包装
- 菜单
- 无关文档

非小票图片不得创建交易。

## Telegram 交互

新任务首先回复：

```text
已收到小票，正在识别。
```

成功后再回复摘要，例如：

```text
已识别并记录购物小票

商家：永辉超市
总计：¥186.30
商品：12 项
支付：支付宝

分类：
食品 ¥63.20
生鲜 ¥48.50
清洁用品 ¥39.90
其他 ¥34.70
```

超时/失败也必须返回终态，不允许静默卡在 processing。

## 隐私

- 原始小票照片不持久化；
- 不写 R2；
- Telegram file URL 不持久化；
- Bot Token 只保留在 Cloudflare Secret；
- D1 只保留结构化账目以及可选 caption。

## 原功能保护

以下继续走旧链路：

```text
晚饭25元，支付宝
今天花了多少
/v1/intake
/v1/sync/*
```

## 真实 E2E 验收

必须证明：

1. Telegram webhook 正常；
2. Queue enqueue 成功；
3. `queued -> processing -> terminal`；
4. Telegram `getFile` 成功；
5. Workers AI Vision 在配置超时内结束；
6. 中文小票字段和商品行可识别；
7. 商品逐项分类合理；
8. 金额核对通过；
9. `transactions +1`；
10. `transaction_items +N`；
11. Telegram 收到最终摘要；
12. 重发同一张已成功小票不重复入账；
13. R2 中没有原始小票图片。

## 第一张真实小票事故记录

第一张真实 v0.3 小票曾产生：

```text
source_id=receipt_1118263109_AQADeRVrG5iMyVR-
status=processing
```

旧版使用 `waitUntil()`，任务被生命周期限制中断，因此没有终态。

部署 Queue 修复后，这条历史记录应保留并标记：

```text
status=failed
error_message=ABANDONED_PRE_QUEUE_WAITUNTIL_ATTEMPT
```

不要删除它，也不要把它当作成功交易。
