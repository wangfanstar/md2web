# 仓库来源模式（本地 SQLite / SVN）设计方案

> 状态：方案提案，尚未实现。  
> 范围：`md2web_config.html` 中仓库的来源模式切换、无 SVN 仓库的本地 SQLite 管理、SVN 仓库定时同步、冲突提醒与恢复。

## 1. 目标与原则

每个 `docs/md` 子目录作为一个独立的“仓库绑定”，支持两种来源模式：

| 模式 | 权威来源 | SQLite 的职责 | `docs/md` 的职责 |
|---|---|---|---|
| `local` 本地模式 | SQLite 中的文档正文与版本 | 保存正文、版本、差异、账户操作和发布记录 | SQLite 的可读写物化目录，供构建和离线浏览 |
| `svn` SVN 模式 | 配置的 SVN 目标路径 | 保存远端快照、revision、差异、账户操作和同步状态 | SVN 的发布镜像，不能作为独立主库 |

核心原则：

1. 同一时刻只有一个权威来源，禁止 SQLite 与 SVN 双向自动覆盖。
2. SVN 模式下始终先读取或提交 SVN，再把已经确认的结果写入 SQLite 和 `docs/md`。
3. 本地模式下先写 SQLite，再原子发布到 `docs/md`；文件系统上的直接修改不能悄悄覆盖数据库。
4. 切换模式必须是管理员操作，切换前完成一次一致性检查、备份和明确的导入方向选择。
5. 同步、切换、网页提交按仓库串行执行；SQLite 事务不跨越 SVN 网络调用。
6. 所有发布使用 staging 目录和原子替换，失败时保留上一个可浏览版本。

## 2. 当前代码差距

现有代码已经具备以下可复用能力：

- `server/config.py` 已有多仓库 `id/mount/url/syncIntervalSeconds/readOnly/allowCommit` 配置和最长目录前缀匹配。
- `server/operations.py` 已有 `repo_bindings`、SVN 检出/导出、远端 revision、定时同步、发布和冲突状态。
- `server/database.py` 已有 `repo_bindings`、`drafts`、`revisions`、`operations`、`document_snapshots`、`document_events` 和审计表。
- `md2web_config.html` 已有仓库映射、更新频率、只读/允许合入和“创建并拉取”入口。

需要补齐的关键能力：

- `repositories[].url` 当前必须填写，不能表达本地模式。
- SQLite 当前的 `document_snapshots` 主要记录文件大小和 mtime，没有保存本地模式所需的完整 Markdown 正文。
- 同步线程需要跳过 `local` 仓库，并把“模式切换”纳入仓库操作队列。
- 配置页需要显示来源模式、当前权威来源、最后同步/发布状态和冲突处理入口。

## 3. 推荐配置模型

在每个仓库配置中增加 `sourceMode`，取值严格为 `local` 或 `svn`：

```json
{
  "id": "hardware",
  "mount": "md/硬件设计",
  "sourceMode": "svn",
  "url": "https://svn.example.invalid/svn/hardware/trunk/docs/",
  "credential_group": "engineering",
  "syncIntervalSeconds": 120,
  "readOnly": false,
  "allowCommit": true,
  "group": "硬件"
}
```

本地模式示例：

```json
{
  "id": "team-notes",
  "mount": "md/团队笔记",
  "sourceMode": "local",
  "url": "",
  "syncIntervalSeconds": 0,
  "readOnly": false,
  "allowCommit": false,
  "group": "本地文档"
}
```

校验规则：

- `sourceMode` 缺省时，为兼容旧配置按 `svn` 处理；旧配置的非空 `url` 不改变行为。
- `local` 模式必须拒绝非空 SVN URL，或在保存时提示管理员清空；不保存“看似启用但不参与同步”的 URL。
- `svn` 模式必须有 `http/https` URL；URL 不允许指向 `docs/` 内部路径。
- 同一 `mount` 只能有一个绑定；嵌套目录继续使用最长目录段匹配。
- `syncIntervalSeconds=0` 只对 SVN 模式表示关闭自动同步；本地模式统一视为不适用。
- `allowCommit` 在本地模式显示为“允许网页发布到本地源”，在 SVN 模式显示为“允许提交 SVN”，避免同一字段产生误解。

## 4. SQLite 数据模型

### 4.1 扩展 `repo_bindings`

新增一次迁移（建议 v6）：

| 字段 | 说明 |
|---|---|
| `source_mode` | `local` / `svn`，非空，默认 `svn` |
| `source_revision` | 本地模式的 SQLite 版本号，或 SVN revision |
| `source_hash` | 当前权威来源的受管文件清单 hash |
| `pending_mode` | 正在进行的切换目标模式，空表示无切换 |
| `sync_state` | `idle/running/conflict/failed/switching` |
| `last_success_at` | 最近一次成功同步或本地发布时间 |
| `last_error_code` | 稳定错误码，供前端显示和统计 |

