# SVN 认证、文档编辑与 SQLite 历史设计

日期：2026-09-15  
基线：`f49460a`（已包含双栏 MD 编辑器、源文件保存、自动重建、AI 助手）  
状态：方案建议；本文件不代表功能已实现。用户已确认团队共用一台内网服务，工程师也可在各自电脑编辑并提交 SVN；SQLite 仅需记录通过网页进行的编辑与提交。

## 实施进度

| 阶段 | 状态 | 落地内容 |
|---|---|---|
| 阶段一：认证与只读边界 | **已实现（见本次提交）** | `server/` 包（config/database/svn/auth/documents/app/paths/passwords）、`serve.py --config` 认证服务（配置缺失自动生成）、网页「设置」界面（管理员 admin/admin 可配置 SVN 认证路径/仓库映射/AI 助手/改密，热应用）、登录/退出/会话/CSRF、写接口守卫（匿名 401、旧 `/__md/save` 410、草稿/SVN 501）、静态白名单、前端 `auth.js`/`settings.js` 与 `sanitize.js` 净化、`tests/test_server.py` 59 项测试 |
| 阶段二：草稿与修改记录 | 待实施 | `drafts/revisions` 表已建好；`/__md/draft` 当前返回 501 |
| 阶段三：多库 SVN 操作与发布 | 待实施 | `repo_bindings/operations` 表与最长前缀匹配已就绪；`/__svn/*` 当前返回 501 |

阶段一验收结论（本机假 SVN 集成测试）：匿名写请求 401；错误密码 401；认证路径允许匿名访问时登录被拒绝（503）；合法账号可登录且口令不落库（仅内存传参）；退出/重启/认证源变更后旧会话与旧写请求全部失败；编辑器预览对 `<script>`、事件属性与 `javascript:` 链接已净化。

## 1. 推荐结论

采用 **现有静态文档前端 + 可选的 Python 认证服务 + SQLite + SVN 命令行客户端**。

工作流：**匿名阅读 → SVN 账号登录 → 编辑并保存个人草稿 → 查看差异 → 用当前账号提交 SVN → 发布文档并重建站点**。

三个明确边界：

1. `docs/` 是对所有读者可见的已发布内容；个人草稿、账户数据库、配置和 SVN 工作副本放在站点目录之外。
2. SVN 是账号密码与仓库操作权限的权威来源；SQLite 保存应用账号档案、会话、版本和操作记录，不保存 SVN 密码。
3. 站点内编辑必须通过已认证服务。`file://` 分发模式为只读，保留搜索、图形、下载等阅读能力；不在静态 HTML 中实现可绕过的账号校验。
4. 工程师本地编辑器与 SVN 客户端保持原用法。外部提交以 SVN 为准，网站按库同步；不采集本地编辑过程，不把外部提交记成网页审计，不替外部提交作者自动创建网站账户。

“合入”在首版定义为 **将选中文档修改提交到配置的 SVN 目标路径（commit）**。跨分支 `svn merge` 不隐含在提交按钮中，后续可独立增加。

## 2. 最新代码的可复用部分与必须调整处

| 当前代码 | 可以复用 | 需要调整 |
|---|---|---|
| `web/md-editor.js` | 双栏预览、Markdown 快捷键、图形/公式渲染、原文下载 | 增加登录状态与草稿加载；Ctrl+S 保存个人草稿；401/403 不降级成文件写入；移除冲突后第二次保存强制覆盖 |
| `web/workspace.js` | 编辑按钮、路径与目录上下文 | 匿名显示“登录后编辑”；新增当前库状态与修改历史入口 |
| `serve.py:save_md` | 路径越界检查、UTF-8、换行保持、原子替换 | 提取为发布服务底层函数；强制版本前置条件；不能让 HTTP 请求传入 force 绕过冲突 |
| `serve.py:PreviewHandler` | 已有前端接口和静态资源结构 | 当前只有来源 IP 限制，没有账户认证；新的服务端守卫必须覆盖所有写接口 |
| `serve.py:start_watcher` | 源文档更新后构建 | 发布与 watcher 共用构建队列，避免重复/并发重建；发布失败与 SVN 提交失败分开显示 |
| `setup_docsify.py` | 全部离线构建能力 | 登录/SVN 前端资源从 web/ 复制；构建仍不修改 docs/md |

