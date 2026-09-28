# 文档文件夹来源类型（SVN 库 / 软链接 / 本地文件夹）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/md` 一级文件夹明确分为 SVN 库、软链接（强制只读）、本地文件夹三类，在配置页可检查/创建/移除链接，在总览与入口页首页用不同标记展示，并保证软链接目录不可写入。

**Architecture:** `server/folder_sources.py` 作为唯一的来源探测/安全遍历/链接管理模块，构建与服务共用；配置 `sourceMode` 为权威，未配置文件夹按实际目录探测；软链接在配置层强制只读并在所有写接口按路径兜底拦截。

**Tech Stack:** Python 3.6 标准库、Flask、原生 JavaScript/CSS、Docsify 构建流程。

**Spec:** `specs/2026-09-28-three-folder-source-types-design.md`

**基线说明:** 工作区已有上一轮半成品：`server/folder_sources.py`、`tests/test_folder_sources.py`、`server/config.py` / `server/app.py` / `server/operations.py` / `setup_docsify.py` / `web/md2web-config.js` 的部分改动（当前 352 个 Python 测试与 9 个 JS 测试全绿）。本计划在其上补齐并修正，不重复已有内容。

**验证约定:** 只跑 Python 3.6.8：`& "C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe" -m unittest ...`；Node 测试用 `node --test`；前端改动必须 `node --check` 后重建。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `server/folder_sources.py` | 链接识别（含失效/Windows 联接）、`describe`、只跟随一级链接的 `walk_paths`、`manage_link`（含错误码）、`has_link_ancestor` |
| `server/config.py` | `symlink` 类型校验、`linkTarget` 解析、强制只读 |
| `server/app.py` | `/__admin/folder-link`、`__folders` 探测字段、写接口软链接守卫、健康分支 |
| `server/entries.py` | 文档/文件夹在线操作的软链接写入拒绝 |
| `server/operations.py` | `sync_all` 跳过非 SVN、`repo_health` symlink 分支、repair/recreate/provision 守卫、`list_md_folders` 含链接 |
| `setup_docsify.py` | 扫描改安全遍历、auto 探测来源、总览/README 标记 |
| `web/md2web_config.html` / `web/md2web-config.js` | 三类型选择与按类型字段、链接管理按钮 |
| `tests/*` | 回归测试 |
| `README.md` / `AGENTS.md` | 使用与维护文档 |

---

### Task 1: folder_sources 加固（失效链接、遍历、空目录替换、错误码）

**Files:**
- Modify: `server/folder_sources.py`
- Test: `tests/test_folder_sources.py`

- [ ] **Step 1: 写失败测试（改一个旧测试 + 新增四个）**

把 `tests/test_folder_sources.py::FolderSourcesTests.test_reject_unsafe_and_overwrite` 中“已存在目录”改为**非空**目录（空目录按新规则允许替换）：

```python
    def test_reject_unsafe_and_overwrite(self):
        with self.assertRaises(ValueError):
            manage_link(self.md, 'md/a/b', self.target, 'create')
        with self.assertRaises(ValueError):
            manage_link(self.md, 'md/md', self.md, 'create')
        os.makedirs(os.path.join(self.md, 'existing'))
        with open(os.path.join(self.md, 'existing', 'keep.md'), 'w') as fh:
            fh.write('x')
        with self.assertRaises(ValueError):
            manage_link(self.md, 'existing', self.target, 'create')

    def test_broken_link_is_reported_as_symlink(self):
        try:
            os.symlink(os.path.join(self.tmp, 'missing'), os.path.join(self.md, 'broken'),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        info = describe(os.path.join(self.md, 'broken'))
        self.assertEqual(info['sourceMode'], 'symlink')
        self.assertFalse(info['linkExists'])
        self.assertTrue(is_directory_link(os.path.join(self.md, 'broken')))

    def test_empty_directory_can_be_replaced_by_link(self):
        os.makedirs(os.path.join(self.md, 'empty'))
        info = manage_link(self.md, 'empty', self.target, 'create')
        self.assertEqual(info['sourceMode'], 'symlink')
        self.assertTrue(info['linkExists'])

    def test_non_empty_directory_cannot_be_replaced(self):
        os.makedirs(os.path.join(self.md, 'busy'))
        with open(os.path.join(self.md, 'busy', 'x.md'), 'w') as fh:
            fh.write('x')
        with self.assertRaises(ValueError):
            manage_link(self.md, 'busy', self.target, 'create')

    def test_nested_links_inside_target_are_not_followed(self):
        nested_target = os.path.join(self.tmp, 'nested-target')
        os.makedirs(os.path.join(nested_target, 'deep'))
        with open(os.path.join(nested_target, 'deep', 'deep.md'), 'w') as fh:
            fh.write('deep')
        try:
            os.symlink(nested_target, os.path.join(self.target, 'nested-link'),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        manage_link(self.md, 'ext', self.target, 'create')
        paths = [p.replace('\\', '/') for p in walk_paths(self.md)]
        self.assertIn(self.md.replace('\\', '/') + '/ext/docs/a.md', paths)
        self.assertIn(self.md.replace('\\', '/') + '/ext/nested-link', paths)
        self.assertNotIn(self.md.replace('\\', '/') + '/ext/nested-link/deep/deep.md', paths)
```

同时把文件顶部 import 补上 `FolderLinkError`：`from server.folder_sources import (FolderLinkError, describe, has_link_ancestor, is_directory_link, manage_link, walk_paths)`，并新增错误码断言（加到 `test_empty_directory_can_be_replaced_by_link` 末尾）：

```python
        with self.assertRaises(FolderLinkError) as caught:
            manage_link(self.md, 'empty', self.target, 'create')
        self.assertEqual(caught.exception.code, 'link_exists')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `& "C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe" -m unittest tests.test_folder_sources -v`
Expected: 新测试 FAIL（`describe` 把失效链接当 local、嵌套链接被跟随、空目录替换抛错、`FolderLinkError` 未定义）。

- [ ] **Step 3: 实现（替换 `server/folder_sources.py` 对应函数）**

在常量区新增：

```python
_REPARSE = 0x0400
_TAG_MOUNT_POINT = 0xA0000003
_TAG_SYMLINK = 0xA000000C


class FolderLinkError(ValueError):
    """链接管理错误：code 供接口层直接回传前端。"""

    def __init__(self, code, message):
        super(FolderLinkError, self).__init__(message)
        self.code = code
```

`is_directory_link` / `describe` 替换为：

```python
def is_directory_link(path):
    """Return true for a directory symlink, Windows junction, or dangling link."""
    path = _path(path)
    try:
        info = os.lstat(path)
    except (OSError, ValueError):
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attrs = getattr(info, 'st_file_attributes', 0)
    if not attrs & _REPARSE:
        return False
    tag = getattr(info, 'st_reparse_tag', None)
    if tag is not None:
        return tag in (_TAG_MOUNT_POINT, _TAG_SYMLINK)
    try:
        real = os.path.normcase(os.path.realpath(path))
        return real != os.path.normcase(path)
    except (OSError, ValueError):
        return False


def describe(path):
    path = _path(path)
    if is_directory_link(path):
        try:
            target = os.path.realpath(path)
        except OSError:
            target = ''
        return {'sourceMode': 'symlink', 'linkTarget': target,
                'linkExists': bool(target and os.path.isdir(target))}
    return {'sourceMode': 'local', 'linkTarget': '',
            'linkExists': bool(os.path.isdir(path))}
```

`walk_paths` 替换为（嵌套链接只列出、不进入）：

```python
def walk_paths(root):
    """Yield lexical paths; follow links directly below *root* only, never nested links."""
    root = _path(root)
    if not os.path.isdir(root):
        return
    seen = set()

    def visit(directory, lexical):
        real = os.path.realpath(directory)
        if real in seen:
            return
        seen.add(real)
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return
        for name in names:
            if _ignored(name):
                continue
            actual = os.path.join(directory, name)
            out = os.path.join(lexical, name)
            if os.path.isdir(actual):
                yield out
                if not is_directory_link(actual):
                    for child in visit(actual, out):
                        yield child
            elif os.path.isfile(actual):
                yield out

    for name in sorted(os.listdir(root)):
        if _ignored(name):
            continue
        actual = os.path.join(root, name)
        out = os.path.join(root, name)
        if os.path.isdir(actual):
            yield out
            for child in visit(actual, out):
                yield child
        elif os.path.isfile(actual):
            yield out
