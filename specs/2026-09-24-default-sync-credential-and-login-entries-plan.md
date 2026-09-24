# 默认同步凭据与登录快捷入口 实施计划

> 设计见 `specs/2026-09-24-default-sync-credential-and-login-entries-design.md`。
> 仓库约定：TDD（先失败测试）、提交信息中文、验收用 Python 3.6.8。

**目标**：配置页可设置默认 SVN 同步账号（未单独配置凭据的仓库统一使用）；同步凭据改行内输入框；所有独立页有登录快捷入口。

**关键接口**

- `server/auth.py`
  - `DEFAULT_CREDENTIAL_ID = "__default__"`
  - `default_credential()` / `default_credential_username()` / `store_default_credential(username, password)`
  - `repo_sync_credential(binding, session_credential=None)` → 仓库凭据 → 默认凭据 → `session_credential` → `sync_credential()`（环境变量）
- `server/app.py`
  - `GET /__admin/default-credential` → `{"ok": true, "credential": {"configured": bool, "username": str}}`
  - `POST /__admin/default-credential` `{username, password}` → `verify_account` 校验后入库；管理员账号 400
- `web/md2web-config.js`：保留 ID 集合加入 `__default__`；行内凭据输入 + `saveRepoCredential` / `saveDefaultCredential` / `saveSiteCredential`
- `web/auth.js`：无侧栏宿主时渲染 `.site-auth-fixed` 固定右上角入口；`window.MD2WEB_BASE` 前缀用于 `__auth/*`

## 任务

- [ ] **T1 后端：默认凭据存储与接口（TDD）**
  - 先写失败测试（`tests/test_server.py`，类 `FolderOpsTests`）：
    - `test_default_credential_roundtrip`：管理员 POST 合法账号 → 200；`auth.default_credential()` 命中；库内 `secret` 非明文；GET 返回用户名；匿名 GET 401；无 CSRF 403；缺参 400。
    - `test_default_credential_rejects_admin_account`：`username=admin` → 400 `admin_account_not_allowed`，且不写库。
    - `test_default_credential_verify_failure_not_saved`：FakeSvn 拒绝口令 → 401 `auth_failed`，库里无默认凭据。
  - 3.6.8 跑测试确认失败。
  - 实现 `server/auth.py` 三个方法（复用 `store_repo_credential` / `repo_credential`，id 用 `DEFAULT_CREDENTIAL_ID`）。
  - 实现 `server/app.py` 两个接口（`/__admin/verify-account` 旁），校验复用 `auth_service.verify_account`。
  - 3.6.8 跑测试通过。

- [ ] **T2 后端：同步链路使用默认凭据（TDD）**
  - 先写失败测试：
    - `test_repo_sync_credential_precedence`：仓库凭据 > 默认凭据 > 环境变量（直接测 `auth.repo_sync_credential`）。
    - `test_sync_repositories_uses_default_credential`：配置仓库无自有凭据 + 默认凭据，`auth.sync_repositories(md_dir)` 后 FakeSvn 记录的 `credentials` 为默认账号；再设仓库凭据后同步使用仓库账号。
  - 实现 `repo_sync_credential` 并替换使用点：`sync_repositories`（`credential_of` 回退默认）、`backup_site_data`、`repo_health_reports`、`repair_repository`、`recreate_repository`、`recreate_site_backup_workcopy`、`app.py` 的 `/__admin/provision`（仓库 → 默认 → 会话 → 环境变量）。
  - 3.6.8 跑 `tests/test_server.py` 全绿。

- [ ] **T3 配置页：行内凭据 + 默认凭据面板**
  - `web/md2web_config.html`：新增「默认同步凭据（SVN 账号）」面板（认证路径、同步账号、密码、验证并保存、状态）；仓库明细行与网站备份面板改成行内输入。
  - `web/md2web-config.js`：`usedIds` 加入 `__default__`；`loadDefaultCredential`/`saveDefaultCredential`；`saveRepoCredential`/`saveSiteCredential` 读行内输入（删除 `window.prompt`）；`renderRepos`/`renderSiteBackup` 回填用户名与状态；监听 `siteauth:change` 刷新。
  - `web/md2web_config.html` 引入 `lib/auth.js` 与 `lib/auth.css`（登录快捷入口）。
  - `node --check web/md2web-config.js`。

- [ ] **T4 登录快捷入口（auth.js + 独立页）**
  - `web/auth.js`：`request()` 支持 `window.MD2WEB_BASE` 前缀；新增固定入口渲染（注入样式，右上角；侧栏宿主出现后隐藏/移除）。
  - `web/plot-playground.html`：`window.MD2WEB_BASE = '../'; <script src="auth.js">`。
  - `setup_docsify.py`：总览页 `docs/index.html` 加 `<script src="lib/auth.js"></script>`。
  - `tests/test_setup_docsify.py` 增加断言（总览页/绘图预览页含 auth.js；配置页含默认凭据保留 ID）。

- [ ] **T5 回归与验收**
  - 3.6.8 `python -m unittest discover -s tests` 全绿。
  - `node --test tests/test_search.js`、`tests/test_packetdiag.js`、`tests/test_ai_retrieval.js` 全绿。
  - `node --check` 全部改动 JS。
  - 3.6.8 `python setup_docsify.py`，`git status` 无意外差异；`docs/md` 未变。

**注意**：`web/` 改动后必须重建；`docs/lib/` 是产物不手改；不要提交密钥。
