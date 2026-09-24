# 文档列表与即时 SVN 操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仓库入口与合并入口直接管理 Markdown 文档，并确保 SVN 仓库的创建、重命名、删除与本地内容保持一致，同时提升源码预览清晰度。

**Architecture:** `server/entries.py` 负责路径、草稿、权限、SVN 工作副本和幂等状态；`server/content_lock.py` 串行化 SVN 提交与后台同步。`web/folder-view.js` 作为正文列表与侧栏右键的统一交互入口，列表只在服务端操作成功后刷新。编辑器弹窗使用布局居中，避免 transform 导致的半像素文字合成。

**Tech Stack:** Python 3.6.8 标准库、Flask、SQLite、SVN CLI、原生 JavaScript/CSS、Docsify 离线构建。

---

- [x] 写设计与服务端红灯测试：即时 SVN 提交、冲突、只读、幂等、草稿保护。
- [x] 实现 `entries.py`、SVN move/delete、写锁和 API 路由。
- [x] 修正文件夹视图根路由，显示仓库对应目录的递归 Markdown 列表。
- [x] 让列表按钮与左侧导航右键共用操作，并支持一次性补充 SVN 凭据。
- [x] 优化编辑器预览弹窗布局和资源清晰度。
- [x] 更新 README.md、AGENTS.md、构建产物及测试断言。
- [ ] 用 Python 3.6.8、Node、离线构建完成验收，提交并推送 GitHub。