已有 `repository_uuid/root_url/target_url/published_revision` 在本地模式下保留为空或最后一次 SVN 身份信息，不作为本地模式的权威依据。

### 4.2 新增 `repository_documents`

该表保存仓库绑定下受管 Markdown 的完整正文，是本地模式的主数据，也是 SVN 模式的远端快照缓存：

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `binding_id` | 关联 `repo_bindings` |
| `path` | 相对 mount 的规范化路径 |
| `content` | UTF-8 正文 |
| `content_hash` | 正文 hash |
| `eol` | `LF/CRLF/CR`，发布时保持 |
| `source_revision` | 保存该内容时对应的本地版本或 SVN revision |
| `state` | `published/deleted/conflict` |
| `updated_at` | 最后更新时间 |

唯一键为 `(binding_id, path)`。图片等二进制资源不塞入正文表，沿用现有受管图片发布流程；如需完整离线回滚，另存资源 hash、大小和相对路径清单。

### 4.3 新增 `source_events`

记录来源变更和同步过程，避免把 SVN 日志误当成网页编辑历史：

```text
id, binding_id, operation_id, mode, event_type,
path, before_hash, after_hash, base_revision, target_revision,
actor_id, detail, created_at
```

`event_type` 至少包括 `local_publish`、`svn_sync`、`svn_commit`、`mode_switch`、`conflict`、`recovery`。正文差异继续复用现有 `revisions.unified_diff`；跨来源同步只保存必要的基线 hash/revision 和受管文件清单。

### 4.4 事务边界

- SQLite 事务只负责写入快照、版本、状态和审计；绝不在事务内执行 SVN 命令。
- SVN 模式的“远端已确认 → SQLite 快照 → 本地物化目录”分为可恢复阶段，`operation_id` 贯穿全过程。
- 本地模式的“SQLite 提交 → `docs/md` 发布 → 索引重建”也使用状态机，重启后按 hash 判断是否需要重放。
- 迁移必须保持 SQLite 3.7.17 兼容，不使用 UPSERT、CTE、窗口函数、生成列或 RETURNING。

## 5. 本地模式流程

### 5.1 首次建立本地仓库

管理员在配置页选择“本地模式”后：

1. 服务扫描该 mount 下现有 Markdown，并生成文件清单。
2. 若目录为空，创建本地绑定并初始化 SQLite 记录。
3. 若目录已有文件，必须选择“导入现有文件到 SQLite”；导入前显示数量、hash 和异常编码。
4. 导入成功后，以 SQLite 版本 1 为基线，再生成 `docs/md` 的物化标记。

不会自动删除现有文件，也不会把目录中的 `.svn` 当成普通文件导入。

### 5.2 网页编辑与发布

1. 登录用户编辑草稿，现有 `drafts/revisions` 保存账户、版本和差异。
2. 管理员或具备发布权限的用户点击“发布到本地源”。
3. 服务校验草稿基线仍等于 `repository_documents` 当前 hash。
4. 在 SQLite 短事务中写入新正文、diff、版本和 `source_events`。
5. 从 SQLite 生成 staging 目录，校验清单后原子更新 `docs/md`，触发一次构建。
6. 构建成功后将 `source_revision`、`source_hash` 和 operation 状态置为完成；构建失败保留旧镜像并标记可重试。

### 5.3 发现人工修改

后台 watcher 发现 `docs/md` 与 SQLite hash 不一致时，不自动覆盖：

- 状态标为 `local_external_change`；
- 页面显示“目录文件已偏离 SQLite”；
- 管理员可选择“导入为新版本”或“恢复 SQLite 版本”；
- 两个动作都要生成事件和差异，不能静默抹掉文件。

## 6. SVN 模式流程

### 6.1 定时同步

每个 SVN 仓库按自身 `syncIntervalSeconds` 进入队列，同一仓库同时只允许一个同步/提交/切换任务：

```text
读取 svn info
    ├─ revision 未变化 → 记录检查时间，结束
    └─ revision 变化
         ↓
      导出到 staging（不改 docs/md）
         ↓
      校验 URL/UUID、UTF-8、路径边界、受管清单
         ↓
      比较当前发布 hash、远端快照、活动草稿
         ├─ 有冲突 → 保留旧发布，记录冲突并提醒
         └─ 无冲突 → 更新 SQLite 快照，再原子发布 docs/md，再重建
```

具体顺序为：