```

`manage_link` 替换为（错误码 + 空目录替换）：

```python
def manage_link(md_dir, mount, target, action):
    """Check, create, or remove a safe top-level directory link."""
    root, link = _mount_path(md_dir, mount)
    action = str(action or 'check').lower()
    if action not in ('check', 'create', 'remove'):
        raise FolderLinkError('link_action_invalid', 'action 必须是 check、create 或 remove')
    if action == 'check':
        return describe(link)
    if action == 'remove':
        if not is_directory_link(link):
            raise FolderLinkError('not_a_link', '该位置不是目录链接，无需移除')
        if os.path.islink(link):
            os.unlink(link)
        else:
            os.rmdir(link)
        return describe(link)
    target = _path(target)
    if not os.path.isdir(target):
        raise FolderLinkError('link_target_invalid', '软链接目标必须是已存在的文件夹: %s' % target)
    if _inside(target, root) or _inside(root, target):
        raise FolderLinkError('link_target_invalid', '软链接目标不能位于 md 根目录及其内部')
    if os.path.lexists(link):
        if is_directory_link(link):
            raise FolderLinkError('link_exists', '目标位置已存在链接，请先移除链接')
        if not os.path.isdir(link) or os.listdir(link):
            raise FolderLinkError('link_not_empty', '目标位置已有非空目录，不能替换为软链接')
        os.rmdir(link)
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError:
        if os.name != 'nt':
            raise
        # Junctions do not require SeCreateSymbolicLinkPrivilege.
        try:
            subprocess.check_call(['cmd', '/c', 'mklink', '/J', link, target],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except (OSError, subprocess.CalledProcessError):
            raise
    return describe(link)
```

`has_link_ancestor` 不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `& "C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe" -m unittest tests.test_folder_sources -v`
Expected: `OK`（Windows 无权限的 symlink 用例 skip，允许）。

- [ ] **Step 5: 提交**

```bash
git add server/folder_sources.py tests/test_folder_sources.py
git commit -m "fix: 加固软链接识别与安全遍历"
```

---

### Task 2: 配置校验：linkTarget 解析与 symlink 强制只读

**Files:**
- Modify: `server/config.py`
- Test: `tests/test_server.py`（`ConfigTests`）

- [ ] **Step 1: 写失败测试**

在 `tests/test_server.py::ConfigTests` 末尾新增：

```python
    def test_symlink_repository_resolves_target_and_forces_read_only(self):
        target = self.tmp / "shared" / "hw"
        target.mkdir(parents=True)
        path = self.write_config({"repositories": [{
            "id": "hw", "mount": "md/硬件设计", "sourceMode": "symlink",
            "linkTarget": str(target), "url": "",
            "readOnly": False, "allowCommit": True, "syncIntervalSeconds": 30,
        }]})
        config = server_config.load_config(path, self.docs)
        repo = config["repositories"][0]
        self.assertEqual(repo["source_mode"], "symlink")
        self.assertEqual(repo["link_target"], str(target.resolve()))
        self.assertTrue(repo["read_only"])
        self.assertFalse(repo["allow_commit"])
        self.assertIsNone(repo["sync_interval"])

    def test_symlink_repository_accepts_relative_target_and_rejects_unsafe(self):
        (self.tmp / "shared").mkdir()
        path = self.write_config({"repositories": [{
            "id": "hw", "mount": "md/硬件设计", "sourceMode": "symlink",
            "linkTarget": "shared",
        }]})
        config = server_config.load_config(path, self.docs)
        self.assertEqual(config["repositories"][0]["link_target"],
                         str((self.tmp / "shared").resolve()))
        for item in (
            {"id": "x", "mount": "md/x", "sourceMode": "symlink", "linkTarget": ""},
            {"id": "x", "mount": "md/x", "sourceMode": "symlink",
             "linkTarget": str(self.tmp / "shared"),
             "url": "https://svn.example.invalid/svn/x/"},
            {"id": "x", "mount": "md/x", "sourceMode": "symlink",
             "linkTarget": str(self.docs / "md")},
            {"id": "x", "mount": "md/x", "sourceMode": "symlink",
             "linkTarget": str(self.tmp)},
        ):
            path = self.write_config({"repositories": [item]})
            with self.assertRaises(server_config.ConfigError, msg=json.dumps(item, ensure_ascii=False)):
                server_config.load_config(path, self.docs)

    def test_public_and_saved_config_keep_symlink_fields(self):
        target = self.tmp / "shared"
        target.mkdir()
        path = self.write_config({"repositories": [{
            "id": "hw", "mount": "md/硬件设计", "sourceMode": "symlink",
            "linkTarget": str(target),
        }]})
        config = server_config.load_config(path, self.docs)
        public = server_config.public_config(config)
        self.assertEqual(public["repositories"][0]["linkTarget"], str(target.resolve()))
        saved = server_config.config_to_json(config)
        self.assertEqual(saved["repositories"][0]["linkTarget"], str(target.resolve()))
        self.assertEqual(saved["repositories"][0]["sourceMode"], "symlink")
```

说明：`self.tmp / "no-such-target"` 不存在**不报错**（网络共享掉线不阻塞启动）；它出现在列表里是为了验证解析通过而不是抛错——从循环里移除，单独断言：

```python
    def test_symlink_repository_allows_offline_target(self):
        path = self.write_config({"repositories": [{
            "id": "hw", "mount": "md/硬件设计", "sourceMode": "symlink",
            "linkTarget": str(self.tmp / "offline-share"),
        }]})
        config = server_config.load_config(path, self.docs)
        self.assertTrue(config["repositories"][0]["link_target"].endswith("offline-share"))
```

- [ ] **Step 2: 运行测试确认失败**

Run: `& "C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe" -m unittest tests.test_server.ConfigTests -v`
Expected: FAIL（相对路径未解析、offsets/包含 md 的越界未拒绝、`sync_interval` 未清空；`allow_commit` 仍为 True）。

- [ ] **Step 3: 实现**

在 `server/config.py` 的 `_resolve_path` 后新增：

```python
def _resolve_link_target(base, value, docs_dir):
    """解析并校验软链接目标：相对路径按配置文件目录解析，禁止指向/包含 docs 或 md。"""
    raw = str(value or "").strip()
    if not raw:
        raise ConfigError("repositories[].linkTarget 不能为空（软链接必须填写目标目录）")
    if raw.startswith("\\\\") or raw.startswith("//"):
        raise ConfigError("linkTarget 不支持 UNC 网络路径，请先挂载为本地目录: %s" % raw)
    path = Path(raw)
    resolved = (base / path).resolve() if not path.is_absolute() else path.resolve()
    docs = Path(docs_dir).resolve()
    if resolved == docs or docs in resolved.parents:
        raise ConfigError("linkTarget 不能放在 docs/ 内（会随站点分发）: %s" % resolved)
    md_root = docs / "md"
    if resolved == md_root or md_root in resolved.parents:
        raise ConfigError("linkTarget 不能位于 md 目录内: %s" % resolved)
    if resolved in md_root.parents:
        raise ConfigError("linkTarget 不能包含 md 目录（会造成递归收录）: %s" % resolved)
    return str(resolved)
```

把仓库循环里的 `link_target` 分支改为（替换现有 `raw_url` / `link_target` 处理）：

```python
        raw_url = str(item.get("url") or "").strip()
        link_target = ""
        if source_mode == "svn":
            repo_url = _check_url(raw_url, f"repositories[{index}].url")
        else:
            if raw_url:
                raise ConfigError(f"repositories[{index}] 非 SVN 模式不能配置 SVN URL，请清空 url")
            repo_url = ""
        if source_mode == "symlink":
            link_target = _resolve_link_target(
                base, item.get("linkTarget", item.get("link_target", "")), docs_dir)
```

把追加字典中的两个字段改为：

```python
            "read_only": True if source_mode == "symlink" else bool(item.get("readOnly", False)),
            "allow_commit": False if source_mode == "symlink" else bool(item.get("allowCommit", True)),
```

并在 `sync_interval` 解析完成后追加：

```python
        if source_mode == "symlink":
            sync_interval = None
```

- [ ] **Step 4: 运行测试确认通过**

Run: `& "C:\Users\wangf\AppData\Local\Temp\opencode\py36\python\python.exe" -m unittest tests.test_server.ConfigTests -v`
Expected: `OK`。

- [ ] **Step 5: 提交**

```bash
git add server/config.py tests/test_server.py
git commit -m "feat: 配置层支持软链接来源并强制只读"
```

---

### Task 3: 构建扫描与标记

**Files:**
- Modify: `setup_docsify.py`（新增 `import os`、`from server import folder_sources`）
- Modify: `server/app.py`（`folder_metrics`）
- Modify: `server/operations.py`（`list_md_folders` 含链接）
- Test: `tests/test_setup_docsify.py`、`tests/test_server.py`

- [ ] **Step 1: 写失败测试**

`tests/test_setup_docsify.py` 新增测试类（放在 `MultiRepoTests` 之后；文件顶部若无 `import os` 需补上）：

```python
class FolderSourceBuildTests(TempDirTestCase):
    """未配置文件夹的来源探测：软链接/失效链接/普通目录与循环安全。"""

    def link(self, name, target):
        try:
            os.symlink(str(target), str(self.md / name), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')

    def test_unconfigured_symlink_detected_and_marked_in_overview(self):
        self.write_doc("本地/a.md", "# A")
        external = self.tmp / "外部资料"
        external.mkdir()
        (external / "b.md").write_text("# B", encoding="utf-8")
        self.link("外部资料", external)
        auto = self.module.auto_folder_repos([])
        item = [entry for entry in auto if entry["id"] == "外部资料"][0]
        self.assertEqual(item["source_mode"], "symlink")
        self.assertEqual(item["link_target"], str(external.resolve()))
        self.assertTrue(item["link_exists"])
        self.assertTrue(item["read_only"])
        self.assertFalse(item["allow_commit"])
        with mock.patch.object(self.module, "load_repositories", lambda: []):
            with redirect_stdout(io.StringIO()):
                repos = self.module.load_all_repos()
        self.module.generate_master_index_html(repos, "测试站")
        page = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertIn('badge symlink', page)
        self.assertIn("↗ 软链接", page)
        self.assertIn("本地文件夹", page)
        self.assertNotIn("未配置 SVN", page)

    def test_broken_link_marked_and_skipped_by_scan(self):
        self.write_doc("本地/a.md", "# A")
        self.link("失效资料", self.tmp / "不存在")
        auto = self.module.auto_folder_repos([])
        item = [entry for entry in auto if entry["id"] == "失效资料"][0]
        self.assertEqual(item["source_mode"], "symlink")
        self.assertFalse(item["link_exists"])
        self.module.generate_master_index_html(auto, "测试站")
        page = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertIn("链接失效", page)
        self.assertEqual(self.scan(), ["本地/a.md"])

    def test_scan_follows_top_level_link_but_not_nested_links(self):
        self.write_doc("本地/a.md", "# A")
        external = self.tmp / "外部资料"
        nested_target = self.tmp / "深层"
        (external / "sub").mkdir(parents=True)
        (external / "sub" / "b.md").write_text("# B", encoding="utf-8")
        nested_target.mkdir()
        (nested_target / "hidden.md").write_text("# C", encoding="utf-8")
        try:
            os.symlink(str(nested_target), str(external / "nested-link"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        self.link("外部资料", external)
        files = self.scan()
        self.assertIn("外部资料/sub/b.md", files)
        self.assertNotIn("外部资料/nested-link/hidden.md", files)

    def test_readme_repo_list_labels_sources(self):
        repos = [
            {"id": "svn", "mount": "md/svn", "url": "https://svn.example.invalid/x/",
             "source_mode": "svn", "group": "默认", "read_only": False, "allow_commit": True},
            {"id": "link", "mount": "md/link", "source_mode": "symlink",
             "link_target": "D:/share", "link_exists": True, "group": "默认",
             "read_only": True, "allow_commit": False},
            {"id": "missing", "mount": "md/missing", "source_mode": "symlink",
             "link_target": "D:/gone", "link_exists": False, "group": "默认",
             "read_only": True, "allow_commit": False},
            {"id": "local", "mount": "md/local", "source_mode": "local",
             "group": "默认", "read_only": True, "allow_commit": False},
        ]
        with redirect_stdout(io.StringIO()):
            self.module.generate_readme(["svn/a.md"], "测试站", repos=repos)
        text = (self.docs / "html" / "README.md").read_text(encoding="utf-8")
        self.assertIn("来源：SVN 库", text)
        self.assertIn("来源：↗ 软链接", text)
        self.assertIn("链接失效", text)
        self.assertIn("来源：本地文件夹", text)
```

`tests/test_server.py::FolderMetadataTests` 新增（链接目录的 `__folders` 元数据与探测字段）：

```python
    def test_folders_report_symlink_detection_and_size(self):
        external = self.tmp / "外部资料"
        external.mkdir()
        (external / "link.md").write_text("# L\n", encoding="utf-8")
        try:
            os.symlink(str(external), str(self.docs / "md" / "外部资料"),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        folders = {item["path"]: item for item in self.client.get("/__folders").get_json()["folders"]}
        item = folders["md/外部资料"]
        self.assertEqual(item["sourceMode"], "symlink")
        self.assertEqual(item["linkTarget"], str(external.resolve()))
        self.assertTrue(item["linkExists"])
        self.assertEqual(item["mdFiles"], 1)
        self.assertGreater(item["sizeBytes"], 0)
```

（`tests/test_server.py` 顶部需要 `import os`；已存在则跳过。）

- [ ] **Step 2: 运行测试确认失败**

Run: `& "...py36\python.exe" -m unittest tests.test_setup_docsify.FolderSourceBuildTests tests.test_server.FolderMetadataTests -v`
Expected: FAIL（auto 仍为 local、无 badge、README 无来源、`/__folders` 无探测字段/未统计链接）。

- [ ] **Step 3: 实现**

`setup_docsify.py`：

1) 顶部 import 增加 `import os` 与 `from server import folder_sources`（放在 `from server import references as reference_tools` 旁）。

2) `scan_markdown` 的收集循环替换：

```python
    files = []
    root = Path(md_dir)
    for candidate in folder_sources.walk_paths(root):
        path = Path(candidate)
        if not path.is_file():
            continue
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if path.suffix == ".md":
            files.append(relative.as_posix())
        elif path.suffix.lower() == ".md":
            print(f"  [警告] 跳过非小写扩展名文档: {display_path(path)}（请重命名为 .md）")
    files.sort()
```

（删除原来的 `root.rglob("*")` 循环与 `part.startswith(".")` 判断——`walk_paths` 已跳过隐藏目录与 `回收站`。）

3) `scan_directories` 替换为：

```python
    root = Path(md_dir)
    directories = []
    if not root.is_dir():
        return directories
    for candidate in folder_sources.walk_paths(root):
        path = Path(candidate)
        if not path.is_dir():
            continue
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if any(part in SIDEBAR_IGNORED_DIRS for part in relative.parts):
            continue
        directories.append(relative.as_posix())
    directories.sort()
    return directories
```

4) `first_level_folders` 替换为：

```python
def first_level_folders():
    """docs/md 下的一级文件夹名（含失效链接，不含隐藏目录与回收站）。"""
    if not MD_DIR.is_dir():
        return []
    names = []
    for name in sorted(os.listdir(str(MD_DIR))):
        if name.startswith(".") or name == "回收站":
            continue
        path = MD_DIR / name
        if path.is_dir() or folder_sources.is_directory_link(path):
            names.append(name)
    return names
```

5) `load_repositories` 在 `folder_groups` 覆盖循环后追加：

```python
        for repo in repos:
            sub = mount_subpath(repo["mount"])
            probe = folder_sources.describe(MD_DIR / sub) if sub else {"linkExists": False}
            repo["link_exists"] = bool(probe.get("linkExists", False))
```

6) `auto_folder_repos` 的 `auto.append({...})` 改为：

```python
        info = folder_sources.describe(MD_DIR / name)
        auto.append({
            "id": name,
            "mount": "md/" + name,
            "url": "",
            "source_mode": info.get("sourceMode", "local"),
            "link_target": info.get("linkTarget", ""),
            "link_exists": bool(info.get("linkExists", False)),
            "group": groups.get("md/" + name, "默认"),
            "read_only": info.get("sourceMode") == "symlink",
            "allow_commit": info.get("sourceMode") != "symlink",
            "sync_interval": None,
            "auto": True,
        })
```

7) `MASTER_STYLE` 的 badge 增加：

```css
  .badge.broken { background: #fee2e2; color: #b91c1c; }
```

8) `generate_master_index_html` 的 badge 与 note 替换为：

```python
            source_mode = repo.get("source_mode", "svn")
            if source_mode == "symlink":
                badges += '<span class="badge symlink">↗ 软链接</span>'
                if not repo.get("link_exists", True):
                    badges += '<span class="badge broken">链接失效</span>'
            elif source_mode == "local":
                badges += '<span class="badge local">本地文件夹</span>'
            else:
                badges += '<span class="badge svn">SVN 库</span>'
            if repo.get("read_only"):
                badges += '<span class="badge readonly">只读</span>'
            if not repo.get("allow_commit", True):
                badges += '<span class="badge readonly">禁止合入</span>'
            if source_mode == "symlink":
                note = "→ " + (repo.get("link_target") or "目标目录未配置")
                if not repo.get("link_exists", True):
                    note += "（链接失效，请检查目标目录）"
            elif source_mode == "svn":
                note = repo.get("url") or "（未填写 SVN 地址）"
            else:
                note = "本地文件夹（不连接 SVN）"
```

（删除原来的 `if repo.get("auto"): badges += '未配置 SVN'` 与旧 note 三元表达式。）

9) `generate_readme` 的仓库列表分支替换为：

```python
            for repo in groups[group]:
                source_mode = repo.get("source_mode", "svn")
                labels = {"svn": "SVN 库", "symlink": "↗ 软链接", "local": "本地文件夹"}
                flags = ["来源：" + labels.get(source_mode, "SVN 库")]
                if source_mode == "symlink":
                    flags.append("→ " + (repo.get("link_target") or "目标未配置"))
                    if not repo.get("link_exists", True):
                        flags.append("链接失效")
                if repo.get("read_only"):
                    flags.append("只读")
                if not repo.get("allow_commit", True):
                    flags.append("禁止合入")
                suffix = "（" + "、".join(flags) + "）"
                page = HTML_PREFIX + repo_page_name(repo["id"])
                lines.append(f'- <a href="{page}">{repo["id"]}</a> · `{repo["mount"]}`{suffix}')
```

10) `generate_index_html` 的 `repo_list_js` 增加字段：

```python
         "url": item.get("url", ""), "sourceMode": item.get("source_mode", "svn"),
         "linkTarget": item.get("link_target", ""), "linkExists": bool(item.get("link_exists", False))}
```

`server/app.py` 的 `folder_metrics`：把 `for item in child.rglob("*"):` 循环替换为：

```python
            for candidate in folder_sources.walk_paths(child):
                path = Path(candidate)
                if not path.is_file():
                    continue
                try:
                    relative = path.relative_to(child)
                except ValueError:
                    continue
                if ".svn" in relative.parts:
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                file_size = int(stat.st_size)
                files += 1
                size += file_size
                newest = max(newest, int(stat.st_mtime))
                if len(relative.parts) > 1:
                    nested_files += 1
                    nested_bytes += file_size
                if path.suffix.lower() == ".md":
                    md_files += 1
                    md_bytes += file_size
                else:
                    other_files += 1
                    other_bytes += file_size
```

`server/operations.py` 的 `list_md_folders`：头部加 `from . import folder_sources`；循环替换为：

```python
    for path in sorted(root.iterdir()):
        if path.name.startswith(".") or path.name == "回收站":
            continue
        if not path.is_dir() and not folder_sources.is_directory_link(path):
            continue
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        mount = "md/" + relative
        documents = 0
        if path.is_dir():
            for child in path.iterdir():
                if child.is_file() and child.suffix.lower() == ".md" and not child.name.startswith("."):
                    documents += 1
```

- [ ] **Step 4: 运行测试确认通过**

Run: `& "...py36\python.exe" -m unittest tests.test_setup_docsify.FolderSourceBuildTests tests.test_server.FolderMetadataTests tests.test_setup_docsify.MultiRepoTests -v`
Expected: `OK`；随后全量 `tests.test_setup_docsify` 与 `tests.test_server` 通过。

- [ ] **Step 5: 提交**

```bash
git add setup_docsify.py server/app.py server/operations.py tests/test_setup_docsify.py tests/test_server.py
git commit -m "feat: 构建识别软链接来源并统一标记"
```

---

### Task 4: 管理接口 `POST /__admin/folder-link`

**Files:**
- Modify: `server/app.py`
- Test: `tests/test_server.py`

- [ ] **Step 1: 写失败测试**

新增测试类（放在 `AdminConfigTests` 之后）：

```python
class FolderLinkApiTests(ServerTestBase):
    """/__admin/folder-link：检查/创建/移除软链接（管理员 + CSRF）。"""

    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        server_database.ensure_admin(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.auth = server_auth.AuthService(self.conn, FakeSvn(), self.config)
        self.auth.on_startup()
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()
        self.client.post("/__auth/login", json={"username": "admin", "password": "admin"})

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def csrf(self):
        return self.client.get("/__auth/session").get_json()["csrfToken"]

    def test_manage_link_requires_admin_and_csrf(self):
        target = self.tmp / "shared"
        target.mkdir()
        anonymous = self.client.post("/__admin/folder-link",
                                     json={"mount": "md/共享", "action": "create", "target": str(target)})
        self.assertEqual(anonymous.status_code, 401)
        response = self.client.post("/__admin/folder-link",
                                    json={"mount": "md/共享", "action": "create", "target": str(target)})
        self.assertEqual(response.status_code, 403, "登录但无 CSRF 也必须拒绝")
        self.assertEqual(response.get_json()["code"], "csrf_failed")

    def test_create_check_and_remove_link(self):
        target = self.tmp / "shared"
        target.mkdir()
        (target / "a.md").write_text("# A\n", encoding="utf-8")
        headers = {"X-CSRF-Token": self.csrf()}
        created = self.client.post("/__admin/folder-link",
                                   json={"mount": "md/共享", "action": "create", "target": str(target)},
                                   headers=headers)
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        link = created.get_json()["link"]
        self.assertEqual(link["sourceMode"], "symlink")
        self.assertTrue(link["linkExists"])
        checked = self.client.post("/__admin/folder-link",
                                   json={"mount": "md/共享", "action": "check"},
                                   headers=headers)
        self.assertEqual(checked.get_json()["link"]["linkTarget"], str(target.resolve()))
        removed = self.client.post("/__admin/folder-link",
                                   json={"mount": "md/共享", "action": "remove"},
                                   headers=headers)
        self.assertEqual(removed.get_json()["link"]["sourceMode"], "local")
        self.assertTrue(target.is_dir(), "移除链接不能删除目标目录")

    def test_manage_link_rejects_unsafe_targets_and_non_empty_directory(self):
        headers = {"X-CSRF-Token": self.csrf()}
        (self.tmp / "shared").mkdir()
        response = self.client.post("/__admin/folder-link",
                                    json={"mount": "md/共享", "action": "create",
                                          "target": str(self.docs / "md")},
                                    headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "link_target_invalid")
        busy = self.docs / "md" / "非空"
        busy.mkdir()
        (busy / "keep.md").write_text("# K\n", encoding="utf-8")
        response = self.client.post("/__admin/folder-link",
                                    json={"mount": "md/非空", "action": "create",
                                          "target": str(self.tmp / "shared")},
                                    headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "link_not_empty")
        response = self.client.post("/__admin/folder-link",
                                    json={"mount": "md/普通", "action": "remove"},
                                    headers=headers)
        self.assertEqual(response.get_json()["code"], "not_a_link")

    def test_broken_link_check_reports_missing(self):
        headers = {"X-CSRF-Token": self.csrf()}
        try:
            os.symlink(str(self.tmp / "gone"), str(self.docs / "md" / "失效"),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        response = self.client.post("/__admin/folder-link",
                                    json={"mount": "md/失效", "action": "check"},
                                    headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["link"]["sourceMode"], "symlink")
        self.assertFalse(response.get_json()["link"]["linkExists"])
```

（`self.tmp / "shared"` 在最后一条断言前需存在；在 `test_manage_link_rejects_unsafe_targets_and_non_empty_directory` 开头加 `(self.tmp / "shared").mkdir()`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `& "...py36\python.exe" -m unittest tests.test_server.FolderLinkApiTests -v`
Expected: FAIL（404，接口不存在）。

- [ ] **Step 3: 实现**

`server/app.py` 在 `set_repo_group` 之后新增：

```python
    @app.post("/__admin/folder-link")
    def manage_folder_link():
        """检查/创建/移除 md 下一级文件夹的软链接（管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            result = folder_sources.manage_link(
                md_dir(), payload.get("mount"), payload.get("target"), payload.get("action"))
        except folder_sources.FolderLinkError as error:
            return json_error(400, error.code, str(error))
        except ValueError as error:
            return json_error(400, "link_error", str(error))
        except OSError as error:
            return json_error(500, "link_error", "链接操作失败：%s" % error)
        if payload.get("action") in ("create", "remove") and on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, "link": result})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `& "...py36\python.exe" -m unittest tests.test_server.FolderLinkApiTests -v`
Expected: `OK`。

- [ ] **Step 5: 提交**

```bash
git add server/app.py tests/test_server.py
git commit -m "feat: 增加软链接检查/创建/移除管理接口"
```

---

### Task 5: 写入保护、同步/健康/修复守卫

**Files:**
- Modify: `server/app.py`（写接口守卫）
- Modify: `server/entries.py`
- Modify: `server/operations.py`
- Test: `tests/test_server.py`

- [ ] **Step 1: 写失败测试**

`LocalPublishTests` 新增（顶部确保 `import os` 与 `from server import folder_sources as server_folder_sources`）：

```python
    def test_symlink_folder_rejects_all_writes(self):
        target = self.tmp / "外部资料"
        target.mkdir()
        (target / "a.md").write_text("# A\n", encoding="utf-8")
        try:
            server_folder_sources.manage_link(self.docs / "md", "md/软链接", str(target), "create")
        except (OSError, ValueError):
            self.skipTest('link unavailable')
        headers = {"X-CSRF-Token": self.csrf()}
        path = "md/软链接/a.md"
        response = self.client.post("/__md/publish",
                                    json={"path": path, "content": "# B\n", "baseHash": ""},
                                    headers=headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "symlink_readonly")
        response = self.client.put("/__md/draft",
                                   json={"path": path, "content": "# B\n", "expectedVersion": 0},
                                   headers=headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "symlink_readonly")
        response = self.client.post("/__md/create",
                                    json={"parent": "md/软链接", "name": "新文档", "kind": "document"},
                                    headers=headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "symlink_readonly")
        self.assertEqual((target / "a.md").read_text(encoding="utf-8"), "# A\n")
```

`SvnOperationTests` 增加 symlink 跳过同步与健康检查（复用该类已有 `self.config`/`self.md_dir`；若字段名不同以类内现有为准）：

```python
    def test_sync_all_skips_symlink_source_without_calling_svn(self):
        link = {"id": "link", "mount": "md/链接", "source_mode": "symlink",
                "link_target": str(self.tmp / "shared"), "url": "",
                "read_only": True, "allow_commit": False, "credential_group": "default",
                "sync_interval": 1}
        self.config["repositories"] = [link]

        class NeverSvn:
            def info(self, *args, **kwargs):
                raise AssertionError("symlink source must not call svn")

        self.assertEqual(server_operations.sync_all(self.conn, NeverSvn(), self.config,
                                                    self.md_dir, now=time.time() + 1000), [])

    def test_repo_health_reports_symlink_without_svn(self):
        external = self.tmp / "shared"
        external.mkdir()
        try:
            server_folder_sources.manage_link(self.md_dir, "md/链接", str(external), "create")
        except (OSError, ValueError):
            self.skipTest('link unavailable')
        binding = {"id": "link", "mount": "md/链接", "source_mode": "symlink",
                   "link_target": str(external.resolve()), "url": "",
                   "read_only": True, "allow_commit": False, "credential_group": "default",
                   "sync_interval": None}
        report = server_operations.repo_health(self.conn, None, self.config, self.md_dir, binding)
        self.assertEqual(report["status"], "软链接（只读）")
        self.assertEqual(report["level"], "ok")

    def test_repair_and_provision_reject_symlink(self):
        binding = {"id": "link", "mount": "md/链接", "source_mode": "symlink",
                   "link_target": str(self.tmp / "shared"), "url": "",
                   "read_only": True, "allow_commit": False, "credential_group": "default",
                   "sync_interval": None}
        for call in (lambda: server_operations.provision_repository(
                        self.conn, None, self.config, self.md_dir, binding),
                     lambda: server_operations.repair_repo(
                        self.conn, None, self.config, self.md_dir, binding)):
            with self.assertRaises(server_operations.OperationError) as caught:
                call()
            self.assertEqual(caught.exception.status, 400)
```

（`server_operations.repo_health` 的 `svn_client` 传 `None`，symlink 分支不得触碰它。）

- [ ] **Step 2: 运行测试确认失败**

Run: `& "...py36\python.exe" -m unittest tests.test_server.LocalPublishTests tests.test_server.SvnOperationTests -v`
Expected: FAIL（publish 会写穿链接或报路径越界、draft 未拒绝、entries 未拒绝、sync/health/repair 未处理 symlink）。

- [ ] **Step 3: 实现**

`server/app.py`：在 `md_dir()` 定义后新增：

```python
    def symlink_write_guard(path):
        """软链接目录（含未配置、靠物理路径识别的链接）一律拒绝写入。"""
        if path and folder_sources.has_link_ancestor(md_dir(), path):
            return json_error(403, "symlink_readonly", "软链接目录只读，请在目标目录直接修改")
        return None
```

在以下位置（CSRF 校验之后、业务调用之前）插入 `guard = symlink_write_guard(...)` / `if guard is not None: return guard`：

- `put_draft`：参数 `payload.get("path")`；
- `upload_image`、`upload_attachment`：参数 `payload.get("path")`；
- `pending_publish`：参数 `payload.get("path")`（放在 `binding = ...` 之前）。

`server/entries.py`：`from . import database, documents, folder_sources, operations, recycle`；在 `mutate` 里 `canonical` 调用之前插入：

```python
    for raw in (payload.get('parent'), payload.get('path')):
        if raw and folder_sources.has_link_ancestor(md_dir, raw):
            raise operations.OperationError(403, '软链接目录只读，请在目标目录直接修改',
                                            code='symlink_readonly')
```

`server/operations.py`：

1) 顶部 `from . import folder_sources`（与现有相对导入并列）。
2) `sync_all` 跳过条件改为：

```python
        if binding.get("source_mode", "svn") != "svn":
            continue
```

3) `repo_health` 在 `local_path` / `row` 计算后、`if not url:` 之前插入 symlink 分支：

```python
    if (binding.get("source_mode") or "svn") == "symlink":
        info = folder_sources.describe(local_path)
        if info.get("linkExists"):
            result.update(status="软链接（只读）",
                          detail="内容来自链接目标：%s" % info.get("linkTarget"),
                          hints=["在目标目录直接修改内容后重新构建站点"])
        else:
            result.update(status="链接失效", level="error",
                          detail="链接目标不存在或不可访问：%s" % (binding.get("link_target") or ""),
                          hints=["检查目标目录（网络共享/磁盘）", "在配置页移除后重新创建链接"])
        return result
```

4) `repair_repo` / `recreate_repo` / `provision_repository` 开头统一加：

```python
    if (binding.get("source_mode") or "svn") != "svn":
        raise OperationError(400, "该文件夹不是 SVN 库（本地文件夹/软链接），不支持该操作")
```

`server/app.py` 的 `repo_health_endpoint`：把 local/svn 拆分改为：

```python
        local = [item for item in bindings if item.get("source_mode") == "local"]
        remote = [item for item in bindings if item.get("source_mode") != "local"]
        reports = []
        if remote or not repo_id:
            reports = auth_service.repo_health_reports(md_dir(), remote, credential,
                                                       include_site_backup=not repo_id)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `& "...py36\python.exe" -m unittest tests.test_server.LocalPublishTests tests.test_server.SvnOperationTests tests.test_server.FolderMetadataTests -v`
Expected: `OK`。

- [ ] **Step 5: 提交**

```bash
git add server/app.py server/entries.py server/operations.py tests/test_server.py
git commit -m "feat: 软链接强制只读并跳过同步/修复流程"
```

---

### Task 6: 配置页三类型 UI

**Files:**
- Modify: `web/md2web_config.html`
- Modify: `web/md2web-config.js`
- Test: `tests/test_md2web_config.js`（Task 7）

- [ ] **Step 1: 修改 HTML**

`web/md2web_config.html`：

- 表头 `<th>启用 SVN</th>` → `<th>来源类型</th>`；
- 状态说明第一条末尾追加：`软链接为只读来源，内容在目标目录维护，网页不修改目标文件。`
- 样式区在 `.repo-detail .repo-flags .perm-hint:empty { display: none; }` 后追加：

```css
    .repo-detail [data-source-field][hidden] { display: none !important; }
    .repo-detail .repo-field-link-target { grid-column: span 7; order: 1; }
    .repo-detail .repo-link-box { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; grid-column: span 12; order: 4; }
    .repo-detail .repo-link-box .hint { margin-left: 2px; }
    .repo-source-label select { min-width: 118px; }
```

- [ ] **Step 2: 修改 `web/md2web-config.js`**

2a) `repoRow` 明细区整段替换（从 `'<tr data-pair-detail="'` 到 `'</div></td></tr>'` 的拼接）：

```javascript
      '<tr data-pair-detail="' + pair + '"' + (sourceMode === 'local' ? ' hidden' : '') + '>',
      '<td colspan="7"><div class="repo-detail">',
      '<input type="hidden" data-repo="id" value="' + escapeHtml(item.id || '') + '">',
      '<label class="repo-field repo-field-url" data-source-field="svn"' + (svnEnabled ? '' : ' hidden')
        + '><span>SVN 地址</span><input type="text" data-repo="url" value="' + escapeHtml(item.url)
        + '" placeholder="https://svn.example.com/svn/xxx/trunk/docs/"' + disabled + '></label>',
      '<label class="repo-field repo-field-link-target" data-source-field="symlink"'
        + (sourceMode === 'symlink' ? '' : ' hidden')
        + '><span>软链接目标目录</span><input type="text" data-repo="linkTarget" value="' + escapeHtml(item.linkTarget || '')
        + '" placeholder="D:/共享文档/项目资料"' + disabled + '></label>',
      '<label class="repo-field repo-field-interval" data-source-field="svn"' + (svnEnabled ? '' : ' hidden')
        + '><span>更新频率（秒）</span><input type="number" min="0" step="30" data-repo="syncIntervalSeconds" value="'
        + escapeHtml(interval) + '" placeholder="默认"' + disabled + '></label>',
      '<div class="repo-credential" data-source-field="svn"' + (svnEnabled ? '' : ' hidden') + '>',
      '<label class="repo-field"><span>同步账号</span><input type="text" data-repo="credUsername" placeholder="SVN 用户名" autocomplete="off" value="'
        + escapeHtml(credential.username) + '"' + disabled + '></label>',
      '<label class="repo-field"><span>密码</span><input type="password" data-repo="credPassword" placeholder="保存时填写，不回显" autocomplete="new-password"'
        + disabled + '></label>',
      '<div class="repo-credential-actions">',
      '<button type="button" data-action="repo-credential"' + disabled + '>保存凭据</button>',
      '<span class="hint repo-credential-status' + (credential.cls ? ' ' + credential.cls : '') + '">'
        + escapeHtml(credential.status) + '</span>',
      '</div>',
      '</div>',
      '<div class="repo-link-box" data-source-field="symlink"' + (sourceMode === 'symlink' ? '' : ' hidden') + '>',
      '<button type="button" data-action="link-check"' + disabled + '>检查连接</button>',
      '<button type="button" data-action="link-create"' + disabled + '>创建链接</button>',
      '<button type="button" data-action="link-remove"' + disabled + '>移除链接</button>',
      '<span class="hint" data-link-status>' + linkStatusText(item, folder) + '</span>',
      '</div>',
      '<div class="repo-flags">',
      '<label class="flag" title="' + (sourceMode === 'svn'
        ? '勾选后允许登录用户把草稿合入 SVN 库；取消勾选则网页只读，内容由服务器定时同步更新'
        : sourceMode === 'symlink' ? '软链接默认只读，网页不会修改目标目录'
        : '勾选后允许登录用户在线编辑并发布到本地库；取消勾选则网页只读，内容由服务器自动更新') + '">'
        + '<input type="checkbox" data-repo="allowCommit"'
        + (allow && sourceMode !== 'symlink' ? ' checked' : '')
        + (sourceMode === 'symlink' ? ' disabled' : disabled) + '>'
        + (sourceMode === 'svn' ? '允许合入 SVN 库' : sourceMode === 'symlink' ? '软链接只读' : '允许在线修改') + '</label>',
      '<span class="hint perm-hint" data-perm-hint>'
        + (sourceMode !== 'symlink' && !allow ? '未勾选：网页为只读，内容由服务器自动更新' : '') + '</span>',
      '</div>',
      '</div>',
      '<div class="actions">'
        + '<button type="button" data-source-field="svn"' + (svnEnabled ? '' : ' hidden') + ' data-action="health"' + disabled + '>检查</button>'
        + '<button type="button" data-source-field="svn"' + (svnEnabled ? '' : ' hidden') + ' data-action="repair"' + disabled + '>修复</button>'
        + '<button type="button" data-source-field="svn"' + (svnEnabled ? '' : ' hidden') + ' data-action="recreate"' + disabled + '>删除重建</button>'
        + '<button type="button" data-source-field="svn"' + (svnEnabled ? '' : ' hidden') + ' data-action="provision"' + disabled + '>创建并拉取</button>'
        + '<button type="button" class="danger" data-action="remove-repo"' + disabled + '>移除映射</button>'
        + '</div></td></tr>'
```

在 `repoRow` 前新增辅助函数：

```javascript
  function linkStatusText(item, folder) {
    var sourceMode = item.sourceMode || (item.id ? 'svn' : 'local');
    if (sourceMode !== 'symlink') {
      return '';
    }
    if (!item.linkTarget) {
      return '尚未填写目标目录：填写后保存，再点「创建链接」。';
    }
    var exists = item.linkExists !== undefined ? item.linkExists
      : (folder && folder.linkExists !== undefined ? folder.linkExists : null);
    if (exists === false) {
      return '链接失效：目标目录不存在或不可访问（' + item.linkTarget + '）。';
    }
    if (exists === true) {
      return '已连接：' + item.linkTarget + '（只读）';
    }
    return '目标：' + item.linkTarget;
  }
```

2b) `repoRow` 里的 `item.linkTarget` 合并 `folder` 探测结果：在 `var linkKey = ...` 后加：

```javascript
    if (folder) {
      if (item.linkTarget === undefined || item.linkTarget === '') { item.linkTarget = folder.linkTarget || ''; }
      if (item.linkExists === undefined) { item.linkExists = folder.linkExists; }
      if (item.sourceMode === undefined && folder.sourceMode) { item.sourceMode = folder.sourceMode; }
      sourceMode = item.sourceMode || (item.id ? 'svn' : 'local');
      svnEnabled = sourceMode === 'svn';
    }
```

2c) `validateRepos` 增加：

```javascript
      if (repo.sourceMode === 'symlink' && !repo.linkTarget) {
        return '仓库 ' + repo.id + ' 选择了软链接但缺少目标目录：请填写目标目录。';
      }
```

2d) `switchedToLocal` 改名语义为“离开 SVN 的确认”，保持函数名不变但匹配条件扩展：

```javascript
      return old && old.sourceMode !== repo.sourceMode && repo.sourceMode !== 'svn';
```

`save()` 的确认文案改为：

```javascript
    var switched = switchedToLocal(repos);
    if (switched.length && !window.confirm('以下仓库将不再从 SVN 同步（地址会被清空）：'
        + switched.map(function (repo) { return repo.id; }).join('、') + '。确定继续？')) {
      return;
    }
```

2e) `readRepos` 的 `allow` 处理：symlink 强制只读：

```javascript
      var allow = sourceMode !== 'symlink'
        && !!(entry && entry.detail.querySelector('[data-repo="allowCommit"]').checked);
```

2f) `sourceMode` change 处理替换为按类型显隐 + 权限标签：

```javascript
    if (name === 'sourceMode') {
      entry.detail.hidden = target.value === 'local';
      var detail = entry.detail;
      all('[data-source-field]', detail).forEach(function (field) {
        field.hidden = field.getAttribute('data-source-field') !== target.value;
      });
      var allowInput = detail.querySelector('[data-repo="allowCommit"]');
      if (allowInput) {
        allowInput.disabled = target.value === 'symlink' || !state.editable;
        if (target.value === 'symlink') { allowInput.checked = false; }
      }
      syncPermLabel(detail, target.value);
      if (target.value === 'svn') {
        var urlInput = detail.querySelector('[data-repo="url"]');
        if (urlInput && !urlInput.value.trim()) { urlInput.focus(); }
      } else if (target.value === 'symlink') {
        if (!pairField(entry, 'linkTarget')) { detail.querySelector('[data-repo="linkTarget"]').focus(); }
        setStatus('软链接只读：填写目标目录并保存后，可点「创建链接」建立引用。');
      } else if (pairField(entry, 'id')) {
        setStatus('本地模式不连接 SVN，SVN 地址会被清空。');
      }
      updateSummary(entry);
      return;
    }
```

2g) `syncPermLabel` 支持三类型：

```javascript
  function syncPermLabel(detail, sourceMode) {
    if (!detail) {
      return;
    }
    var label = detail.querySelector('.repo-flags .flag');
    var text = sourceMode === 'svn' ? '允许合入 SVN 库'
      : sourceMode === 'symlink' ? '软链接只读' : '允许在线修改';
    if (label && label.lastChild && label.lastChild.nodeType === 3) {
      label.lastChild.nodeValue = text;
    }
    if (label) {
      label.setAttribute('title', sourceMode === 'svn'
        ? '勾选后允许登录用户把草稿合入 SVN 库；取消勾选则网页只读，内容由服务器定时同步更新'
        : sourceMode === 'symlink' ? '软链接默认只读，网页不会修改目标目录'
        : '勾选后允许登录用户在线编辑并发布到本地库；取消勾选则网页只读，内容由服务器自动更新');
    }
  }
```

并把 change 监听里 `syncPermLabel(detail, svnToggle.value === 'svn')` 改为 `syncPermLabel(detail, svnToggle.value)`。

2h) 点击处理新增（在 `action === 'health' ...` 之前插入）：

```javascript
    } else if (action === 'link-check' || action === 'link-create' || action === 'link-remove') {
      var linkEntry = pairOf(target);
      var linkMount = pairField(linkEntry, 'mount')
        || (linkEntry && linkEntry.summary ? linkEntry.summary.getAttribute('data-mount') : '');
      var linkTarget = pairField(linkEntry, 'linkTarget');
      var linkAction = action === 'link-check' ? 'check' : (action === 'link-create' ? 'create' : 'remove');
      if (linkAction !== 'check' && !linkMount) {
        setStatus('请先填写文件夹并通过保存生成仓库 ID。', true);
        return;
      }
      if (linkAction === 'create' && !linkTarget) {
        setStatus('请先填写软链接目标目录。', true);
        return;
      }
      setStatus('正在' + (linkAction === 'check' ? '检查连接' : (linkAction === 'create' ? '创建链接' : '移除链接')) + '…');
      api('__admin/folder-link', { method: 'POST', body: JSON.stringify({
        mount: linkMount, action: linkAction, target: linkTarget
      }) }).then(function (payload) {
        var link = payload.link || {};
        var statusBox = linkEntry && linkEntry.detail ? linkEntry.detail.querySelector('[data-link-status]') : null;
        if (statusBox) {
          statusBox.textContent = link.sourceMode === 'symlink'
            ? (link.linkExists ? '已连接：' + link.linkTarget + '（只读）' : '链接失效：' + (link.linkTarget || linkTarget))
            : '未建立链接';
        }
        if (link.sourceMode === 'symlink') {
          var select = linkEntry.summary.querySelector('[data-repo="sourceMode"]');
          if (select && select.value !== 'symlink') {
            select.value = 'symlink';
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (linkEntry.detail) {
            var targetInput = linkEntry.detail.querySelector('[data-repo="linkTarget"]');
            if (targetInput && link.linkTarget) { targetInput.value = link.linkTarget; }
          }
        }
        setStatus(linkAction === 'create' ? '链接已创建（只读来源）。保存配置后总览页会显示「↗ 软链接」标记。'
          : linkAction === 'remove' ? '链接已移除；目标目录未被删除。' : '连接检查完成。');
        if (linkAction !== 'check') { refreshFolders(); }
      }).catch(function (error) {
        setStatus('链接操作失败：' + error.message, true);
      });
```

2i) `updateSummary` 的 modeCell 文案已支持 symlink，无需改动；`remove-repo` 分支里把来源选择重置为 `local` 后需同步隐藏明细，现有代码设置 `entry.detail.hidden = true` 已满足。

- [ ] **Step 3: 语法检查**

Run: `node --check web/md2web-config.js`
Expected: 无输出（通过）。

- [ ] **Step 4: 提交**

```bash
git add web/md2web_config.html web/md2web-config.js
git commit -m "feat: 配置页支持三类来源与链接管理"
```

---

### Task 7: 前端测试与全量回归

**Files:**
- Modify: `tests/test_md2web_config.js`
- Test: `tests/test_setup_docsify.py::EndToEndTests`（旧断言更新）

- [ ] **Step 1: 更新 JS 测试夹具**

`tests/test_md2web_config.js` 的 `page()`：

- `fields` 循环加入 `linkTarget`：

```javascript
    for (const key of ['id', 'mount', 'url', 'syncIntervalSeconds', 'linkTarget']) {
      fields[key] = { value: String(item[key] ?? ''), focus() { this.focused = true; } };
    }
    fields.sourceMode = { value: item.sourceMode || (item.svn === false ? 'local' : 'svn') };
    fields.allowCommit = { checked: item.allow !== false };
```

- `select` 的 summary 字段名单改为：

```javascript
      if (match) return (['mount', 'sourceMode'].includes(match[1]) === summary) ? fields[match[1]] : null;
```

（删除 `fields.svnEnabled = ...` 一行。）

新增测试：

```javascript
test('symlink repository keeps linkTarget and drops SVN fields', () => {
  const p = page([{ id: 'shared', mount: 'md/共享', sourceMode: 'symlink',
    url: 'https://svn.example.com/r', linkTarget: 'D:/share' }]);
  const repo = p.readRepos()[0];
  assert.equal(repo.sourceMode, 'symlink');
  assert.equal(repo.linkTarget, 'D:/share');
  assert.equal(repo.url, '');
  assert.equal(repo.allowCommit, false);
  assert.equal(repo.readOnly, true);
});

test('symlink without a target is rejected before saving', () => {
  const problem = page([]).validateRepos([{ id: 'shared', mount: 'md/共享',
    sourceMode: 'symlink', url: '', linkTarget: '', readOnly: true, allowCommit: false }]);
  assert.match(problem, /目标目录/);
});

test('symlink detail renders link management buttons and a disabled permission box', () => {
  const p = page([]);
  const html = p.repoRow({ id: 'shared', mount: 'md/共享', sourceMode: 'symlink',
    linkTarget: 'D:/share', linkExists: true }, { name: '共享', path: 'md/共享' }, 0);
  assert.match(html, /data-action="link-check"/);
  assert.match(html, /data-action="link-create"/);
  assert.match(html, /data-action="link-remove"/);
  assert.match(html, /data-source-field="symlink"/);
  assert.match(html, /软链接只读/);
});
```

- [ ] **Step 2: 更新旧断言并运行 Node 测试**

`tests/test_setup_docsify.py::EndToEndTests::test_full_build_creates_entry_page_per_folder` 第 1809 行：

```python
        self.assertIn("本地文件夹", overview)
        self.assertNotIn("未配置 SVN", overview)
```

Run:
```bash
node --test tests/test_md2web_config.js
node --test tests/test_search.js
node --test tests/test_packetdiag.js
node --test tests/test_ai_retrieval.js
node --test tests/test_text_find.js
node --test tests/test_folder_view.js
```
Expected: 全部 pass。

- [ ] **Step 3: 前端语法检查**

Run:
```bash
node --check web/custom-search.js
node --check web/workspace.js
node --check web/md2web-config.js
node --check web/md-editor.js
node --check web/settings.js
node --check web/auth.js
```
Expected: 全部通过。

- [ ] **Step 4: Python 全量测试**

Run: `& "...py36\python.exe" -m unittest discover -s tests -v`
Expected: `OK`（允许平台相关的 symlink skip）。

- [ ] **Step 5: 提交**

```bash
git add tests/test_md2web_config.js tests/test_setup_docsify.py
git commit -m "test: 覆盖三类来源配置与软链接只读"
```

---

### Task 8: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 `README.md`**

- 功能列表“分组与权限（仓库配置页）”改为三类来源说明：

```markdown
- 来源类型（仓库配置页）：每个 `docs/md` 一级文件夹可设为 **SVN 库**（地址/更新频率/同步账号/允许合入）、**软链接**（填写目标目录，可检查/创建/移除链接；默认且强制只读，网页不修改目标文件）或 **本地文件夹**（只需分组与在线编辑）。未配置的文件夹按实际目录自动识别：目录链接显示为软链接，其余为本地文件夹；是否属于 SVN 库完全以配置为准，不靠目录内容推断。
```

- “保存语义”句补充：`软链接目录下的文档不可编辑/暂存，页面会提示“软链接目录只读，请在目标目录直接修改”。`
- 常见问题新增一条：

```markdown
- **软链接显示“链接失效”**：目标目录不存在或网络共享未挂载。在配置页点「检查连接」确认，恢复目标后点「移除链接」再「创建链接」；失效期间总览页会显示红色「链接失效」标记。
```

- [ ] **Step 2: 更新 `AGENTS.md`**

- 文件职责表新增/更新：
  - 新增行：`server/folder_sources.py` | 目录来源探测（符号链接/Windows 目录联接/失效链接）、只跟随 `docs/md` 一级链接的安全遍历 `walk_paths`、管理员链接检查/创建/移除 `manage_link` 与 `has_link_ancestor` 写保护判断 |
  - `server/config.py` 行补充：`symlink` 类型、`linkTarget` 相对配置文件目录解析并禁止指向/包含 `docs` 或 `md`、强制只读
  - `server/app.py` 行补充：`POST /__admin/folder-link`、写接口 `symlink_readonly` 守卫
  - `setup_docsify.py` 行补充：扫描用 `folder_sources.walk_paths`、未配置文件夹自动探测来源、总览/README 三类标记
  - `web/md2web-config.js` 行补充：来源类型三选一、软链接目标与检查/创建/移除按钮
- “常见陷阱”新增：
  - 软链接只允许建在 `docs/md` 一级；只跟随一级链接，目标目录内部的嵌套链接不收录（防循环）；配置加载不要求目标在线，失效由探测字段/健康检查报告。
  - 软链接硬只读：配置强制 `readOnly=true/allowCommit=false`，且 `has_link_ancestor` 对所有写接口兜底（未配置的物理链接也拒绝）。
  - Windows 无符号链接权限时自动回退 `mklink /J` 目录联接；移除链接只删链接，目标目录不动；非空目录不能替换成链接。
- “完成前检查清单”无需改动。

- [ ] **Step 3: 提交**

```bash
git add README.md AGENTS.md
git commit -m "docs: 说明三类来源与软链接只读语义"
```

---

### Task 9: 构建、幂等验证与推送

**Files:** 全部生成物

- [ ] **Step 1: 3.6.8 全量测试 + Node 测试**

Run:
```bash
& "...py36\python.exe" -m unittest discover -s tests
node --test tests/test_search.js
node --test tests/test_packetdiag.js
node --test tests/test_ai_retrieval.js
node --test tests/test_text_find.js
node --test tests/test_folder_view.js
node --test tests/test_md2web_config.js
```
Expected: 全绿。

- [ ] **Step 2: 3.6.8 构建与幂等检查**

Run: `& "...py36\python.exe" setup_docsify.py`
然后 `git status --short`，Expected: 只有 `docs/` 生成物的预期变化（index.html/README.md/侧栏/入口页/`docs/lib/md2web-config.js` 等）；`docs/md` 无任何改动（`git diff --stat -- docs/md` 为空）。
再跑一次构建，Expected: 第二次 `git status` 不再新增差异（幂等）。

- [ ] **Step 3: 人工抽查**

- `docs/index.html`：4 个现有文件夹显示灰绿色`本地文件夹`，无`未配置 SVN`；
- `docs/html/README.md`：仓库列表带`来源：本地文件夹`；
- 临时在 `docs/md` 外建目录并 `manage_link` 创建链接后重建（可选，验证后移除），总览显示紫色`↗ 软链接`。

- [ ] **Step 4: 提交生成物**

```bash
git add -A
git commit -m "build: 同步三类来源构建产物"
```

- [ ] **Step 5: 推送 GitHub（走本机代理）**

```bash
git log --oneline -12
git status --short
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main
```

---

## 自查记录

- **Spec 覆盖**：第 2 节判定规则 → Task 1/3；第 3 节配置模型 → Task 2；第 4 节配置页 → Task 6；第 5 节管理接口 → Task 4；第 6 节构建链路 → Task 3；第 7 节写保护 → Task 5；第 8 节标记 → Task 3（总览/README）；第 9 节同步/健康/修复 → Task 5；第 10/11 节测试与文档 → Task 7/8；第 12 节兼容 → Task 2/3（旧配置默认 svn）；第 13 节不做项未引入。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`source_mode`/`link_target`/`link_exists`（Python 侧）与 `sourceMode`/`linkTarget`/`linkExists`（JS/JSON 侧）贯穿一致；错误码 `symlink_readonly`、`link_exists`、`link_not_empty`、`link_target_invalid`、`not_a_link` 前后一致；`FolderLinkError` 仅在 Task 1 定义、Task 4 使用。
- **已知需同步修改的旧断言**：`tests/test_folder_sources.py::test_reject_unsafe_and_overwrite`（Task 1）、`tests/test_setup_docsify.py` E2E `未配置 SVN`（Task 7）、`tests/test_md2web_config.js` 夹具（Task 7）。
