# md2web 单源就地架构设计（v2）

- 日期：2026-09-14
- 状态：已确认
- 取代：`2026-09-14-md2web-merged-multisource-design.md` 中的多源合并、镜像同步、配置文件与自定义输出部分

## 1. 背景与目标

v1 架构支持多源合并，但需要把源文档复制到 `docs/<分组>/`，维护者要同时面对 `md/`（源）与 `docs/`（副本），存在重复维护与误改风险。v2 改为**单源就地**：

- 源文档直接位于 `docs/md/`，站点运行时直接读取，**构建不复制、不移动、不删除任何源文档**
- 构建只生成导航（`_sidebar.md`）、首页（`README.md`）、搜索索引、离线数据与入口页
- 只维护一个文件夹：`docs/`

## 2. 目标目录结构

```
md2web/
├── docs/                     # 唯一目录：源文档 + 站点 + 离线依赖
│   ├── md/                   # 源文档（唯一需要手动维护）
│   │   ├── 使用说明/
│   │   │   └── 快速开始.md   # 示例文档
│   │   ├── 子文件夹1/*.md
│   │   ├── 子文件夹2/*.md
│   │   └── images/…          # 图片任意位置，相对路径直接引用
│   ├── lib/                  # 离线依赖 + 生成资源
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   └── search-index.json     # 搜索索引（生成）
├── specs/                    # 设计文档
├── tests/                    # 离线回归测试
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台预览
├── start_windows.bat / start_linux.sh
└── README.md
```

删除：根目录 `md/`、`md_sources.json`。

## 3. 构建流程

1. 校验 `docs/md/` 存在且递归包含至少一个 `.md`；否则抛出 `BuildError`，**不写任何文件**
2. `ensure_assets()`：`docs/lib/` 依赖存在即复用，缺失才下载（30s 超时、`.part` 原子替换、Content-Length 校验），失败报错并列出清单
3. `patch_docsify_file_router()`、`patch_docsify_css()`：幂等原地补丁
4. `ensure_prism_components(md_dir, md_files)`：按代码围栏语言准备组件，失败仅警告
5. `generate_custom_search_assets()`：生成 `custom-search.js/css`
6. `scan_markdown(docs/md)`：递归收集 `.md` 相对路径（posix），跳过隐藏路径
7. 生成 `_sidebar.md`、`README.md`、`search-index.json`、`offline-data.js`/`offline-file.js`、`index.html`
8. 打印预览命令

`--index-only`：执行 1、6，然后只重建 `search-index.json` 与 `offline-data.js`/`offline-file.js`（跳过依赖、Prism、导航与入口生成）。

**核心不变量**：构建过程不删除、不移动、不重命名 `docs/md/` 下任何内容；只覆盖上述生成文件。

## 4. 路由与导航

- 文档路由：`/md/<相对路径>`；站点首页：`/`
- 侧边栏：`- **文档列表**` + `docs/md` 目录树；目录直接含 1 个 `.md` 且无含文档子目录时折叠为文件链接
- 首页：`# <title>` + `## 文档列表` + 相对链接 `md/<相对路径>`
- 搜索索引：覆盖首页与全部文档；`file://` 模式下 `offline-data.js` 内嵌 `docs/**/*.md`（含 `_sidebar.md`）
- 图片：保留在 `docs/md` 内，按相对路径直接引用，无需登记或复制

## 5. 命令行接口

| 参数 | 说明 |
|------|------|
| （无参数） | 完整构建 `docs/md/` → `docs/` |
| `--title T` | 站点标题，默认「文档中心」 |
| `--index-only` | 仅重建搜索索引与离线数据 |

删除：`--source-md`、`--config`、`--no-config`、`--output-docs`、位置参数、`md_sources.json`。

## 6. 代码变更

**删除**：
- `SourceSpec`、`Source`、`load_config_file`、`load_source_specs`
- `resolve_sources`、`assign_group_dirs`、`sanitize_dir_name`、`WINDOWS_RESERVED_NAMES`、`_is_relative_to`
- `sync_sources`（镜像同步与过期清理）
- `collect_search_paths`、`compute_search_namespace`（仅用于日志，属遗留）
- `IMAGE_EXTENSIONS`、`RESERVED_GROUP_DIRS`
- `configure_paths`（输出固定为 `docs/`）

**保留（可能调整签名）**：
- `_download`、`ensure_assets`、`extract_autoloader_maps`、`resolve_prism_languages`
- `collect_fence_languages`（改为接收 md 根与相对路径列表）
- `build_page_index`、`_slugify_heading`、`build_doc_tree`、`render_doc_tree`
- `generate_sidebar`、`generate_readme`、`generate_search_index`、`generate_offline_data`、`generate_index_html`
- `read_markdown`、`display_path`、`BuildError`

**新增/调整**：
- 常量 `MD_DIR = DOCS_DIR / "md"`
- `scan_markdown(md_dir) -> list[str]`：递归收集 `.md` 相对路径，跳过隐藏路径，`.md` 大小写不敏感
- `generate_index_html(title)`：去掉 `search_paths`/`namespace` 参数
- `main`：单源流程，捕获 `(BuildError, OSError, UnicodeDecodeError)`

## 7. 安全与错误处理

| 场景 | 行为 |
|------|------|
| `docs/md/` 不存在 | `BuildError`，提示创建目录并放入文档，不写文件 |
| `docs/md/` 无 `.md` | `BuildError`，不写文件 |
| 非 UTF-8 文档 | `read_markdown` 报错并指明文件路径 |
| 依赖缺失且下载失败 | 报错并列出缺失清单与修复指引 |
| Prism 组件缺失且下载失败 | 警告，不影响其余功能 |
| 用户手工放入 `docs/md` 的文件/图片 | 构建不删除、不修改 |

## 8. 迁移步骤

1. 新建 `docs/md/`，放入示例文档 `docs/md/使用说明/快速开始.md`
2. 删除根 `md/`（当前仅 `.gitkeep`）与 `md_sources.json`
3. 首次构建：重新生成 `docs/lib` 中的 `offline-data.js`、`custom-search.*`、`offline-file.js`，替换 18MB 旧快照
4. 更新 `README.md`、`serve.py` 帮助文案与 specs 文档

## 9. 测试计划

重写 `tests/test_setup_docsify.py`（`unittest`，全程离线）：

1. `scan_markdown`：嵌套目录、隐藏路径跳过、`.MD` 大写扩展名
2. 树渲染：单文件叶子折叠、目录先于文件、空目录不显示
3. 生成：侧边栏（`/md/...` 链接）、首页（`md/...` 相对链接）、搜索索引路由、离线数据含 `_sidebar.md`、`index.html` 标题转义
4. 依赖：复用不下载、缺失报错、下载成功/失败/截断/超时（保留现有用例）
5. Prism：多语言收集、复用与警告、兜底闭包
6. 主流程：完整离线构建、`--title`、`--index-only`、`docs/md` 缺失报错、**构建不删除用户文件**
7. `serve.py`：端口 0 服务、端口回退、越界端口、缺 index.html

## 10. 验收标准

1. `python -m unittest discover -s tests -v` 全部通过（无网络访问）
2. `docs/md/` 放入文档后 `python setup_docsify.py` 构建成功，`docs/index.html` 可浏览、搜索、代码高亮
3. 修改 `docs/md` 文档后重新构建，搜索索引与离线数据更新
4. 构建前后 `docs/md` 内容逐字节不变（不删除、不移动、不修改）
5. 仓库不再包含 `md/`、`md_sources.json`、`webtool/`
6. `README.md` 描述与实际行为一致
