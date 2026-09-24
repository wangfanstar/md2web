# 编辑器查找/替换与左侧导航子文件夹

两项改进：
1. 编辑 MD 界面（`web/md-editor.js`）增加查找/替换（Ctrl+F / Ctrl+H）。
2. 修复左侧导航：分组右键新建落到第一个子文件夹；空文件夹不出现在导航里。

## 设计

### 1. 查找/替换

- 纯逻辑抽到 `web/text-find.js`（`window.TextFind`，离线可用、可单测）：
  - `findMatches(text, query, options)` → `[{start, end}]`
  - `replaceAll(text, query, replacement, options)` → `{text, count}` 或 `{error}`
  - options：`caseSensitive`、`wholeWord`、`regex`；正则模式支持 `$1`/`$&` 替换，非法正则返回错误。
  - 整词匹配用「前后不是 [0-9A-Za-z_]」判断（兼容 CJK，不用 lookbehind）。
- 编辑器（`md-editor.js`）：
  - 源码面板内嵌查找条：查找输入 + 计数（第 n/m 个）+ 上一个/下一个 + 选项（Aa 大小写、W 整词、.* 正则）+ 关闭；
    替换模式多一行替换输入 + 替换 / 全部替换。
  - `Ctrl+F` 打开查找、`Ctrl+H` 打开替换（编辑器中拦截浏览器查找）；`Enter`/`Shift+Enter`、`F3`/`Shift+F3` 导航；`Esc` 先关查找条。
  - 命中通过 textarea 选区展示并滚动到可见区域；替换走 `historyRecord()` + `afterContentChanged(true)`，可撤销；全部替换一次完成并提示数量。
  - 工具栏加「查找」「替换」按钮，快捷键说明同步。
- 构建：`setup_docsify.py` 复制 `web/text-find.js` 到 `docs/lib/`，docsify 页面在 `md-editor.js` 之前引入。

### 2. 左侧导航

- 生成侧栏时把真实目录（`scan_directories`，跳过隐藏目录与 `images/`、`附件/`、`回收站/`）也并入目录树，
  空文件夹因此显示在左侧导航（无文档时只是分组名）。
- 分组标签写入 `data-folder="md/..."`：仓库分组链接、子文件夹分组（`<span class="sidebar-group-name">`）、
  以及「所有文档」（`data-folder="md"`）。
- `web/folder-view.js` 的 `pathFromElement`：
  - 文档链接 → 文档路径（不变）；
  - 分组节点 → 读取最近的 `data-folder`（精确定位，不再取第一个子文档的目录）；
  - 旧产物无 `data-folder` 时保留原兜底逻辑。
- 空文件夹可在左侧导航上右键新建文档/子文件夹（复用同一菜单）。

## 验证

- Node：`tests/test_text_find.js`（大小写/整词/正则/非法正则/全部替换/空匹配安全）。
- Python：`scan_directories` 忽略清单、空文件夹进入侧栏、`data-folder` 属性、仓库侧栏指向自身入口页。
- Node：`tests/test_folder_view.js` 覆盖 `pathFromElement` 的文档/分组/兜底三种输入。
- 重建后 CDP 实测：编辑器查找替换、空文件夹显示、分组右键新建归属正确。
- 3.6.8 全量测试、构建幂等、`docs/md` 不变；提交并推送 GitHub。
