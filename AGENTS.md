# AGENTS.md — AI 助手开发指南

> 面向在本仓库工作的 AI 助手（opencode / Claude Code / Codex 等）；人类维护者亦可参考。

## 项目概览

md2web 把 `docs/md/` 下的 Markdown 构建成**完全离线可用**的 Docsify 文档站（产物在 `docs/`）。

- 运行时：Python 3.8+（仅标准库，无需 pip/Node.js）；前端为原生 JS/CSS + Docsify 4.13.1 + Prism 1.29.0 + Mermaid 11.17.2，全部本地化
- 支持 Windows 与 Linux；`file://` 双击与 HTTP 预览均可用
- Python 版本：**3.6.8 及以上统一支持**（构建/只读预览仅标准库；认证编辑服务 `python3 -m pip install -r server/requirements.txt`）。新增代码必须通过 `Python36CompatibilityTests`（3.6 语法解析 + 禁用 3.7+ API 清单）。
- **验证统一用 Python 3.6.8**：改完代码只跑 3.6.8 的解释器（本机 `C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe`，目标机 `python3`）跑测试/构建，**不需要再跑 3.12**；系统默认 `python`（3.12）只用于临时脚本与调试，不作为验收依据。
- 仓库是**公开仓库**：不要提交密钥、令牌或敏感文档；AI 助手的 API Key 只允许存在浏览器 localStorage（`window.AI_ASSISTANT_CONFIG` 也仅作可选预置，禁止把 Key 写进被提交的文件）

## 架构与数据流

```text
docs/md/**/*.md ──scan──> setup_docsify.py ──生成──> docs/html/_sidebar.md
                                          ├─ docs/html/README.md         (首页索引)
                                          ├─ docs/html/search-index.json (搜索索引)
                                          ├─ docs/html/index_<仓库>.html  (各仓库入口页)
                                          ├─ docs/html/index_all.html     (合并视图)
                                          ├─ docs/lib/offline-data*.js    (file:// 内嵌快照)
                                          └─ docs/index.html              (总览入口，docs 根目录只留它)
web/*.{js,css}  ──copy──> docs/lib/*      (前端源码在 web/，产物在 docs/lib/)
docs/lib/<第三方依赖>                       (离线依赖，缺失时才联网补齐)
docs/html/images|uploads                  (反馈截图/附件，运行时写入)
```

> 站点页面都在 `docs/html/` 下，页面 head 带 `<base href="../">`，因此 `lib/`、`md/`、
> `search-index.json`、API（`__auth/...`）等相对路径一律按**站点根**解析；
> 页面之间的链接统一写成站点根相对路径（`html/index_all.html`、`index.html`）。
> docsify 侧用 `basePath: "../"` 与 `alias: 'html/_sidebar.md'` 取 `docs/md` 与侧栏文件。

## 文件职责

