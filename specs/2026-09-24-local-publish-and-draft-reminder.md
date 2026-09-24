# 本地发布（无 SVN）与暂存提醒

目标：
1. 编辑 MD 时，**没有 SVN 库**的文档（未配置文件夹 / `sourceMode=local`）能一步「保存到服务器」：写入 docs/md 并重建站点。
2. 有 SVN 库的文档保持两步：保存 = **本地暂存**（个人草稿，只在本机服务器）、提交 SVN = 写仓库；按钮文案改清楚。
3. 离开网页时，如果当前登录用户还有**未提交 SVN 的本地暂存**（或编辑器里有未保存修改），浏览器弹确认提醒。

## 设计

### 服务端

- `POST /__md/publish`（替换 501 桩；登录 + CSRF）`{path, content, baseHash}`：
  - 文档有 `read_only` / `allow_commit=false` 仓库 → 403（`repo_write_guard`）；
  - 关联 SVN 库 → 400 `use_svn_commit`（请用「提交 SVN」）；
  - 本地模式仓库 → `operations.local_publish_content`（写入 SQLite 主库并物化 docs/md，`baseHash` 校验）；
  - 未关联仓库 → `operations.publish_file`（`documents.save_md` 原子写 + base_hash 冲突 409 + 审计）；
  - 成功后触发站点重建（`on_config_changed`），网页即时更新。
- `GET /__md/drafts`（登录）：当前用户的活动草稿（path/version/updatedAt），供前端退出提醒。
- `FEATURES.localPublish = True`。

### 前端（`web/md-editor.js`）

- `isLocalDocument()`：未关联仓库或 `source_mode=local`（且非只读/首页）。
  - 「保存」按钮文案：本地文档 = 「保存到服务器」，SVN 文档 = 「本地暂存」；`Ctrl+S` 同源。
  - 本地文档保存走 `publishToServer()`：成功后更新 `original/baseHash`，状态提示「已保存到服务器（站点已更新）」；关闭编辑器时自动刷新页面看到更新；409 提示载入最新/合并，不覆盖。
  - 本地文档隐藏「提交 SVN…」「SVN 日志」，目标库标签显示「本地库 …（保存到服务器）」/「未关联 SVN（保存到服务器）」。
- 退出提醒：`beforeunload` → 有未提交草稿（`/__md/drafts`）或编辑器内未保存修改时弹确认；登录状态变化、保存草稿、放弃草稿、提交成功后刷新草稿数。

## 验证

- Python：`LocalPublishTests`（未关联文档写回 + 冲突 409 + SVN 库拒绝 400 + 只读 403 + 本地模式仓库发布；草稿列表接口）。
- Node：`node --check`（无新纯逻辑）。
- CDP 实测：未配置文档 Ctrl+S → docs/md 立即更新、关闭编辑器后页面显示新内容；SVN 文档保存=暂存、提交=写仓库；有草稿时刷新/离开出现提醒。
- 3.6.8 全量测试、构建幂等、`docs/md` 不变；提交并推送。
