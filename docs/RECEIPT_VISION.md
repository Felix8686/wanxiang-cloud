# v0.3 Telegram 小票图片识别

## 目标

用户在 Telegram 中直接发送购物小票照片。万象云端在 Cloudflare 内完成图片下载、视觉识别、逐商品分类、金额核对和 D1 入账，不依赖本机 Hermes 常驻。

## 链路

```text
Telegram photo
  -> /telegram/webhook
  -> Telegram getFile / file download
  -> Workers AI Vision
  -> Worker 结构校验
  -> 金额 reconciliation
  -> D1 transactions + transaction_items
  -> Telegram 摘要回复
```

原有纯文字 Telegram 消息继续委托给 `src/index.ts`，v0.3 入口层为 `src/app.ts`，避免改写已经稳定的 v0.1/v0.2 核心逻辑。

## 视觉模型

默认：`@cf/google/gemma-4-26b-a4b-it`

配置变量：`RECEIPT_VISION_MODEL`

选择原则：Cloudflare-hosted、支持 Vision、多语言文档理解，并保持较低推理成本。模型不是硬编码到业务逻辑中，可在实测发现中文小票效果不足时通过 Wrangler 变量替换。

图片输入使用 Workers AI 支持的 multimodal message：`image_url` + data URI。图片只在当前 Worker 请求/后台任务生命周期内保留，不写 R2、不写 Git、不保存 Telegram file URL。

## Telegram 图片处理

1. 从 `message.photo` 中选择分辨率最大的 `PhotoSize`。
2. 使用 `file_id` 调用 Telegram `getFile`。
3. 下载实际图片。
4. 最大允许 8 MiB，避免 base64 后超过多模态请求的合理尺寸。
5. `caption` 会作为用户补充说明一起交给视觉解析器。
6. 视觉处理通过 `waitUntil()` 后台执行，Webhook 可以尽快返回 200，降低 Telegram 因视觉推理耗时而重试的概率。

### 幂等

同一图片使用稳定 source id：

```text
receipt_<chat_id>_<file_unique_id>
```

如果 `file_unique_id` 不存在，才退回 message/update id。

因此 Telegram webhook 重试、或同一用户再次发送完全相同的 Telegram 图片，都不会重复创建 transaction。

`ingestion_log` 同时作为处理锁：状态可为 `processing` / `parsed` / `rejected` / `failed`。

## 数据模型

Migration：`migrations/0003_transaction_items.sql`

一张成功小票对应：

- `transactions`：1 条总交易
- `transaction_items`：N 条商品明细

`transaction_items`：

- `id`
- `transaction_id`（FK -> transactions，ON DELETE CASCADE）
- `name`
- `quantity`（REAL，支持称重）
- `unit_price_fen`（可空）
- `line_total_fen`
- `category`
- `confidence`
- `created_at`

金额继续使用“分”落库，避免浮点污染。

## 商品分类

v0.3 明细分类固定为：

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

顶层 `transactions.category_id` 为兼容旧统计使用聚合映射：

- 食品/饮料/生鲜/零食 -> 餐饮
- 日用品/清洁用品/个护/家居 -> 日用品
- 其他类别 -> 其他支出

按明细金额占比最大的组确定顶层分类。精细统计以后应直接查询 `transaction_items.category`。

## 金额核对

视觉模型必须拆分：

- `items[].line_total`
- `discount_amount`（正数，表示优惠减少）
- `tax_amount`
- `rounding_amount`（可正可负）
- `total_amount`

Worker 计算：

```text
expected_total = sum(items.line_total)
               - discount
               + tax
               + rounding
```

与小票总额的误差最多允许 2 分。

超过误差：拒绝入账，并提示用户重新拍完整/清晰小票。

## 置信度安全门

自动入账要求：

- 整张小票 confidence >= 0.80
- 总金额 total_confidence >= 0.90
- 低于 0.55 的商品行不得超过全部商品的 25%
- 商品行数量 1-200
- 总金额 > 0

不满足时只返回失败提示，不创建 `transactions` 或 `transaction_items`。

普通图片必须输出 `is_receipt=false`，不会入账。

## 支付账户

视觉结果中的 `payment_method` 会尝试匹配已有 `accounts`：

- 支付宝
- 微信
- 现金
- 或完整支付方式文本

找不到已有账户时使用 `account-unspecified`，不会在视觉识别阶段擅自创建新账户。

## 隐私

默认不永久保存原始小票图片：

- 不写 R2
- 不写 D1
- 不写本地磁盘
- 不写 Git
- 不保存 Telegram file URL
- 不保存完整 OCR 原文

`transactions.raw_text` 对图片消息只保存用户主动填写的 caption（如有）。

## Telegram 成功回复

示例：

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

## MVP 限制

- 一次 Telegram message 处理一张图片；暂不把多张长小票照片自动拼接为同一张小票。
- 暂无按钮式逐行人工校对 UI。
- 图片模糊、反光、折叠、金额缺失时优先拒绝自动入账。
- 不永久保存原始小票，因此发生识别争议时需要用户重新发送照片。
- 视觉模型的真实中文小票效果必须由 Hermes 在 Cloudflare dev 环境和用户真实 Telegram 小票上继续验收。

## Hermes 验收重点

Hermes 只负责部署/调试/反馈，不负责重新设计业务逻辑。必须验证：

1. `0003_transaction_items.sql` 远程 migration。
2. Gemma 4 Vision 在当前 Cloudflare 账户可调用。
3. 中文超市小票逐行 OCR。
4. 多类别分类。
5. 金额核对通过/失败两条路径。
6. 普通图片拒绝。
7. 同一图片重复发送幂等。
8. 原文字记账和 Obsidian sync 回归。
9. 用户本人真实 Telegram 小票 E2E。
