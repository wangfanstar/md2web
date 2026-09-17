# Markdown 离线文档站生成器（md2web）

把 `docs/md/` 里的 Markdown 一键转换成**完全离线可用**的 Docsify 文档站：产物自包含，拷贝到任意机器双击即可浏览与搜索；需要 Python 3.6.8+（构建与只读预览仅用标准库；认证编辑服务执行 `python3 -m pip install -r server/requirements.txt`，Flask 2.0.3 + Waitress 2.0.0，已在 3.6.8 / 3.8 / 3.12 实测），仅用标准库，无需 pip/Node.js，支持 Windows 与 Linux。

## 特性

- 单目录维护：源文档就在 `docs/md/`，构建**不复制、不移动、不删除**任何文档
- 完全离线：依赖保存在 `docs/lib/`，运行时零外部请求；依赖存在时重建全程不联网
- 工程搜索：正文与代码一并索引，支持全文/文件模式、文件夹范围、当前文档、短语与排除词，保留标题锚点与命中跳转
- 离线代码高亮：按文档实际用到的语言准备 Prism 组件，cuda/p4/asm 自动近似高亮
- Mermaid 图形：代码围栏标注 `mermaid` 即渲染流程图/时序图/甘特图等，本地渲染、离线可用
- PacketDiag 报文图：代码围栏标注 `packetdiag` 即渲染报文/字段布局，离线 Canvas 渲染、可下载 PNG
- 单页导出：阅读区「下载本页」把当前文档导出为自包含 HTML（样式内联、图片与图形内嵌，可直接分享）
- 在线预览：内置绘图预览页（`lib/plot-playground.html`），Mermaid 全部图形类型与 PacketDiag 增强语法（位序/编号/全局注释）可边写边看、一键复制源码、下载 SVG/PNG；侧栏顶部提供「绘图预览」快捷入口
- 图形放大：点击 Mermaid / PacketDiag 图形放大查看时**按源码重新渲染**，避免克隆导致文字或箭头缺失；导出 HTML 时同样重绘为图片
- 绘图示例：`docs/md/使用说明/绘图示例.md` 收录全部 27 种 Mermaid 类型与 11 个 PacketDiag 模板，每个样例均为「效果 + 源码」对照（有测试保证与绘图预览同步）
- 阅读增强：复制路径、查看源码（免登录，可编辑/预览/保存到本地）、双栏编辑器（Markdown 格式分色 + 实时预览）、`Ctrl+S` 保存草稿或直连写回、下载 MD、下载本页为自包含 HTML（目录固定左侧）、序号开关
- 数学公式：`$...$` / `$$...$$` 由 KaTeX 离线渲染（编辑器预览与文档页一致）
- AI 助手：右下角对话面板 + 侧栏设置图标（设置与 AI 配置合一），本地检索后再发给可配置的大模型（OpenAI 兼容 / DeepSeek / Ollama / Anthropic），支持资料范围勾选与上传文档、带引用来源跳转；Key 仅存浏览器本地，跨域时经本机 `serve.py` 代理
- 登录与权限（阶段一）：`python serve.py --config config/server.local.json` 启动认证编辑服务（Flask + Waitress + SQLite + SVN CLI），SVN 账号密码登录、会话/CSRF、匿名只读、静态分发白名单与前端内容净化；离线 `file://` 保持只读

内网/无外网环境可用离线依赖包（已随仓库提供 Linux x86_64 + Python 3.6 的 wheels）：
```bash
python3 -m pip install --user --no-index --find-links server/wheels -r server/requirements.txt   # 非 root 用户加 --user
python3 -m pip install --no-index --find-links server/wheels -r server/requirements.txt
```
其他平台（如 aarch64、Python 3.8+）可用 `python -m pip download -r server/requirements.txt -d server/wheels` 重新下载；`start_linux.sh` 在缺少依赖时会自动优先使用该离线包。
- 网页端「设置」（侧栏 HOME 图标旁，单一入口）：本机 AI 设置（含**参考源码路径**与资料范围，仅浏览器 localStorage）+ 服务端设置（默认管理员 admin/admin；SVN 认证路径、仓库映射、全站 AI 默认值），保存后热应用；配置与数据库均在 `docs/` 之外、不入库提交
- 管理员可用本机账号直接登录编辑（不需要 SVN 校验）；提交 SVN 时补充一次 SVN 账号（仅进程内存）
- 管理员密码：默认 `admin / admin`（PBKDF2 存库），可在「设置」中修改；忘记密码时用 `python serve.py --reset-admin-password` 强制恢复为默认值
- 个人草稿（阶段二）：登录后 `Ctrl+S` 保存带版本的草稿，支持修改历史、已发布↔草稿差异、放弃草稿；冲突只提示不覆盖，与 SVN 提交（阶段三）分离
- SVN 提交在「阶段二·编辑器 → 提交 SVN」：选择仓库/文件/填写说明后用账号提交私有工作副本，只有确认过的文件内容会入库；失败分 failed/uncertain 且不自动重试（可在 SVN 日志中按账号查看）。登录时的 SVN 口令会以本机密钥加密保存在服务端数据库，提交与信息查询直接复用最新口令（换密码后重新登录会自动更新）
- 章节编号：正文 h2–h4 与右侧「本文目录」自动显示 `1 / 1.1 / 1.1.1` 序号
- 跨平台预览：`start_windows.bat` / `start_linux.sh` 一键启动（Windows 脚本会检查 Python 与依赖，缺少认证依赖时自动尝试安装，失败则降级为只读预览），Windows/Linux 通用；也可直接双击 `docs/index.html`
- 多文件夹工作台：完整保留目录层级与同名文件位置，支持折叠树、数量统计、路径筛选、定位当前文档和分类首页
- 阅读工具：路径面包屑、复制路径、复制代码、宽屏阅读（隐藏右侧目录）、章节序号开关、可拖动侧栏和本文目录
- 点击放大：正文图片与 Mermaid 图形可点击全屏查看，支持缩放、平移、适应窗口、1:1、滚轮与触屏操作；Mermaid 图形可单独下载 SVG / PNG

