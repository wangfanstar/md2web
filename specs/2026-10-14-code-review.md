# md2web 代码审查报告（重点：SVN）

- 审查日期：2026-10-14。
- 基线：`aa94f8873d7c9555433693f59f86cedbf742002a`，审查开始时工作区干净。
- 原始审查发现 **9 项问题（6 项 P1、3 项 P2）**，以及 3 项 Node 测试失败；后续已逐项修复，最终验收见文末。
- 本文前半部分保留原始审查证据；用户随后授权修复，修复结果见文末。未向真实 SVN 提交测试内容。

## 范围与验证边界

以整个仓库为审查范围，重点人工检查 `server/svn.py`、`operations.py`、`svn_update.py`、`entries.py`、`auth.py`、`app.py` 的认证、提交、同步、备份和并发路径；同时抽查配置方案、仓库删除/恢复、Markdown 路径校验、参考文献文件操作、静态访问限制和前端配置/工作台/搜索入口，并执行全量现有测试。

这不是对每一行代码、第三方压缩库及所有部署环境的形式化验证。没有连接真实 SVN 服务，没有执行真实 RHEL7 客户端、浏览器端到端操作、进程崩溃或磁盘故障压力测试。动态复现使用 Python 3.6.8、临时目录、临时 SQLite 数据库及假 SVN 客户端；不会读取真实仓库凭据。静态确认的问题与动态复现的问题分别注明。

## R1 · P1：提交旧草稿会覆盖他人已经提交的远端修改

**位置**：`server/operations.py:453`、`:512`、`:519`、`:555`（`prepare_commit` / `run_commit`）。

准备提交时保存了 `basePublishedHash`，但执行提交时没有使用它检查远端基线。`run_commit` 检出并更新到最新文件后，直接把草稿全文写入工作副本，再提交。只要他人的修改发生在本次 `svn update` 之前，工作副本就是最新版本，SVN 自身的过期版本检查不会阻止覆盖。

**动态复现**：本地旧文档上保存草稿并 prepare；假 SVN 的 update 返回 `SOMEONE ELSE NEW REMOTE`；执行 run_commit。实际提交内容是 `MY OLD-BASE DRAFT`，返回 `published`，没有冲突提示。

**影响**：多人编辑时可静默丢失他人的 SVN 修改。前端先显示差异不能代替服务端提交前校验。

**建议**：保存草稿创建时的基线内容/hash及远端版本；在写工作副本前比较远端实际内容与冻结的基线，不一致返回 409 和合并信息。比较通过后仍保留 SVN 提交时的版本检查，覆盖检查与提交之间的竞态。补充“远端先变更、旧草稿后提交”的回归测试。

## R2 · P1：单文件提交错误地推进整库同步水位，其他文档可能一直保持旧版本

**位置**：`server/operations.py:592`、`:617`、`:1402`。

`publish_committed` 仅发布一个文档，却把仓库级 `published_revision` 提升到该提交版本。后续 `sync_binding` 在远端版本小于等于这一水位时跳过整个仓库导出。如果其他文档此前已经在远端更新，但本地尚未同步，这些变化会被漏掉。

**动态复现**：本地另一个文件仍是旧内容；调用 publish_committed 发布当前文件至 r12；远端 info 返回 r12。sync_binding 返回 `updated=False`，另一个文件仍旧。

**影响**：显示同步成功但站点内容不完整；远端没有后续提交时会持续漏更新。手动单文件更新已避免推进整库水位，但普通提交路径仍有此问题。

**建议**：分离“单文档已发布版本”和“整库完整快照版本”。只有完整同步成功后推进整库水位；单文件提交只更新文档元数据。

## R3 · P1：自动同步未隔离嵌套仓库，也未拒绝目标目录中的软链接

**位置**：`server/operations.py:1424`–`:1447`；对比 `server/svn_update.py:56`–`:66`。

