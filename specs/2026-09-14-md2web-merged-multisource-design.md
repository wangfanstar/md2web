# md2web 合并架构与多源支持设计

- 日期：2026-09-14
- 状态：待评审
- 范围：`setup_docsify.py` 重构、`docs/` 单产物目录合并、多源文件夹支持、跨平台预览与测试

## 1. 背景与目标

当前项目提供 `setup_docsify.py`，把 `md/` 转成 Docsify 离线文档站。存在两个问题：

1. `webtool/lib/`（离线依赖缓存）与 `docs/lib/`（构建产物）内容重复，构建需要"依赖仓库 → 产物"的复制层，且 `webtool/lib/offline-data.js` 是上一项目的 18MB 生成物，语义混乱。
2. 只支持单一源目录，用户无法把多个文件夹的 Markdown 合并为一个可浏览、可搜索的站点。

目标：

- 合并 `webtool/` 与 `docs/`：`docs/` 成为唯一产物目录，站点与离线依赖同处一处，可独立分发。
- 支持配置多个源文件夹，合并为一个站点，统一浏览与搜索。
- Windows 与 Linux 下均可构建、浏览、搜索，构建全程可离线（依赖已存在时零网络请求）。
- 保持结构简单可维护：源 = `md/`（可加更多），产物 = `docs/`，工具 = 根目录脚本。

非目标（本次不做）：

- 实时文件监控、增量索引、编辑器/服务端集成
- 第三方 Python 依赖（仅标准库）
- 站点主题切换、多语言 UI
- 源文件夹的"透明合并"（不加分组目录的旧布局）——统一采用"每个源一个顶层分组"，规则简单一致

## 2. 术语

- **源（source）**：一个包含 `.md` 文件的文件夹，递归生效。
- **分组（group）**：源在站点中的顶层目录，同时是路由前缀，记为 `dir`。
- **产物（docs）**：`docs/` 目录，包含站点页面、同步的文档和 `lib/` 依赖。
- **依赖（assets）**：Docsify、Prism、插件等第三方 JS/CSS，以及构建时生成的 `custom-search.*`、`offline-*.js`。

## 3. 目标目录结构

```
md2web/
├── md/                       # 默认源（唯一需要手动维护的内容目录）
├── docs/                     # 唯一产物：站点 + 离线依赖
│   ├── lib/                  # 第三方依赖 + 生成的 JS/CSS
│   │   ├── docsify.min.js
│   │   ├── prism.min.js
│   │   ├── custom-search.js / custom-search.css
│   │   ├── offline-data.js / offline-file.js
│   │   └── components/       # Prism 语言组件
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   ├── search-index.json     # 搜索索引（生成）
│   └── <分组>/…              # 从各源同步的文档与图片
├── specs/                    # 设计文档（本目录，不属于产物）
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台本地预览
├── start_windows.bat         # Windows 一键预览
├── start_linux.sh            # Linux 一键预览
├── md_sources.json           # 多源配置（可选，仓库自带示例）
└── README.md                 # 工具使用说明
```

`webtool/` 目录取消；其 `lib/` 下依赖一次性并入 `docs/lib/`（见第 10 节迁移）。

## 4. 源配置

### 4.1 配置文件 `md_sources.json`

默认位置为项目根目录；存在时自动加载，可用 `--config PATH` 指定其他文件，`--no-config` 忽略。

```json
{
  "title": "文档中心",
  "sources": [
    { "path": "md", "label": "文档", "dir": "md" },
    { "path": "D:/work/notes", "label": "工作笔记" },
    "E:/refs"
  ]
}
```

- 顶层也可以直接是数组，等价于只提供 `sources`。
- `title`（可选）：站点标题，默认 `文档中心`；用于 `index.html` 的 `<title>` 与 Docsify 名称、首页标题。
- `path`（必填）：相对路径（相对配置文件所在目录）或绝对路径，支持 `~`。
- `label`（可选）：侧边栏/首页中的分组显示名，默认取文件夹名。
- `dir`（可选）：站点内分组目录名与路由前缀，默认取文件夹名的安全化结果。
- 字符串形式（如 `"E:/refs"`）等价于只提供 `path`。

校验与归一化规则：

1. 路径按 `resolve()` 去重，先出现者生效；解析后不存在的源打印警告并跳过。
2. 源根目录必须互相不嵌套（一个源在另一个源内部时报错退出）。
3. 源不能位于 `docs/` 内部，`docs/` 也不能位于源内部，否则报错退出。
4. `dir` 安全化：保留中英文、数字、`-_.`，其余字符替换为 `-`，去除首尾空格与点；结果为空时用 `source-N`。
5. `dir` 冲突（含 Windows 大小写不敏感比较）或与保留名冲突时，自动追加 `-2`、`-3` 并打印警告；若 `dir` 是用户在配置中显式指定的，则报错退出并提示改名。
6. 保留名只有 `lib`（依赖目录）。源内根级 `README.md` 位于 `docs/<dir>/` 内，不会与站点首页 `docs/README.md` 冲突。

