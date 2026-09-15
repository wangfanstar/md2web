# 工程师离线工作台实施计划

**Goal:** 保留现有功能并提升多目录浏览、工程检索与离线可用性。

**Architecture:** Python 继续生成自包含 docs/；web/ 保存可维护的前端源码。搜索与工作台独立文件协作，通过 DOM 与已有路由连接。

**Tech Stack:** Python 标准库、原生 JavaScript/CSS、Docsify、Prism。

## 工作项

- [ ] 基线：49 项 Python 回归通过；保存源文档摘要，检查当前 file:// 页面。
- [ ] 资源边界：原样提取 CUSTOM_SEARCH_JS/CSS 至 web/；生成函数复制工作台与搜索资源到 docs/lib/。保持 Python 常量兼容。
- [ ] 目录与首页：先补单文件目录保留、重复文件名区分、首页分类/数量/离线说明测试，再修改 render_doc_tree 与 generate_readme；保留完整 Markdown 索引。
- [ ] 搜索：先补 Node 用例（多词、路径边界、文件模式、短语/排除、代码与特殊字符），再增强 web/custom-search.js；Python 代码索引及浏览器刷新语义保持一致。
- [ ] 布局：新增 web/workspace.js/css，增强目录 DOM、首页卡片、当前位置、复制及宽屏；保留搜索与阅读插件。
- [ ] 验证：python -m unittest discover -s tests -v；node --test tests/test_search.js；node --check 前端文件；离线重建与浏览器 file/HTTP/窄屏检查。
- [ ] 交付：更新 README 使用方法、重建实际 docs/、审查 diff 与源文档摘要、记录已验证结果。

## 分工与兼容接口

主代理负责 setup_docsify.py、Python 测试、README、集成与浏览器验收。搜索代理只编辑 web/custom-search.js 和 tests/test_search.js。布局代理只编辑 web/workspace.js/css。

首页使用 .workspace-home、.workspace-stats、.workspace-folder-grid、.workspace-folder-card；卡片为链接至该目录第一份文档，显示目录完整名称、递归文件数量和最多三份文档预览。完整索引保留为原生 details。

所有 JS/CSS 在 index.html 引用本地 lib/ 路径。工作台脚本加载于 custom-search.js 后，观察 Docsify 的 .sidebar-nav 和 .markdown-section 更新并保证幂等。
