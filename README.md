# Markdown 离线文档站生成器

将 Markdown 文件夹一键转换为**完全离线可用**的 Docsify 文档站。构建完成后，整个输出文件夹可拷贝到任意环境，无需网络即可浏览、搜索。

## 项目简介

本项目提供一条简单的工作流：

1. 在 `md/` 下按子文件夹组织 Markdown 源文件（可附带本地图片）
2. 运行 `setup_docsify.py` 构建文档站
3. 用本地 HTTP 服务预览，或将 `docs/` 目录部署/拷贝给他人使用

构建脚本会自动完成以下工作：

- 下载 Docsify v4.13.1、Prism v1.29.0 等离线资源到 `docs/lib/`
- 扫描文档中的代码块语言，下载对应的 Prism 语言组件（含依赖）到 `docs/lib/components/`
- 移除主题 CSS 中的外部字体引用，站点运行时不请求任何 CDN
- 同步 Markdown 与图片到 `docs/`
- 生成侧边栏（`_sidebar.md`）、首页索引（`docs/README.md`）、入口页（`index.html`）
- 预构建全文搜索索引（`search-index.json`），并生成自定义离线搜索资源
- 提供左侧文章导航、右侧本文目录、侧边栏常驻搜索、`Ctrl+K` 全局搜索和桌面端可拖拽调宽的侧边栏

> **注意**：项目根目录的 `README.md` 是本工具的使用说明；`docs/README.md` 是文档站首页，由脚本自动生成，请勿手动维护。

## 目录结构

```
md_html/
├── md/                      # 源 Markdown（由你维护）
│   ├── 子文件夹1/
│   │   ├── 文档1.md
│   │   ├── 文档2.md
│   │   └── images/          # 可选，存放 .md 中引用的本地图片
│   └── 子文件夹2/
│       └── 文档.md
├── docs/                    # 生成的 Docsify 站点（由脚本生成/更新）
│   ├── index.html           # 站点入口
│   ├── lib/                 # 离线 JS/CSS 资源
│   │   ├── offline-data.js  # 内嵌 Markdown 和搜索索引（支持 file://）
│   │   ├── offline-file.js  # file:// 下的本地 XHR 适配
│   │   └── components/      # Prism 语言组件（按需下载，离线代码高亮）
│   ├── _sidebar.md          # 自动生成的侧边栏
│   ├── README.md            # 自动生成的首页索引
│   ├── search-index.json    # 预构建搜索索引
│   └── <子文件夹>/          # 从 md/ 同步过来的文档副本
├── setup_docsify.py         # 一键构建脚本
├── tests/                   # 构建脚本回归测试
└── README.md                # 本文件（工具使用说明）
```

## 文件架构与设计原理

### 源文件与生成文件

- `md/` 是唯一需要长期维护的源目录，保存 Markdown、图片和其他文档素材
- `setup_docsify.py` 是构建入口，负责下载资源、同步文件、生成索引和配置
- `docs/` 是可独立分发的生成结果，不建议直接在其中修改 Markdown 或配置
- 根目录 `README.md` 是工具说明；`docs/README.md` 是文档站首页，由构建脚本自动生成

### 构建数据流

```text
md/                         setup_docsify.py                    docs/
源 Markdown ───────────────> 1. 下载本地依赖 ────────────────> lib/
本地图片   ────────────────> 2. 同步文档和图片 ─────────────> <子文件夹>/*.md
代码围栏语言 ──────────────> 3. 下载 Prism 组件 ────────────> lib/components/
目录结构   ────────────────> 4. 生成站点配置 ───────────────> index.html
文档内容   ────────────────> 5. 生成搜索数据 ──────────────> search-index.json
                                                              offline-data.js
                                                              offline-file.js
```

### 浏览器运行模式

`index.html` 只引用 `docs/lib/` 下的本地 JavaScript 和 CSS。根据打开方式，文档内容有两种加载路径：

| 模式 | Markdown 加载 | 搜索索引加载 | 适用场景 |
|------|---------------|--------------|----------|
| HTTP | Docsify 通过本地 HTTP 服务读取 `docs/**/*.md` | 读取 `search-index.json` | 日常预览、局域网访问、推荐方式 |
| `file://` | `offline-file.js` 拦截 XHR，读取 `offline-data.js` 内嵌内容 | 直接读取内嵌索引 | 无服务器环境下双击 `index.html` |

`file://` 模式是为浏览器 CORS 限制增加的兼容层：`offline-data.js` 保存 Markdown 和搜索索引，`offline-file.js` 将 Docsify 的本地 XHR 转换为内存数据读取。因此必须完整保留 `docs/lib/`，不能只复制 `index.html`。

### 生成文件的职责