### 4.2 命令行参数

| 参数 | 说明 |
|------|------|
| （无参数） | 使用 `md_sources.json`；不存在则使用默认源 `md/` |
| `--source-md PATH` | 追加一个源，可重复使用；与配置文件叠加 |
| 位置参数 `源md文件夹` | 兼容旧用法，等价于追加一个源 |
| `--output-docs PATH` / 位置参数 | 输出目录，默认 `docs/` |
| `--config PATH` | 指定配置文件 |
| `--no-config` | 忽略配置文件 |
| `--index-only` | 仅同步文档并重建搜索索引与离线数据，跳过依赖下载与站点文件生成 |

叠加规则：配置文件中的源在前，命令行追加的源在后，按 `resolve()` 路径去重；命令行源默认 `label`/`dir` 取文件夹名。构建开始时打印有效源清单（路径、标签、分组目录）。

## 5. 构建流程

`main()` 顺序：

1. 解析参数与配置，得到有效源列表；打印清单。
2. 校验源（第 4.1 节规则）；无有效源时报错退出。
3. 扫描：对每个源递归查找 `*.md`（跳过隐藏文件/目录，如 `.git`、`.obsidian`）；同时收集图片（所有 `images/` 目录 + 任意位置的 `.png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.ico`）。
4. 若所有源合计 0 个 `.md` 文件，报错退出，且不修改现有 `docs/`。
5. 依赖：确保 `docs/lib/` 下资源齐全（见第 7 节）；失败则报错退出，此时尚未修改 `docs/` 中的文档与页面。
6. Prism 语言组件：按步骤 3 收集的代码围栏语言解析依赖闭包，缺失组件按需下载（失败仅警告）。
7. 同步（镜像语义）：对每个源，先删除 `docs/<dir>`，再按相对路径复制 `.md` 与图片，保证产物与源一致，删除源中文件后产物不会残留。
8. 清理：删除 `docs/` 下不属于当前分组集合的顶层目录（跳过隐藏目录，保留 `lib/`）。
9. 生成 `custom-search.js/css`、`search-index.json`、`offline-data.js`、`offline-file.js`、`_sidebar.md`、`README.md`、`index.html`。
10. 打印完成信息与预览命令（`python serve.py`）。

`--index-only` 时执行步骤 1–4、7–8，然后仅重新生成 `search-index.json` 与 `offline-data.js`、`offline-file.js`；跳过依赖检查、Prism 组件和站点文件（`index.html`、`README.md`、`_sidebar.md`、`custom-search.*`）的生成。

## 6. 站点结构、路由与导航

### 6.1 路由

- 每个源映射为 `docs/<dir>/<源内相对路径>`，路由为 `/<dir>/<相对路径>`（统一 `/` 分隔）。
- 站点首页为 `/`（`docs/README.md`）。
- 示例：`md/指南/入门.md` → `docs/md/指南/入门.md` → 路由 `/md/指南/入门.md`。

### 6.2 侧边栏与首页

按「源分组 → 目录树」递归渲染，规则一致：

- 分组：`- **<label>**`，其下缩进子项。
- 目录节点：若目录直接包含 1 个 `.md` 且没有含文档的子目录，渲染为文件链接 `- [文件名](/<dir>/<相对路径>)`；否则渲染 `- **<目录名>**` 并缩进其子项。
- 文件节点：`- [文件名](/<dir>/<相对路径>)`；无文档的目录不显示。
- 首页 `README.md` 使用相对链接（`<dir>/<相对路径>`），便于 Docsify 路由解析。

示例：

```
- **文档**
  - **指南**
    - [入门](/md/指南/入门.md)
    - [进阶](/md/指南/进阶.md)
  - [常见问题](/md/常见问题.md)
- **工作笔记**
  - [周报](/notes/周报.md)
```

### 6.3 搜索

- `search-index.json` 收录首页与所有文档页；键为完整路由。
- 标题 slug 算法、索引深度（4 级）、锚点跳转逻辑保持现状。
- `compute_search_namespace` 覆盖全部源的文件路径与大小，源或文件变化时哈希变化（保留现有行为）。
- `file://` 模式下搜索索引与 Markdown 由 `offline-data.js` 提供，行为不变。

## 7. 依赖策略（合并后）

