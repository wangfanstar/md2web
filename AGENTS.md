# AGENTS.md — AI 助手开发指南

> 面向在本仓库工作的 AI 助手（opencode / Claude Code / Codex 等）；人类维护者亦可参考。

## 项目概览

md2web 把 `docs/md/` 下的 Markdown 构建成**完全离线可用**的 Docsify 文档站（产物在 `docs/`）。

- 运行时：Python 3.8+（仅标准库，无需 pip/Node.js）；前端为原生 JS/CSS + Docsify 4.13.1 + Prism 1.29.0 + Mermaid 11.17.2，全部本地化
- 支持 Windows 与 Linux；`file://` 双击与 HTTP 预览均可用
- Python 版本：**3.6.8 及以上统一支持**（构建/只读预览仅标准库；认证编辑服务 `python3 -m pip install -r server/requirements.txt`）。新增代码必须通过 `Python36CompatibilityTests`（3.6 语法解析 + 禁用 3.7+ API 清单）。
- 仓库是**公开仓库**：不要提交密钥、令牌或敏感文档；AI 助手的 API Key 只允许存在浏览器 localStorage（`window.AI_ASSISTANT_CONFIG` 也仅作可选预置，禁止把 Key 写进被提交的文件）

## 架构与数据流

```text
docs/md/**/*.md ──scan──> setup_docsify.py ──生成──> docs/_sidebar.md
                                          ├─ docs/README.md         (首页索引)
                                          ├─ docs/search-index.json (搜索索引)
                                          ├─ docs/lib/offline-data.js (file:// 内嵌快照)
                                          └─ docs/index.html        (站点入口)
web/*.{js,css}  ──copy──> docs/lib/*      (前端源码在 web/，产物在 docs/lib/)
docs/lib/<第三方依赖>                       (离线依赖，缺失时才联网补齐)
```

## 文件职责

