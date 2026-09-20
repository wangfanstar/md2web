# 文本与资产分库存储设计方案（SQLite 双库）

> 状态：方案提案（本文件为分析结论与实施计划，尚未实现）。  
> 范围：把 Markdown 文本信息与图片/附件等二进制资产拆分到两个 SQLite 数据库，给出最易维护的落地方案。  
> 约束：Python 3.6.8 / SQLite 3.7.17（RHEL7）、完全离线、构建只读 `docs/md`、SVN 为外部事实源之一。

## 1. 结论（先给答案）

**推荐方案 A：文件是唯一事实源，数据库按生命周期分库——`content.sqlite3` 存文本与元数据，`assets.sqlite3` 存资产登记与二进制备份。**

- `docs/md/` 里的 `.md`、`images/`、`附件/` **保持为可浏览、可提交、可离线拷贝的物化形态**；
- 文本库负责账户、草稿、版本、发布、索引、审计、反馈等**高频小写入**；
- 资产库负责图片/附件的**登记（sha256 去重、引用关系、大小统计、SVN 状态）与可选二进制副本**，低频大写入；
- 两库各自独立迁移、备份、压缩，互不阻塞；跨库一致性由唯一写入口 `server/assets.py` 与对账工具保证。

**不推荐**把 Markdown 正文改成“只存在数据库、磁盘上不留文件”的方案 B（原因见第 3 节：会同时破坏 docsify 离线浏览、SVN 工作副本、构建只读约定与灾难恢复）。

## 2. 现状与问题

当前只有 `data/md2web.sqlite3` 一个库，混合了三类数据：

| 类别 | 现有表 | 写入频率 | 体积增长 |
|---|---|---|---|
| 文本与元数据 | `users/sessions/audit_events/drafts/revisions/operations/repo_bindings/repository_documents/document_snapshots/document_events/feedback` | 高（每次草稿、登录、发布） | 缓慢、可回收（草稿/审计有清理策略） |
| 资产（图片/附件） | 目前**不登记**：文件直接写在 `docs/md/<文档>/images|附件/`，提交时由 `documents.referenced_images/referenced_attachments` 解析 | 中（上传时） | 只增不减，单个 8–32 MB |
| 站点配置 | `config/server.local.json`（JSON 文件，不在库内） | 低 | 固定 |

问题：只要把资产二进制（哪怕只存副本）放进同一个库，库文件会随附件增长；SQLite 的 `VACUUM`、备份、校验都会随体积线性变慢，而文本侧的高频写入会被大文件拖累（写放大、备份窗口变长）。分库可以把“热而小”和“冷而大”彻底隔开。

## 3. 方案对比

| 方案 | 文本权威源 | 资产权威源 | 优点 | 致命缺点 | 结论 |
|---|---|---|---|---|---|
| A 文件 + 双库（文本库/资产库） | `docs/md` 文件（库内保存版本与索引） | `docs/md` 文件（库内登记与备份） | 与现有构建、SVN、离线快照完全兼容；库小、备份快；可对账可重建 | 需要一次分库迁移与对账工具 | **采用** |
| B 文本入库、文件仅物化 | `content.sqlite3` | `assets.sqlite3` | 强版本、原子编辑 | ① docsify 仍需文件，物化步骤等于让构建写 `docs/md`，违反“构建绝不修改 `docs/md`”；② SVN 仍以文件为工作副本，双事实源必冲突；③ `git` 历史、外部编辑器、`rsync` 备份全部失效；④ 库损坏即丢文档 | 不采用 |
| C 单库 + `asset_blobs` 表 | 文件 | 同库 | 改动最小 | 热库被大文件污染，备份/压缩变慢；没有解决用户诉求 | 不采用 |
| D 文本入库 + 资产文件（资产不登记） | `content.sqlite3` | 文件 | 文本侧强版本 | 同 B 的 ①②③④；资产无登记，无法统计/去重/清理 | 不采用 |

方案 A 的关键判断依据：**本项目的“事实源”不止数据库**——SVN、`docs/md` 文件、`offline-data.js` 离线快照、外部编辑器都直接读写文件。任何让文件降级为“缓存”的方案，都会与这些既有契约打架；而把数据库定位为“索引 + 版本 + 资产账本”，则每一项都能落地且可随时重建。

## 4. 推荐方案 A 的数据库划分

### 4.1 `data/content.sqlite3`（文本库，现有库改名沿用）

保留现有全部表与迁移（v1–v8），只做两件事：

1. **新增文档索引表**（可选，加速检索与统计）：

```sql
CREATE TABLE IF NOT EXISTS document_index (
  path TEXT PRIMARY KEY,            -- md/硬件设计/时钟树设计.md
  site TEXT,                        -- 仓库 id（多仓库站点）
  title TEXT,
  content_hash TEXT NOT NULL,       -- documents.text_hash
  size_bytes INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  revision INTEGER,                 -- 最近发布的 SVN revision（本地模式为 NULL）
  published_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_index_site ON document_index (site, path);
```

2. **新增资产引用表**（文本侧只记“引用了哪些资产”，不存二进制）：

```sql
CREATE TABLE IF NOT EXISTS asset_refs (
  document_path TEXT NOT NULL,      -- 引用方文档
  asset_path TEXT NOT NULL,         -- 相对文档目录的资产路径：images/x.png / 附件/手册.pdf
  kind TEXT NOT NULL,               -- image | attachment
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_path, asset_path)
);
```

### 4.2 `data/assets.sqlite3`（资产库，新增，独立迁移）