当前两个保存细节不能带入多人模式：`baseHash` 可缺省，且 `force` 可绕过检查；`save_md` 使用固定临时文件名，同文件并发写可能互相覆盖。新写入需服务器签发版本、文件级锁和独立临时文件。

当前 `md-editor.js` 将 `marked.parse` 输出直接写入 `innerHTML`。账号上线前需统一净化阅读页与预览页的用户内容（离线打包 DOMPurify），保留必要表格、代码、公式与图形渲染，禁止脚本、事件属性和危险 URL。仅隐藏按钮、HttpOnly Cookie 都不能代替内容净化。

## 3. 技术与部署选择

| 方案 | 优点 | 代价 | 选择 |
|---|---|---|---|
| 可选 Flask + Waitress 服务，内置 sqlite3，调用 svn CLI | Windows/Linux 一套入口；路由、请求和错误处理清楚；静态构建不变 | 编辑服务增加少量 Python 依赖和 SVN 客户端 | **推荐** |
| 继续在 ThreadingHTTPServer 中手写全部账号与 API | 无新增 pip 依赖 | 会话、CSRF、路由、并发与错误处理中长期维护成本高 | 仅适合维持本地预览 |
| FastAPI + ORM + Redis/独立任务系统 | 易扩展更多服务 | 对目前单机文档站增加部署和运维负担 | 规模需要时再考虑 |

