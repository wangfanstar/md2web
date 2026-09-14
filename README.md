# Markdown 离线文档站生成器（md2web）

把 `docs/md/` 里的 Markdown 一键转换成**完全离线可用**的 Docsify 文档站：产物自包含，拷贝到任意机器双击即可浏览与搜索；需要 Python 3.8+，仅用标准库，无需 pip/Node.js，支持 Windows 与 Linux。

## 特性

- 单目录维护：源文档就在 `docs/md/`，构建**不复制、不移动、不删除**任何文档
- 完全离线：依赖保存在 `docs/lib/`，运行时零外部请求；依赖存在时重建全程不联网
- 预构建搜索：构建时生成全文索引，支持侧边栏搜索、`Ctrl+K` 全局搜索、标题锚点跳转
- 离线代码高亮：按文档实际用到的语言准备 Prism 组件，cuda/p4/asm 自动近似高亮
- 跨平台预览：`python serve.py` 一键启动，Windows/Linux 通用；也可直接双击 `docs/index.html`
- 目录即导航：`docs/md/` 下的子文件夹自动成为分组，无需额外配置

## 目录结构

```
md2web/
├── docs/                     # 唯一目录：源文档 + 站点 + 离线依赖
│   ├── md/                   # 源文档（唯一需要手动维护）
│   │   ├── 使用说明/快速开始.md
│   │   ├── 子文件夹1/*.md
│   │   └── images/…          # 图片任意位置，相对路径引用
│   ├── lib/                  # 离线 JS/CSS 与生成资源
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   └── search-index.json     # 搜索索引（生成）
├── specs/                    # 设计文档
├── tests/                    # 离线回归测试
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台预览
├── start_windows.bat / start_linux.sh
└── README.md                 # 本文件
```

## 快速开始

### 1. 放文档

在 `docs/md/` 下创建子文件夹并放入 `.md` 文件：

```
docs/md/
├── 指南/
│   ├── 入门.md
│   └── images/flow.png
└── 常见问题.md
```

图片无需登记，放在文档旁边或任意位置，用相对路径引用即可；文档仅支持 UTF-8 编码。

### 2. 构建与预览

```bash
python setup_docsify.py     # 首次构建需联网下载依赖，之后离线可用
python serve.py             # 打开 http://localhost:3000
```

| 场景 | 命令 |
|------|------|
| 完整构建 | `python setup_docsify.py` |
| 自定义标题 | `python setup_docsify.py --title "我的文档"` |
| 仅刷新索引与离线数据 | `python setup_docsify.py --index-only` |
| 预览 | `python serve.py`（`--port 8080`、`--bind 127.0.0.1`、`--no-browser`） |

Windows 可双击 `start_windows.bat`，Linux 可执行 `sh start_linux.sh`。也可以直接双击 `docs/index.html`（file:// 模式，内容与索引内嵌）。

> `--index-only` 只重建搜索索引与离线数据，不重新生成侧边栏与首页；新增文件要出现在导航中需执行一次完整构建。

预览服务默认绑定 `0.0.0.0`，同一局域网内可访问；仅本机访问可执行 `python serve.py --bind 127.0.0.1`。

### 3. 分发与备份

拷贝整个 `docs/` 目录即可：接收方双击 `docs/index.html` 或用任意静态服务器打开即可浏览、搜索、代码高亮。`docs/` 同时包含源文档，因此它也是唯一的备份对象。

> `docs/` 下除 `md/` 与 `lib/` 外的文件（`index.html`、`README.md`、`_sidebar.md`、`search-index.json`）由构建生成，请勿手工维护。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试全程离线（临时目录 + 伪依赖），覆盖扫描与导航、搜索索引、离线数据、依赖复用与报错、主流程端到端与预览服务。

## 常见问题

- **搜索无结果或过时**：搜索索引在构建时生成，修改文档后重新运行 `python setup_docsify.py`（或 `--index-only`）
- **依赖缺失且下载失败**：联网重跑，或把完整依赖文件复制到 `docs/lib/`
- **图片不显示**：确认图片在 `docs/md/` 内且相对路径大小写正确，重新构建
- **代码块不高亮**：检查围栏语言标记；`cuda`/`p4`/`asm` 会自动按近似语法高亮，其余 Prism 不支持的语言需自备组件，否则不高亮
- **文档编码要求**：仅支持 UTF-8 文档；非 UTF-8 文档构建会报错并指明具体文件
- **文件名限制**：文件名包含 `#`、`?`、`%` 时链接与搜索路由可能失效，请避免使用这些字符
- **想彻底重建**：删除 `docs/` 中除 `md/` 外的生成文件后重新构建（依赖缺失时需要联网一次）