## 目录结构

```
md2web/
├── docs/                     # 唯一目录：源文档 + 站点 + 离线依赖
│   ├── md/                   # 源文档（唯一需要手动维护）
│   │   ├── 使用说明/快速开始.md
│   │   ├── 子文件夹/文档.md
│   │   └── images/…          # 图片任意位置，相对路径引用
│   ├── lib/                  # 离线 JS/CSS 与生成资源
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   └── search-index.json     # 搜索索引（生成）
├── specs/                    # 设计文档
├── tests/                    # 离线回归测试
├── web/                      # 自有前端源码，构建复制至 docs/lib/
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台预览
├── start_windows.bat / start_linux.sh
├── AGENTS.md                 # AI 助手开发指南
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
python serve.py             # 打开 http://localhost:8882
```

| 场景 | 命令 |
|------|------|
| 完整构建 | `python setup_docsify.py` |
| 严格离线构建 | `python setup_docsify.py --offline`（缺依赖直接提示，绝不尝试下载） |
| 自定义标题 | `python setup_docsify.py --title "我的文档"` |
| 仅刷新索引与离线数据 | `python setup_docsify.py --index-only` |
| 预览 | `python serve.py`（`--port 8080`、`--bind 127.0.0.1`、`--no-browser`、`--no-build`） |

Windows 可双击 `start_windows.bat`，Linux 可执行 `sh start_linux.sh`。也可以直接双击 `docs/index.html`（file:// 模式，内容与索引内嵌）。

> Linux 启动排障：若出现 `./start_linux.sh: No such file or directory`，多为从 Windows 拷贝导致的 CRLF 或缺少可执行位。
> 修复：`git pull && sed -i "s/\r$//" start_linux.sh && chmod +x start_linux.sh`；也可 `sh start_linux.sh`（脚本会自动去 CR 后重执行）或 `python3 serve.py`。

> `python serve.py` 启动时会自动关闭旧的 `serve.py` 实例，并在运行期间每 2 秒检测 `docs/md` 的新增/删除/修改，自动重建后提示刷新页面（可用 `--no-build` 关闭自动重建）；双击 `docs/index.html` 前需先手动构建一次。
> `--index-only` 只重建搜索索引与离线数据，不重新生成侧边栏与首页；新增文件要出现在导航中需执行一次完整构建。

### 工程师查阅流程

1. 按项目或模块组织 `docs/md/项目/模块/文档.md`。任意深度子目录都会保留；例如 `硬件/接口/README.md` 和 `软件/接口/README.md` 会显示在各自目录下。
2. 打开首页的文件夹卡片，或在左侧「筛选文件」输入文件名、路径。折叠不相关目录，使用「定位当前」返回正在阅读的文件。
3. 按 `Ctrl+K`（macOS 为 `Cmd+K`）或 `/` 搜索全文；按 `Ctrl+P` / `Cmd+P` 按文件名或路径快速打开。输入焦点在正文外时 `/` 才触发。
4. 在搜索框下切换全文/文件模式与范围（全部、当前文档、任意文件夹）。多词默认同时匹配：`DMA 配置`；英文短语用双引号：`"cache line"`；排除不需要的内容：`DMA -deprecated`。代码中的命令、函数和寄存器同样可检索。
5. `↑/↓` 选择搜索结果，`Enter` 打开，`Esc` 关闭搜索；进入命中阅读后 `F3` / `Shift+F3` 在命中间移动，继续支持折叠无命中章节。
6. 用「复制路径」取得文档位置，用代码块「复制」取出命令；阅读宽表格或长代码时开启「宽屏阅读」。

搜索结果显示文件路径，避免同名文件混淆。搜索历史、侧栏宽度、目录展开状态等偏好保存在本机浏览器；浏览器禁用存储时仍可浏览和搜索。

