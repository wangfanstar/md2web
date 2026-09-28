# 文档文件夹来源类型（SVN 库 / 软链接 / 本地文件夹）设计方案

> 状态：设计已评审通过，待实施。
> 范围：`docs/md` 一级文件夹的三类来源判定、配置页交互、管理接口、构建扫描与首页标记、写入保护、同步/健康、测试与文档。
> 前置：`specs/2026-09-20-repository-source-mode-design.md`（`sourceMode=local|svn`）已完成；本设计在其上扩展第三类 `symlink`。

## 1. 背景与目标

`docs/md` 下的每个一级文件夹是一个独立的文档来源。目前代码把所有未配置文件夹当作本地文件夹、所有已配置仓库默认当作 SVN 库，无法表达“目录是软链接、内容在别处且只读”的场景。实际部署中 4 个子文件夹都是普通目录且未配置 SVN，是否属于 SVN 库必须以配置为准，不能靠目录内容推断。

三类来源与期望行为：

| 类型 | 配置方式 | 读取 | 写入 | 首页标记 |
|---|---|---|---|---|
| SVN 库 | SVN 地址、更新频率、同步账号、允许合入；ID 自动生成 | 定时同步导出到 `docs/md` | 草稿 + 提交 SVN（或只读） | 蓝色 `SVN 库` |
| 软链接 | 目标目录、检查连接、创建/移除链接 | 直接读链接目标 | **默认且强制只读** | 紫色 `↗ 软链接` |
| 本地文件夹 | 分组、允许在线编辑；无需地址与同步配置 | 本地文件 | 在线编辑一步保存 | 灰绿色 `本地文件夹` |

设计原则：

1. **配置权威**：已配置的 `sourceMode` 决定类型；目录内容（是否含 `.svn`）不参与判定。
2. **探测补充**：未配置的一级文件夹按实际目录探测——目录链接（symlink 或 Windows 联接）识别为 `symlink` 并记录目标，其余为 `local`。软链接既可在配置页显式管理，也自动识别。
3. **软链接只建立引用**：不复制文件；移除链接只删链接、不删除目标目录；已有非空目录禁止直接替换成链接。
4. **硬只读**：软链接在服务端强制 `read_only=true`、`allow_commit=false`，所有写接口统一拒绝；“以后允许编辑”不在本次范围。
5. **失败要早、要清楚**：失效链接、目标越界、非空目录替换等都在对应操作处返回明确中文错误。
6. 构建绝不修改 `docs/md`；完全不依赖 CDN；仓库 ID 与入口页地址保持兼容。

## 2. 判定优先级（唯一权威）

1. 已配置 `sourceMode`（`svn` / `local` / `symlink`）一律以配置为准。
2. 未配置的一级文件夹：`folder_sources.describe()` 探测实际目录，链接 → `symlink` + `linkTarget`；否则 `local`。
3. 配置与实况不符（配置非 symlink 但实况是链接；或配置 symlink 但路径不是链接 / 目标失效）：
   - **行为仍按配置**（例如配置成 SVN 的目录即使实际是链接，也继续按 SVN 同步/提交）；
   - 配置页与仓库健康给出“实况与配置不一致”“链接失效”告警，不静默改变类型。
4. `sourceMode` 缺失时默认 `svn`（兼容旧配置，与既有实现一致）。

## 3. 配置模型与校验

仓库条目新增/明确两个字段：

```json
{
  "id": "硬件设计",
  "mount": "md/硬件设计",
  "sourceMode": "symlink",
  "linkTarget": "D:/共享文档/硬件设计",
  "url": "",
  "group": "硬件",
  "readOnly": true,
  "allowCommit": false,
  "syncIntervalSeconds": null
}
```

校验规则（`server/config.py`）：

- `sourceMode` 仅接受 `local`、`svn`、`symlink`。
- `svn`：必须为 http/https `url`；`linkTarget` 忽略并清空。
- `local`：`url` 必须为空；`linkTarget` 忽略并清空。
- `symlink`：必须提供 `linkTarget`；`url` 必须为空；`syncIntervalSeconds` 忽略；`read_only` 与 `allow_commit` 服务端强制 `true` / `false`。
- `linkTarget` 解析：相对路径按**配置文件所在目录**解析（与 `storage.*` 一致），内存与写回均使用解析后的绝对路径；解析后不得位于 `docs/` 内、不得包含 `docs/md` 根目录（防递归）；**加载时不要求目标在线**（网络共享暂时掉线不能阻塞服务启动），目标是否存在由探测/健康检查报告。
- 兼容：旧配置没有 `sourceMode` 时行为不变；`config_to_json` 与 `public_config` 都输出 `sourceMode`、`linkTarget`，避免保存/下发给前端时丢字段。

## 4. 配置页交互（`web/md2web_config.html` / `web/md2web-config.js`）

行内“来源类型”下拉取代原“启用 SVN”复选框：`SVN 库` / `软链接（只读）` / `本地文件夹`。明细区按类型展开：