1. 获取目标库 `svn info --xml`，确认 URL、UUID 和远端 revision。
2. 导出目标路径到唯一 staging；下载失败或内容校验失败时不改任何已发布文件。
3. 将远端文件与 `repository_documents` 快照比较，生成增删改清单和 diff。
4. 检查网页活动草稿、服务机外部修改和嵌套仓库边界。
5. 无冲突时，在 SQLite 中写入远端快照和 `source_revision`，随后原子发布 `docs/md`。
6. 发布和构建成功后写入 `published_revision/last_success_at`；索引重建只执行一次。
7. 任一阶段失败，保留上一份可读版本，写入 `last_error_code`，支持“重试同步”而不是重新提交 SVN。

### 6.2 SVN 提交

网页提交必须遵守：


1. 从 SQLite/草稿冻结待提交清单和基线 revision。
2. 在私有工作副本中执行 update、冲突检查和精确文件 diff。
3. 以当前登录账号提交 SVN；SVN 成功后取得实际 revision。
4. 立即从该 revision 重新导出并核对内容，不以浏览器提交正文代替 SVN 结果。
5. 将已确认的 SVN 快照写入 `repository_documents`，再发布到 `docs/md`。
6. SVN 成功但 SQLite/发布失败时标记 `svn_committed` 或 `uncertain`，后续只做核对与发布恢复，禁止重复 commit。

SQLite 不是 SVN 提交的事务回滚点；服务必须明确展示“SVN 已提交、站点待同步”的中间状态。

## 7. 冲突分类与用户处理

冲突要给出可操作原因、三方内容和下一步按钮：

| 冲突码 | 触发条件 | 处理方式 |
|---|---|---|
| `remote_changed_with_draft` | SVN 远端已更新，网页草稿仍基于旧 revision | 展示基线/远端/草稿三方 diff；用户合并后重新保存、提交 |
| `local_external_change` | 本地模式的 `docs/md` 与 SQLite hash 不同 | 选择导入或恢复，保留原文件 hash 和事件 |
| `svn_worktree_modified` | 服务工作副本有未受管修改 | 暂停同步，提供查看、清理或重建工作副本 |
| `mode_switch_conflict` | 切换目标中的内容与当前权威内容不一致 | 先完成一次显式导入/覆盖选择，不允许直接切换 |
| `remote_deleted_with_draft` | SVN 删除文档但网页仍有草稿 | 保留草稿并标记源文件已删除，用户选择恢复或放弃 |
| `source_unavailable` | SVN 暂时不可达或认证失败 | 保留旧发布和 SQLite 快照，显示上次成功 revision |

冲突状态下：

- 自动同步只重试读取和健康检查，不自动覆盖、不自动合并；
- 其他仓库继续服务，不因一个仓库阻塞全站；
- 设置页和文档页显示仓库级提示，编辑器显示文档级提示；
- 解决冲突后由用户点击“重新同步/重新提交”，并产生新的 operation。

## 8. 模式切换设计

切换是管理员专用的长操作，配置页不能只修改一个下拉框就立即生效。流程状态：

```text
requested → validating → staging → awaiting_choice
    ├─ import_current → publishing → completed
    ├─ replace_with_target → publishing → completed
    └─ cancelled / failed / conflict
```

### 8.1 `local → svn`

1. 校验 URL、SVN 登录/只读访问、UUID 和目标路径。
2. 将 SQLite 当前版本导出到 staging，并计算本地文件清单。
3. 读取 SVN 目标现状；目标非空时必须显示三方差异。
4. 管理员二选一：
   - **以本地内容初始化 SVN**：只提交明确清单，提交成功后以实际 revision 回填 SQLite；
   - **以 SVN 内容替换本地**：先导出 SVN，再覆盖 SQLite 和 `docs/md`，本地版本保留在切换备份中。
5. 完成后设置 `source_mode=svn`，启用该库的定时同步。

不允许把本地正文和 SVN 正文直接拼接后自动提交；需要合并时先生成草稿，人工审核后再执行上述流程。

### 8.2 `svn → local`

1. 先执行一次强制 SVN 同步，获取最新 revision。
2. 若有活动草稿、未发布操作或工作副本冲突，切换暂停并提示处理。
3. 把最新 SVN 快照作为本地 SQLite 版本基线，生成切换前备份和 `source_events`。
4. 设置 `source_mode=local`，关闭自动 SVN 同步；保留 URL/UUID 作为历史信息，但不再作为当前权威来源。
5. 后续编辑走 SQLite 发布流程。再次切回 SVN 时，必须重新做 URL/UUID 检查和导入方向选择。

切换失败或服务重启时，按 `pending_mode` 和 operation 状态恢复；在恢复完成前不改变对外显示的权威模式。

## 9. `md2web_config.html` 交互方案

仓库编辑卡片建议按以下顺序显示：