```sql
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL,             -- 内容指纹，用于去重与损坏检测
  kind TEXT NOT NULL,               -- image | attachment
  filename TEXT NOT NULL,           -- 落盘文件名（保留中文）
  mime TEXT,
  size_bytes INTEGER NOT NULL,
  blob BLOB,                        -- 可选：二进制副本（备份/迁移用，可为空）
  created_at TEXT NOT NULL,
  created_by TEXT,                  -- 用户 id / 匿名
  last_seen_at TEXT NOT NULL,       -- 对账时刷新
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_sha_kind ON assets (sha256, kind);

CREATE TABLE IF NOT EXISTS asset_locations (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  PRIMARY KEY (document_path, asset_path)
);
CREATE INDEX IF NOT EXISTS idx_asset_locations_asset ON asset_locations (asset_id);
```

独立版本号 `ASSET_SCHEMA_VERSION`（与 `SCHEMA_VERSION` 分离），迁移函数 `assets.migrate(conn)` 只使用 SQLite 3.7.17 可解析语法（基础 `CREATE TABLE/INDEX`，不用部分索引、UPSERT、CTE）。

### 4.3 落盘位置与事实源

| 数据 | 权威位置 | 库内角色 |
|---|---|---|
| Markdown 正文 | `docs/md/**/*.md` | `drafts/revisions` 版本历史 + `document_index` 索引 |
| 图片 | `docs/md/<文档目录>/images/*` | `assets` 登记 + 可选 `blob` 备份 |
| 附件 | `docs/md/<文档目录>/附件/*` | 同上 |
| 配置 | `config/server.local.json` | 不入库 |

## 5. 实施步骤（每步可独立提交、可回滚）

1. **第 1 步（低风险，先行）**：新增 `server/assets.py`（打开/迁移/登记/查询/对账）、`ASSET_DB_NAME = "assets.sqlite3"`；图片与附件上传成功后调用 `assets.register()`（计算 sha256、写 `assets` + `asset_locations`，可选 `blob` 副本按配置开关 `assets.storeBlobs`）。文本库新增 `asset_refs`（迁移 v9），发布/提交时刷新。
2. **第 2 步**：配置页新增“资产”统计（图片/附件数量、总大小、孤儿文件、缺失文件）与“重建资产登记”（扫描 `docs/md` 全量对账）按钮；`GET /__admin/assets`、`POST /__admin/assets/rebuild`。
3. **第 3 步**：把配置页的文件夹大小统计改为资产库聚合查询（避免每次递归扫描 `docs/md`）；`document_index` 接管首页“最新更新”与搜索索引增量更新。
4. **第 4 步（可选）**：`assets.blob` 作为离线备份与迁移载体：`GET /__admin/assets/export` 导出单文件包（SQLite + 清单），支持在另一台机器 `import` 恢复；`docs/md` 缺失时可由资产库重建附件文件。
5. **第 5 步（可选，仅本地模式）**：若用户坚持“正文以库为准”，只对 `sourceMode=local` 且 `allowCommit=false` 的仓库启用“库→文件”单向物化（由 `serve.py` 后台任务执行，**不放进构建**），SVN 仓库永远保持文件优先。

## 6. 一致性与维护规则

1. **唯一写入口**：所有资产登记/删除走 `server/assets.py`；调用方不得直接写 `assets.sqlite3`。
2. **锁与事务**：两个库共用 `AuthService._db_lock` 串行化；SQLite 事务不跨越 SVN 网络调用（沿用现有约定）。
3. **对账工具**：`assets.reconcile()` 双向核对——文件存在但无登记 → 补登记；登记存在但文件缺失 → 标记 `missing=1` 并上报；`asset_locations` 与 `asset_refs` 不一致 → 以文件解析（`documents.referenced_images/referenced_attachments`）为准。
4. **备份**：文本库保持现有 `database.backup_to`（频繁、体积小）；资产库单独备份（频率可低，`blob` 为空时只需备份登记，秒级完成）。
5. **损坏恢复**：文本库损坏 → 从 `docs/md` 重建 `document_index/asset_refs`（文档不丢）；资产库损坏 → 扫描 `docs/md` 重建登记（附件不丢）。这是方案 A 相对方案 B 的最大维护优势。
6. **兼容**：两库均面向 SQLite 3.7.17；新增迁移必须通过 `DatabaseTests` 的兼容检查。

## 7. 迁移与验收

- 迁移脚本 `python serve.py --migrate-assets`（一次性）：创建 `assets.sqlite3`、全量扫描 `docs/md`、登记现有图片/附件、回填 `asset_refs`，输出统计报告。
- 验收标准：
  1. 文本库体积不随附件增长（上传 100 MB 附件后 `content.sqlite3` 体积不变）；
  2. 资产登记可重建（删除 `assets.sqlite3` 后重建，数量与大小一致）；
  3. 提交 SVN 仍随带 `images/` 与 `附件/`（现有测试 `test_commit_includes_referenced_images/attachments` 保持通过）；
  4. `file://` 离线浏览与 docsify 静态分发不受影响（文件始终在 `docs/md`）。

## 8. 工作量与风险

| 项 | 估计 | 风险 |
|---|---|---|
| 第 1 步 | 0.5–1 天 | 低：只新增代码路径，不改现有读写 |
| 第 2–3 步 | 1–2 天 | 中：统计口径变化，需要与现有配置页对齐 |
| 第 4 步 | 1–2 天 | 中：导入导出需要幂等与校验 |
| 第 5 步 | 2–3 天 | 高：会触碰“构建只读”约定，默认不启用 |

结论：按第 1 步起步即可获得“文本库/资产库分离”的全部维护收益，后续步骤按需推进；任何时候都能用文件重建数据库，不存在单向依赖。