| 路径 | 职责 |
|------|------|
| `setup_docsify.py` | 构建：扫描、编码校验、依赖复用/下载、Prism 组件、生成导航/首页/索引/离线数据/入口 |
| `serve.py` | 跨平台入口：默认**只读预览**（静态站点 + 自动重建 + 本机 AI 代理，写接口一律 403）；`--config config/server.local.json` 启动认证编辑服务（Flask + Waitress）；按 pidfile 只管理本项目自身实例；认证模式后台线程：每 15 秒检查仓库同步到期（`start_repo_sync`）与每 10 秒记录文档增删（`start_document_recorder`） |
| `server/config.py` | 配置加载/校验：存储路径不得在 `docs/` 内、mount 唯一且禁止越界、URL 仅 http/https、仓库存目录段最长前缀匹配；仓库映射支持每库 `syncIntervalSeconds`（0 = 不自动同步） |
| `server/database.py` | SQLite 访问层：迁移 v9（users 含 role/password_hash，首次启动创建 admin/admin；svn_credentials 存加密口令；document_snapshots/document_events 记录文档快照与增删；audit_events 含 client_ip；feedback 含 images/attachments JSON）、外键与 busy_timeout、`backup_to`、SQLite 3.7.17 兼容检查与清理 |
| `server/svn.py` | 唯一的 svn 子进程入口：优先 `--password-from-stdin`，旧版客户端（RHEL7 1.7/1.8）自动回退 `--password`（`password_transport()` 可查询）；匿名可读检测、错误分类、info/log XML 解析、检出/稀疏更新/差异/提交/导出，超时与脱敏 |
| `server/auth.py` | SVN 登录、本地管理员登录/改密、会话（token 只存摘要、闲置/绝对过期）、CSRF、限速、审计；SVN 口令登录成功后以本机密钥加密存入 `svn_credentials`（换密码重新登录会更新），提交时优先取库内最新口令；重启与认证源变更使 SVN 旧会话失效（保留管理员会话）；`verify_account` 只校验账号密码（含限速与审计 `account_verify`），不建会话/不建用户；默认同步凭据存 `repo_credentials` 的保留 id `__default__`（`DEFAULT_CREDENTIAL_ID`），`repo_sync_credential` 解析「仓库自有 → 默认 → 会话/环境变量」；数据库访问串行化 |
| `server/passwords.py` | 管理员口令哈希（PBKDF2-HMAC-SHA256）与校验 |
| `server/operations.py` | 提交任务与仓库同步：审阅清单冻结、私有工作副本（稀疏检出）、UUID/URL 绑定核对、幂等 operation、状态机（prepared/running/svn_committed/published/failed/uncertain/needs_auth）、发布到 docs/md 与 published_revision、远端同步导出；提交时把文档引用的 `images/` 图片与 `附件/` 文件一并 `svn add`/提交（`documents.referenced_images` / `referenced_attachments`）；定时同步（`sync_due`/`sync_all`）跳过有活动草稿的文档并报告冲突，`remote_diff`/`remote_revision` 提供远端对比；无 SVN 库的一步保存：`local_publish_content`（内容直接写 SQLite 主库并物化 docs/md，校验主库与文件基线）与 `publish_file`（未关联仓库的文档直接原子写回 docs/md）；`folder_listing` 返回文档所属 `folder`/`group` 与递归 `allFolders`，`move_entry`/`move_document_assets` 实现文档跨文件夹移动与引用资源随移（共享资源复制、同名不同内容跳过并报告） |
| `server/drafts.py` | 个人草稿与版本历史：乐观并发（expected_version → 409）、不可变 revision 全文快照、统一差异（published/draft/版本号）、放弃草稿；`list_active_drafts` 给离开页面提醒用 |
| `server/documents.py` | 受管 Markdown 读写底层：路径校验、EOL 保持、唯一临时文件 + 原子替换、必填 `base_hash` 冲突检测；图片写入文档同级 `images/`（`save_document_image`），附件写入文档同级 `附件/`（`save_document_attachment`，沿用原文件名、重名加序号、禁止 html/js/svg 等可脚本化后缀）；反馈截图/附件写入 `docs/html/images|uploads`（`save_feedback_image` / `save_feedback_attachment`）；`referenced_images` / `referenced_attachments` 解析提交需随带的资源 |
| `server/app.py` | Flask 应用：`/__auth/session|login|logout`（含 `mode:admin`）、`GET/PUT /__config`、`POST /__config/test-auth`、`POST /__admin/verify-account`（验证 SVN 账号密码是否合法，不切换会话）、`GET/POST /__admin/default-credential`（默认同步凭据：先经认证路径校验再加密入库）、`POST /__admin/password`、`POST /__admin/sync`（立即同步仓库）、`GET /__admin/usage`（登录 IP/账号活动/用户数/审计）、`GET /__admin/documents`（文档更新时间与次数/文件夹大小/增删记录）（均要求管理员 + CSRF）、草稿接口（`/__md/document|draft|drafts|image|attachment|history|diff|revision|discard`）、**无 SVN 库一步保存** `POST /__md/publish`（本地模式写 SQLite 主库、未关联仓库直接写 docs/md，成功后触发重建）、**移动文档** `POST /__md/move`（同仓库内换文件夹）、`GET /__folder` 附带 `group`/`allFolders`（按 `folderGroups`/仓库 group 解析，供分组显示与移动选择）、反馈接口（`/__feedback`、`/__feedback/image|attachment|delete`、`/__admin/feedback`）、SVN 接口（`/__svn/info|log|prepare|commit|refresh|status|remote-diff`、`/__operations/<id>`）、写接口守卫（匿名 401、旧 `/__md/save` 410）、静态分发白名单与安全响应头 |
| `server/paths.py` | 静态分发禁止清单（点目录、`.svn`、`data/`、`config/`、临时/数据库/源码文件），预览与认证服务共用 |
| `web/auth.js` / `.css` | 登录状态与弹窗（`window.SiteAuth`）：会话刷新、登录/退出、侧栏指示器、只读模式提示、管理员角色与 AI 默认值下发；无侧栏的独立页渲染固定右上角登录入口（`.site-auth-fixed`，侧栏出现后自动收起）；`window.MD2WEB_BASE` 可用于指定站点根前缀（如 `docs/lib/plot-playground.html` 用 `'../'`） |
| `web/settings.js` / `.css` | 统一设置弹窗（`window.Settings`，侧栏单一入口，**分为 AI 助手 / SVN 与仓库 / 账号 / 信息查询 四个 Tab**）：本机 AI 设置、管理员登录、SVN 认证路径与测试、仓库映射增删（含凭据分组与「更新频率」）、全站 AI 默认值、管理员改密，、「立即同步 SVN 库」，以及**管理员使用情况**（登录 IP/账号活动/用户数/审计）与**文档统计**（文档更新时间与次数、文件夹大小、增删记录，表头可排序） |
| `web/sanitize.js` | 前端净化入口（`window.Sanitize`，基于离线 DOMPurify）：阅读/预览/AI 回答统一净化；`style` 只放行 `color:` 单属性（编辑器文字颜色用 `<span style="color:…">`，其余样式一律移除） |
| `config/server.example.json` | 认证服务示例配置（可提交）；`config/server.local.json` 为真实配置，不提交（缺失时 `--config` 会自动生成默认文件） |
| `tests/test_server.py` | 认证服务单元/HTTP 集成测试（配置、数据库、SVN 假 CLI、登录会话、静态白名单） |
| `web/custom-search.js` / `.css` | 搜索算法与界面、结果列表、搜索/目录视图切换、**按仓库多选过滤**（⚙ 筛选区的仓库勾选菜单，`state.repoFilter` + `localStorage: md2web:search-repos`，与范围/模式叠加）、正文命中高亮、右侧本文目录 |
| `web/folder-view.js` | `html/index_all.html` 与各仓库入口页的递归 Markdown 文件夹视图（正文只显示当前仓库/文件夹的文档与子文件夹，隐藏本文目录）+ 列表按钮和左侧导航全局右键菜单共用新建文档/新建文件夹/重命名/删除/回收站/设置分组/**移动到…**；文档列表按父文件夹分组（`groupDocuments`，组标题显示文件夹相对路径与配置分组），移动弹窗列出 `__folder?recursive=1` 的 `allFolders` 供选择；`pathFromElement` 先取文档链接、其次分组标签的 `data-folder`（生成侧栏写入的 `md/...` 真实目录），旧产物才回退到「第一个子文档的目录」，保证在分组上右键新建不会落到第一个子文件夹；对应接口 `GET /__folder?recursive=1`、`GET /__trash`（登录）与 `POST /__md/create|rename|move|delete|restore|trash-empty`、`POST /__admin/group`；关联 SVN 的操作由 `server/entries.py` 先提交成功再发布本地，`.md` 文档路由保持正文与右侧本文目录 |
| `server/entries.py` / `server/content_lock.py` | 文档/文件夹在线操作的路径、权限、活动草稿、远端基线、幂等操作号与 SVN 工作副本提交；`move` = 同仓库内移动 Markdown 文档（跨仓库 400），SVN 工作副本 `svn move` 并随移被引用的 `images/附件`（共享资源复制、新目录 `svn add`）；提交、发布、后台同步使用独立内容锁串行化，网络调用不持数据库锁；不确定提交状态禁止自动重试 |
| `server/recycle.py` | 每个仓库挂载目录下的 `回收站/` 条目、原路径元数据、关联图片/附件搬运、恢复与清空；构建扫描、普通目录列表和搜索索引均跳过回收站 |
| `web/workspace.js` / `.css` | 目录树（折叠/过滤/计数/定位）、面包屑、首页卡片、复制、查看源码/编辑/下载 MD、章节序号、Mermaid 样式 |
| `web/mermaid-init.js` | docsify 插件：把 ```mermaid 围栏渲染为图形（离线）；容器保留 `data-source`，并暴露 `window.MermaidRender.render(source)` 供放大查看/导出重渲染 |
| `web/packetdiag.js` | PacketDiag 解析与 Canvas 绘制核心（从 `PacketDiagPic.html` 抽取，`window.PacketDiag = { parse, render, presets, defaultSource, extractSource, bitOrderFor, numberingFor }`）；支持 `bit_order`/`numbering`/`@row`/`@left`/`desctable` 等扩展语法 |
| `web/packetdiag-init.js` | docsify 插件：把 ```packetdiag 围栏渲染为报文图（figure 保留 `data-source`），失败回退源码；暴露 `PacketDiagRerender`（按源码重绘 data URL）与 `PacketDiagEnsureRendered`（导出前修复空白画布） |
| `web/media-viewer.js` | 图片、Mermaid 图形与 PacketDiag 图形的全屏放大查看（放大时用 `MermaidRender.render(source)` 重渲染、PacketDiag 用 `PacketDiagRerender` 重绘，避免克隆丢字/丢箭头）与下载（Mermaid 导出 SVG/PNG，PacketDiag 导出 PNG） |
| `web/page-export.js` | 「下载本页」：把当前文档导出为自包含 HTML（样式内联、Canvas/图片转 data URL、本文目录固定左侧导航；导出前会调用 `PacketDiagEnsureRendered` 重绘空白画布） |
| `web/md-editor.js` | 「编辑 MD / 下载 MD」（含草稿、历史、差异、提交 SVN 与 SVN 日志）：双栏编辑器（左：可拖拽分栏的 Markdown 高亮源码；右：marked + Prism + Mermaid + PacketDiag + KaTeX 实时预览，默认 38%/62% 偏向预览、面板最宽 1720px）、**左侧固定大纲导航**（默认显示、不遮挡内容，点击跳转章节并让右侧预览同步滚动）、**查找/替换**（Ctrl+F / Ctrl+H，浮在源码区右上角：大小写/整词/正则、计数、上一个/下一个、替换/全部替换，Enter/F3 导航、Esc 先关查找条；全部替换可撤销）、**撤销/恢复**（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）、**上传本地图片**、**上传附件**（写入文档同级 `附件/`，沿用原文件名、重名加序号，插入 `[文件名](附件/…)` 链接）、**文字颜色**（Ctrl+Alt+K，HTML span）、**表格行列选择器**（Ctrl+Shift+T，1–8 行列）、**远端差异/提交后差异**（同步冲突时提示合并）、粘贴或拖入图片自动上传到文档同级 `images/`（命名 `<文档名>-<时间戳>-<序号>.<扩展名>`，并插入引用）、拖入其他文件上传到 `附件/`、工具栏与快捷键、`Ctrl+S` **保存语义**（无 SVN 库/未关联仓库 =「保存到服务器」一步写入 docs/md 或本地库并重建，关闭编辑器后刷新页面；有 SVN 库 =「本地暂存」个人草稿，再用「提交 SVN」写入仓库）、**退出提醒**（有未提交本地暂存或编辑器未保存修改时离开页面弹确认）；`window.MdEditor = { open, download, save, close, uploadImage, uploadAttachment, undo, redo }` |
| `web/text-find.js` | 查找/替换的离线纯逻辑（`window.TextFind`：`findMatches` / `replaceAll`，支持大小写、整词（前后非 `[0-9A-Za-z_]`，兼容 CJK）、正则与 `$1`/`$&` 替换，非法正则返回 `invalid_regex`）；编辑器 UI 只做接线，`tests/test_text_find.js` 覆盖 |
| `web/math-init.js` | docsify 插件：`$...$` / `$$...$$` 等分隔符的 KaTeX 离线渲染；暴露 `window.MathRender.render` 供编辑器预览复用 |
| `web/prism-init.js` | docsify 插件：`beforeEach` 阶段按围栏语言预载 Prism 组件，保证 docsify 渲染期即可高亮（docsify 内置 Prism 覆盖了 `window.Prism`，autoloader 必须在其之后加载） |
| `web/ai-retrieval.js` | AI 助手的离线检索核心（纯函数，`window.AIRetrieval`）：分词（CJK 单字+双字）、从 `searchIndex`/Markdown 构建语料、TF-IDF 打分、摘录与上下文/消息组装；`tests/test_ai_retrieval.js` 覆盖 |
| `web/ai-assistant.js` / `.css` | AI 助手聊天面板与独立配置弹窗（`window.AIAssistant`）：设置面板（服务商预设、接口地址、模型、Key、代理策略，Key 仅存 localStorage）、**资料范围勾选**（按文件夹/文档过滤检索）、**上传文档**（.md/.txt，仅本机 localStorage，≤512 KB）、本地检索 + 引用来源、OpenAI/Anthropic 风格流式 SSE 解析、直连失败自动走 `/__ai/chat` 代理；侧栏「AI 配置」图标与对话面板 ⚙ 均可打开配置 |
| `tests/test_ai_retrieval.js` | AI 检索算法测试（`node --test`） |
| `web/plot-playground.html` | 独立绘图在线预览页（Mermaid 全部类型模板 + PacketDiag 增强控件与完整语法说明、一键复制源码、下载），构建复制到 `docs/lib/`；`docs/md/使用说明/绘图示例.md` 与之保持全部样例同步（`tests/test_setup_docsify.py::DrawingExamplesTests` 校验） |
| `web/md2web_config.html` / `web/md2web-config.js` | 仓库配置页（构建复制到 `docs/html/md2web_config.html`）：**仓库 ID 由系统按文件夹名自动生成**（`autoRepoId`，既有仓库沿用保存的 ID 以免绑定/凭据失效），用户只填 SVN 地址与更新频率；默认只列 `docs/md` 一级文件夹（显示文件夹名、不带 `md/` 前缀）+ 入口页链接（已配置仓库用仓库 ID，未配置用文件夹名，均有对应 `index_*.html`）+ 最新更新（作者/时间）+ 仓库大小（合计/文档/附件/子文件夹分类）+ 状态，并有「刷新文件夹信息」按钮；勾选「配置 SVN」才展开 SVN 地址/分组/更新频率/只读/允许合入与操作按钮（不勾选按 `sourceMode=local` 保存并清空地址，切换时需确认）。另有「账号切换与验证（SVN）」面板：查看当前账号、保存/测试 SVN 认证路径（`PUT /__config` + `POST /__config/test-auth`）、退出登录切换账号、验证（可选直接切换）SVN 账号；**「默认同步凭据（SVN 账号）」面板**：认证路径 URL + 同步账号 + 密码，「验证并保存为默认凭据」先用认证路径校验再加密入库（`GET/POST /__admin/default-credential`），未单独配置凭据的仓库同步时统一使用；**每个仓库明细行内**直接提供「同步账号 / 密码 / 保存凭据」（`POST /__admin/repo-credential`，不再用 `window.prompt`），并显示「已单独配置 / 跟随默认凭据」；网站备份凭据同样行内输入；管理员登录后保存配置，支持「创建并拉取」（`POST /__admin/provision`：目录不存在时创建并从 SVN 导出） |
| `docs/index.html` / `docs/html/index_<仓库>.html` / `docs/html/index_all.html` | 构建生成：docs 根目录只留总览页 `index.html`（按分组列出各仓库入口 + 跨仓库搜索）；`docs/html/` 下是每仓库入口页（独立侧栏/离线快照，带只读与允许合入标记；**搜索索引统一为全站 `html/search-index.json`**，任意入口页的「全部文档」范围都能搜到其他仓库并跳转对应入口页）、合并视图、配置页与反馈页、`README.md`/`_sidebar*.md`/`search-index*.json` |
| `docs/md/` | 唯一需要人工维护的源文档目录 |
| `docs/lib/` | 离线依赖 + 生成资源，不要手工修改 |
| `docs/` 其余文件 | `index.html`、`README.md`、`_sidebar.md`、`search-index.json`、`offline-data.js` 等，均由构建生成 |
| `tests/test_setup_docsify.py` | Python 回归测试（unittest，全程离线） |
| `tests/test_search.js` | 搜索算法测试（`node --test`） |
| `tests/test_packetdiag.js` | PacketDiag 解析回归测试（`node --test`） |
| `specs/` | 设计与计划文档（历史归档，新增设计放这里）；`specs/2026-09-20-content-asset-storage-design.md` 为文本/资产 SQLite 双库存储方案（结论：文件仍为唯一事实源，`content.sqlite3` 存文本元数据、`assets.sqlite3` 存资产登记与可选二进制备份） |

- 第三方组件与许可：见 `THIRD-PARTY-NOTICES.md`（本项目基于 docsify 4.13.1 构建，构建会给 `docsify.min.js` 写版权横幅）。

## 常用命令

```bash
python setup_docsify.py                 # 完整构建（依赖已存在时全程离线）
python setup_docsify.py --index-only    # 仅重建搜索索引与离线数据
python setup_docsify.py --title "我的文档"
python setup_docsify.py --offline       # 严格离线：依赖缺失时报错，不尝试下载
python3 -m pip install --user --no-index --find-links server/wheels -r server/requirements.txt  # 离线包（非 root 加 --user；Linux x86_64 + cp36）
python3 -m pip install --no-index --find-links server/wheels -r server/requirements.txt  # 离线包（系统级，需写权限）
python3 -m pip install -r server/requirements.txt  # 联网安装（3.6.8+ 通用，仅认证模式需要）
python serve.py                         # 默认认证编辑服务（认证模式下需先安装上面的依赖）
python serve.py --preview               # 只读预览 http://localhost:8882（无写接口）
python serve.py --reset-admin-password  # 忘记管理员密码时强制恢复为默认 admin/admin
python -m unittest discover -s tests -v
node --test tests/test_search.js
node --test tests/test_packetdiag.js
node --test tests/test_ai_retrieval.js
node --test tests/test_text_find.js
node --test tests/test_folder_view.js
node --check web/custom-search.js       # 前端语法检查（workspace/mermaid-init/media-viewer/packetdiag/page-export/md-editor/text-find/math-init/prism-init/ai-assistant/ai-retrieval/auth/sanitize 同理）
```

> 验收只跑 3.6.8：把上面的 `python` 换成 3.6.8 解释器（本机 `C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe`，Linux 为 `python3`），例如
> `& "C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe" -m unittest discover -s tests`。
> 3.12 的运行结果不作为验收依据（仅方便临时调试）。

## 不可破坏的约定

1. **构建绝不修改 `docs/md/`**：不删除、不移动、不重写源文档；新增/删除文档由用户操作。编辑器的 `Ctrl+S` 是用户主动触发（经本机预览服务写回），不属于构建行为。
2. **生成物不手工维护**：`docs/index.html`、`docs/html/` 下的页面与索引（`README.md`、`_sidebar*.md`、`search-index*.json`、`index*.html`、`md2web_*.html`）、`docs/lib/` 下生成资源都会被构建覆盖；`docs/html/images|uploads` 是反馈运行数据（构建不动）。
3. **前端源码在 `web/`**：改搜索/工作台/样式要改 `web/`，再运行构建同步到 `docs/lib/`；不要直接改 `docs/lib/`。
4. **完全离线**：运行时不得请求 CDN；新增第三方库必须保存到 `docs/lib/` 并登记到 `setup_docsify.py` 的 `ASSETS`（含固定版本 URL）。KaTeX 含 `katex/fonts/*.woff2` 共 20 个字体文件，`ensure_assets` 会自动创建嵌套目录。
5. **失败要早、要清楚**：`docs/md` 缺失/为空、非 UTF-8 文档等应在写任何文件前抛 `BuildError`，错误信息带路径。
6. **索引语义一致**：Python 预构建 `build_page_index` 与浏览器重读 `buildSearchPage` 必须一致——代码围栏内容进入正文、代码内 `#` 不生成标题、首个标题前不落空壳条目。
7. **绘图围栏不交给 Prism**：`collect_fence_languages` 必须忽略 `mermaid` 与 `packetdiag`（`IGNORED_FENCE_LANGS`），分别由 `web/mermaid-init.js`、`web/packetdiag-init.js` 渲染。
8. **静态页链接用原始 HTML**：docsify 会重写 Markdown 链接为 hash 路由，指向 `lib/plot-playground.html` 等静态文件时必须使用 `<a href="lib/...">` 原始锚点，否则会被路由拦截。
9. **UI 令牌统一**：颜色/字体使用 `--docs-*` 变量；`--docs-accent`（#1f6feb）只用于当前项/命中/焦点；路径、标识符、计数用等宽字体。
10. **章节序号**：正文 h2–h4 由 CSS 计数器生成，右侧目录编号由 `buildPageToc` 生成，两者规则需保持一致（1 / 1.1 / 1.1.1）；阅读区「隐藏序号/显示序号」按钮通过 `body.hide-heading-numbers` 关闭两者，偏好存于 localStorage。

## 开发流程

- **TDD**：先写失败测试（Python `unittest` 或 Node `node --test`），再实现，最后跑全量测试。
- 新增 Python 行为必须补测试；前端改动至少 `node --check` 通过，并重建验证生成物。
- 提交信息用中文，前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `test:`。
- 推送 GitHub：直连 github.com 可能被重置，需走本机代理：
  `git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main`

## 常见陷阱

- Windows 下 Python 文本写入产生 CRLF、`web/` 源文件为 LF；比较生成物一致性时先归一化换行。
- `docs/md` 仅支持 UTF-8；大写扩展名（`.MD`）会被跳过并警告（docsify 按大小写敏感匹配）。
- 文件名含 `#`、`?`、`%`、`[`、`]` 会破坏链接或路由，文档中应提示用户避免。
- 修改 `web/*.js|css` 后必须重新构建，`docs/lib/` 才会更新；`serve.py` 的自动重建只监视 `docs/md`。
- docsify 会覆盖 `window.Prism`（内置核心 + markup/css/clike/javascript），`prism-autoloader.min.js` 与 `prism-init.js` 必须放在 `docsify.min.js` 之后，否则代码块不会按需加载语言组件。
- `docsify` 会逐目录请求 `_sidebar.md`，已在 `index.html` 用 `alias` 回落到根侧栏；不要移除。
- **写接口只在认证服务中存在**：只读预览下 `/__md/*`、`/__svn/*` 一律 403；前端不得回退成“文件写入”或“匿名直存”。匿名 401、旧接口 410、未实现阶段 501，均有明确错误码。
- 编辑器的保存语义：**无 SVN 库**（未关联仓库 / `sourceMode=local`）用 `POST /__md/publish` 一步写入（未关联仓库直接原子写 docs/md；本地模式写 SQLite 主库后物化，主库与文件基线都必须匹配 `baseHash`，否则 409 不覆盖），成功后触发重建；**有 SVN 库**的保存只写个人草稿（`PUT /__md/draft`），「提交 SVN…」才写仓库（`/__md/publish` 对 svn 仓库返回 400 `use_svn_commit`）。离开页面前用 `GET /__md/drafts` 检查未提交本地暂存并弹确认（编辑器内未保存修改也提醒）。
- SQLite 连接由 Waitress 多线程共享：`database.connect` 使用 `check_same_thread=False`，所有访问必须经 `AuthService._db_lock` 串行化；数据库写锁不得跨越 SVN 网络调用。
- 服务启动只按 pidfile 终止本项目自身实例；不要再恢复“扫描并终止所有 serve.py 进程”的行为。
- 监听地址与端口解析：`serve.resolve_bind` / `serve.resolve_port`（CLI `--bind`/`--port` 优先，其次配置 `server.bind`/`server.port`，最后 `0.0.0.0`/`8882`）；认证服务与预览默认都监听所有网卡，`print_access_hints` 负责打印「本机访问/局域网访问」、按实际 firewalld/ufw 状态给出 `firewall-cmd --add-port=<port>/tcp` / `ufw allow` 放行命令与「仅本机使用请加 --bind 127.0.0.1」提醒；`start_linux.sh` / `start_windows.bat` 在用户未指定 `--bind` 时自动补 `--bind 0.0.0.0`，别再写死 localhost。
- 认证模式直接绑定配置端口：端口被占用时打印明确提示（不会自动换端口）；重复双击启动靠 pidfile 关闭旧实例。`start_windows.bat` 保持纯 ASCII（cmd 用 OEM 代码页解析，中文会破坏脚本）。
- 认证依赖安装：`start_linux.sh` 在非 root 时优先 `--user` 安装（系统目录常不可写，直接装会 PermissionError），顺序为「离线 --user → 离线系统 → 联网 --user → 联网系统」；提示用户级失败时给出 sudo/--user 与 pip 升级命令。
- **数据库兼容目标 SQLite 3.7.17（RHEL7 自带，Python 3.6 的 sqlite3）**：Windows 端也只写旧版能解析的对象，`data/` 数据库可在 Windows 与 RHEL7 之间直接共用。`database.sqlite_compat_issues` 负责静态检查（部分索引/表达式索引/UPSERT/CTE/窗口函数/STRICT/生成列/RETURNING/JSON 等），`database.migrate` 末尾调用 `sanitize_schema` 清理残留的不兼容对象；新增迁移必须保持基础语法，`DatabaseTests.test_schema_sql_avoids_modern_only_features` 与 `test_migrate_removes_sqlite37_incompatible_objects` 守护。
- 旧版 SQLite 打开含不兼容对象的库会报 `malformed database schema`（连读取失败）：`database.connect` 会先移除这类索引（原文件留 `*.repair-*.bak`），仍失败则把库改名为 `*.corrupt-*.bak` 并重建。
- 离线依赖包位于 `server/wheels/`（cp36 + manylinux1 x86_64，含 MarkupSafe 的 manylinux wheel 与本地构建的 blinker/dataclasses 纯 Python wheel，`*.whl` 在 `.gitattributes` 中标记为 binary）；新增/升级依赖时同步更新该目录，`OfflineWheelsTests` 会校验覆盖度。
- `start_linux.sh` 必须保持 LF + 可执行位（`.gitattributes` 已声明 `*.sh text eol=lf`）；脚本内置 CRLF 自愈（`sh start_linux.sh` 也会去 CR 后重执行），`start_windows.bat` 必须纯 ASCII。
- `--svn-command` 支持带空格的路径（Windows 用双引号包住）；测试用假 svn 可执行文件注入，真实认证需要能连通的强制认证 SVN 路径。
- 本地管理员默认 `admin / admin`（PBKDF2 存库）：仅用于网页「设置」；部署后必须尽快改密。修改 SVN 认证路径只失效 SVN 用户会话，管理员会话保留。
- 本机管理员账号只能本地编辑（草稿）与配置；提交 SVN 时要求补充 SVN 账号（仅会话内存），界面与提示不得暗示本机账号可直接合入。
- 登录接口会自动识别本机管理员账号（`auth_source_id = local-admin`）：直接用本地口令校验并以管理员身份登录，**不需要 SVN 校验**；普通账号仍走 SVN 认证路径。
- 管理员界面数据来源：登录记录/使用量来自 `audit_events`（登录时记录 `client_ip`）、`operations` 与 `sessions`；文档更新时间/次数来自 `operations`（published），文件夹大小来自实时扫描 `docs/md`，增删记录由 `serve.py` 后台线程每 10 秒对比 `document_snapshots` 写入 `document_events`（首次为基线不产生事件）。
- 生成的 `index.html` 会给自有资源加内容版本号（`version_asset_urls` → `lib/x.js?v=<sha1>`），改 `web/` 后必须重建才会更新版本号；排查「改了没生效/放大丢字」先确认浏览器拿到的是新脚本。
- SVN 定时同步：`serve.py` 每 15 秒按各仓库 `syncIntervalSeconds`（留空用 `sync.interval_seconds`，0 关闭）判断到期，`svn info` 比对远端版本后导出更新 `docs/md`；**有活动草稿的文档不覆盖**，记入 `conflicts` 并把仓库 `sync_error` 标记为 `conflicts`，编辑器据此提示「远端已更新，请先合并」并提供「远端差异」；同步凭据来自环境变量 `sync.credential_name`（`用户名:口令`），未配置时按匿名读取。
- SVN 提交会把文档引用的 `images/` 图片一起存档：`prepare_commit` 的清单含 `images` 列表（由 `documents.referenced_images` 解析 Markdown/HTML 图片引用），`run_commit` 复制到工作副本、必要时 `svn add`，并与文档同一次 `svn commit` 提交；图片不参与文本差异比对（冲突风险由用户确认）。
- 多仓库站点：`setup_docsify.load_repositories()` 读 `config/server.local.json` 的 repositories（id/mount/url/group/readOnly/allowCommit/syncIntervalSeconds）；每个仓库在 `docs/html/` 生成 `index_<仓库>.html` + `_sidebar_<仓库>.md` + `lib/offline-data_<仓库>.js`（搜索统一用全站 `html/search-index.json`，不再生成每仓库索引；旧的 `search-index_<仓库>.json` 由 `cleanup_repo_artifacts` 清理），根 `index.html` 是分组总览，`html/index_all.html` 是合并视图。仓库页的 docsify `alias` 必须同时映射 `/_sidebar.md` 与 `/.*/_sidebar.md`（否则首页路由会加载全局侧栏，把其它仓库的文档列出来）；搜索索引每条记录带 `site`，跨仓库结果会先跳到对应入口页。
- 每个一级文件夹都有入口页：`load_all_repos()` = 配置的仓库 + `auto_folder_repos()` 为**未配置仓库的文件夹**补的条目（`auto=True`，id 即文件夹名，`index_<文件夹名>.html`，总览页显示「未配置 SVN」徽标、备注「本地文件夹（不连接 SVN）」），因此配置页「仓库入口页」列对每个文件夹都有链接；`repo_page_name()` 保留中文等 CJK 字符（否则中文 id 会全部塌缩成 `index_repo.html`），前端 `entryPage()` 必须保持同一规则。删除文件夹后重建由 `cleanup_repo_artifacts()` 清理其入口页/侧栏/索引/离线数据。
- `./start_linux.sh: No such file or directory` 多为 CRLF 或缺少可执行位：`start_linux.sh` 必须保持 LF + 100755（`.gitattributes` 已声明 `*.sh text eol=lf`，`LauncherScriptsTests` 校验无 CR 与可执行位）；排障命令 `sed -i "s/\r$//" start_linux.sh && chmod +x start_linux.sh`，或直接 `sh start_linux.sh`（脚本会去 CR 后重执行）。
- `start_linux.sh` 的开关要**连写**（`--restart`、`--stop`）；若误写成 `-- restart`（中间多空格）或漏写 `--`（`restart`），脚本也会识别，且多余的 `--` 会被忽略（不再透传给 `serve.py`，避免 argparse 报 “unrecognized arguments”）。
- `start_linux.sh` 默认**后台启动**（`nohup … >> data/serve.log 2>&1 &`，等待就绪后打印 PID/日志/停止命令），`--foreground` 前台、`--stop` 按 pidfile 停止、`--restart` 强制重启（先停本实例，再用 ss/lsof/fuser 结束占用端口的进程）、`--status` 查看状态；脚本自身的开关会先剥离，其余参数透传 `serve.py`；后台模式自动补 `--no-browser`；保持 POSIX sh、LF 与可执行位。**指定端口**支持 `--port 8891`、`--port=8891` 与裸端口号 `./start_linux.sh 8891`（解析时把纯数字参数转成 `--port`，`--port/--bind/--pidfile/--config/--title/--svn-command` 的取值参数不会被误判），启动前用 `validate_port` 校验 1-65535。
- 启动前端口检查（`confirm_port_conflict`）：端口被**非本项目实例**占用时打印占用进程信息（`process_info`：优先读 `/proc/<pid>`，ps 字段兼容性差时不依赖它；含 PID/用户/运行时长/命令行），交互式询问是否强制结束——`y`/回车结束、`n` 取消启动、**10 秒无操作自动强制结束**；`[ -t 0 ] || [ -r /dev/tty ]` 时都先询问（非交互且无 /dev/tty 才自动结束）。询问函数 `prompt_kill_or_cancel` **优先单键确认**（`stty -icanon -echo min 0 time 100` + `dd bs=1 count=1` 读一个字符，输入 y/n 无需回车，10 秒超时由终端驱动；读完必须 `stty "$saved_tty"` 恢复），不支持时回退 `timeout 10 sh -c 'read' < /dev/tty`（dash 等 /bin/sh 不支持 `read -t`，否则会**跳过等待直接强杀**）或 `read -t 10`。占用者是本实例（PID 与 pidfile 一致）时跳过询问，交由 `serve.py` 按 pidfile 重启。`--restart` 仍是直接强杀不询问。
- 后台就绪判断（约 20 秒）：pidfile 进程存活 **且端口已监听**（`port_holders`）即视为就绪，日志关键字仅作无 ss/lsof/fuser 时的回退；后台启动用 `python -u`（关闭输出缓冲）保证 `data/serve.log` 即时可读（否则缓冲会让日志长时间为空、误判“未就绪”）。失败时打印 pidfile 进程状态、端口监听状态与日志尾部，日志为空时明确提示。
- Linux 进程名：`serve.py` 启动时调用 `set_process_title()`（libc `prctl(PR_SET_NAME)`）把进程名设为 `md2web-serve`，便于 `pgrep -af md2web` / `ps -o pid,comm,args -C md2web-serve` 查找；Windows 下仅设置控制台标题（进程名仍是 python.exe），实例管理仍以 pidfile 为准。
- 搜索索引：所有 docsify 页面（含每个仓库入口页）的 `customSearch.indexPath` 都是 `html/search-index.json`，因此「全部文档」范围是**全站**范围；跨仓库结果靠索引条目的 `site`（`html/index_<仓库>.html`）跳转，配合关键词交接（localStorage）在目标页恢复高亮。不要改回每仓库索引，否则仓库入口页搜不到其他仓库。
- 侧栏导航：顶部「返回上一层」图标（`SIDEBAR_BACK_ICON`）固定指向 `html/index_all.html`（全部文档合并视图），「返回首页」链接固定指向站点总览 `index.html`（不再读 `window.$docsify.homeLink`，该配置仍随页面生成但前端未使用）；全局侧栏（`_sidebar.md`）的一级分组名由 `generate_sidebar(link_first_level=True)` 生成为 `<a class="sidebar-group-link" href="html/index_<仓库>.html" data-folder="md/...">`（Markdown 链接会被 docsify 重写成 hash 路由，必须用原始 HTML 锚点）；各仓库侧栏（`_sidebar_<仓库>.md`）的一级分组名同样是指回本仓库入口页的原始 HTML 锚点（`generate_sidebar(top_link=HTML_PREFIX + page)`），进入文档后点分组名即可返回仓库首页（`index_<仓库>.html#/`）。分组标签一律带 `data-folder="md/..."`（「所有文档」为 `md`），子文件夹分组是 `<span class="sidebar-group-name" data-folder="...">**名称**</span>`：`folder-view.js` 的右键菜单据此精确定位目录，不再落到第一个子文件夹；构建把 `scan_directories` 收集的真实目录（跳过隐藏目录与 `images/`、`附件/`、`回收站/`）并入侧栏，**空文件夹也会显示**，可直接右键在其中新建文档/子文件夹。合并视图的左侧导航**不再按仓库过滤**（`workspace.js` 已移除 `filterByCurrentRepo`），进入文档后仍显示全部文档。
- 文档移动（`POST /__md/move`）：只允许 Markdown 文档，且只能在同一仓库（或同为未配置文件夹）内换文件夹——跨仓库/只读/有活动草稿都会拒绝（400/403/409）；移动会带上文档在 `images/`、`附件/` 里引用的文件：只被本文档引用就移动，被源目录其它文档也引用则保留原件并在目标目录复制一份，目标目录已有同名且内容不同的资源会跳过并记入结果 `assets.conflicts`。文件夹视图的文档列表按父文件夹分组，`/__folder?recursive=1` 的 `documents[].folder/group` 与 `allFolders[].group` 由 `folderGroups`/仓库 `group` 解析（子文件夹继承上级仓库的分组）。
- 仓库同步凭据：`repo_credentials`（v6，按 repository_id 存密文，`site-backup` 为网站备份专用 id，`__default__` 为默认同步凭据保留 id，配置页自动生成仓库 ID 时避开）；`AuthService.repo_credential` 解密，`repo_sync_credential` 按「仓库自有 → 默认 → 会话/环境变量」解析（同步、健康检查、修复/重建、创建并拉取共用）；默认凭据保存前必须经 SVN 认证路径校验（本机管理员账号被拒绝）；接口 `POST /__admin/repo-credential`、`GET /__admin/credentials`、`GET/POST /__admin/default-credential`（均需管理员）。
- 网站数据备份：配置 `siteBackup`（enabled/url/intervalSeconds/include/message），`operations.backup_site` 在 `data/site-wc` 检出后复制 `docs/` 并 `svn add` + `svn commit`（`svn status` 为空则跳过）；`serve.py` 同步线程按频率触发，`POST /__admin/site-backup` 可立即备份。
- 读者反馈：`web/md2web_feedback.html` + `web/md2web-feedback.js`（构建复制到 `docs/html/` 与 `docs/lib/`）：`GET /__feedback`（公开只读，含状态字典）、`POST /__feedback`（登录 + CSRF，标题≥2 字 + 描述，可带 `images`/`attachments`）、`POST /__feedback/image|attachment`（登录 + CSRF，截图写 `docs/html/images/`、附件写 `docs/html/uploads/`）、`POST /__feedback/delete`（登录 + CSRF，作者本人或管理员）、`POST /__admin/feedback`（管理员 + CSRF，更新 status/note）；数据库 v9 `feedback` 表（含 images/attachments JSON，服务端只接受真实存在的 `html/images|uploads` 文件路径）。入口：docsify 页面在侧栏 AI 设置图标旁（`[data-sidebar-feedback]`，点击打开 `window.FeedbackDialog` 弹窗），无 AI 图标的独立页（配置页/总览页）显示右上角固定入口（`.feedback-fixed-entry`，侧栏渲染后自动收起）；反馈卡片与弹窗样式由 `md2web-feedback.js` 注入（`FEEDBACK_STYLE`），独立页只保留页面框架样式。
- 分组与权限：配置页「分组」在**公共行**（每个一级文件夹都有），保存到配置 `folderGroups`（`md/<文件夹>` → 分组名）；构建侧 `load_folder_groups()` 覆盖已配置仓库的 group，并给 `auto_folder_repos` 的未配置文件夹带上分组。权限为单一开关：勾选 → `readOnly=false, allowCommit=true`（SVN 模式文案「允许合入 SVN 库」，本地模式「允许在线修改」）；未勾选 → 只读，内容由服务器同步更新。
- 仓库健康与修复：`operations.repo_health` 检查配置/目录/远端连通与认证/同步错误/仓库身份（UUID 与绑定比对）/本地内容缺失（返回 status+level+hints+indexPage）；`site_workcopy_health` 单独检查网站备份工作副本（`data/site-wc`，报告 id 为 `site-backup`，仅在「检查全部」时附带）。`repair_repo` 执行网站备份 `svn cleanup`（修不好自动移入 `data/trash`）+ **强制重新拉取**（`force=True` 绕过「远端版本未变化不拉取」短路，恢复本地被删/损坏的文件）；`recreate_repo` 先移目录到 `data/trash`，再 `rebind=True` 允许远端 UUID/地址变化并重置 published_revision 后强制拉取（远端库被重建时用）。接口 `POST /__admin/repo-health|repo-repair|repo-recreate`（管理员 + CSRF，`id` 可为 `site-backup`：只处理网站备份工作副本，重建会重新检出并立即备份）。「创建并拉取」/`repo-repair|recreate` 优先使用仓库凭据。
- `GET /__folders` 只列 `docs/md` 的**一级**子文件夹（仓库映射以一级目录为单位），并附带 `sizeBytes`/`files`（递归含附件）、分类统计 `mdFiles`/`mdBytes`（Markdown）、`otherFiles`/`otherBytes`（附件等）、`subfolders`/`nestedFiles`/`nestedBytes`（子文件夹及其内文件，已计入前两类）与 `latestUpdate`（`source=publish` 时来自 `operations` 最近发布记录的作者/时间，否则回退最新文件修改时间，`database.folder_latest_updates` 提供聚合查询）。配置页「刷新文件夹信息」按钮即重新拉取该接口并重绘。`POST /__admin/repo-health` 对 `sourceMode=local` 的仓库返回 `本地模式`（level ok），不做 SVN 检查。
- 仓库写权限：`readOnly` / `allowCommit=false` 的仓库在 `/__svn/prepare`、`/__svn/commit` 返回 403 （`repo_read_only` / `repo_commit_disabled`），编辑器也会提示只读；`PUT /__config` 与「创建并拉取」后会触发站点重建。
- 编辑器布局：`.md-editor-body` 用 **flex**（大纲固定 210px → 源码区宽度由拖拽分栏设置 → 6px 分隔条 → 预览占剩余）；不要再改回「三列 grid」，否则新增大纲后预览会被挤到第二列并被遮挡（大纲宽度按可用区域计算拖拽百分比）。
- 搜索结果阅读模式下：命中工具条（sticky，z-index 960）在上，操作行通过 `--reading-toolbar-h` 下移（z-index 940）两者同时可见；不要再把操作行隐藏或让两者同 top 重叠。正文命中高亮有四点容易踩坑：① **不能排除 `.anchor`**（docsify 把标题文字包在 `a.anchor` 里，排除后标题命中不会高亮）；② docsify 重新渲染会替换正文节点，已采集的 `Range` 会**塌缩失效**，应用高亮前必须用 `readingRangesValid()` 校验并在失效时 `refreshReadingMatches()` 重新采集（`buildReadingMode` 的 `domIntact` 分支与 400/1200/2600ms 延迟检查都会兜底）；③ 无 Highlight API 的浏览器走 `<mark>` 回退，重采集前必须先 `clearReadingMarks()`（含 normalize）再 `wrapReadingMatches()`，否则 `<mark>` 会重复嵌套；④ `::highlight()` 只保证支持 `background-color`，不要写 `background` 简写。关键词跨页交接用 `localStorage`（`md2web:search-reading` + 2 分钟有效期，sessionStorage 不跨标签页）：docsify 页的搜索结果点击在 `handleSearchResultNavigate` 记录，总览页 `index.html` 的搜索点击在 `MASTER_SCRIPT` 里记录，目标页索引就绪后由 `restoreReadingQuery()` 恢复。
- 放大查看按「整体适配」打开（`Math.min(1, fitScale())`）：大于视口的时序图/甘特图/四象限图会先缩小到完整可见，重渲染后以新 SVG 的 viewBox 刷新尺寸并重新适配，避免文字与线条被裁掉；需要细看再用「适应 / 1:1」或滚轮缩放。
- 放大查看/导出禁止直接克隆已渲染的 SVG（会丢文字或箭头）：Mermaid 走 `MermaidRender.render(data-source)`，PacketDiag 走 `PacketDiagRerender(figure)`。
- 本文目录固定靠窗口右缘（`--docs-toc-right`），左边缘为拖动手柄调整**宽度**（`md2web:toc-width`，写入 `--docs-toc-width`）；目录内容放在内层 `.docs-page-toc-scroll`，外层禁止横向滚动，拖动手柄才不会被滚动条带偏。
- 忘记管理员密码用 `python serve.py --reset-admin-password`（`database.reset_admin_password` 强制写回默认值）；不要在网页接口里提供”重置为默认“的公开入口。
- `PUT /__config` 为热应用：校验 → 原子写配置文件 → 原地更新内存配置 → 重建认证源摘要；AI 默认值（含 Key）只下发给已登录用户，匿名会话不下发。
- 草稿保存必须带 `expectedVersion`（或 `baseHash`）；版本不符返回 409 且不回写任何文件——不要恢复“再次保存强制覆盖”。
- 提交使用的 SVN 凭据：优先数据库里最新保存的（登录成功即加密更新），其次当前会话内存；管理员本机账号没有 SVN 口令，提交时补充并立即校验并保存，`needs_auth` 状态允许带凭据重试；口令被 SVN 拒绝时自动清理库内旧密文；旧版 svn 客户端不支持 `--password-from-stdin` 时回退到命令行参数（仅本机可见，建议升级）
- 提交状态机与幂等：同一 `operationId` 重复提交直接返回已有结果；不确定（超时/断网）标记 `uncertain` 且绝不自动重试；发布写 docs/md 前核对 hash，站点重建由 watcher 完成。
- 服务默认按认证模式启动（`--preview` 才是只读预览）；缺少 Flask/Waitress 时给出安装提示，不静默回退匿名写。
- 搜索的排除词语法为 `-词`，短语为 `"词 组"`；改动 `parseQuery` 时注意与 UI 提示保持一致。
- 搜索仓库过滤使用 `state.repoFilter`，仓库 = `md/` 下一级文件夹，见 `routeRepoName`；筛选菜单由 `renderRepoMenu`/`syncRepoFilterUI` 渲染，两个视图共用一份状态，改动过滤逻辑时同步更新 `tests/test_search.js` 的仓库过滤用例。
- 搜索设置图标只提供“模式”和“仓库”两个筛选：移除范围控件；仓库菜单支持全部仓库、任意仓库多选和当前入口页对应的本仓库快捷项；默认模式 `both` 同时搜索文档名与正文，并在结果中分为“文档名匹配”“全文匹配”两组。入口页的当前仓库通过搜索索引条目的 `site` 映射到 `routeRepoName`。
- **站点页面在 `docs/html/`**：页面 head 必须保留 `<base href="../">`（相对路径含 API 都按站点根解析），docsify 用 `basePath: "../"`、`alias` 值 `html/_sidebar.md`、`homepage: html/README.md`、`customSearch.indexPath: html/search-index.json`；页面间链接与 `web/*.js` 里的入口链接一律写 `html/index_*.html`（`entryPage()`/`folder-view.js`/`md2web-feedback.js` 已统一）。`docsify.min.js` 的 hash 规范化补丁必须用 `slice(0,0<=n?n:location.href.length)`（`<base>` 下相对 `#/` 会被解析到站点根，导致跳错页）。
- 反馈截图/附件目录固定为 `docs/html/images`（`documents.FEEDBACK_IMAGE_REL`，命名 `fb-<时间戳>-<序号>.<扩展名>`）与 `docs/html/uploads`（`FEEDBACK_UPLOAD_REL`，沿用原文件名、重名加序号、禁止可脚本化后缀）；提交反馈时服务端只保留 `html/images|uploads/` 下真实存在的文件路径，卡片按 `html/images/...` 相对路径展示（页面带 `<base>` 时正好解析到站点根）。
- 离线快照（`docs/lib/offline-data*.js`）的键以**站点根**为基准：md 用 `md/...`，侧栏/首页用 `html/_sidebar*.md`、`html/README.md`；`offline-file.js` 的 `SITE_BASE` 取 `lib/` 的上一级（`document.currentScript`），不要改回按页面目录计算。
- 编辑器文字颜色用 `<span style="color:…">`；`web/sanitize.js` 已改为**只放行 `color` 单属性**（DOMPurify `afterSanitizeAttributes` 钩子 + 正则白名单），不要再把 `style` 加回 `FORBID_ATTR`，否则预览里颜色会消失（站点渲染不经过 `Sanitize`，只有编辑器预览/AI 回答经过）。
- 附件目录名固定为 `附件/`（`documents.ATTACHMENT_DIR_NAME`），与 `images/` 同级；上传沿用原文件名（清理链接敏感字符、重名加 `-2/-3`），并禁止 `.html/.js/.svg` 等可脚本化后缀（同源静态分发有 XSS 风险）。提交随带依赖 `documents.referenced_attachments` 解析 `[名称](附件/…)` 与 `<a href="附件/…">`，改动目录名或链接写法要同步更新解析与测试。
- 配置页 SVN 明细行（`.repo-detail`）是 12 栅格：仓库 ID（只读展示 `.repo-id-auto`，自动生成）/更新频率各 3 列、SVN 地址 6 列、权限与操作按钮整行；标签在上输入框在下，窄屏（≤980px/≤620px）逐级降为 6/12 列。改布局时保持 `.repo-field-*` 类名与 `md2web-config.js` 中 `repoRow` 的 class 对应；不要恢复成让用户手填仓库 ID（`data-repo="id"` 只作为隐藏字段保留既有值）。
- SVN 配置页只让用户填写地址与更新频率；ID 由文件夹名稳定生成，既有 ID 必须保留，移除映射行通过 `data-repo-removed` 标记避免保存时又自动生成。频率必须是有限的非负数；同步若因活动草稿产生冲突，即使远端版本不变也要持续报告，直到草稿解决。
- `web/plot-playground.html` 的返回链接指向 `html/index_all.html`（页面位于 `docs/lib/`，相对站点根解析）。

## 完成前检查清单

1. **用 Python 3.6.8 跑** `python -m unittest discover -s tests` 全绿（含 `tests/test_server.py`：配置、数据库、SVN 假 CLI、登录会话、静态白名单）；不再跑 3.12
2. `node --test tests/test_search.js`、`node --test tests/test_packetdiag.js`、`node --test tests/test_ai_retrieval.js`、`node --test tests/test_text_find.js`、`node --test tests/test_folder_view.js` 全绿
3. `node --check web/custom-search.js`、`web/workspace.js`、`web/mermaid-init.js`、`web/media-viewer.js`、`web/packetdiag.js`、`web/packetdiag-init.js`、`web/page-export.js`、`web/md-editor.js`、`web/text-find.js`、`web/math-init.js`、`web/prism-init.js`、`web/auth.js`、`web/sanitize.js` 通过
4. **用 3.6.8 跑** `python setup_docsify.py` 后 `git status` 无意外生成物差异（构建幂等）
5. `docs/md` 内容逐字节未变