| 路径 | 职责 |
|------|------|
| `setup_docsify.py` | 构建：扫描、编码校验、依赖复用/下载、Prism 组件、生成导航/首页/索引/离线数据/入口 |
| `serve.py` | 跨平台入口：默认**只读预览**（静态站点 + 自动重建 + 本机 AI 代理，写接口一律 403）；`--config config/server.local.json` 启动认证编辑服务（Flask + Waitress）；按 pidfile 只管理本项目自身实例 |
| `server/config.py` | 配置加载/校验：存储路径不得在 `docs/` 内、mount 唯一且禁止越界、URL 仅 http/https、仓库存目录段最长前缀匹配 |
| `server/database.py` | SQLite 访问层：7 张表迁移 v2（users 含 role/password_hash，首次启动创建 admin/admin）、外键与 busy_timeout、`backup_to` |
| `server/svn.py` | 唯一的 svn 子进程入口：`--password-from-stdin`（口令绝不进 argv）、匿名可读检测、错误分类（含冲突/远端不存在）、info/log XML 解析、检出/稀疏更新/差异/提交/导出，超时与脱敏 |
| `server/auth.py` | SVN 登录、本地管理员登录/改密、会话（token 只存摘要、闲置/绝对过期）、CSRF、限速、审计；重启与认证源变更使 SVN 旧会话失效（保留管理员会话）；数据库访问串行化 |
| `server/passwords.py` | 管理员口令哈希（PBKDF2-HMAC-SHA256）与校验 |
| `server/operations.py` | 提交任务：审阅清单冻结、私有工作副本（稀疏检出）、UUID/URL 绑定核对、幂等 operation、状态机（prepared/running/svn_committed/published/failed/uncertain/needs_auth）、发布到 docs/md 与 published_revision、远端同步导出 |
| `server/drafts.py` | 个人草稿与版本历史：乐观并发（expected_version → 409）、不可变 revision 全文快照、统一差异（published/draft/版本号）、放弃草稿 |
| `server/documents.py` | 受管 Markdown 读写底层：路径校验、EOL 保持、唯一临时文件 + 原子替换、必填 `base_hash` 冲突检测 |
| `server/app.py` | Flask 应用：`/__auth/session|login|logout`（含 `mode:admin`）、`GET/PUT /__config`、`POST /__config/test-auth`、`POST /__admin/password`（均要求管理员 + CSRF）、草稿接口（`/__md/document|draft|history|diff|revision|discard`）、SVN 接口（`/__svn/info|log|prepare|commit|refresh`、`/__operations/<id>`；提交支持管理员补充 SVN 凭据）、写接口守卫（匿名 401、旧 `/__md/save` 410）、静态分发白名单与安全响应头 |
| `server/paths.py` | 静态分发禁止清单（点目录、`.svn`、`data/`、`config/`、临时/数据库/源码文件），预览与认证服务共用 |
| `web/auth.js` / `.css` | 登录状态与弹窗（`window.SiteAuth`）：会话刷新、登录/退出、侧栏指示器、只读模式提示、管理员角色与 AI 默认值下发 |
| `web/settings.js` / `.css` | 统一设置弹窗（`window.Settings`，侧栏单一入口）：本机 AI 设置（服务商/接口/模型/Key/代理/**参考源码路径**/资料范围，浏览器 localStorage）、管理员登录、SVN 认证路径与测试、仓库映射增删、全站 AI 默认值、管理员改密；服务端保存走 `PUT /__config` 热应用 |
| `web/sanitize.js` | 前端净化入口（`window.Sanitize`，基于离线 DOMPurify）：阅读/预览/AI 回答统一净化 |
| `config/server.example.json` | 认证服务示例配置（可提交）；`config/server.local.json` 为真实配置，不提交（缺失时 `--config` 会自动生成默认文件） |
| `tests/test_server.py` | 认证服务单元/HTTP 集成测试（配置、数据库、SVN 假 CLI、登录会话、静态白名单） |
| `web/custom-search.js` / `.css` | 搜索算法与界面、结果列表、搜索/目录视图切换、正文命中高亮、右侧本文目录 |
| `web/workspace.js` / `.css` | 目录树（折叠/过滤/计数/定位）、面包屑、首页卡片、复制、查看源码/编辑/下载 MD、章节序号、Mermaid 样式 |
| `web/mermaid-init.js` | docsify 插件：把 ```mermaid 围栏渲染为图形（离线）；容器保留 `data-source`，并暴露 `window.MermaidRender.render(source)` 供放大查看/导出重渲染 |
| `web/packetdiag.js` | PacketDiag 解析与 Canvas 绘制核心（从 `PacketDiagPic.html` 抽取，`window.PacketDiag = { parse, render, presets, defaultSource, extractSource, bitOrderFor, numberingFor }`）；支持 `bit_order`/`numbering`/`@row`/`@left`/`desctable` 等扩展语法 |
| `web/packetdiag-init.js` | docsify 插件：把 ```packetdiag 围栏渲染为报文图（figure 保留 `data-source`），失败回退源码；暴露 `PacketDiagRerender`（按源码重绘 data URL）与 `PacketDiagEnsureRendered`（导出前修复空白画布） |
| `web/media-viewer.js` | 图片、Mermaid 图形与 PacketDiag 图形的全屏放大查看（放大时用 `MermaidRender.render(source)` 重渲染、PacketDiag 用 `PacketDiagRerender` 重绘，避免克隆丢字/丢箭头）与下载（Mermaid 导出 SVG/PNG，PacketDiag 导出 PNG） |
| `web/page-export.js` | 「下载本页」：把当前文档导出为自包含 HTML（样式内联、Canvas/图片转 data URL、本文目录固定左侧导航；导出前会调用 `PacketDiagEnsureRendered` 重绘空白画布） |
| `web/md-editor.js` | 「编辑 MD / 下载 MD」（含草稿、历史、差异、提交 SVN 与 SVN 日志）：双栏编辑器（左：可拖拽分栏的 Markdown 高亮源码；右：marked + Prism + Mermaid + PacketDiag + KaTeX 实时预览）、工具栏与快捷键、`Ctrl+S` 直连写回（HTTP 走 `/__md/save`，file:// 走 File System Access/下载）；`window.MdEditor = { open, download, save, close }` |
| `web/math-init.js` | docsify 插件：`$...$` / `$$...$$` 等分隔符的 KaTeX 离线渲染；暴露 `window.MathRender.render` 供编辑器预览复用 |
| `web/prism-init.js` | docsify 插件：`beforeEach` 阶段按围栏语言预载 Prism 组件，保证 docsify 渲染期即可高亮（docsify 内置 Prism 覆盖了 `window.Prism`，autoloader 必须在其之后加载） |
| `web/ai-retrieval.js` | AI 助手的离线检索核心（纯函数，`window.AIRetrieval`）：分词（CJK 单字+双字）、从 `searchIndex`/Markdown 构建语料、TF-IDF 打分、摘录与上下文/消息组装；`tests/test_ai_retrieval.js` 覆盖 |
| `web/ai-assistant.js` / `.css` | AI 助手聊天面板与独立配置弹窗（`window.AIAssistant`）：设置面板（服务商预设、接口地址、模型、Key、代理策略，Key 仅存 localStorage）、**资料范围勾选**（按文件夹/文档过滤检索）、**上传文档**（.md/.txt，仅本机 localStorage，≤512 KB）、本地检索 + 引用来源、OpenAI/Anthropic 风格流式 SSE 解析、直连失败自动走 `/__ai/chat` 代理；侧栏「AI 配置」图标与对话面板 ⚙ 均可打开配置 |
| `tests/test_ai_retrieval.js` | AI 检索算法测试（`node --test`） |
| `web/plot-playground.html` | 独立绘图在线预览页（Mermaid 全部类型模板 + PacketDiag 增强控件与完整语法说明、一键复制源码、下载），构建复制到 `docs/lib/`；`docs/md/使用说明/绘图示例.md` 与之保持全部样例同步（`tests/test_setup_docsify.py::DrawingExamplesTests` 校验） |
| `docs/md/` | 唯一需要人工维护的源文档目录 |
| `docs/lib/` | 离线依赖 + 生成资源，不要手工修改 |
| `docs/` 其余文件 | `index.html`、`README.md`、`_sidebar.md`、`search-index.json`、`offline-data.js` 等，均由构建生成 |
| `tests/test_setup_docsify.py` | Python 回归测试（unittest，全程离线） |
| `tests/test_search.js` | 搜索算法测试（`node --test`） |
| `tests/test_packetdiag.js` | PacketDiag 解析回归测试（`node --test`） |
| `specs/` | 设计与计划文档（历史归档，新增设计放这里） |

