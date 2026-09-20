# 仓库来源模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有 SVN 仓库能力的前提下，为每个挂载目录增加本地 SQLite 来源模式，并支持管理员安全切换、定时 SVN 同步和冲突提示。

**Architecture:** 配置层用 `sourceMode=local|svn` 明确唯一权威来源；数据库增加受管 Markdown 正文快照和来源事件；本地模式先写 SQLite 再物化到 `docs/md`，SVN 模式先从 SVN staging 导出并校验再回填 SQLite/发布目录。切换作为仓库级长操作执行，所有网络操作在数据库事务外完成。

**Tech Stack:** Python 3.6+ 标准库、Flask/Waitress、sqlite3（兼容 SQLite 3.7.17）、原生 HTML/JS、SVN CLI、现有 Docsify 构建流程。

---

### Task 1: 配置兼容与数据库迁移

**Files:**
- Modify: `server/config.py`
- Modify: `server/database.py`
- Test: `tests/test_server.py`

- [ ] 添加 `sourceMode` 解析、默认值和 local/svn 校验；旧配置无字段时保持 SVN 行为。
- [ ] 添加数据库迁移字段和 `repository_documents`、`source_events` 表，保持旧 SQLite 语法。
- [ ] 增加配置与 schema 回归测试，覆盖空 URL 的本地模式、旧配置兼容和迁移幂等。

### Task 2: 本地 SQLite 来源服务

**Files:**
- Modify: `server/database.py`
- Modify: `server/operations.py`
- Modify: `server/app.py`
- Test: `tests/test_server.py`

- [ ] 实现本地目录导入、SQLite 正文快照、hash/version 校验和原子物化。
- [ ] 让本地模式跳过 SVN 命令，并提供本地发布、状态和外部修改检测。
- [ ] 将本地发布接入现有草稿/操作/审计记录，增加失败恢复测试。

### Task 3: SVN 同步分流与冲突状态

**Files:**
- Modify: `server/operations.py`
- Modify: `server/auth.py`
- Modify: `serve.py`
- Test: `tests/test_server.py`

- [ ] 定时任务仅对 `sourceMode=svn` 入队；同步先 staging/校验，再写 SQLite 和发布目录。
- [ ] 处理远端变更、活动草稿、外部文件修改、认证失败和不确定提交状态。
- [ ] 增加 SVN 远端更新写入快照、冲突保留旧页面和重试测试。

### Task 4: 配置页模式切换与状态展示

**Files:**
- Modify: `server/app.py`
- Modify: `web/md2web_config.html`
- Modify: `web/md2web-config.js`
- Test: `tests/test_server.py`

- [ ] 增加来源模式选择、模式专属字段、健康状态和冲突提示。
- [ ] 实现管理员显式切换接口，要求导入方向选择并保留切换备份。
- [ ] 添加 local→svn、svn→local、切换冲突和取消/重试的接口测试。

### Task 5: 构建同步与验证

**Files:**
- Modify: `setup_docsify.py` only if source-mode metadata must enter generated indexes
- Modify: `docs/lib/*` through `python setup_docsify.py --offline`

- [ ] 运行 Python 全量测试、Node 测试和前端语法检查。
- [ ] 离线重建，验证 `docs/md` 内容不变、生成物幂等。
- [ ] 手工验证本地/ SVN 仓库在配置页的状态、切换确认和冲突提醒。