- `index.html`：Docsify 入口、运行参数、本地资源引用和 `file://` 兼容层引用
- `docs/lib/docsify.min.js`：文档路由、Markdown 渲染和页面生命周期
- `docs/lib/custom-search.js`：侧边栏搜索、全局搜索、搜索结果和右侧文章目录
- `docs/search-index.json`：HTTP 模式使用的预构建搜索索引
- `docs/lib/offline-data.js`：`file://` 模式使用的 Markdown 与索引副本
- `docs/lib/offline-file.js`：`file://` 模式的 XHR 适配器
- `docs/_sidebar.md`、`docs/README.md`：根据源目录自动生成的导航和首页

### 更新原则

修改 `md/` 后重新运行构建脚本；不要直接修改 `docs/` 中的生成文件。构建脚本会覆盖首页、侧边栏、搜索索引、入口页和离线数据，已存在的第三方资源通常会复用。页面上的“更新索引”按钮只更新当前页面内存，不能写回磁盘文件。

## 安装与依赖

### 必需环境

- **Python 3.6 及以上**
- 仅使用 Python **标准库**，无需安装 pip、Node.js 或 npm 依赖
- 支持 Windows、Linux、macOS
- 构建时需要访问 jsdelivr CDN，用于首次下载 Docsify、Prism 和代码语言组件
- 构建完成后，预览和使用不需要网络

### 安装方式

本项目无需安装到系统，也无需执行 `pip install`。获取项目后进入项目根目录即可：

```bash
# 检查 Python 版本
python --version

# Windows 如果 python 命令不可用，可尝试
py --version
```

如果构建环境不能联网，请在可联网环境先完成一次构建，再将完整的 `docs/` 目录复制到离线环境。离线环境不需要安装第三方 Python 包。

### 依赖边界

- Python 标准库只用于构建阶段
- Docsify、Prism、插件和 CSS/JavaScript 资源会被下载并保存到 `docs/lib/`
- 运行时不依赖 CDN、Google Fonts 或 GitHub emoji 图片
- 使用 HTTP 预览时只需要一个静态文件服务器，Python 自带的 `http.server` 即可
- 直接双击 `docs/index.html` 时依赖浏览器允许加载同目录的本地脚本；若浏览器策略仍限制 `file://`，使用 HTTP 预览

## 快速开始

### 常用命令

| 场景 | 命令 |
|------|------|
| 默认构建（`md/` → `docs/`） | `python setup_docsify.py` |
| 指定源目录和输出目录 | `python setup_docsify.py --source-md path/to/md --output-docs path/to/docs` |
| 使用位置参数指定目录 | `python setup_docsify.py path/to/md path/to/docs` |
| 预览默认输出目录 | `cd docs && python -m http.server 3000 --bind 0.0.0.0` |
| 运行回归测试 | `python -m unittest tests.test_setup_docsify_search -v` |

### 1. 添加文档

在 `md/` 下创建**子文件夹**，并在其中放置 `.md` 文件：

```
md/
└── my-docs/
    ├── 入门指南.md
    └── images/
        └── screenshot.png
```

规则说明：

- `md/` 根目录下**不能直接**放 `.md` 文件，必须放在子文件夹中
- 每个子文件夹可包含一个或多个 `.md` 文件
- 图片放在子文件夹下的 `images/` 目录，在 Markdown 中用相对路径引用，例如：`![](images/screenshot.png)`
- 新增、修改或删除文档后，需要重新运行构建脚本

### 2. 构建文档站

在项目根目录执行：

```bash
python setup_docsify.py
```

脚本会依次：下载/更新离线资源 → 同步 Markdown 与图片 → 下载文档用到的代码高亮语言组件 → 生成配置与搜索索引。

已下载的第三方静态资源若已存在会跳过下载；同步的文件和配置文件每次都会覆盖更新。

也可以指定源 Markdown 目录和输出站点目录：

```bash
python setup_docsify.py --source-md path/to/md --output-docs path/to/docs
```

或使用位置参数：

```bash
python setup_docsify.py path/to/md path/to/docs
```

两种参数形式等价；不要同时混用位置参数和同名选项。指定输出目录后，预览时请进入对应输出目录再启动 HTTP 服务。

### 3. 本地预览

```bash
cd docs
python -m http.server 3000 --bind 0.0.0.0
```