| 类型 | 明细字段 | 操作按钮 |
|---|---|---|
| SVN 库 | SVN 地址、更新频率、同步账号/密码/保存凭据 | 检查健康、立即同步、创建并拉取（维持现状） |
| 软链接 | 目标目录输入框；连接状态（已连接 / 链接失效 / 未创建 / 目标不是链接）；“软链接只读，网页不会修改目标目录”说明，允许修改复选框禁用且不勾选 | **检查连接 / 创建链接 / 移除链接** |
| 本地文件夹 | 仅公共行的分组 + “允许在线修改” | 无 |

交互规则：

- 公共行始终显示文件夹名、入口页链接、大小/最新更新、分组输入。
- 切换类型需确认：SVN → 其他类型时提示将清空地址；切到软链接时提示填写目标目录后保存。
- “创建链接”成功或“移除链接”后自动刷新文件夹信息；若该文件夹此前是 `local`，页面把来源类型更新为软链接并提示保存配置（探测结果与配置不一致时以配置为准）。
- 状态文案直接采用服务端错误原因（非空目录不可替换、目标不存在、目标在 `docs/` 内等），不吞错。
- `repo-field-link-target` 与按钮组补充到配置页样式，沿用 12 栅格；窄屏断点与现有规则一致。

## 5. 管理接口

`POST /__admin/folder-link`（管理员 + CSRF）：

```json
{ "mount": "md/硬件设计", "action": "check|create|remove", "target": "D:/共享文档/硬件设计" }
```

- `action=check`：返回 `{sourceMode, linkTarget, linkExists, isLink}`。
- `action=create`：目标必须存在且为目录、不在 `docs/` 内、不包含 `docs/md` 根；链接位置不存在，或仅存在**空**实体目录（先 `rmdir` 再建链接）时可创建；链接位置已有任何条目——非空目录 → `link_not_empty`，已有链接（含失效链接）→ `link_exists`，均需先“移除链接/手工清理”再创建。
- `action=remove`：仅当路径是目录链接（含失效链接）时删除链接本身（符号链接 `unlink`、Windows 联接 `rmdir`），目标目录不受影响；不是链接 → `not_a_link`。
- Windows 无符号链接权限时回退 `cmd /c mklink /J` 创建目录联接；POSIX 用 `os.symlink`。
- 错误码：`link_exists`、`link_not_empty`、`link_target_invalid`、`link_broken`、`not_a_link`，均带中文说明。
- `GET /__folders` 已返回 `sourceMode` / `linkTarget` / `linkExists`；本设计修正其探测以覆盖失效链接。

## 6. 构建读取链路

统一由 `server/folder_sources.py` 提供，构建与服务共用：

- `is_directory_link()`：识别 POSIX 符号链接、Windows 符号链接与目录联接；失效（悬空）链接同样算链接。Windows 上用 reparse 属性 + `realpath` 差异判定，Python 3.8+ 再用 `st_reparse_tag` 过滤云盘占位符等非链接重解析点。
- `describe()`：链接 → `{sourceMode: symlink, linkTarget(realpath), linkExists}`；否则 `{sourceMode: local, ...}`。
- `walk_paths()`：只跟随 `docs/md` 一级链接，链接目标内部的嵌套链接**不跟随**（防循环、防重复收录）；用 realpath 去重；跳过隐藏目录与 `回收站`。现有实现会多跟随目标内部一层链接，一并修正。
- `has_link_ancestor()`：判断受管路径是否穿过链接目录，供写保护。

`setup_docsify.py`：

- `scan_markdown()`、`scan_directories()`、`first_level_folders()` 改用 `folder_sources`（`first_level_folders` 用 `lexists` 语义，失效链接也能生成入口页）；`.MD` 大小写警告、隐藏目录/回收站跳过等既有行为不变。
- `auto_folder_repos()`：对未配置文件夹调用 `describe()` 写入 `source_mode` / `link_target` / `link_exists`；symlink 自动带 `read_only=true`、`allow_commit=false`。
- `load_repositories()` 保留配置的 `source_mode` / `link_target`，并补充 `link_exists` 探测结果。
- 搜索索引、离线快照、侧栏、每仓库入口页沿用同一份扫描结果，链接目标内容被正常收录且无循环。
- 总览页与 README 标记见第 8 节；`repoList` 保持携带 `sourceMode`（已修正的丢失点），并补 `linkTarget`/`linkExists`。

`server/app.py`：

- `folder_metrics()` 改为 loop-safe 遍历（`rglob` 会跟随链接导致循环/重复），大小、分类统计包含链接目标内容。

## 7. 写入保护

服务端统一拒绝软链接下的一切写入（含未配置、靠探测识别的链接）：