自动同步把导出目录中每一个 `.md` 直接映射到父仓库挂载目录，没有按最长挂载路径重新检查文件所属仓库，也没有检查目标路径祖先是否为软链接。手动更新实现了这些检查，但自动同步没有复用。

**动态复现**：配置父 SVN 库 `md/repo` 和嵌套本地库 `md/repo/nested`；父库导出包含 `nested/a.md`。自动同步实际写入了嵌套本地库。

**静态确认的扩展影响**：若目标的中间目录是链接，`target.parent.mkdir` 和临时文件写入会沿链接写入目标目录。此扩展场景未在本机建立链接实测。

**建议**：自动/手动同步共用经过校验的发布清单，检查最长匹配仓库、隐藏目录/回收站、源链接及目标祖先链接，校验全部通过后才发布。

## R4 · P1：已有挂载切换 SVN 地址后，自动同步绕过仓库身份检查

**位置**：`server/operations.py:354`、`:1389`–`:1402`。

`_binding_row` 只按 mount 查询旧绑定；sync_binding 仅在没有旧记录时调用 ensure_binding。配置方案切换或修改 URL 后，同一挂载仍复用旧绑定的 published_revision，却直接从新 URL 获取内容，没有核对 UUID 和 target_url。

**动态复现**：先登记旧 URL，再把同一挂载的 URL 改成另一地址。sync_binding 正常返回更新成功，数据库 target_url 仍然是旧地址。

**影响**：可能把新仓库内容写入旧仓库目录，或因新仓库版本号较小而长期跳过同步；状态接口也可能因绑定不一致而显示不正确。

**建议**：每次同步核对本次 info 返回的 UUID、规范化 URL、配置仓库 ID 与绑定。身份不一致时停止，要求显式重新绑定；不能仅复用旧版本水位。

## R5 · P1：修复/删除重建与后台同步的加锁顺序相反，可导致服务死锁

**位置**：`server/auth.py:483`、`:516`、`:521`；`server/operations.py:1311`、`:1350`、`:1379`；`server/content_lock.py:9`。

**静态确认的调用链**：

1. 后台 `sync_repositories` 先通过 `@serialized` 获取内容锁，再在 sync_all/sync_binding 中获取 `_db_lock`。
2. 管理员 `repair_repository` / `recreate_repository` 先获取 `_db_lock`，再经 provision_repository 调用带 `@serialized` 的 sync_binding，等待内容锁。
3. 若两线程分别持有第一个锁，就形成“内容锁 → DB 锁”和“DB 锁 → 内容锁”的循环等待。

这不是一般的网络慢；一旦形成循环等待，两边不会靠 SVN 超时自行解开。此外，健康检查及网站备份也在持有 DB 锁期间执行网络调用，会阻塞其他数据库请求。

**建议**：统一内容锁在外、DB 锁只包围短数据库操作的顺序；网络调用不得持 DB 锁。补充使用线程 barrier 精确控制交错顺序的并发测试。本次未在真实运行服务上触发死锁。

## R6 · P1：网站 SVN 备份会把明文凭据 JSON 一并提交到远端

**位置**：`server/operations.py:1064`、`:1083`、`:1088`–`:1097`。

网站备份默认 include 为 docs，直接 copytree 整个目录，随后 svn add/commit。现在 docs/html 中的 `md2web_config*.json` 包含明文 SVN 账号密码及可选 AI Key。Git 的忽略规则和静态 HTTP 禁止规则都不会作用于这个 SVN 备份流程。

**动态复现**：临时站点生成配置方案后执行 backup_site；假 SVN 的 add 接收到的工作副本中确实存在 `docs/html/md2web_config.json`。

**影响**：开启网站备份后，服务凭据进入备份仓库及其历史，拥有备份仓库读取权限的人可以读取。用户允许本机 JSON 明文保存，并不等于所有配置副本都适合进入远端网站备份。

**建议**：默认排除配置方案、密钥及运行数据库；需要备份配置时采用明确的独立受保护备份方案。如果此前已经提交过，应核查备份仓库权限及历史，并按实际暴露范围更换凭据。本次未检查真实备份仓库是否包含凭据。

