# AGENTS.md — AI 助手开发指南

> 面向在本仓库工作的 AI 助手（opencode / Claude Code / Codex 等）；人类维护者亦可参考。

## 项目概览

md2web 把 `docs/md/` 下的 Markdown 构建成**完全离线可用**的 Docsify 文档站（产物在 `docs/`）。

- 运行时：Python 3.8+（仅标准库，无需 pip/Node.js）；前端为原生 JS/CSS + Docsify 4.13.1 + Prism 1.29.0 + Mermaid 11.17.2，全部本地化
- 支持 Windows 与 Linux；`file://` 双击与 HTTP 预览均可用
- 仓库是**公开仓库**：不要提交密钥、令牌或敏感文档

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
| `serve.py` | 跨平台预览：端口回退、自动替换旧实例、运行期每 2s 检测 `docs/md` 变化并自动重建 |
| `web/custom-search.js` / `.css` | 搜索算法与界面、结果列表、搜索/目录视图切换、正文命中高亮、右侧本文目录 |
| `web/workspace.js` / `.css` | 目录树（折叠/过滤/计数/定位）、面包屑、首页卡片、复制、宽屏、章节序号、Mermaid 样式 |
| `web/mermaid-init.js` | docsify 插件：把 ```mermaid 围栏渲染为图形（离线） |
| `docs/md/` | 唯一需要人工维护的源文档目录 |
| `docs/lib/` | 离线依赖 + 生成资源，不要手工修改 |
| `docs/` 其余文件 | `index.html`、`README.md`、`_sidebar.md`、`search-index.json`、`offline-data.js` 等，均由构建生成 |
| `tests/test_setup_docsify.py` | Python 回归测试（unittest，全程离线） |
| `tests/test_search.js` | 搜索算法测试（`node --test`） |
| `specs/` | 设计与计划文档（历史归档，新增设计放这里） |

## 常用命令

```bash
python setup_docsify.py                 # 完整构建（依赖已存在时全程离线）
python setup_docsify.py --index-only    # 仅重建搜索索引与离线数据
python setup_docsify.py --title "我的文档"
python setup_docsify.py --offline       # 严格离线：依赖缺失时报错，不尝试下载
python serve.py                         # 预览 http://localhost:3000
python -m unittest discover -s tests -v
node --test tests/test_search.js
node --check web/custom-search.js       # 前端语法检查（workspace/mermaid-init 同理）
```

## 不可破坏的约定

1. **构建绝不修改 `docs/md/`**：不删除、不移动、不重写源文档；新增/删除文档由用户操作。
2. **生成物不手工维护**：`docs/index.html`、`docs/README.md`、`docs/_sidebar.md`、`docs/search-index.json`、`docs/lib/` 下生成资源都会被构建覆盖。
3. **前端源码在 `web/`**：改搜索/工作台/样式要改 `web/`，再运行构建同步到 `docs/lib/`；不要直接改 `docs/lib/`。
4. **完全离线**：运行时不得请求 CDN；新增第三方库必须保存到 `docs/lib/` 并登记到 `setup_docsify.py` 的 `ASSETS`（含固定版本 URL）。
5. **失败要早、要清楚**：`docs/md` 缺失/为空、非 UTF-8 文档等应在写任何文件前抛 `BuildError`，错误信息带路径。
6. **索引语义一致**：Python 预构建 `build_page_index` 与浏览器重读 `buildSearchPage` 必须一致——代码围栏内容进入正文、代码内 `#` 不生成标题、首个标题前不落空壳条目。
7. **Mermaid 围栏不交给 Prism**：`collect_fence_languages` 必须忽略 `mermaid`（`IGNORED_FENCE_LANGS`），由 `web/mermaid-init.js` 渲染。
8. **UI 令牌统一**：颜色/字体使用 `--docs-*` 变量；`--docs-accent`（#1f6feb）只用于当前项/命中/焦点；路径、标识符、计数用等宽字体。
9. **章节序号**：正文 h2–h4 由 CSS 计数器生成，右侧目录编号由 `buildPageToc` 生成，两者规则需保持一致（1 / 1.1 / 1.1.1）。

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
- `docsify` 会逐目录请求 `_sidebar.md`，已在 `index.html` 用 `alias` 回落到根侧栏；不要移除。
- 搜索的排除词语法为 `-词`，短语为 `"词 组"`；改动 `parseQuery` 时注意与 UI 提示保持一致。

## 完成前检查清单

1. `python -m unittest discover -s tests -v` 全绿
2. `node --test tests/test_search.js` 全绿
3. `node --check web/custom-search.js`、`web/workspace.js`、`web/mermaid-init.js` 通过
4. `python setup_docsify.py` 后 `git status` 无意外生成物差异（构建幂等）
5. `docs/md` 内容逐字节未变