1. **仓库标识**：名称、挂载目录、分组。
2. **来源模式**：`本地 SQLite` / `SVN 仓库` 单选，旁边显示“当前权威来源”。
3. **模式相关字段**：
   - 本地模式：SQLite 文档数、版本号、最后发布、外部修改数；
   - SVN 模式：URL、凭据组、自动更新频率、最后 revision、最后成功同步。
4. **健康状态**：正常、同步中、冲突、认证失败、待切换。
5. **操作**：保存配置、立即同步、查看差异、处理冲突、切换来源、备份/恢复。

切换弹窗必须展示：当前模式、目标模式、当前 hash/revision、目标状态、将覆盖的文件数量、备份位置和预计影响。确认按钮使用明确文案，如“以 SVN 覆盖本地 12 个文件”，不使用模糊的“确定”。

匿名用户只读；普通登录用户查看本人草稿和被授权的同步状态；管理员才能修改模式、URL、频率、凭据组和执行切换。

## 10. API 与后台任务边界

建议新增或扩展以下接口，保持现有 CSRF、会话和管理员守卫：

| 接口 | 行为 |
|---|---|
| `GET /__config` | 返回 `sourceMode`、健康状态、revision/hash 摘要，不下发口令 |
| `PUT /__config` | 校验并保存配置；模式变化只创建切换任务，不直接覆盖文件 |
| `POST /__admin/repository/switch` | 创建模式切换 operation，返回 `operationId` |
| `POST /__admin/repository/sync` | 仅 SVN 模式执行立即同步；本地模式返回“不适用” |
| `GET /__admin/repository/status` | 返回同步、冲突、快照和待处理操作 |
| `POST /__admin/repository/resolve` | 提交管理员选择的导入/恢复/重试动作 |
| `GET /__admin/repository/diff` | 返回模式切换或同步的受限三方差异 |

后台线程只负责到期入队和状态收集；实际同步由每仓库串行 worker 执行。服务启动时恢复 `running/switching/uncertain` 状态，先核对远端和 hash，再决定继续发布、标记失败或要求人工处理。

## 11. 备份、回滚与数据保留

- 每次模式切换前备份 SQLite、配置文件、受管文件清单和当前 `docs/md` 快照。
- 本地模式至少保留最近 N 个 SQLite 版本和每次发布 diff；N 作为管理员可配置的保留策略，默认 50。
- SVN 模式默认不把完整 SVN log 导入 SQLite，只保存同步事件、revision、hash 和网页操作；SVN 日志仍实时查询。
- 备份目录必须位于 `docs/` 外，并禁止静态分发；文件名包含仓库 id、模式、revision/版本和时间。
- 回滚本地模式只回滚 SQLite 版本，再重新物化 `docs/md`；回滚 SVN 模式只恢复到可确认的旧快照并生成新的 SVN 提交，不直接修改 SVN 历史。

## 12. 实施顺序与验收标准

建议拆成四个可独立验证的阶段：

1. **配置和迁移**：增加 `sourceMode`、v6 数据库迁移、兼容旧 SVN 配置。
2. **本地模式**：正文快照表、导入、网页发布、外部修改提醒、恢复。
3. **SVN 同步收口**：定时任务按模式分流，staging、快照回填、冲突状态和不重复提交。
4. **配置页与模式切换**：管理员交互、切换 operation、三方差异、备份恢复。

验收必须覆盖：

- 旧配置启动后仍按 SVN 模式工作；本地模式不调用任何 SVN 命令。
- 本地模式重启后能从 SQLite 恢复正文，`docs/md` 与数据库 hash 一致。
- SVN 远端更新时先写 staging，冲突时旧页面继续可读且有明确提示。
- SVN 成功提交后，SQLite 记录实际 revision；网络中断不会自动重复 commit。
- `local ↔ svn` 两个方向均要求显式选择导入方向，切换失败可恢复，原内容可追溯。
- 多仓库、嵌套 mount、只读/禁止提交、活动草稿和外部文件修改均有测试。
- Python 3.6 语法、SQLite 3.7.17 兼容、全量服务测试和离线构建通过；`docs/md` 内容不被构建修改。

## 13. 推荐结论

采用“**每仓库一个来源模式 + SQLite 统一记录 + `docs/md` 物化发布 + SVN 单向权威同步**”方案。它复用现有认证、草稿、操作状态机和 SVN 封装，新增表和状态有限；同时把最容易造成数据丢失的“双主库自动合并”改成管理员可审计的显式切换。对于工程师日常使用，SVN 仓库继续以 SVN 为准，本地无 SVN 文件也能获得同样的版本、差异、审计和回滚能力，后续切换来源时不需要迁移整套编辑器或搜索构建流程。