Python 官方明确 `http.server` 不推荐作为生产服务；Waitress 是支持 Windows 的纯 Python WSGI 服务。这里增加框架仅用于认证编辑服务，不要求静态站读者安装任何软件。[Python 文档](https://docs.python.org/3.12/library/http.server.html)、[Flask/Waitress 部署](https://flask.palletsprojects.com/en/stable/deploying/waitress/)

建议运行方式：

- 构建和离线阅读：仍使用原来的 `python setup_docsify.py --offline` 与 `docs/index.html`。
- 服务启动：`python serve.py --config config/server.local.json`，默认绑定 loopback，由内网 HTTPS 入口转发。
- 团队使用：认证服务部署一份，SQLite 在服务机本地磁盘，浏览器通过内网 HTTPS 访问。TLS 由团队已有的反向代理终止，服务只信任显式配置的代理与 Host。个人电脑不需要安装本站服务，可继续用本地编辑器和 SVN 客户端。
- 服务依赖锁定版本并提供本地 wheel 安装包，SVN 客户端提供独立安装说明；内网部署不要求能访问公网。
- 新版本无认证配置时只读预览；不能因为配置缺失回退到原来的匿名本机保存。停用旧的无认证写服务，入口不再扫描并终止所有名字含 serve.py 的进程，仅管理本项目自身实例。

SVN 登录与提交需要能连接 SVN 服务。公网断网但内网 SVN 可达时可以正常工作；SVN 完全不可达时不能新认证。已有未过期会话可以继续保存服务端个人草稿，提交需等待 SVN 恢复；服务重启后重新登录。

## 4. 组件与目录

```text
浏览器：Docsify / MdEditor / 登录弹窗 / 修改与 SVN 面板
                 │ 同源 HTTP API + 会话 Cookie
                 ▼
Python 服务：认证守卫 → 文档/草稿服务 → SVN 适配器
                 │          │               │
                 │          ▼               ▼
                 │       SQLite        私有 SVN 工作副本
                 │                          │
                 └──── 发布与构建队列 ◀──── SVN 仓库
                            │
                            ▼
                       docs/ 已发布站点
```

建议模块边界：

```text
server/
  app.py               # 创建应用、API、静态文件白名单、统一错误
  config.py            # 配置与路径/URL/仓库身份校验
  auth.py              # SVN 登录、会话与权限守卫
  database.py          # sqlite3、迁移、事务与备份
  documents.py         # 草稿、版本、差异、并发检查
  svn.py               # 唯一的 svn 子进程调用入口
  operations.py        # 提交任务、状态核对、发布与恢复
  sync.py              # 外部 SVN 变更同步到已发布站点
web/
  auth.js / auth.css
  svn-panel.js / svn-panel.css
config/server.example.json   # 只含示例配置，可提交
config/server.local.json     # 实际内部地址，不提交
data/md2web.sqlite3          # 账户与修改记录，不提交、不静态分发
data/workspaces/             # 私有工作副本，不静态分发
```

启动时拒绝 database、workspaces 或配置落在 docs/ 内。静态服务禁止访问点目录、`.svn`、临时文件与数据库文件；不开放目录列表。现有 MD 子文件夹若自带 `.svn`，其元数据绝不能随站点导出。

## 5. SVN 登录：真正验证输入的密码

管理员配置固定远程 `auth.url`，推荐 HTTPS 下需要口令认证的专用路径，例如只读的 `/auth-check/`。普通用户不能自行指定认证服务器。

流程：

1. 浏览器通过同源 HTTPS POST 发送用户名/密码，不放 URL。
2. 服务生成本次请求专用的 SVN 配置目录，执行只读远程命令（如 `svn info --xml <auth.url>`），设置 `--non-interactive`、`--no-auth-cache`、`--config-dir`，密码通过 `--password-from-stdin` 输入。启动检查客户端是否支持此选项，不退回把密码放进命令行。
3. 仅在该路径确实强制口令认证且命令成功时创建/更新用户并签发会话。SVN 不可达、证书错误、密码错误分别返回清晰错误，但不输出原始密码或包含秘密的进程参数。
4. 凭据只存服务进程内、按会话隔离；退出、过期、服务重启或管理员吊销后丢弃引用。Python 进程内秘密无法保证物理内存擦除，因此不声称密码从未进入内存。

必须区分：

- **远程路径与本地工作副本路径**：对本地目录执行 svn info 不会证明远程账号有效。
- **身份认证与匿名访问**：如果 URL 无密码也能读，读取成功不能当作登录成功。部署检查必须验证匿名访问会被拒绝。SVN 的 HTTP 配置可能跳过匿名可读请求的认证。[SVN HTTP 认证说明](https://svnbook.red-bean.com/en/1.8/svn.serverconfig.httpd.html)
- **禁止环境凭据替代输入口令**：不复用服务系统用户的 SVN 缓存、Windows 集成登录或 SSH key；首版不将仅 SSO、file://、svn+ssh:// 端点当成“输入用户名密码验证”入口。
- **读权限与写权限**：在认证路径登录成功不代表所有文档库可提交，也不能通过一次 svn info 推断写权限；最终提交由目标 SVN 库执行授权。
- **多库复用凭据**：仅向管理员明确绑定的同一认证体系/可信服务器发送当前会话凭据；发现文件夹中的新库只显示待配置，不自动发送密码。

`--password-from-stdin` 是 SVN 客户端已有能力，实施时通过客户端帮助检查支持情况。[Apache SVN 变更记录](https://github.com/apache/subversion/blob/trunk/CHANGES)

### 会话约定

- Cookie 保存高熵随机 session token；SQLite 仅存 token 摘要。设置 HttpOnly、SameSite、Path；HTTPS 部署开启 Secure。
- 默认绝对有效期 8 小时、闲置 30 分钟，可配置。关闭服务后不恢复需密码的旧会话，草稿历史保留。
- 所有写请求检查服务端会话、CSRF token、Origin/Host、资源归属；请求正文中传入 username 不产生身份。
- 登录限速；退出撤销会话。首次启用认证或配置认证源变化，旧会话全部失效。
- 对操作超出会话生命周期的情况：任务实际启动 SVN 子进程前再次校验会话并取得当前凭据；排队期间过期/退出或服务重启的任务转为 needs_auth，不执行 SVN。用户重新登录后需显式恢复并重新核对基线。已经启动的提交可以完成并记录结果；退出不会假装撤销一个可能已到达 SVN 服务器的提交。

## 6. 读者与编辑者体验

| 能力 | 未登录 / file:// | 已登录 |
|---|---|---|
| 阅读、搜索、目录、图形/公式、原文下载、单页导出 | 保留 | 保留 |
| 站点文档编辑 | 显示“登录后编辑”；file:// 提示启动服务 | 现有双栏编辑器 |
| 保存草稿、查看自己的草稿历史 | 不可用 | 可用 |
| 修改已发布文档、提交 SVN | 服务端拒绝 | 校验版本、目标权限后执行 |
| SVN 远程信息、日志、差异 | 默认需登录 | 使用当前账号，按目标库权限返回 |
| 管理仓库映射 | 不可用 | 管理员配置，不由普通登录隐含获得 |

编辑器工具栏：`保存草稿 Ctrl+S`、`查看差异`、`提交 SVN…`、`修改历史`。页面顶部显示 `alice · 已登录`、当前目录、目标库、基线版本、草稿状态。

点击“提交 SVN…”后，在同一个面板显示 **目标库 + 分支路径 + 精确文件列表 + 已冻结版本的差异 + 提交说明**；确认按钮才执行提交。一次只处理一个库，跨库选择自动分组分别确认，不能承诺跨库原子提交。

会话过期时保留编辑器内未保存文字，提示重新登录后续写，不回退匿名写文件。原文下载继续开放；权限只约束本应用写入受管文档，无法阻止用户在自己的操作系统中修改已下载副本。

绘图预览等独立沙盒继续可用，但不绕过文档发布 API。现有 AI 功能保留，原来的本机代理限制不因新增登录自动放开；若团队要共享 AI 代理，应另设目标地址白名单与调用权限，不能把当前任意 URL 代理直接对内网用户开放。

## 7. 多文件夹、多仓库映射

配置示意（推荐初版用 JSON 文件；下面的地址均为示例）：

```json
{
  "server": { "bind": "127.0.0.1", "port": 3000 },
  "auth": {
    "url": "https://svn.example.invalid/svn/accounts/auth-check/",
    "credential_group": "engineering",
    "session_hours": 8,
    "idle_minutes": 30
  },
  "storage": {
    "database": "../data/md2web.sqlite3",
    "workspaces": "../data/workspaces"
  },
  "sync": {
    "interval_seconds": 120,
    "credential_source": "deployment_secret",
    "credential_name": "MD2WEB_SVN_READONLY"
  },
  "repositories": [
    {
      "id": "hardware",
      "mount": "md/硬件设计",
      "url": "https://svn.example.invalid/svn/hardware/trunk/docs/",
      "credential_group": "engineering"
    },
    {
      "id": "verification",
      "mount": "md/验证指南",
      "url": "https://svn.example.invalid/svn/verification/trunk/manual/",
      "credential_group": "engineering"
    }
  ]
}
```

存储路径相对配置文件所在目录；mount 相对 docs/。同一 mount 不允许重复；嵌套 mount 使用 **目录段的最长前缀**，例如 `md/A/B` 优先于 `md/A`，`md/A` 不匹配 `md/AB`。

`sync` 凭据引用由部署环境提供，只读服务账号用于后台更新已发布镜像；它与用户提交身份分开，永远不用于用户 commit。实际秘密不写 JSON、SQLite 或 docs/。若库允许匿名读取，可将 sync 设置为匿名读取；若不准备后台只读凭据，则明确降为登录用户手动刷新，不承诺登出后持续自动同步。

绑定时用 `svn info --xml` 记录仓库 UUID、根 URL 和目标 URL；后续遇到 WC 被 switch、迁移或实际 UUID 不符时停止操作，要求管理员重新绑定。多个库根或分支即使账号相同，也作为独立目标处理。

对于已经是 SVN 工作副本的 md 子目录：可以读取其库信息并预填绑定，但要比较配置和真实 URL/UUID；首次绑定若存在本地修改，先显示差异并导入为具名草稿或由维护者处理，不把旧修改自动归给新登录者，不自动清理或覆盖已有工作副本。

无 SVN 绑定的目录：允许登录后编辑、留历史，并提供明确的“发布到本地文档”动作；界面显示“未关联 SVN”，不伪装成已入库。

## 8. 多人编辑、差异与提交

### 为什么不让所有人直接写同一份工作副本

单纯给 svn commit 加一把锁，只能避免命令同时运行，不能避免 A 保存的改动被 B 的提交一起带上。因此推荐私有草稿和私有工作副本；共享 docs/md 只承载已发布内容。

### 保存

1. 打开编辑器，服务返回个人草稿或已发布版本，以及服务端版本号、基线内容 hash、SVN 基线 revision。
2. Ctrl+S 发送正文与 expected_version。在同一 SQLite 短事务中更新草稿、插入不可变 revision 和审计记录；版本不符返回 409，保留双方内容供比对。
3. 新修改归属于当前服务端会话用户，不能由浏览器指定作者。草稿不会被自动重建加入匿名可读的 search-index/offline-data。

### 提交和发布

1. 为选中的草稿 revision 创建 operation_id，冻结文件清单、内容 hash、基线版本和提交说明。服务端生成差异并签发 review token；提交只接受该版本。
2. 首版按 operation_id 和仓库绑定创建临时私有 WC，采用稀疏 checkout 获取目标文件，避免包含其他草稿或遗留修改。完成且结果已核对后清理；uncertain 操作保留恢复所需资料。checkout/update 不隐式拉取 externals；嵌套库由映射独立处理。提交频繁且性能需要时，再优化成每用户每库持久 WC。
3. 检查选中文档在远端的基线是否改变。首版有并发远端修改时直接展示“基线 / 当前远端 / 我的草稿”并要求处理，不做静默自动合并。非冲突文件可正常提交。
4. 仅把已确认草稿写入私有 WC，保持 SVN 属性与换行语义；再次读取实际 diff 验证它与 review token 对应的改动相同。
5. 使用当前会话凭据执行 svn commit，目标是显式文件列表；不提交整个目录，不递归 add 全库，不混入 externals、其他用户文件或未选择文件。首版沿用现有编辑器的“修改已有 MD”，新增/删除/重命名作为后续独立操作。
6. SVN 确认成功后记录实际 revision；触发该库镜像同步，取不低于已发布版本的新 SVN 快照写入 docs/md，原子替换每个文件并触发一次统一重建。若外部提交已产生更新 revision，发布最新快照，不让延迟执行的网页操作把网站回滚到旧 revision。构建过程中不应暴露半批次索引；记录发布清单以便失败重试。
7. 若已有工作副本承载发布目录，先确认干净并通过受控 SVN 同步保持元数据一致；存在外部本地修改时暂停发布，不覆盖。没有 WC 的普通目录按确认 revision 导出内容即可。

现有两个“冲突”应分开显示：应用草稿版本冲突（两个标签页或外部变更）与 SVN 远端基线过期。SVN 对被他人修改而过期的文件拒绝提交，需要更新并处理冲突。[SVN 工作副本状态](https://svnbook.red-bean.com/en/1.8/svn.basic.in-action.html)

“保存草稿”与“已提交 SVN”是不同状态；“SVN 已提交，站点待更新”也是独立状态。不能用一次“保存成功”覆盖所有含义。

### 工程师本地提交后的同步

**SVN 是已发布版本的权威来源，SQLite 是网页编辑过程的记录。** 两者覆盖范围不同，不做双向审计补录。

- 默认每 120 秒检查配置仓库的远端版本，也提供“立即更新文档”入口；一次固定一个明确 revision，同一库的提交发布与后台同步进入同一串行队列。
- 远端内容先取得到 staging，完成内容与索引校验后才进入发布阶段；原有 watcher 不允许在同步的半成品上构建。发布采用统一读写协调与持久化发布清单，失败保留/恢复上一份可浏览版本，启动恢复结束前不对外提供未完成版本。
- 同步记录库的 published_revision、last_checked_at 和错误状态。某库不可用时保留旧版本供浏览，显示该库上次更新时间与失败状态，其他库继续工作。
- 新增/修改/删除的已发布 Markdown 与本地图片资源按受管清单更新，再统一重建导航、索引和离线快照。删除只针对该绑定此前发布的文件；不删除未受管文件，不覆盖嵌套绑定的目录，不导出 `.svn`。
- 对 URL/UUID、目标路径和站点 hash 做校验；服务机 docs/md 被人工修改时暂停受影响文件同步并提示，不用 `svn revert` 或镜像删除抹掉现场。工程师应在个人工作副本编辑，中央发布目录作为服务管理的镜像。
- 网页草稿保持独立。远端已变化时在草稿旁显示“基线已过期”，提交前再次核对；版本号变化但目标文件内容未变时不必阻止提交，目标文件内容/路径/关键属性有变时要求处理差异。
- 例如：小王网页草稿基于 r120；小李本地提交 r121；网站同步显示 r121，小王草稿仍在。小王提交时比较基线、r121 与草稿，处理冲突并重新审阅后提交 r122。
- “网页修改历史”来自 SQLite，含草稿保存与本网站提交；“SVN 日志”按当前账号从目标库分页获取，包含本地客户端等全部提交，并明确标注来源。日志接口有超时和数量限制，不默认把完整 SVN 历史导入 SQLite。
- 外部删除了有网页草稿的文档时，保留草稿并标记源文件已删除，不能自动重新添加。改名同理显示路径变化，首版不猜测自动关联。

后台读取使用只读同步账号；网页提交始终使用发起人的当前 SVN 账号。若只读同步账号无法读取某些路径，不允许用某个用户的更高权限提交结果绕过发布范围，也不自动把仅该用户能读的内容公开到匿名站点。

## 9. SQLite 记录模型

| 表 | 主要字段 | 用途 |
|---|---|---|
| users | id, auth_source_id, svn_username, display_name, disabled, created_at, last_login_at | 账号档案；唯一键为认证源 + SVN 用户名，不自行将所有用户名转小写 |
| sessions | token_hash, user_id, created_at, last_seen_at, expires_at, revoked_at, process_epoch | 可撤销会话；不含 SVN 密码，不跨服务重启恢复凭据 |
| repo_bindings | id, mount_path, repository_uuid, root_url, target_url, credential_group, config_version, published_revision, last_checked_at, sync_error | 目录和仓库身份、配置变更、已发布版本与同步状态 |
| drafts | id, user_id, document_path, binding_id, version, base_revision_id, head_revision_id, state | 每用户每文档一份当前草稿，乐观并发控制 |
| revisions | id, draft_id, actor_id, parent_id, base_svn_revision, before_hash, after_hash, content, eol, unified_diff, created_at | 完整内容快照 + 差异，可恢复和任意两版比对；首次编辑保存基线快照 |
| operations | id, actor_id, binding_id, kind, state, reviewed_manifest, message, svn_revision, error_code, created_at, finished_at | 提交/本地发布、状态恢复和防重复 |
| audit_events | id, actor_id, action, resource, operation_id, result, created_at | 登录、退出、草稿保存、提交与拒绝记录；错误信息脱敏 |

只保存 diff 不足以长期可靠还原，故保存不可变全文版本和父版本关系。默认不静默删除历史；需要控制容量时提供明确的归档/保留策略。私有草稿历史仅本人可读，已发布历史可按团队策略向登录用户展示，不默认匿名公开账户信息。

连接打开后启用外键、设置 busy_timeout；写事务不等待 SVN 网络命令。首版用单服务进程和串行数据库写入通道，SQLite 文件放本机磁盘，备份通过 sqlite3 backup API。

本次环境 sqlite3 底层版本为 3.49.1。建议首版使用 rollback journal，避免直接开启并发 WAL；如启用 WAL，须使用带官方 WAL-reset 修复的版本并验证运行时版本（官方列出的修复包括 3.51.3、3.50.7、3.44.6），且数据库不放网络共享。SQLite WAL 只有一个同时写入者且不支持跨主机共享文件。[SQLite WAL 文档](https://www.sqlite.org/wal.html)

## 10. 文件、数据库和 SVN 之间的失败恢复

它们不是同一个事务系统，不能声称 SQLite BEGIN 能回滚已完成的 SVN 提交。

操作状态：

```text
prepared → running → svn_committed → published
    ↘ needs_auth → 重新登录并显式恢复
                 ↘ failed
                 ↘ uncertain → 核对远端后恢复
```

- 先持久化提交意图、唯一 operation_id 和不可变版本清单，再发起远端操作。
- 重复提交同一 operation_id 返回已有结果。已冻结操作对应旧版内容，即使用户又保存新草稿，也不能偷偷换成新内容提交。
- 同一仓库队列覆盖提交、同步与发布；发布锁内检查 target_revision >= published_revision 后才能替换，并在完成后持久化新的 published_revision。数据库写锁不跨越网络操作，但 published_revision 的检查与发布必须由同一仓库的操作锁保护。
- 提交说明附应用操作标识用于核对；核对同时比较作者、仓库身份、精确变更路径和内容，不只凭日志字符串判断。
- SVN 成功但响应丢失/进程退出/数据库写失败：标为 uncertain 或启动恢复 running 任务；查远端日志核实，未核实前不自动再次提交。远端不可读时保持待核对，提供明确状态。
- SVN 已成功但本地发布/构建失败：保留 svn_revision，只重试同步发布与构建，不再 commit。发布版本不得低于当前 published_revision；对 docs/md 当前 hash 做前置检查，避免覆盖外部修改。
- 未绑定目录本地发布使用意图记录 → 文件替换 → 状态完成流程；重启按目标 hash 核对，明确记录未完成状态。
- 草稿保存成功以数据库事务提交为准；数据库失败时不先改共享源文件。

## 11. API 草案

| API | 权限与行为 |
|---|---|
| GET /__auth/session | 返回匿名/登录、功能可用性、CSRF token（登录后） |
| POST /__auth/login | 固定认证源的 SVN 账号密码验证、限速、创建会话 |
| POST /__auth/logout | 撤销会话；不删除草稿 |
| GET /__md/document?path=... | 登录后读取编辑基线/自己的草稿，返回服务端版本 |
| PUT /__md/draft | 登录 + CSRF + expected_version，保存个人草稿 |
| GET /__md/history?path=... | 按当前用户/发布历史策略返回版本列表 |
| GET /__md/diff?from=...&to=... | 验证版本访问权后返回安全的逐行差异 |
| GET /__svn/info?path=... | 服务端映射仓库，显示 URL/UUID/基线版本；调用者不提供任意服务器 URL |
| GET /__svn/status?binding=... | 仅当前用户 WC/草稿与缓存状态，远程刷新显式触发 |
| GET /__svn/log?binding=... | 当前账号访问目标库，分页/限制数量 |
| POST /__svn/refresh | 登录 + CSRF，排队刷新绑定库已发布镜像；只读同步身份执行 |
| POST /__svn/prepare | 冻结选中版本，生成 review token 与实际 diff |
| POST /__svn/commit | 登录 + CSRF，提交已审阅版本，返回 operation_id |
| GET /__operations/{id} | 本人或管理员可查看任务进展 |
| POST /__md/publish | 未绑定 SVN 目录的显式本地发布，版本校验和历史记录 |

旧 `/__md/save` 无法继续匿名运行。升级前后由同一权限层统一拒绝匿名；新前端迁到 draft 接口，旧调用返回清晰的认证/升级错误，不静默强制覆盖。

SVN 适配器只接受内部枚举命令、受管路径和配置中的仓库；subprocess 使用参数数组和 shell=False，校验换行/控制字符、选项注入、路径越界/符号链接、SVN peg revision 特殊字符。XML 输出用于结构化解析；命令/日志输出限制长度、设置超时，不把原始敏感参数写入审计。

## 12. 实施顺序和验收

### 阶段一：认证与只读边界

- 配置加载、服务入口、SQLite 迁移、SVN 认证适配器、登录/退出。
- 编辑入口、快捷键、旧保存接口、file:// 分发统一只读策略。
- 前端渲染净化、会话/CSRF、日志脱敏、配置/数据库静态访问阻断。

验收：匿名直接 POST 被拒绝；错误密码、匿名可读认证路径、系统已缓存其他账号都不能伪登录；合法账号可登录，密码不落库；退出后所有旧写请求失败。

### 阶段二：草稿与修改记录

- 保留现有编辑器预览功能，Ctrl+S 改为有版本的服务端个人草稿。
- SQLite 全文版本、差异面板、409 冲突处理、本地发布与恢复。

验收：两用户和两个标签页不互相覆盖；保存失败不改变已发布文件；EOL 保留；匿名搜索/内嵌离线数据不会包含个人草稿；重启重新登录后草稿可恢复。

### 阶段三：多库 SVN 操作与发布

- 最长目录匹配、真实 UUID/URL 校验、私有 WC、SVN 信息与日志。
- 审阅清单、当前账号提交、幂等操作、断网/超时/崩溃核对、外部 SVN 变更同步、发布/构建队列。

验收：A 库提交不夹带 B 库文件；A 用户提交不夹带 B 用户草稿；跨库分开操作；目标库无写权限时保留草稿；已有外部修改不会被覆盖；SVN 成功但站点更新失败可只重试发布。

同步验收：工程师本地提交可出现在站点和 SVN 日志中，但不产生网页修改记录；同步不得覆盖个人草稿；旧发布任务不能回滚新发布版本；外部删除和嵌套目录不会导致错误清理。

### 测试与交付

- Python 单元与 HTTP 权限集成测试、前端登录状态/快捷键/预览回归。
- SVN 单测以可控进程输出为基础，但认证正确性必须用强制密码认证的测试 SVN 服务做集成测试；`file://` 本地测试库无法验证账号密码。
- 增加账号 A/B、错误密码、匿名认证路径、只读账号、不同 UUID/嵌套目录、同文件并发、断网和提交后进程崩溃场景。
- 保留搜索、PacketDiag、Mermaid、KaTeX、导出、AI 检索等现有测试与浏览器验证；构建前后源文件不变。
- 本次基线检查已通过 87 项 Python、19 项 JavaScript 测试；尚未安装 SVN 客户端或连接实际仓库，本方案不包含真实 SVN 认证验证结论。

首版不引入账户密码注册/找回、多服务节点、Redis、ORM、后台静默 SVN 提交、跨库事务或分支自动合并。认证依托已有 SVN 账号体系，SQLite 管应用历史，代码只保留一个 SVN 调用入口。
