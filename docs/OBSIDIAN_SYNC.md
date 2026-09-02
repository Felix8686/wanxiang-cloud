# Obsidian 与 Cloudflare R2 云端同步规范 (v0.2 MVP)

## 1. 核心架构与云端主库原则

- **云端主库 (Cloud as Single Source of Truth)**：Cloudflare R2 + D1 是权威的云端数据层。结构化账目、同步索引与版本元数据存于 D1；实际 Markdown 与附件文件存于 R2。
- **本地工作副本 (Local Working Copy)**：本地 Obsidian Vault 只是编辑与查看的工作副本，不与云端平级，不建立“双主库”。
- **D1 / R2 分工**：
  - **D1（`sync_files` 表）**：维护文件路径索引、`object_key`、`version`（乐观并发版本号）、`content_hash`（SHA-256）、`size_bytes`、`modified_at`、`last_source`（最后操作来源）、`is_deleted`/`deleted_at`（安全软删除标记）、`created_at`/`updated_at`。
  - **R2（bucket `wanxiang-cloud-dev-files`，binding `FILES`）**：保存文件本体（`notes/*.md` 与 `attachments/*`），Worker 同步 API 不做物理硬删除。
  - **不迁移范围**：`transactions`、`accounts`、`categories`、`ingestion_log` 等账目/结构化数据继续只存 D1，不放入 R2。

## 2. 存储与 Object Key 映射规则

采用稳定、可预测的前缀映射（避免中文路径与复杂层级在对象存储中的编码歧义）：

- Markdown 笔记：`notes/<relative-path>`（本地 `A.md` → `notes/A.md`）
- 附件与媒体：`attachments/<relative-path>`（本地 `attachments/pic.png` → `attachments/pic.png`）
- 本地同步状态目录：`<vault>/.wanxiang-sync/sync-state.json`（**不**上传）
- 忽略清单：`.git/`、`.obsidian/cache/`、`.trash/`、`node_modules/`、`.DS_Store`、`thumbs.db`、`*.tmp`、`*.temp`、`*.swp`、`*~`、`*.conflict-<timestamp>.*` 备份副本、`.wanxiang-sync/`

## 3. Worker 同步 API（全部需 Bearer 鉴权）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/sync/list?include_deleted=true|false` | 列出同步文件（默认隐藏已软删除） |
| GET | `/v1/sync/metadata?path=<rel>` | 获取单个文件 metadata |
| GET | `/v1/sync/file?path=<rel>` | 下载文件本体 |
| PUT/POST | `/v1/sync/file` | 上传/更新文件（带冲突检测头） |
| DELETE | `/v1/sync/file?path=<rel>` | 软删除（tombstone，R2 对象保留） |
| POST | `/v1/sync/restore` `{"path": ...}` | 恢复软删除文件 |

上传请求通过 `X-Wanxiang-Path`、`X-Wanxiang-Base-Version`、`X-Wanxiang-Base-Hash`、`X-Wanxiang-Modified-At`、`X-Wanxiang-Source` 头携带基线信息。无 `Authorization: Bearer` 一律返回 401，匿名读写被禁止。

## 4. 同步流程与冲突机制

1. 本地 CLI 扫描 Vault（排除忽略清单），读取 `.wanxiang-sync/sync-state.json` 中每个文件上次成功同步的 `lastSyncedHash` / `lastSyncedVersion`。
2. `push`：本地有、云端无 → 新建（version 1）；本地有、云端有 → 携带 base version/hash 上传，云端校验基线。
3. `pull`：云端有、本地无 → 下载写入本地并更新状态。
4. `sync`：先 `status` 得出差异，再按方向执行 push/pull。
5. **冲突判定（不静默覆盖）**：当云端文件自本地上次同步后变化（云端 `version` 或 `content_hash` 与客户端基线不同），同时本地文件也修改过，则：
   - 上传请求被 Worker 拒绝并返回 `409 CONFLICT`（`error: CONFLICT`），云端内容保持不变；
   - 本地 `sync`/`status` 将该文件标记为 `conflict`，自动把本地编辑复制为 `<name>.conflict-<timestamp>.<ext>` 备份，绝不丢弃本地编辑。
6. 内容完全一致时返回 `FILE_UNCHANGED`，不产生无意义版本递增。

## 5. 安全软删除与恢复