## 常用命令

```bash
python setup_docsify.py                 # 完整构建（依赖已存在时全程离线）
python setup_docsify.py --index-only    # 仅重建搜索索引与离线数据
python setup_docsify.py --title "我的文档"
python setup_docsify.py --offline       # 严格离线：依赖缺失时报错，不尝试下载
python3 -m pip install -r server/requirements.txt  # 认证编辑服务依赖（3.6.8+ 通用，仅认证模式需要）
python serve.py                         # 默认认证编辑服务（认证模式下需先安装上面的依赖）
python serve.py --preview               # 只读预览 http://localhost:3000（无写接口）
python serve.py --reset-admin-password  # 忘记管理员密码时强制恢复为默认 admin/admin
python -m unittest discover -s tests -v
node --test tests/test_search.js
node --test tests/test_packetdiag.js
node --test tests/test_ai_retrieval.js
node --check web/custom-search.js       # 前端语法检查（workspace/mermaid-init/media-viewer/packetdiag/page-export/md-editor/math-init/prism-init/ai-assistant/ai-retrieval/auth/sanitize 同理）
```

## 不可破坏的约定

1. **构建绝不修改 `docs/md/`**：不删除、不移动、不重写源文档；新增/删除文档由用户操作。编辑器的 `Ctrl+S` 是用户主动触发（经本机预览服务写回），不属于构建行为。
2. **生成物不手工维护**：`docs/index.html`、`docs/README.md`、`docs/_sidebar.md`、`docs/search-index.json`、`docs/lib/` 下生成资源都会被构建覆盖。
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
- SQLite 连接由 Waitress 多线程共享：`database.connect` 使用 `check_same_thread=False`，所有访问必须经 `AuthService._db_lock` 串行化；数据库写锁不得跨越 SVN 网络调用。
- 服务启动只按 pidfile 终止本项目自身实例；不要再恢复“扫描并终止所有 serve.py 进程”的行为。
- 认证模式直接绑定配置端口：端口被占用时打印明确提示（不会自动换端口）；重复双击启动靠 pidfile 关闭旧实例。`start_windows.bat` 保持纯 ASCII（cmd 用 OEM 代码页解析，中文会破坏脚本）。
- `start_linux.sh` 必须保持 LF + 可执行位（`.gitattributes` 已声明 `*.sh text eol=lf`）；脚本内置 CRLF 自愈（`sh start_linux.sh` 也会去 CR 后重执行），`start_windows.bat` 必须纯 ASCII。
- `--svn-command` 支持带空格的路径（Windows 用双引号包住）；测试用假 svn 可执行文件注入，真实认证需要能连通的强制认证 SVN 路径。
- 本地管理员默认 `admin / admin`（PBKDF2 存库）：仅用于网页「设置」；部署后必须尽快改密。修改 SVN 认证路径只失效 SVN 用户会话，管理员会话保留。
- 本机管理员账号只能本地编辑（草稿）与配置；提交 SVN 时要求补充 SVN 账号（仅会话内存），界面与提示不得暗示本机账号可直接合入。
- 登录接口会自动识别本机管理员账号（`auth_source_id = local-admin`）：直接用本地口令校验并以管理员身份登录，**不需要 SVN 校验**；普通账号仍走 SVN 认证路径。
- 搜索结果阅读模式下：命中工具条（sticky，z-index 960）在上，操作行通过 `--reading-toolbar-h` 下移（z-index 940）两者同时可见；不要再把操作行隐藏或让两者同 top 重叠。
- 放大查看/导出禁止直接克隆已渲染的 SVG（会丢文字或箭头）：Mermaid 走 `MermaidRender.render(data-source)`，PacketDiag 走 `PacketDiagRerender(figure)`。
- 本文目录固定靠窗口右缘（`--docs-toc-right`），左边缘为拖动手柄调整**宽度**（`md2web:toc-width`，写入 `--docs-toc-width`）；目录内容放在内层 `.docs-page-toc-scroll`，外层禁止横向滚动，拖动手柄才不会被滚动条带偏。
- 忘记管理员密码用 `python serve.py --reset-admin-password`（`database.reset_admin_password` 强制写回默认值）；不要在网页接口里提供”重置为默认“的公开入口。
- `PUT /__config` 为热应用：校验 → 原子写配置文件 → 原地更新内存配置 → 重建认证源摘要；AI 默认值（含 Key）只下发给已登录用户，匿名会话不下发。
- 草稿保存必须带 `expectedVersion`（或 `baseHash`）；版本不符返回 409 且不回写任何文件——不要恢复“再次保存强制覆盖”。
- 提交只用**当前会话的 SVN 凭据**（登录时记入进程内存，退出/过期/重启即失效）；管理员本机账号没有 SVN 口令，提交时补充并立即校验，`needs_auth` 状态允许带凭据重试。
- 提交状态机与幂等：同一 `operationId` 重复提交直接返回已有结果；不确定（超时/断网）标记 `uncertain` 且绝不自动重试；发布写 docs/md 前核对 hash，站点重建由 watcher 完成。
- 服务默认按认证模式启动（`--preview` 才是只读预览）；缺少 Flask/Waitress 时给出安装提示，不静默回退匿名写。
- 搜索的排除词语法为 `-词`，短语为 `"词 组"`；改动 `parseQuery` 时注意与 UI 提示保持一致。

## 完成前检查清单

1. `python -m unittest discover -s tests -v` 全绿（含 `tests/test_server.py`：配置、数据库、SVN 假 CLI、登录会话、静态白名单）
2. `node --test tests/test_search.js`、`node --test tests/test_packetdiag.js`、`node --test tests/test_ai_retrieval.js` 全绿
3. `node --check web/custom-search.js`、`web/workspace.js`、`web/mermaid-init.js`、`web/media-viewer.js`、`web/packetdiag.js`、`web/packetdiag-init.js`、`web/page-export.js`、`web/md-editor.js`、`web/math-init.js`、`web/prism-init.js`、`web/auth.js`、`web/sanitize.js` 通过
4. `python setup_docsify.py` 后 `git status` 无意外生成物差异（构建幂等）
5. `docs/md` 内容逐字节未变