- `docs/lib/` 是唯一资源位置；产物自包含，分发只需拷贝 `docs/`。
- 资源存在且非空即复用：日常重建、`--index-only` 全程零网络。
- 资源缺失时才联网下载（首次构建或清理过 `docs/lib` 后）；下载失败则报错退出，列出缺失清单与修复指引（联网重跑，或从其他完整 `docs/lib/` 拷贝对应文件）。下载使用 30 秒超时、`.part` 临时文件原子替换并校验 `Content-Length`。
- 依赖清单：`ASSETS`（docsify、prism、插件）+ `components/` 下的 Prism 语言组件。
- `docsify.min.js` 的 `file://` 路由补丁、主题 CSS 外部字体清理在 `docs/lib/` 原地幂等应用；重复构建不重复修改。
- 生成物（`custom-search.*`、`offline-*.js`）由脚本直接写入 `docs/lib/`，不属于可复用依赖。

## 8. 跨平台预览

新增 `serve.py`（仅标准库，Python 3.8+）：

- 参数：`--port`（默认 3000，端口占用时自动 +1 重试）、`--bind`（默认 `0.0.0.0`）、`--dir`（默认脚本同级 `docs/`）、`--no-browser`。
- 使用 `ThreadingHTTPServer` + `SimpleHTTPRequestHandler(directory=...)`。
- 启动后打印本机地址与局域网地址（通过 UDP connect 探测本机 IP，失败时回退 `localhost`），并自动打开浏览器。
- `start_windows.bat`：切换到脚本目录，优先 `python serve.py`，失败回退 `py serve.py`。
- `start_linux.sh`：切换目录，优先 `python3 serve.py`，回退 `python serve.py`。
- 双击 `docs/index.html` 的 `file://` 模式继续可用：`offline-data.js` 内嵌全部 Markdown 与搜索索引，`offline-file.js` 拦截本地 XHR。

## 9. 错误处理

| 场景 | 行为 |
|------|------|
| 指定 `--config` 文件不存在 | 报错退出 |
| 配置文件 JSON 非法或结构错误 | 报错退出并说明期望格式 |
| 某个源不存在 | 警告并跳过；全部无效时报错退出 |
| 源互相嵌套 / 与 docs 嵌套 | 报错退出 |
| 所有源合计 0 个 md | 报错退出，不修改现有 docs |
| 依赖缺失且下载失败 | 报错退出，列出缺失文件与修复指引 |
| Prism 语言组件缺失且下载失败 | 警告，该语言不高亮，其余功能正常 |
| `docs/<dir>` 与保留名冲突（显式配置） | 报错退出并提示修改 `dir` |

## 10. 迁移步骤（一次性）

1. 创建 `docs/lib/`，把 `webtool/lib/` 下全部文件移入（含旧 `offline-data.js`，首次构建会覆盖为当前项目的离线数据）。
2. 删除空的 `webtool/` 目录。
3. 新增 `md_sources.json` 示例（默认源 `md/` → 标签"文档"、分组 `md`）。
4. 更新 `README.md` 为合并后的使用说明。

## 11. 测试计划

新增 `tests/test_setup_docsify.py`（`unittest`，纯离线，临时目录内构造伪 `docs/lib` 资源）：

1. 配置解析：对象/字符串/纯数组形式；路径去重；缺失源警告；非法 JSON 报错。
2. 多源同步：两个源生成两个分组；嵌套目录、根级 md、图片（`images/` 与散落图片）正确复制。
3. 镜像语义：删除源内文件/整个源后重建，产物中不残留。
4. 侧边栏/首页：分组与目录树、单文件目录直接链接、无文档目录隐藏。
5. 搜索索引：路由含分组前缀、首页条目、标题锚点。
6. 离线数据：包含全部 md（含 `_sidebar.md`）与搜索索引。
7. 依赖：已有伪资源时构建成功且不联网；缺失且无法下载时明确报错。
8. 命名空间：文件集合变化时哈希变化。

运行方式：`python -m unittest discover -s tests -v`。

## 12. 验收标准

1. 在 `docs/lib` 已有依赖的前提下，断网执行 `python setup_docsify.py` 构建成功。
2. `md_sources.json` 配置两个源时，`docs/` 下出现两个分组，侧边栏、首页、搜索结果均覆盖两组。
3. 源内嵌套目录与图片正确复制，源内删除文件后重建不残留。
4. `python serve.py` 在 Windows 与 Linux 均可浏览、搜索；`docs/index.html` 双击（`file://`）同样可用。
5. 依赖缺失且无网络时给出明确错误，不产生半成品站点。
6. `python -m unittest discover -s tests -v` 全部通过。
7. `README.md` 描述与实际行为一致。

## 13. 兼容性说明

- 位置参数与 `--source-md` 旧用法保留；默认行为从"仅 md/ 子文件夹"扩展为"递归扫描源内所有 md"。
- `--output-docs` 指定其他输出目录时，依赖写入该输出的 `lib/`，行为一致。
- 旧 `docs/` 产物在首次构建时会被镜像同步与清理覆盖，无需手动删除。
- Python 版本要求从 3.6+ 调整为 3.8+（`serve.py` 使用 3.7+ 标准库特性，统一按 3.8+ 说明）。