浏览器打开 [http://localhost:3000](http://localhost:3000) 即可查看文档站。

如果需要从其他机器访问 Linux 主机上的文档站，请打开：

```text
http://<Linux主机IP>:3000
```

若 `localhost:3000` 可访问，但 `<Linux主机IP>:3000` 无法访问，按下面顺序检查：

```bash
# 1. 确认服务监听在所有网卡，而不是只监听 127.0.0.1
ss -ltnp | grep ':3000'

# 2. 确认当前 Linux 主机 IP
hostname -I

# 3. 在 Linux 主机本机验证 IP 访问
curl http://127.0.0.1:3000/
curl http://<Linux主机IP>:3000/
```

如果 `curl http://127.0.0.1:3000/` 正常，但 IP 访问失败，通常是防火墙、云服务器安全组、虚拟机 NAT、WSL 或 Docker 端口映射限制。常见放行方式：

```bash
# Ubuntu/Debian ufw
sudo ufw allow 3000/tcp

# CentOS/RHEL firewalld
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

> 推荐使用 HTTP 服务预览。构建完成后的 `docs/index.html` 也支持直接双击打开：脚本会使用本地内嵌的 Markdown 和搜索索引，绕过 `file://` 协议对 XHR/fetch 的限制。若直接打开仍报跨源错误，请先重新运行构建脚本，并确认 `docs/lib/offline-data.js`、`docs/lib/offline-file.js` 存在。

### 4. 更新文档

修改、添加、删除或重命名 `md/` 下的文件后，在项目根目录重新执行：

```bash
python setup_docsify.py
```

重新构建会更新 Markdown 副本、侧边栏、首页、搜索索引、离线数据和入口页；已有的第三方资源通常会直接跳过下载。

### 5. 分发离线站点

分发时只需要复制完整的 `docs/` 目录，不需要复制 Python 环境、`md/` 源目录或项目根目录。接收方可以：

- 直接双击 `docs/index.html`
- 将 `docs/` 放到任意静态文件服务器
- 在有 Python 的环境执行 `cd docs && python -m http.server 3000`

## 搜索功能说明

文档站内置自定义离线搜索，支持按文件名、标题、寄存器名、信号名和正文内容检索。

### 工作原理

- 构建时在 `docs/search-index.json` 中**预生成**搜索索引，避免浏览器在运行时逐页抓取并写入 localStorage（大文档集容易超出约 5MB 配额）
- `index.html` 引用本地生成的 `custom-search.js` 与 `custom-search.css`
- 搜索支持侧边栏常驻入口和 `Ctrl+K` 全局搜索弹窗
- 搜索结果优先匹配文件名、标题、寄存器名、信号名等技术文档关键词

### 使用方式

- 在左侧栏顶部输入关键词，可直接查看前几条结果
- 点击搜索框下方的“更新索引”按钮，可在当前页面内重新扫描文档并立即刷新搜索结果
- 按 `Ctrl+K` 打开全局搜索弹窗，适合查看更多结果
- 搜索结果支持键盘操作：`↑/↓` 切换结果，`Enter` 打开，`Esc` 关闭弹窗
- 多关键词搜索默认要求全部命中，例如 `tx fifo` 会优先返回同时包含两个词的结果
- 点击搜索结果会精确跳转到对应章节锚点（与 Docsify 的标题 id 生成规则逐字符对齐，
  中文标点、页内重复标题、数字开头的标题均可正确跳转）

> HTTP 模式会重新读取当前站点中的 Markdown 文件；`file://` 模式使用构建时内嵌的 Markdown 快照。若要让更新永久保存，仍需修改 `md/` 后重新运行 `python setup_docsify.py`。

### 何时需要重新构建

以下情况请重新运行 `python setup_docsify.py`：

- 新增、删除或重命名 `.md` 文件
- 修改文档内容（搜索索引在构建时生成，不会自动更新）
- 新增或移动子文件夹

### 搜索范围

- 索引深度为标题 **4 级**（`#` 至 `####`）
- 首页（`docs/README.md`）和每个子文件夹下的 `.md` 文件均纳入搜索

## 代码高亮

代码高亮基于 Prism v1.29.0，完全离线：

- 构建时扫描 `md/` 中所有代码围栏的语言标记，自动下载对应的 Prism 语言组件及其依赖到 `docs/lib/components/`
- 常见语言（`markup`、`css`、`clike`、`javascript`）已内置于核心文件，无需额外下载
- Prism 官方不支持的语言会自动映射到最接近的语法高亮（**仅影响渲染，不修改源文件**）：

  | 文档中的语言标记 | 实际高亮语法 |
  |------------------|--------------|
  | `cuda` | C++ |
  | `p4` | C |
  | `asm` | x86 汇编（NASM） |

- 需要调整映射或新增映射时，修改 `setup_docsify.py` 中的 `PRISM_LANG_FALLBACK` 字典并重新构建

> 新增包含新语言代码块的文档后，重新运行构建脚本即可自动下载对应组件；下载失败（如断网）会给出警告，该语言暂不高亮，下次构建会重试。

## 文章导航布局

文档站采用左右分工的导航布局：

- 左侧栏只显示文章列表和搜索入口，不再混入当前文章的小标题
- 左侧栏顶部提供“返回首页”链接，指向 `../../index.html`
- 左侧搜索区域固定占据侧栏顶部，下面的文档列表独立滚动，不会被搜索栏遮挡
- 右侧栏显示当前文章的内部目录，默认收录 `##` 至 `####` 标题
- 点击右侧目录项会跳转到对应标题锚点
- 切换文章后，右侧目录会随当前页面自动刷新
- 移动端隐藏右侧目录，保留 Docsify 原本的抽屉式左侧栏

## 侧边栏宽度

桌面端左侧栏支持拖拽调宽，适合处理长文件名或浏览器边缘遮挡的情况。

- 将鼠标移到侧边栏右边缘，拖拽即可调整宽度
- 也可以聚焦侧边栏右边缘的分隔条后，用 `←/→` 微调宽度，`Home/End` 切到最小/最大宽度
- 宽度会保存到浏览器本地，下次刷新仍保留
- 移动端保留 Docsify 原本的抽屉式侧边栏，不显示调宽手柄

## 离线使用说明

1. **首次构建**需要联网，脚本从 jsdelivr CDN 下载 Docsify、Prism 及语言组件到 `docs/lib/`
2. 构建完成后，`docs/` 目录**不再依赖任何外部资源**，运行时零外部请求：
   - 代码高亮语言组件从本地 `lib/components/` 加载
   - 主题 CSS 中的 Google Fonts 引用在构建时已移除，回退系统字体
   - `:emoji:` 语法不做图片替换（避免请求 GitHub CDN），保留文字原样
3. 可将整个 `docs/` 文件夹：
   - 拷贝到 U 盘或内网服务器
   - 用任意静态文件服务器或 `python -m http.server` 提供访问
   - 直接双击 `docs/index.html` 打开（需保留 `lib/offline-data.js` 和 `lib/offline-file.js`）
   - 在断网环境下正常浏览、搜索和代码高亮

## 常见问题

### 搜索无结果或结果过时

搜索索引在构建时生成。修改 `md/` 下的文档后，请重新运行：

```bash
python setup_docsify.py
```

然后刷新浏览器页面。

### 搜索报错或行为异常

搜索索引由 `docs/search-index.json` 提供。若页面使用了旧构建产物、浏览器缓存未刷新，可能看到过时结果。

**解决方法：**

1. 重新运行 `python setup_docsify.py`
2. 强制刷新浏览器页面，或使用无痕窗口访问
3. 推荐通过 `http://localhost:3000` 等 HTTP 方式访问；若使用 `file://`，确认是最新构建产物，并检查 `docs/lib/offline-data.js` 和 `docs/lib/offline-file.js` 是否存在

### 侧边栏与首页是如何生成的？

- **单文件子文件夹**：侧边栏直接显示该文件名链接
- **多文件子文件夹**：侧边栏以子文件夹名分组，下列各文档链接
- `docs/README.md` 为文档站首页，自动生成文档索引列表

以上文件均由 `setup_docsify.py` 生成，**不要手动编辑** `docs/` 下的 `_sidebar.md`、`README.md`、`index.html`、`search-index.json` 和 `lib/` 目录（`lib/` 下的文件由脚本下载和修补，例如移除 CSS 外部字体引用），修改会在下次构建时被覆盖或失效。

### 构建时提示 md/ 不存在或没有子文件夹

- 请先创建 `md/` 目录
- 在 `md/` 下至少创建一个子文件夹，并在其中放入 `.md` 文件

### 某个语言的代码块没有高亮

- 确认构建日志中该语言组件下载成功（失败会有 `[警告]` 提示，联网后重新构建即可重试）
- 确认代码围栏使用了正确的语言标记，例如 `python`、`c`（写在围栏开头，如三反引号后）
- Prism 官方不支持的语言（如 `cuda`、`p4`、`asm`）默认用近似语法高亮，可在 `PRISM_LANG_FALLBACK` 中调整映射

### 图片无法显示

- 确认图片放在对应子文件夹的 `images/` 目录下
- Markdown 中使用相对路径引用，例如 `![](images/foo.png)`
- 修改图片后重新运行构建脚本

### 能否只更新部分文档？

脚本每次会同步 `md/` 下所有子文件夹的内容。增量更新由文件复制完成，运行一次 `setup_docsify.py` 即可，无需额外操作。

## 相关文件

| 文件 | 说明 |
|------|------|
| `setup_docsify.py` | 构建脚本入口 |
| `md/` | 源 Markdown，唯一需要手动维护的内容 |
| `docs/` | 生成的站点，构建后可独立分发 |
| `CLAUDE.md` / `AGENTS.md` | 面向 AI 助手的项目说明（可选参考） |
