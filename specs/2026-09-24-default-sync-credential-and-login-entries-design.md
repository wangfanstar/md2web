# 默认同步凭据与登录快捷入口

目标：配置页可设置一份「默认 SVN 同步账号」，统一用于所有未单独配置凭据的仓库同步；仓库可单独覆盖。
同步凭据输入改为行内输入框（不再用浏览器弹窗）；所有独立页面提供统一的登录快捷入口。

## 现状

- `repo_credentials` 表按 `repository_id` 加密保存同步凭据（`site-backup` 为网站备份专用 id）。
- `AuthService.sync_repositories` 用 `credential_of(binding)` 取仓库凭据，回退环境变量 `sync.credential_name`。
- 配置页 `web/md2web-config.js` 用 `window.prompt` 输入同步账号/密码；网站备份同样弹窗。
- 登录入口：docsify 侧栏（`auth.js` 指示器）、配置页管理员登录面板、反馈页登录按钮；总览页/回收站页/绘图预览页没有入口。

## 设计

### 1. 默认同步凭据（服务端）

- 保留 id：`server/auth.py` 定义 `DEFAULT_CREDENTIAL_ID = "__default__"`，复用 `repo_credentials` 表，
  与 `site-backup` 同类约定；配置页自动生成仓库 ID 时把 `__default__` 加入保留集合，避免冲突。
- `AuthService` 新增：
  - `default_credential()` / `default_credential_username()` / `store_default_credential(username, password)`；
  - `repo_sync_credential(binding, session_credential=None)`：**仓库自有 → 默认 → 会话（可选）→ 环境变量**。
- 使用点：`sync_repositories`（定时同步）、`backup_site_data`、`repo_health_reports`、`repair_repository`、
  `recreate_repository`、`recreate_site_backup_workcopy`、`server/app.py` 的 `/__admin/provision`。
  草稿合入（prepare/commit）仍使用登录用户凭据，不受影响。
- 接口（管理员 + CSRF）：
  - `GET /__admin/default-credential` → `{ok, credential: {configured, username}}`
  - `POST /__admin/default-credential` `{username, password}` → 先经 `verify_account`（SVN 认证路径）校验，
    通过后加密入库；本机管理员账号返回 400 `admin_account_not_allowed`；未配置认证路径返回 `not_configured`；
    SVN 拒绝口令按既有 AuthError 映射返回。

### 2. 配置页界面

- 新增面板「默认同步凭据（SVN 账号）」：认证路径 URL（与「账号切换与验证」面板同源，保存后双方刷新）、
  同步账号、密码、「验证并保存为默认凭据」；状态显示「未配置（回退环境变量）/ 已配置：user」。
- 仓库明细行内常显：`同步账号 / 密码 / 保存凭据` + 状态（已单独配置：user / 跟随默认凭据 / 未配置）；
  删除 `window.prompt`；`/__admin/credentials` 返回的用户名回填输入框（密码不回显）。
- 网站备份面板：同样行内用户名/密码 + 「保存备份凭据」，替换「设置备份凭据…」按钮。
- 监听 `siteauth:change`：登录/退出后刷新页面状态（面板、按钮可用性）。

### 3. 登录快捷入口

- `web/auth.js`：没有侧栏宿主（`.custom-search-top-row` / `aside.sidebar`）时，创建固定的右上角入口
  （`.site-auth-fixed`，样式由 auth.js 注入），内容与侧栏指示器一致：未登录=「登录」，已登录=「用户名 + 退出」；
  侧栏稍后渲染出现时自动移除固定入口，避免重复。
- 引入 auth.js 的页面：构建生成的 `docs/index.html`、`web/md2web_config.html`、`web/plot-playground.html`
  （配 `window.MD2WEB_BASE = '../'`，使 `__auth/*` 相对站点根解析）；回收站页已引入；反馈页保留自己的登录按钮。
- docsify 页面继续使用侧栏指示器，不显示固定入口。

### 4. 测试

- `tests/test_server.py`：
  - 默认凭据接口：校验通过后加密入库、`GET` 返回用户名、匿名 401、CSRF 403；
  - 校验失败不保存；本机管理员账号 400；
  - `repo_sync_credential` 优先级：仓库凭据 > 默认凭据 > 环境变量；
  - 定时同步（`sync_repositories`）与健康检查在无仓库凭据时使用默认凭据（FakeSvn 记录凭据）。
- `tests/test_setup_docsify.py`：总览页与 `plot-playground.html` 含 `lib/auth.js`；配置页保留 ID 含默认凭据保留 ID。
- 前端 `node --check`；3.6.8 全量测试；构建幂等；`docs/md` 逐字节不变。

## 兼容性

- 旧配置与库无需迁移：默认凭据是新增保留条目，未设置时行为与现在完全一致（仓库凭据/环境变量）。
- `web/` 改动后必须重建，`docs/lib/` 才会同步。