### 离线刷新与分发

| 使用方式 | 内容来自哪里 | 文档修改后的操作 |
|----------|--------------|------------------|
| 双击 `docs/index.html` | 构建时内嵌的 Markdown 与搜索快照 | 运行 `python setup_docsify.py --offline`，然后刷新浏览器 |
| `python serve.py` | 本地 Markdown；启动时自动检测文档变化 | 新增/删除后重新构建或重启预览；内容修改后可重建并刷新 |
| 页面「重读索引」 | 已知文档（HTTP）或当前内嵌快照（file://） | 用于重新读取已有内容；新增文件需完整构建，不能在页面内扫描磁盘 |

接收方只需完整 `docs/` 文件夹和浏览器，无需 Python、Node.js 或网络。维护方需要 Python 3.8+；严格离线构建若提示缺少依赖，把另一份完整站点的对应 `docs/lib/` 文件复制过来即可。文档自己引用的远程图片/资源需提前改成本地相对路径，才能随站点离线分发。

监听地址：**默认监听所有网卡（`0.0.0.0`）**，启动日志会打印「局域网访问: http://<本机IP>:8882」；只允许本机访问用 `python serve.py --bind 127.0.0.1`，端口用 `--port 8891` 覆盖（也可改 `config/server.local.json` 的 `server.bind`/`server.port`）。启动脚本（`start_linux.sh` / `start_windows.bat`）同样默认按局域网开放。

局域网打不开时先确认服务器防火墙放行端口：RHEL/CentOS 7 用 `sudo firewall-cmd --add-port=8882/tcp --permanent && sudo firewall-cmd --reload`，Ubuntu 用 `sudo ufw allow 8882/tcp`（服务启动时会检测 firewalld/ufw 并提示对应命令）。局域网内任何人都能看到登录页与文档，请务必修改默认管理员密码；只允许本机时用 `--bind 127.0.0.1`。

### 3. 分发与备份

拷贝整个 `docs/` 目录即可：接收方双击 `docs/index.html` 或用任意静态服务器打开即可浏览、搜索、代码高亮。`docs/` 同时包含源文档，因此它也是唯一的备份对象。

> `docs/` 下由构建生成的文件为 `index.html`、`README.md`、`_sidebar.md`、`search-index.json` 以及 `lib/` 中的生成资源（`custom-search.*`、`workspace.*`、`offline-*.js`），请勿手工维护；自有前端改动写在 `web/` 后重新构建。`docs/md/` 不会被构建修改，`lib/` 中第三方依赖首次构建会就地打补丁（幂等）。

## 测试

```bash
python -m unittest discover -s tests -v
node --test tests/test_search.js tests/test_offline.js
```

Python 测试全程离线（临时目录 + 伪依赖），覆盖扫描与导航、搜索索引、代码检索、首页、严格离线构建、源文件保护与预览服务。Node 仅用于开发回归测试，不是构建或浏览站点的依赖。

## 常见问题

- **搜索无结果或过时**：搜索索引在构建时生成，修改文档后重新运行 `python setup_docsify.py`（或 `--index-only`）
- **依赖缺失且下载失败**：联网重跑，或把完整依赖文件复制到 `docs/lib/`
- **图片不显示**：确认图片在 `docs/md/` 内且相对路径大小写正确，刷新浏览器；图片不经过构建处理
- **代码块不高亮**：检查围栏语言标记；`cuda`/`p4`/`asm` 会自动按近似语法高亮，其余 Prism 不支持的语言需自备组件，否则不高亮
- **Mermaid 图形不显示**：确认围栏语言写的是 `mermaid`；`docs/lib/mermaid.min.js` 缺失时重新构建会自动补齐（需要联网一次）
- **PacketDiag 图形不显示**：确认围栏语言写的是 `packetdiag`，语法见「使用说明 → 绘图示例」；渲染失败时会回退显示源码并在控制台提示
- **文档编码要求**：仅支持 UTF-8 文档；非 UTF-8 文档构建会报错并指明具体文件
- **文件名限制**：文件名包含 `#`、`?`、`%`、`[`、`]` 时链接与搜索路由可能失效，请避免使用这些字符
- **想彻底重建**：删除 `docs/` 中除 `md/` 外的生成文件后重新构建（依赖缺失时需要联网一次）
- **认证服务启动报 `malformed database schema`**：本机 SQLite 版本较旧（如 RHEL7 自带 3.7.17）无法解析数据库里由新版本写入的索引；服务启动时会自动移除这类索引（原文件留 `*.repair-*.bak`），若仍不可用则把库备份为 `*.corrupt-*.bak` 后重建（本地草稿丢失、管理员密码恢复为默认 `admin/admin`）
- **`data/` 数据库跨平台共用**：程序只写入 SQLite 3.7.17（RHEL7）能解析的对象，启动时也会清理历史遗留的不兼容索引，因此 Windows 上生成的 `data/` 可以直接拷到旧版 Linux 继续使用；反之亦然