| 接口 | 行为 |
|---|---|
| `PUT /__md/draft` | 403 `symlink_readonly` |
| `POST /__md/publish` | 403 `symlink_readonly` |
| `POST /__md/image`、`/__md/attachment` | 403 `symlink_readonly` |
| `POST /__md/create|rename|move|delete|restore`（`server/entries.py`） | 403 `symlink_readonly` |
| `/__svn/*` | 配置过的 symlink 由强制 `read_only` 拒绝；未配置软链接无绑定，天然不进入 SVN 流程 |

- 错误文案：“软链接目录只读，请在目标目录直接修改”。
- 判定入口：`folder_sources.has_link_ancestor(md_dir, path)`；配置过的 symlink 同时受 `read_only` 兜底。
- 前端：入口页沿用 `repoReadOnly`；编辑器保存失败时展示服务端具体原因。

## 8. 首页与入口页标记

范围：站点总览 `docs/index.html` + 各入口页首页仓库列表 `docs/html/README.md`；侧栏与其他页面不动。

总览卡片（保留原业务分组，颜色、图标、文字三者共同区分）：

| 类型 | badge | 备注行 |
|---|---|---|
| `svn` | 蓝 `SVN 库` | SVN 地址 |
| `symlink` | 紫 `↗ 软链接` | `→ 目标目录`；失效时追加红 `链接失效` 并提示检查 |
| `local` | 灰绿 `本地文件夹` | 本地文件夹说明 |

- 移除旧的“未配置 SVN”badge：未配置文件夹默认就是本地文件夹，不再是异常；`只读`、`禁止合入` 等既有 badge 保留。
- `docs/html/README.md` 仓库列表加 `[SVN 库]` / `[↗ 软链接]` / `[本地文件夹]` 文字标记与目标/失效提示。
- 失效链接的入口页照常生成，页面内以提示为主，不阻断构建。

## 9. 同步、健康与修复

- `operations.sync_all()`：跳过条件由 `source_mode == "local"` 改为 `source_mode != "svn"`（当前 symlink 会误入同步）。
- `repo_health()`：symlink 只做本地检查——链接存在/失效、目标路径、实况是否为链接；返回 `level`（ok / warn）与中文提示，不连 SVN。
- `repair_repo()` / `recreate_repo()` / `provision_repository()`：symlink（及 local）返回 400 并说明“本地文件夹/软链接不支持该操作”；配置页对软链接行隐藏健康检查以外的 SVN 操作按钮。
- 配置 symlink 不影响现有 SVN/local 仓库的同步、提交、重建流程。

## 10. 测试计划

Python（Python 3.6.8 验收）：

- `tests/test_folder_sources.py`：悬空链接识别、Windows 联接、空目录替换、非空目录拒绝、目标越界拒绝、嵌套链接不跟随、`has_link_ancestor`。
- `tests/test_server.py`：`sourceMode=symlink` 配置成功/失败分支；`readOnly/allowCommit` 强制；`linkTarget` 越界拒绝；`public_config`/`config_to_json` 字段保留；`/__admin/folder-link` 权限、创建/移除/检查、错误码；写接口在软链接目录返回 403；`sync_all` 跳过 symlink；`repo_health` symlink 分支。
- `tests/test_setup_docsify.py`：未配置链接自动识别为 symlink、失效链接入口页与 badge、README 标记、总览三色 badge、循环目录不重复收录。

Node：

- `tests/test_md2web_config.js` 适配来源类型下拉与 detail 显隐；`tests/test_workspace.js` 维持 `sourceMode` 过滤。
- `node --check` 覆盖改动的 `web/*.js`。

构建：Python 3.6.8 构建后 `git status` 无意外生成物差异、`docs/md` 逐字节未变。

## 11. 文档更新

- `README.md`：功能列表补三类来源与软链接只读语义；配置页说明补来源类型、目标目录、检查/创建/移除链接；保存语义段补充软链接下不可编辑。
- `AGENTS.md`：`server/folder_sources.py` 职责、`server/config.py` 校验、`web/md2web_config.js`、`setup_docsify.py` 探测与标记、接口清单、常见陷阱（只跟随一级链接、硬只读、Windows 联接回退、已配置仓库默认 svn）。

## 12. 兼容与迁移

- 旧配置（无 `sourceMode`）默认 `svn`；旧 `local` 配置不变。
- 现有仓库 ID、入口页地址、凭据与同步逻辑不变。
- 现有 4 个未配置普通文件夹在新构建后显示为灰绿色“本地文件夹”（行为与现在一致，仅标记更准确），无需迁移。
- 数据库无结构变更。

## 13. 明确不做（Out of scope）

- 软链接下允许网页编辑（含“明确提示后允许”的开关）；后续如需单独立项。
- 嵌套链接/多级软链接的递归跟随；只支持 `docs/md` 一级链接。
- 远端挂载（NFS/SMB 自动挂载）、链接目标跨平台路径映射。
- 真实 SVN 服务的端到端连通验证（沿用现有假 CLI 测试与既有部署流程）。
