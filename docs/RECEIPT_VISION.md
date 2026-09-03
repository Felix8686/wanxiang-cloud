# v0.3 Telegram 小票图片识别

## 目标

用户在 Telegram 中直接发送购物小票照片。万象云端在 Cloudflare 内完成图片接收、队列调度、视觉识别、逐商品分类、金额核对和 D1 入账，不依赖本机 Hermes 常驻。

## 当前链路

```text
Telegram photo
  -> /telegram/webhook
  -> Cloudflare Queue: wanxiang-receipt-dev
  -> Queue consumer
  -> Telegram getFile / file download
  -> Workers AI Vision
  -> Worker 结构校验
  -> 金额 reconciliation
  -> D1 transactions + transaction_items
  -> Telegram 摘要回复
```

原有纯文字 Telegram 消息继续委托给 `src/index.ts`。v0.3 HTTP/Queue 入口为 `src/app.ts`，小票持久化流程为 `src/receipt-job.ts`，Vision/OCR 与结构解析基础能力为 `src/receipt.ts`。

## 为什么使用 Queue

最初实现把完整 Vision 任务放入 HTTP `ctx.waitUntil()`。真实图片第一次 E2E 时，`ingestion_log` 被写成 `processing`，但任务超过 HTTP 响应后的后台生命周期后被取消，导致状态长期没有终态。

修复后 webhook 只负责校验、幂等和入队。Queue consumer 负责耗时的图片下载和 Vision 推理。

当前防护：

- Telegram 图片下载：30 秒硬超时
- Workers AI Vision：120 秒硬超时
- `processing`：240 秒后视为 stale，可安全重新接管
- Queue 至少一次投递 + D1 `source/source_id` 双重幂等
- transaction 入库前二次确认 processing lock ownership
- failed/rejected/stale 的同一图片允许安全重试

## Vision 模型

默认：

```text
@cf/google/gemma-4-26b-a4b-it
```

通过：

```text
RECEIPT_VISION_MODEL
```

可替换。

该模型用于中文/中英混合购物小票识别、OCR、商品明细提取和基础分类。

## Vision 调用兼容性

真实 E2E 暴露过一次 `RECEIPT_AI_EMPTY_RESPONSE`。原因是最初实现按错误的响应假设读取结构化输出，同时把图片放在 `messages[].content[].image_url` 中。

当前实现按 Workers AI 原生调用习惯处理：

- 图片通过顶层 `image` 字段传给 `env.AI.run()`；
- `messages` 只保留文本指令；
- 使用 `response_format.type=json_schema`；
- 关闭 Gemma thinking，减少结构化输出漂移；
- 优先读取 `choices[0].message.parsed`；
- 同时兼容 `response` 对象/字符串、`message.content`、REST 风格 `result` 包装和直接 parsed 对象；
- 只有当无法识别返回结构时，日志才记录 AI 返回值的“形状”：类型、顶层字段名、choices 数量、message 字段名等；绝不记录响应正文、OCR 文本、图片、Token、file path 或 data URI。

## 数据模型

一张小票：

```text
1 transactions
N transaction_items
```

`transaction_items` 由 `migrations/0003_transaction_items.sql` 创建，字段包含：

- id
- transaction_id
- name
- quantity
- unit_price_fen
- line_total_fen
- category
- confidence
- created_at

## 商品类别

MVP 使用：

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

小票总交易仍使用现有 transactions 顶层 category；细粒度统计使用 transaction_items.category。

## 金额核对

AI 不能直接写数据库。

Worker 计算：

```text
sum(items.line_total)
- discount
+ tax
+ rounding
```

并与 receipt.total_amount 比较。

允许最大误差：2 分。

不满足时：

- transaction 不写入
- transaction_items 不写入
- ingestion_log 进入 rejected/failed 终态
- Telegram 返回失败提示

## 置信度

当前阈值由 `src/receipt-job.ts` 执行：

- receipt confidence >= 0.80
- total confidence >= 0.90
- 单商品 confidence < 0.55 视为低置信商品
- 低置信商品比例不能超过 25%

## 幂等

source：

```text
telegram
```

source_id 基于：

```text
chat_id + Telegram file_unique_id
```

相同 Telegram 图片重复发送不会创建第二笔 transaction。

## 隐私

小票原图默认不持久化。

不得：

- 保存到 R2
- 保存到 D1
- 提交到 Git
- 长期保存 Telegram file URL
- 输出 Bot Token
- 输出图片 data URI

图片只存在于当次 Queue consumer 的内存处理周期内。

## 失败状态

关键失败均必须进入终态：

- `failed`
- `rejected`
- `parsed`

不允许正常情况下永久停留在 `processing`。

历史第一张真实小票曾由旧 waitUntil 实现遗留：

```text
receipt_1118263109_AQADeRVrG5iMyVR-
```

该历史记录应保留并标为 failed，不删除。

## 验收

最终真实 E2E 必须证明：

```text
Telegram photo
-> webhook accepted
-> Queue received
-> Telegram image downloaded
-> Workers AI returned parseable structured result
-> receipt validation
-> amount reconciliation
-> transactions + transaction_items
-> Telegram success reply
```

同时必须验证：

- 相同图片重复发送不重复入账
- 非小票图片不入账
- 文字记账不回归
- Obsidian sync 不回归
- 原图没有出现在 R2/D1/Git