- 删除只做 **soft delete / tombstone**：D1 置 `is_deleted=1` 并写 `deleted_at`、`version` 自增；R2 对象继续保留，任何 API 都不物理删除对象。
- 默认列表（`include_deleted=false`）隐藏已删除文件；如需查看可带 `include_deleted=true`。
- 误删后通过 `restore` 恢复：校验 R2 对象仍存在，然后清 `is_deleted`/`deleted_at` 并递增 version。

## 6. 本地同步工具（CLI）

路径：`local/obsidian-sync/`，纯按需执行，不依赖常驻守护进程，可由用户、Hermes 或计划任务随时调用。运行依赖 `tsx`（已加入 devDependencies）。

### 环境变量

| 变量 | 说明 |
|---|---|
| `OBSIDIAN_VAULT_PATH` | 本地 Vault 绝对路径 |
| `WANXIANG_SERVER_URL` | Worker 地址（默认 `https://wanxiang-cloud-dev.mzer8-substracker.workers.dev`） |
| `WANXIANG_API_KEY` | Bearer Token（与 Worker secret `WANXIANG_API_KEY` 一致） |

也可用 `--vault`、`--server`、`--token` 覆盖。绝对路径不写死在代码中。

### 命令

```bash
npx tsx local/obsidian-sync/index.ts status [--vault <path> --server <url> --token <key>]
npx tsx local/obsidian-sync/index.ts sync [--dry-run] [--vault ... --server ... --token ...]
npx tsx local/obsidian-sync/index.ts push [file-path] [--force] [--dry-run] [--vault ...]
npx tsx local/obsidian-sync/index.ts pull [file-path] [--dry-run] [--vault ...]
npx tsx local/obsidian-sync/index.ts delete <file-path> [--dry-run] [--vault ...]
npx tsx local/obsidian-sync/index.ts restore <file-path> [--dry-run] [--vault ...]
```

- `status`：显示每个文件状态：`synced` / `local_only` / `cloud_only` / `modified_local` / `modified_cloud` / `conflict` / `deleted_cloud`。
- `sync --dry-run` / `push --dry-run`：只模拟并打印将要执行的动作，不写入云端、不写本地文件、不更新状态库。
- `delete`：软删除云端文件；`restore`：恢复。
- `--force`：push 时跳过基线版本校验（慎用；仅用于已知单向覆盖场景）。

### 本地状态文件

`<vault>/.wanxiang-sync/sync-state.json` 记录每个文件上次成功同步的 hash/version/时间，是冲突检测与增量同步的依据。CLI 失败时不会破坏该状态，可安全重试。

## 7. 恢复方法

- **本地文件丢失/损坏**：`pull <file-path>` 从云端下载恢复；整库恢复可先清空 Vault 内容（保留 `.wanxiang-sync`）再执行 `pull`。
- **云端误删（soft delete）**：`restore <file-path>` 恢复，文件内容在 R2 中始终保留。
- **本地与云端冲突**：本地编辑已自动备份为 `*.conflict-<timestamp>.*`；人工比对后，把需要的版本写回原文件再执行 `push`/`sync` 收敛。
- **状态库损坏**：删除 `<vault>/.wanxiang-sync/sync-state.json` 后重新 `status`——云端与本地差异会重新完整列出，不会丢失任何一侧文件。
- **整库重建**：新机器配置三个环境变量后，`pull` 即可从云端主库拉取全部文件。

## 8. 已实测验证清单（2026-09-02，独立测试 Vault）

1. 本地新建 A.md → `push` → 云端存在（v1）✅
2. 云端新建 B.md → `pull` → 本地出现 ✅
3. 本地修改 A.md → `sync` → 云端更新（v2）✅
4. 云端修改 B.md → `sync` → 本地更新（v2）✅
5. 本地与云端同时修改同一文件 → Worker 返回 `409 CONFLICT`，云端未被覆盖；本地生成 `*.conflict-*.md` 备份 ✅
6. `--dry-run` → 无任何实际写入/删除 ✅
7. 附件（`attachments/pic.png`）→ push 成功，pull 后 SHA-256 一致 ✅
8. soft delete → `is_deleted=1` + tombstone，默认列表隐藏 ✅
9. restore → 文件恢复 active ✅

## 9. 当前 MVP 限制

1. **三方自动合并**：v0.2 对冲突不做逐行 3-way merge，仅自动生成本地带时间戳的 conflict 副本供人工比对。
2. **大文件**：单文件最大建议 100MB 以内；未做分片上传。
3. **实时监听**：按需执行模式，暂无本地文件系统实时监控（后续桌面端/插件层集成）。
4. **多设备收敛**：云端版本冲突需要人工/后续版本合并；MVP 保证“绝不静默覆盖”。
