# 第三方组件与许可声明（THIRD-PARTY NOTICES）

本项目（md2web）**基于 [docsify](https://github.com/docsifyjs/docsify) 构建并做了本地修改**：
站点前端由 docsify 驱动，`setup_docsify.py` 会在构建时下载/复用离线依赖，并对
`docsify.min.js` 打入「file:// 路由兼容」补丁（见下文「本地修改说明」）。

## 组件清单

| 组件 | 版本 | 许可 | 上游 | 用途 |
|------|------|------|------|------|
| docsify | 4.13.1 | MIT | https://github.com/docsifyjs/docsify | 站点框架（路由、侧栏、插件、Markdown 渲染） |
| docsify 官方插件 zoom-image / front-matter | 4.13.1 | MIT | 同上（`lib/plugins/`） | 图片缩放、Front Matter 解析 |
| Prism | 1.29.0 | MIT | https://github.com/PrismJS/prism | 代码高亮（核心由 docsify 内置，另含样式与按需加载器） |
| Mermaid | 11.17.2 | MIT | https://github.com/mermaid-js/mermaid | 流程图/时序图/甘特图等图形渲染（离线） |
| marked | 12.0.2 | MIT | https://github.com/markedjs/marked | 编辑器实时预览的 Markdown 渲染 |
| DOMPurify | 3.1.6 | Apache-2.0 OR MPL-2.0 | https://github.com/cure53/DOMPurify | 阅读/预览/AI 回答的 HTML 净化 |
| KaTeX | 0.16.11 | MIT | https://github.com/KaTeX/KaTeX | 数学公式渲染（含 20 个 woff2 字体） |

第三方文件位于 `docs/lib/`（构建自动补齐，离线可用），版本与下载地址登记在
`setup_docsify.py` 的 `ASSETS` 中；升级时请同步更新本文件。

## 本地修改说明

1. **docsify.min.js（file:// 路由兼容）**：docsify 在 `file://` 下用
   `location.replace` 跳转 hash 路由会导致刷新/回退异常，本项目改为在 `file://` 下使用
   `location.hash`（补丁代码见 `setup_docsify.patch_docsify_file_router`）。
2. **docsify 主题样式**：`patch_docsify_css` 对 `docsify.min.css` 做少量选择器/变量适配
   （`--docs-*` 令牌、目录与正文间距），不改变组件行为。
3. **其它自研前端**（`web/` 目录）：搜索、工作台、编辑器、AI 助手、媒体查看器、页面导出、
   PacketDiag 渲染等均为本项目原创实现，不属第三方组件。

## 许可与版权

- 上述第三方组件版权归各自作者所有，使用须遵守对应许可（MIT / Apache-2.0 / MPL-2.0）。
- 本项目自身代码的许可与使用范围由仓库维护者决定；分发时请保留本声明与各组件的许可信息。
- docsify 的 MIT 许可要求保留版权与许可声明：本项目在构建时会把版权/许可横幅
  （`docsify v4.13.1 | MIT License | https://github.com/docsifyjs/docsify`）写入
  `docs/lib/docsify.min.js` 文件头部，并在生成的 `docs/index.html` 中保留注释说明。
