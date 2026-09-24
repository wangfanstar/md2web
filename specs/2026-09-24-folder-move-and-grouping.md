# 文档按文件夹分组与移动到其他文件夹

目标（`index_仓库名.html` / `index_all.html` 的文件夹视图）：
1. 列出的文档如果来自子文件夹，按父文件夹分组显示，并在分组标题显示「文件夹相对路径 + 分组（配置页「分组」，子文件夹继承上级仓库）」。
2. 右键菜单（和「操作」按钮）支持「移动到…」：弹窗选择本仓库内的目标文件夹（跨仓库不允许）。
3. 移动时把文档引用的 `images/`、`附件/` 一并移动；若同一资源还被源目录其他文档引用，则保留原文件并在目标目录复制一份；目标目录已有同名资源时跳过并提示。

## 设计

### 服务端

- `GET /__folder`（`operations.folder_listing`）：
  - 文档增加 `folder`（父目录路径）与 `group`；文件夹增加 `group`；
  - `recursive=1` 时增加 `allFolders`（当前目录及所有子目录，含 path/name/group），供移动弹窗选择目标；
  - 分组解析：`md/<顶层>` 优先取 `folderGroups`，其次取仓库配置的 `group`，默认「默认」（由 `app.py` 注入解析函数）。
- `POST /__md/move`（登录 + CSRF，`entries.mutate('move')`）`{path, parent, requestId}`：
  - 只允许 Markdown 文档；目标目录必须存在；同名冲突 409；原地移动 400；跨仓库（含一方未配置）400；只读/关闭合入 403；有活动草稿 409。
  - 关联 SVN 的文档：工作副本 `svn move`（资源用 `shutil.copy2` + `svn add` 保留原文件，或被引用时 `svn move`），与其他目录操作一样先提交成功再发布本地。
  - 未关联/本地模式：`operations.move_entry` 直接移动文件与资源。
- `operations.move_entry(md_dir, relative, parent)` + `move_document_assets(...)`：移动资源并返回 `{moved, copied, conflicts}`。

### 前端（`web/folder-view.js` + `workspace.css`）

- `groupDocuments(documents)`：按 `folderPathOf(path)` 分组（按路径排序、组内按名称排序），组对象带 `folder`/`group`/`documents`，供渲染与单测。
- `renderFolderView`：只有一个分组且就是当前目录时保持原表格；否则每个文件夹一个小节，标题 `文件夹相对路径/` + `分组：xxx`（当前目录显示「（当前文件夹）」）。
- 右键菜单/操作按钮增加「移动到…」：弹窗（复用回收站弹窗样式）列出 `allFolders`（排除当前目录，显示路径与分组），确认后 `POST /__md/move` → 提示结果（含资源移动/复制/冲突数量）并刷新。

## 验证

- Node：`tests/test_folder_view.js` 覆盖 `groupDocuments`（分组、排序、分组信息）。
- Python：`folder_listing` 的 `group`/`allFolders`/`folder` 字段；`operations.move_entry` 资源移动/共享复制/同名冲突；HTTP 移动（未关联文档、本地库、草稿阻止、跨仓库拒绝、只读 403）；`EntryTests` 的 SVN 移动（`svn move` + 提交、资源随移）。
- 3.6.8 全量测试、Node 测试、构建幂等、CDP 实测（分组显示 / 移动弹窗 / 资源随移 / 刷新后正文与导航正确）；提交并推送。
