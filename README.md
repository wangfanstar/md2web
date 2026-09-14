# Markdown 离线文档站生成器（md2web）

把多个文件夹里的 Markdown 一键转换成**完全离线可用**的 Docsify 文档站：产物自包含，拷贝到任意机器双击即可浏览与搜索；需要 Python 3.8+，仅用标准库，无需 pip/Node.js，支持 Windows 与 Linux。

## 特性

- 多源合并：`md_sources.json` 配置任意多个源文件夹，合并为一个站点，统一浏览与搜索
- 完全离线：依赖保存在 `docs/lib/`，运行时零外部请求；依赖存在时重建全程不联网
- 预构建搜索：构建时生成全文索引，支持侧边栏搜索、`Ctrl+K` 全局搜索、标题锚点跳转
- 离线代码高亮：按文档实际用到的语言准备 Prism 组件，cuda/p4/asm 自动近似高亮
- 跨平台预览：`python serve.py` 一键启动，Windows/Linux 通用；也可直接双击 `docs/index.html`
- 镜像同步：源里删除的文件或文件夹不会在产物中残留

## 目录结构

```
md2web/
├── md/                       # 默认源（唯一需要手动维护的内容目录）
├── docs/                     # 唯一产物：站点 + 离线依赖，可单独分发
│   ├── lib/                  # 离线 JS/CSS 与生成资源
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   ├── search-index.json     # 搜索索引（生成）
│   └── <分组>/…              # 从各源同步的文档
├── specs/                    # 设计文档
├── tests/                    # 离线回归测试
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台预览
├── start_windows.bat / start_linux.sh
├── md_sources.json           # 多源配置（可选）
└── README.md                 # 本文件
```

## 快速开始

### 1. 放文档

默认源为 `md/`，可任意组织子目录：

```
md/
├── 指南/
│   ├── 入门.md
│   └── images/flow.png
└── 常见问题.md
```

图片支持放在 `images/` 目录，或与文档同目录直接引用（`.png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.ico`）。

### 2. 配置多个文件夹（可选）

`md_sources.json`：

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

| 字段 | 必填 | 说明 |
|------|------|------|
| `title` | 否 | 站点标题，默认「文档中心」 |
| `path` | 是 | 源文件夹，相对配置文件所在目录或绝对路径 |
| `label` | 否 | 侧边栏/首页分组名，默认取文件夹名 |
| `dir` | 否 | 站点内分组目录，默认取文件夹名安全化结果 |

命令行参数（与配置文件叠加）：

| 场景 | 命令 |
|------|------|
| 默认构建 | `python setup_docsify.py` |
| 追加源（可重复） | `python setup_docsify.py --source-md D:/notes --source-md E:/refs` |
| 指定配置文件 | `python setup_docsify.py --config other.json` |
| 忽略配置文件 | `python setup_docsify.py --no-config` |
| 指定输出目录 | `python setup_docsify.py --output-docs site` |
| 仅同步并刷新索引 | `python setup_docsify.py --index-only` |

> 兼容旧用法：`python setup_docsify.py path/to/md path/to/docs`（位置参数指定源与输出）。
> `--index-only` 会镜像同步文档并刷新搜索索引与离线数据，但不会重建侧边栏与首页；新增文件要出现在导航中需执行一次完整构建。

### 3. 构建与预览

```bash
python setup_docsify.py     # 首次构建需联网下载依赖，之后离线可用
python serve.py             # 打开 http://localhost:3000
```

Windows 可双击 `start_windows.bat`，Linux 可执行 `sh start_linux.sh`。也可以直接双击 `docs/index.html`（file:// 模式，内容与索引内嵌）。

预览服务默认绑定 `0.0.0.0`，同一局域网内可访问，请勿在含敏感内容的文档站上使用；仅本机访问可执行 `python serve.py --bind 127.0.0.1`。用 `--output-docs site` 构建时，预览需执行 `python serve.py --dir site`。

### 4. 分发

只需要拷贝整个 `docs/` 目录；接收方双击 `docs/index.html` 或用任意静态服务器打开即可浏览、搜索、代码高亮。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试全程离线（临时目录 + 伪依赖），覆盖配置解析、多源扫描与镜像同步、依赖复用与报错、导航/首页/搜索生成、主流程端到端与预览服务。

## 常见问题

- **搜索无结果或过时**：搜索索引在构建时生成，修改文档后重新运行 `python setup_docsify.py`
- **依赖缺失且下载失败**：联网重跑，或把完整依赖文件复制到 `docs/lib/`
- **图片不显示**：确认图片在源文件夹内且路径大小写正确，重新构建
- **代码块不高亮**：检查围栏语言标记；Prism 不支持的语言会按近似语法高亮
- **文件名限制**：文件名包含 `#`、`?`、`%` 时链接与搜索路由可能失效，请避免使用这些字符
- **想彻底重建**：删除 `docs/` 后重新构建（需要联网一次重新获取依赖）