## R7 · P2：未完成的文档提交没有绑定仓库，阻断检查失效

**位置**：`server/operations.py:458`；`server/svn_update.py:30`；`server/repositories.py:66` 附近。

prepare_commit 通过 `create_operation(..., None, "svn_commit", manifest)` 创建记录，binding_id 为 NULL，run_commit 后续也未补齐。手动更新和仓库删除检查未完成提交时却依赖 binding_id 或对 repo_bindings 的 JOIN，无法查到这些记录。

**动态复现**：创建一个 prepared 文档提交，确认 binding_id 为 None，然后手动整库更新，更新没有被阻止。仓库删除另有活动草稿检查，不能据此断言所有删除场景都会放行；但这项未完成 operation 检查本身确实失效。

**建议**：操作创建时建立可靠关联；对旧 NULL 记录从受信任 manifest 中识别挂载并补齐/兼容查询。覆盖 prepared、uncertain、svn_committed 状态。

## R8 · P2：自动同步中途失败会留下部分更新，且未记录同步错误

**位置**：`server/operations.py:1428`–`:1468`。

自动同步逐文件读取 UTF-8 并立即写入；只捕获 SvnError。后续文件出现 UnicodeDecodeError、磁盘写入失败或权限异常时，之前的文件已经发布，没有回滚，sync_error 也没有更新。

**动态复现**：导出中 `a.md` 合法、`z.md` 含非法 UTF-8 字节。sync_binding 抛 UnicodeDecodeError，a.md 已写入站点，数据库 sync_error 仍为空。

**影响**：站点成为混合版本，状态页未准确反映失败；后续构建/同步可能反复报错。

**建议**：发布前先验证完整快照；采用备份与失败回滚或可恢复发布日志；统一记录编码、文件系统和网络错误，不应显示“保留现有内容”却已经部分改写。

## R9 · P2：远端提交成功但本地发布失败后，重试无法完成发布

**位置**：`server/operations.py:38`、`:476`、`:560`–`:564`。

`svn_committed` 被归入 DONE_STATES。远端 commit 成功后先写该状态，再发布本地文件；若本地发布失败，再调用 run_commit 会直接返回 reused，不会继续发布。

**动态验证**：在临时数据库构造“远端已成功、本地仍旧”的 svn_committed 状态，再调用 run_commit，返回 svn_committed/reused，本地内容没有更新。这验证恢复分支，不代表本次实际发生了真实磁盘故障。

**建议**：仅 published 作为完全完成；svn_committed 重试应只执行幂等本地发布，不得再提交 SVN。增加“commit 成功 → 本地发布异常 → 重试完成发布”的测试。

## 当前测试结果及前端待核对项

| 验证 | 实际结果 |
| --- | --- |
| Python 3.6.8：`-m unittest discover -s tests` | 443 项，完成且通过，跳过 1 项；81.319 秒 |
| Node v24.19.0：`node --test tests/*.js` | 110 项，107 通过，3 失败 |
| `web/` 全部 24 个 JS：`node --check` | 全部通过 |
| 临时 SVN/SQLite 定向复现 | R1、R2、R3 的嵌套库场景、R4、R6、R7、R8、R9 均观察到报告描述的行为 |

Node 失败明细：

1. `tests/test_config_credentials.js:44` 的 save / check 两个用例：期望保存后密码框为空，实际仍为测试输入。`web/md2web-config.js:814` 清空后又由凭据状态刷新回填。当前产品已有从 JSON 回显密码的设计，因此这是**测试与现行行为不一致**，不能直接据此认定认证失败；应确定期望行为后统一实现和测试。
2. `tests/test_workspace.js` 中 `document actions show on md pages but not on index entry/root views`：`isDocumentView('md/硬件设计', plain)` 期望 false，实际 true。`web/workspace.js:321` 仅依赖 `.folder-view` 已存在来排除无末尾斜杠的文件夹路由。目录视图尚未渲染时可能误显示文档工具；需补真实 docsify 渲染时序验证，不能把假 DOM 的断言直接当成完整浏览器复现。

测试日志位于本机临时目录：`%TEMP%/md2web-review-python.log`、`%TEMP%/md2web-review-node.log`。Python 输出中有 ResourceWarning，当前未导致用例失败。审查未运行写入当前站点的完整构建，避免不必要地改变生成物；构建相关逻辑由现有全量 Python 测试覆盖。

## 建议的修复与验收顺序

1. 先修 R1/R2：避免远端内容覆盖和长期漏同步；回归测试必须验证真实“旧基线 + 他人先提交”的时序。
2. 修 R3/R4/R5/R6：统一同步路径/绑定检查、锁顺序和备份排除规则。
3. 修 R7/R8/R9：补齐操作关联和失败恢复，并校准前端 3 项失败测试。
4. 最后用真实 SVN 测试库验证中文/空格文件名、旧版客户端认证、并发提交、断网重试、嵌套目录及图片附件；禁止在生产库用覆盖测试验证这些问题。

上述描述对应原始审查基线，后续修复状态见下节；现有 Python 测试全绿不能单独证明所有边界情况安全。无登录手动更新是当前 AGENTS.md 明确规定的行为，本报告没有把该设计本身当作认证绕过缺陷。


## 后续修复记录（2026-10-14）

用户已授权修复并存档 GitHub，本次逐项落实：

| 问题 | 修复实现 | 回归证据 |
| --- | --- | --- |
| R1 | 冻结原草稿基线，准备及执行时核对本地内容，提交前核对更新后的 SVN 内容，冲突返回 409 | remote_changes、original_draft_baseline |
| R2 | 单文件发布不改整库水位；v10 迁移让旧 SVN 库补拉一次完整快照 | sibling_sync、upgrade_resets_old_svn_watermark_only_once |
| R3 | 自动/手动同步共用 svn_snapshot，校验最长仓库归属及链接 | nested_repository、link_ancestor |
| R4 | 自动同步每次核对 UUID、URL、仓库 ID；配置不一致拒绝写入 | changed_url、uuid_change |
| R5 | 修复/重建/健康检查/备份采用内容锁在外，网络调用不持 DB 锁；调用链传递 db_lock | repair_network_does_not_hold_database_lock |
| R6 | 备份复制过滤私有路径和链接，显式备份私有文件拒绝执行 | backup_excludes_private_profiles、backup_rejects_explicit_private_file |
| R7 | prepare 建立绑定关联，阻断查询兼容旧 NULL 记录的冻结 mount | prepared_and_legacy_null_operations |
| R8 | 快照完整校验后发布；备份、失败回滚、记录错误 | invalid_snapshot、auto_sync_rolls_back_first_write |
| R9 | svn_committed 只恢复本地发布；成功完成对应草稿，不重复远端提交 | publish_failure_can_resume_without_second_commit |

前端目录工具判断已增加仓库根路由保护；凭据测试按既有 JSON 回填约定更新，保留对密码原文、保存请求及健康状态的断言。SVN 假客户端的 info 改为回显查询 URL，确保测试真实验证绑定检查。

新增回归位于 `tests/test_review_regressions.py`。旧备份仓库中已经存在的明文凭据及其历史不属于本次代码自动清理范围；没有真实 SVN/RHEL7 联机验收，不声称覆盖所有部署差异。


### 修复后最终验收

- Python **3.6.8**：459 项测试完成并通过（跳过 1 项），其中新增 16 项审查回归；全量运行 120.745 秒。
- Node：110 项测试全部通过；`web/` 下 24 个 JS 文件语法检查通过。
- Python 3.6.8 严格离线构建通过，生成页面已更新；`docs/md/` 无修改。
- README.md 与 AGENTS.md 已同步新约定。本次未对真实 SVN 远端执行写入测试。
