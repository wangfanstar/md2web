# md2web 单源就地架构 实现计划（v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 md2web 从"多源 + 复制同步"重构为"单源就地"：源文档位于 `docs/md/`，构建只生成导航/首页/搜索索引/离线数据/入口，不复制、不删除源文档。

**Architecture:** `docs/` 是唯一目录（源文档 + 站点 + 离线依赖）。`setup_docsify.py` 简化为：校验 `docs/md` → 依赖复用 → Prism 组件 → 扫描 → 生成；CLI 只保留 `--title` 与 `--index-only`。`serve.py` 不变。

**Tech Stack:** Python 3.8+ 标准库；Docsify 4.13.1、Prism 1.29.0（已在 `docs/lib`）。

**设计文档:** `specs/2026-09-14-md2web-single-source-design.md`

---

## 执行前须知

- 工作目录：`E:\MCP_PROJECT\md2web`，Shell 为 Windows PowerShell 5.1。
- 测试命令：`python -m unittest discover -s tests -v`。
- **不要改动** `setup_docsify.py` 中三处内嵌字符串：`CUSTOM_SEARCH_JS`、`CUSTOM_SEARCH_CSS`、`OFFLINE_FILE_JS`。
- 任务 2–3 期间脚本处于重构中间态（`main`/生成函数暂时不可用），以测试为准；任务 4 恢复完整功能。
- 每个任务完成后提交一次。

---

### Task 1: 迁移目录与示例文档

**Files:**
- Create: `docs/md/使用说明/快速开始.md`
- Delete: `md/`（仅含 `.gitkeep`）、`md_sources.json`

- [x] **Step 1: 创建示例文档**

创建 `docs/md/使用说明/快速开始.md`：

````markdown
# 快速开始

欢迎使用 md2web。把 Markdown 放进 `docs/md/`，运行构建脚本即可生成完全离线的文档站。

## 目录约定

- `docs/md/` 是唯一需要维护的目录，可自由创建子文件夹
- 图片放在文档旁边或 `images/` 目录，用相对路径引用，例如 `![](images/flow.png)`
- 支持的文件：`.md` 文档与常见图片（`.png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.ico`）

## 构建与预览

```
python setup_docsify.py
python serve.py
```

也可以直接双击 `docs/index.html` 浏览（file:// 模式，内容与搜索索引已内嵌）。

## 代码高亮

```python
print("hello md2web")
```
````

- [x] **Step 2: 删除旧目录与配置**

```powershell
Remove-Item md -Recurse -Force
Remove-Item md_sources.json -Force
```

- [x] **Step 3: 验证**

```powershell
Get-ChildItem docs\md -Recurse -File | Select-Object FullName
Test-Path md; Test-Path md_sources.json
```

Expected: 列出 `docs\md\使用说明\快速开始.md`；两个 `Test-Path` 均为 `False`。

- [x] **Step 4: 提交**

```powershell
git add -A
git commit -m "迁移：源文档改为 docs/md 就地维护"
```

---

### Task 2: 核心精简（CLI、扫描，删除多源/同步/配置）

**Files:**
- Modify: `setup_docsify.py`
- Rewrite: `tests/test_setup_docsify.py`（新基类 + `ScanTests` + `CLITests`，保留 `AssetTests`、`ServeTests`，删除 `ConfigTests`/`SourceTests`/`SyncTests`）

- [x] **Step 1: 重写测试文件**

用下面的完整内容**覆盖** `tests/test_setup_docsify.py`（后续任务会追加类）：

```python
import importlib.util
import io
import json
import shutil
import tempfile
import threading
import unittest
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TempDirTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="md2web-test-"))
        self.module = load_module("setup_docsify", "setup_docsify.py")
        self.docs = self.tmp / "docs"
        self.md = self.docs / "md"
        self.md.mkdir(parents=True)
        self.module.DOCS_DIR = self.docs
        self.module.LIB_DIR = self.docs / "lib"
        self.module.MD_DIR = self.md

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_doc(self, rel, content):
        path = self.md / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def scan(self):
        with redirect_stdout(io.StringIO()):
            return self.module.scan_markdown(self.md)


class CLITests(TempDirTestCase):
    def test_parse_args_defaults(self):
        args = self.module.parse_args([])
        self.assertEqual(args.title, "文档中心")
        self.assertFalse(args.index_only)

    def test_parse_args_custom(self):
        args = self.module.parse_args(["--title", "E2E", "--index-only"])
        self.assertEqual(args.title, "E2E")
        self.assertTrue(args.index_only)


class ScanTests(TempDirTestCase):
    def test_scan_markdown_collects_nested_and_skips_hidden(self):
        self.write_doc("a.md", "# A")
        self.write_doc("sub/b.md", "# B")
        self.write_doc("sub/Images/pic.png", "x")
        self.write_doc(".hidden/c.md", "# C")
        self.write_doc("note.txt", "x")
        self.assertEqual(self.scan(), ["a.md", "sub/b.md"])

    def test_scan_markdown_uppercase_extension(self):
        self.write_doc("A.MD", "# A")
        self.assertEqual(self.scan(), ["A.MD"])

    def test_scan_markdown_missing_dir(self):
        shutil.rmtree(self.md)
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(self.module.BuildError):
                self.module.scan_markdown(self.md)

    def test_scan_markdown_empty_dir(self):
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(self.module.BuildError):
                self.module.scan_markdown(self.md)

    def test_build_doc_tree_and_render(self):
        tree = self.module.build_doc_tree(
            ["指南/入门.md", "指南/进阶.md", "FAQ.md"]
        )
        lines = []
        self.module.render_doc_tree(tree, "/md", "  ", lines, lambda route: route)
        self.assertEqual(
            lines,
            [
                "  - **指南**",
                "    - [入门](/md/指南/入门.md)",
                "    - [进阶](/md/指南/进阶.md)",
                "  - [FAQ](/md/FAQ.md)",
            ],
        )

    def test_render_single_file_dir_folds(self):
        tree = self.module.build_doc_tree(["单独/只有一篇.md"])
        lines = []
        self.module.render_doc_tree(tree, "/md", "", lines, lambda route: route)
        self.assertEqual(lines, ["- [只有一篇](/md/单独/只有一篇.md)"])


class AssetTests(TempDirTestCase):
    def test_ensure_assets_reuses_existing(self):
        (self.docs / "lib").mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        with mock.patch.object(self.module, "_download") as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_assets()
        download.assert_not_called()

    def test_ensure_assets_reports_missing(self):
        with mock.patch.object(self.module, "_download", return_value=False):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(self.module.BuildError) as ctx:
                    self.module.ensure_assets()
        self.assertIn("docsify.min.js", str(ctx.exception))

    def test_download_writes_file(self):
        dest = self.tmp / "out.js"

        class FakeResponse(io.BytesIO):
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(url, timeout=None):
            self.assertEqual(timeout, 30)
            return FakeResponse(b"data")

        with mock.patch.object(self.module.urllib.request, "urlopen", fake_urlopen):
            self.assertTrue(self.module._download("https://example.invalid/x.js", dest))
        self.assertEqual(dest.read_bytes(), b"data")
        self.assertFalse((self.tmp / "out.js.part").exists())

    def test_download_failure_keeps_existing_file(self):
        dest = self.tmp / "out.js"
        dest.write_bytes(b"old")

        def fake_urlopen(url, timeout=None):
            raise self.module.urllib.error.URLError("boom")

        with mock.patch.object(self.module.urllib.request, "urlopen", fake_urlopen):
            with redirect_stdout(io.StringIO()):
                self.assertFalse(
                    self.module._download("https://example.invalid/x.js", dest)
                )
        self.assertEqual(dest.read_bytes(), b"old")
        self.assertFalse((self.tmp / "out.js.part").exists())

    def test_download_rejects_truncated_response(self):
        dest = self.tmp / "out.js"
        dest.write_bytes(b"old")

        class TruncatedResponse(io.BytesIO):
            headers = {"Content-Length": "100"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(url, timeout=None):
            return TruncatedResponse(b"0123456789")

        with mock.patch.object(self.module.urllib.request, "urlopen", fake_urlopen):
            with redirect_stdout(io.StringIO()):
                self.assertFalse(
                    self.module._download("https://example.invalid/x.js", dest)
                )
        self.assertEqual(dest.read_bytes(), b"old")
        self.assertFalse((self.tmp / "out.js.part").exists())

    def test_ensure_assets_redownloads_empty_file(self):
        (self.docs / "lib").mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        (self.docs / "lib" / "docsify.min.js").write_text("", encoding="utf-8")
        with mock.patch.object(self.module, "_download", return_value=True) as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_assets()
        self.assertEqual(download.call_count, 1)
        self.assertEqual(download.call_args.args[1].name, "docsify.min.js")


class ServeTests(unittest.TestCase):
    def test_server_serves_index(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            (tmp / "index.html").write_text("ok", encoding="utf-8")
            server, port = serve.make_server(tmp, "127.0.0.1", 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with mock.patch.object(
                    serve.http.server.SimpleHTTPRequestHandler,
                    "log_message",
                    lambda *args, **kwargs: None,
                ):
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/index.html"
                    ) as response:
                        self.assertEqual(response.read().decode("utf-8"), "ok")
            finally:
                server.shutdown()
                server.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_parse_args_rejects_out_of_range_port(self):
        serve = load_module("serve", "serve.py")
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                serve.parse_args(["--port", "65536"])
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                serve.parse_args(["--port", "-1"])

    def test_make_server_falls_back_to_next_port(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            (tmp / "index.html").write_text("ok", encoding="utf-8")
            blocker, port = serve.make_server(tmp, "127.0.0.1", 0)
            try:
                server, actual = serve.make_server(tmp, "127.0.0.1", port)
                try:
                    self.assertGreater(actual, port)
                finally:
                    server.server_close()
            finally:
                blocker.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_main_requires_index_html(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    serve.main(["--dir", str(tmp), "--no-browser"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
```

- [x] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `ScanTests`/`CLITests` 失败（`module has no attribute 'scan_markdown'`、`parse_args` 不认识 `--title`），`AssetTests`/`ServeTests` 通过。

- [x] **Step 3: 实现核心精简**

3a. 替换文件头导入与常量：

```python
"""将 Markdown 文件夹转成 Docsify 离线文档站。"""

import argparse
import html
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
DOCS_DIR = ROOT / "docs"
LIB_DIR = DOCS_DIR / "lib"
MD_DIR = DOCS_DIR / "md"


class BuildError(Exception):
    """构建期间的致命错误，由 main 统一打印并退出。"""
```

3b. 用下面实现整体替换 `parse_args`：

```python
def parse_args(argv=None):
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        description="将 docs/md 下的 Markdown 转成离线可用的 Docsify 文档站。"
    )
    parser.add_argument("--title", default="文档中心", help="站点标题，默认「文档中心」")
    parser.add_argument(
        "--index-only",
        "--refresh-index-only",
        action="store_true",
        dest="index_only",
        help="仅重建搜索索引与离线数据，跳过依赖检查与站点文件生成",
    )
    return parser.parse_args(argv)
```

3c. **删除**以下函数/常量（按名字定位，全部移除）：
`_resolve_config_path`、`configure_paths`、`load_config_file`、`load_source_specs`、`_is_relative_to`、`sanitize_dir_name`、`scan_source`、`resolve_sources`、`assign_group_dirs`、`sync_sources`、`collect_search_paths`、`compute_search_namespace`；常量 `IMAGE_EXTENSIONS`、`RESERVED_GROUP_DIRS`、`WINDOWS_RESERVED_NAMES`。

3d. 在 `display_path` 之后新增 `scan_markdown`：

```python
def scan_markdown(md_dir) -> list:
    """递归收集 docs/md 下的 .md 相对路径（posix），跳过隐藏路径。"""
    root = Path(md_dir)
    if not root.is_dir():
        raise BuildError(
            f"源文档目录不存在: {display_path(root)}，请创建该目录并放入 .md 文档"
        )
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() != ".md":
            continue
        rel = path.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        files.append(rel.as_posix())
    if not files:
        raise BuildError(
            f"源文档目录中没有 .md 文件: {display_path(root)}，请放入文档后重试"
        )
    return files
```

- [x] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 18 个用例通过（CLITests 2 + ScanTests 6 + AssetTests 6 + ServeTests 4）。注意：此时 `main` 与生成函数仍是旧签名（中间态），测试不调用它们。

- [x] **Step 5: 提交**

```powershell
git add -A
git commit -m "refactor: 单源扫描与 CLI 精简"
```

---

### Task 3: 生成层简化

**Files:**
- Modify: `setup_docsify.py`
- Modify: `tests/test_setup_docsify.py`（追加 `GenerationTests`、`PrismTests`）

- [x] **Step 1: 追加失败测试**

在 `tests/test_setup_docsify.py` 末尾追加：

```python
class GenerationTests(TempDirTestCase):
    def build_site(self):
        self.write_doc("指南/入门.md", "# 入门\n\n## 安装\n\n内容")
        self.write_doc("指南/进阶.md", "# 进阶")
        self.write_doc("常见问题.md", "# FAQ")
        md_files = self.scan()
        with redirect_stdout(io.StringIO()):
            self.module.generate_sidebar(md_files)
            self.module.generate_readme(md_files, "测试站点")
            self.module.generate_search_index(md_files, "测试站点")
            self.module.generate_offline_data()
        return md_files

    def test_sidebar_tree(self):
        self.build_site()
        sidebar = (self.docs / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn("- **指南**", sidebar)
        self.assertIn("[入门](/md/指南/入门.md)", sidebar)
        self.assertIn("[常见问题](/md/常见问题.md)", sidebar)

    def test_readme_index(self):
        self.build_site()
        readme = (self.docs / "README.md").read_text(encoding="utf-8")
        self.assertIn("# 测试站点", readme)
        self.assertIn("[入门](md/指南/入门.md)", readme)

    def test_search_index_routes(self):
        self.build_site()
        index = json.loads(
            (self.docs / "search-index.json").read_text(encoding="utf-8")
        )
        self.assertIn("/", index)
        self.assertIn("/md/指南/入门.md", index)
        entry = index["/md/指南/入门.md"]["/md/指南/入门.md?id=安装"]
        self.assertEqual(entry["route"], "/md/指南/入门.md")

    def test_offline_data_contains_all_md(self):
        self.build_site()
        text = (self.docs / "lib" / "offline-data.js").read_text(encoding="utf-8")
        payload = json.loads(text.split("=", 1)[1].rstrip().rstrip(";"))
        self.assertIn("md/指南/入门.md", payload["content"])
        self.assertIn("_sidebar.md", payload["content"])
        self.assertIn("searchIndex", payload)

    def test_index_html_title_and_escaping(self):
        title = "文档</script><script>alert(1)</script>"
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html(title)
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("</script><script>alert(1)", html_text)
        self.assertIn("\\u003c/script", html_text)
        self.assertIn("&lt;/script&gt;", html_text)

    def test_search_index_reports_non_utf8_path(self):
        self.write_doc("a.md", "# A")
        (self.md / "bad.md").write_bytes(b"\xff\xfe\x00bad")
        md_files = self.scan()
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(self.module.BuildError) as ctx:
                self.module.generate_search_index(md_files, "T")
        self.assertIn("bad.md", str(ctx.exception))

    def test_offline_data_reports_non_utf8_path(self):
        (self.md / "bad.md").write_bytes(b"\xff\xfe\x00bad")
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(self.module.BuildError) as ctx:
                self.module.generate_offline_data()
        self.assertIn("bad.md", str(ctx.exception))


class PrismTests(TempDirTestCase):
    def test_collect_fence_languages_from_markdown(self):
        self.write_doc("a.md", "```python\nprint(1)\n```\n\n```cuda\nx\n```")
        self.assertEqual(
            self.module.collect_fence_languages(self.md, ["a.md"]), {"python", "cuda"}
        )

    def test_collect_fence_languages_multiple_files(self):
        self.write_doc("a.md", "```python\nprint(1)\n```")
        self.write_doc("sub/b.md", "```go\npackage main\n```")
        md_files = self.scan()
        self.assertEqual(
            self.module.collect_fence_languages(self.md, md_files), {"python", "go"}
        )

    def test_ensure_prism_components_reuses_and_warns(self):
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        (components / "prism-python.min.js").write_text("x", encoding="utf-8")
        self.write_doc("a.md", "```python\nprint(1)\n```\n\n```rust\nx\n```")
        md_files = self.scan()
        with mock.patch.object(self.module, "_download", return_value=False) as download:
            with redirect_stdout(io.StringIO()) as output:
                self.module.ensure_prism_components(self.md, md_files)
        requested = " ".join(str(call.args[0]) for call in download.call_args_list)
        self.assertIn("prism-rust.min.js", requested)
        self.assertNotIn("prism-python.min.js", requested)
        self.assertIn("警告", output.getvalue())

    def test_ensure_prism_components_skips_without_languages(self):
        self.write_doc("a.md", "# 无代码块")
        md_files = self.scan()
        with mock.patch.object(self.module, "_download") as download:
            with redirect_stdout(io.StringIO()) as output:
                self.module.ensure_prism_components(self.md, md_files)
        download.assert_not_called()
        self.assertIn("跳过", output.getvalue())

    def test_ensure_prism_components_resolves_fallback_closure(self):
        self.write_doc("a.md", "```cuda\nx\n```")
        md_files = self.scan()
        with mock.patch.object(self.module, "_download", return_value=True) as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_prism_components(self.md, md_files)
        requested = " ".join(str(call.args[0]) for call in download.call_args_list)
        self.assertIn("prism-cpp.min.js", requested)
        self.assertIn("prism-c.min.js", requested)
        self.assertNotIn("prism-cuda", requested)
```

- [x] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `GenerationTests`/`PrismTests` 失败（旧签名不接受 `md_files`/`title`）。

- [x] **Step 3: 实现**

3a. 用下面实现整体替换 `collect_fence_languages`：

```python
def collect_fence_languages(md_dir, md_files) -> set:
    """扫描 docs/md 下的 Markdown，收集代码围栏中出现的语言名。"""
    langs = set()
    fence_re = re.compile(r"^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]+)", re.M)
    for rel in md_files:
        text = (Path(md_dir) / rel).read_text(encoding="utf-8", errors="ignore")
        for match in fence_re.finditer(text):
            langs.add(match.group(1).lower())
    return langs
```

3b. 用下面实现整体替换 `ensure_prism_components`（其余逻辑不变，仅签名与调用）：

```python
def ensure_prism_components(md_dir, md_files) -> None:
    """按文档实际用到的语言准备 Prism 组件，缺失才下载，失败仅警告。"""
    fence_langs = collect_fence_languages(md_dir, md_files)
    if not fence_langs:
        print("  [跳过] 未发现代码块语言，无需语言组件")
        return

    deps, aliases = extract_autoloader_maps()
    components = resolve_prism_languages(fence_langs, deps, aliases)
    components_dir = LIB_DIR / "components"
    components_dir.mkdir(parents=True, exist_ok=True)

    for name in sorted(components):
        dest = components_dir / f"prism-{name}.min.js"
        if dest.exists() and dest.stat().st_size > 0:
            print(f"  [复用] prism-{name}.min.js")
            continue
        url = f"{PRISM_COMPONENTS_CDN}prism-{name}.min.js"
        print(f"  [下载] prism-{name}.min.js <- {url}")
        if not _download(url, dest):
            print(f"  [警告] prism-{name}.min.js 下载失败，该语言暂不高亮（联网后重跑可重试）")
    print("  Prism 语言组件处理完成。\n")
```

3c. 用下面实现整体替换 `generate_sidebar` 与 `generate_readme`：

```python
def generate_sidebar(md_files):
    """生成 _sidebar.md 侧边栏文件"""
    lines = ["- **文档列表**"]
    tree = build_doc_tree(md_files)
    render_doc_tree(tree, "/md", "  ", lines, lambda route: route)

    sidebar_path = DOCS_DIR / "_sidebar.md"
    sidebar_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  [生成] _sidebar.md ({len(lines) - 1} 项)")


def generate_readme(md_files, title="文档中心"):
    """生成 README.md 作为首页索引"""
    lines = [f"# {title}", "", "## 文档列表", ""]
    tree = build_doc_tree(md_files)
    render_doc_tree(tree, "md", "", lines, lambda route: route)

    readme_path = DOCS_DIR / "README.md"
    readme_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("  [生成] README.md (首页索引)")
```

3d. 用下面实现整体替换 `generate_search_index`：

```python
def generate_search_index(md_files, title="文档中心", depth=SEARCH_DEPTH):
    """在构建时生成 search-index.json，避免浏览器 localStorage 配额限制。"""
    index = {}
    readme = DOCS_DIR / "README.md"
    if readme.exists():
        index["/"] = build_page_index("/", read_markdown(readme), depth, title)

    for rel in md_files:
        route = f"/md/{rel}"
        index[route] = build_page_index(
            route, read_markdown(MD_DIR / rel), depth, Path(rel).stem
        )

    index_path = DOCS_DIR / "search-index.json"
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_mb = index_path.stat().st_size / (1024 * 1024)
    print(f"  [生成] search-index.json ({len(index)} 页, {size_mb:.1f} MB)")
```

3e. 用下面实现整体替换 `generate_index_html`（去掉 `search_paths`/`namespace` 参数，模板不变）：

```python
def generate_index_html(title="文档中心"):
    """生成 index.html"""
    prism_lang_map_js = json.dumps(PRISM_LANG_FALLBACK, ensure_ascii=False)
    title_html = html.escape(title)
    title_js = json.dumps(title, ensure_ascii=False).replace("<", "\\u003c")
    html_text = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title_html}</title>
  <link rel="stylesheet" href="lib/prism.min.css">
  <link rel="stylesheet" href="lib/docsify.min.css">
  <link rel="stylesheet" href="lib/custom-search.css">
</head>
<body>
  <script src="lib/offline-data.js"></script>
  <script src="lib/offline-file.js"></script>
  <div id="app">加载中...</div>
  <script>
    window.$docsify = {{
      name: {title_js},
      repo: '',
      loadSidebar: true,
      coverpage: false,
      subMaxLevel: 0,
      auto2top: true,
      noEmoji: true,
      plugins: [function (hook) {{
        // Prism 无对应组件的语言（cuda/p4/asm 等）改用近似语法高亮，源 md 不受影响
        var langMap = {prism_lang_map_js};
        hook.beforeEach(function (content) {{
          var inFence = false, fenceChar = '';
          return content.split('\\n').map(function (line) {{
            var m = line.match(/^\\s*(`{{3,}}|~{{3,}})(.*)$/);
            if (m) {{
              var marker = m[1].charAt(0);
              if (!inFence) {{
                inFence = true; fenceChar = marker;
                var lm = m[2].match(/^\\s*([A-Za-z0-9_+#.-]+)/);
                if (lm) {{
                  var target = langMap[lm[1].toLowerCase()];
                  if (target) {{
                    return line.replace(lm[1], target);
                  }}
                }}
              }} else if (marker === fenceChar) {{
                inFence = false; fenceChar = '';
              }}
            }}
            return line;
          }}).join('\\n');
        }});
      }}],
      customSearch: {{
        indexPath: 'search-index.json',
        maxSidebarResults: 8,
        maxDialogResults: 50,
        minQueryLength: 2,
      }},
      customToc: {{
        enabled: true,
        minLevel: 2,
        maxLevel: 4,
        title: '本文目录',
      }},
    }}
  </script>
  <script src="lib/prism.min.js"></script>
  <script src="lib/prism-autoloader.min.js"></script>
  <script>
    // 语言组件改从本地 lib/components/ 加载，运行时不请求 CDN
    if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {{
      Prism.plugins.autoloader.languages_path = 'lib/components/';
    }}
  </script>
  <script src="lib/docsify.min.js?v=file-router-3"></script>
  <script src="lib/zoom-image.min.js"></script>
  <script src="lib/front-matter.min.js"></script>
  <script src="lib/custom-search.js"></script>
</body>
</html>
"""
    index_path = DOCS_DIR / "index.html"
    index_path.write_text(html_text, encoding="utf-8")
    print("  [生成] index.html")
```

- [x] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 30 个用例通过（原 18 + GenerationTests 7 + PrismTests 5）。

- [x] **Step 5: 提交**

```powershell
git add -A
git commit -m "refactor: 单源导航与搜索生成"
```

---

### Task 4: 主流程整合与端到端

**Files:**
- Modify: `setup_docsify.py`
- Modify: `tests/test_setup_docsify.py`（追加 `EndToEndTests`）

- [x] **Step 1: 追加失败测试**

在末尾追加：

```python
class EndToEndTests(TempDirTestCase):
    def seed_assets(self):
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        (components / "prism-python.min.js").write_text("x", encoding="utf-8")

    def test_full_build_offline(self):
        self.write_doc("a.md", "# A\n\n```python\nprint(1)\n```")
        self.write_doc("sub/b.md", "# B")
        self.seed_assets()
        with mock.patch.object(self.module, "_download") as download:
            with redirect_stdout(io.StringIO()):
                self.module.main([])
        download.assert_not_called()
        self.assertTrue((self.docs / "index.html").exists())
        self.assertTrue((self.docs / "_sidebar.md").exists())
        self.assertTrue((self.docs / "README.md").exists())
        self.assertTrue((self.docs / "search-index.json").exists())
        self.assertTrue((self.md / "a.md").exists())
        self.assertIn(
            "<title>文档中心</title>",
            (self.docs / "index.html").read_text(encoding="utf-8"),
        )

    def test_full_build_custom_title(self):
        self.write_doc("a.md", "# A")
        self.seed_assets()
        with redirect_stdout(io.StringIO()):
            self.module.main(["--title", "E2E"])
        self.assertIn(
            "<title>E2E</title>",
            (self.docs / "index.html").read_text(encoding="utf-8"),
        )
        self.assertIn("# E2E", (self.docs / "README.md").read_text(encoding="utf-8"))

    def test_index_only_skips_site_files(self):
        self.write_doc("a.md", "# A")
        with redirect_stdout(io.StringIO()):
            self.module.main(["--index-only"])
        self.assertTrue((self.docs / "search-index.json").exists())
        self.assertFalse((self.docs / "index.html").exists())

    def test_missing_source_exits(self):
        shutil.rmtree(self.md)
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.module.main([])

    def test_empty_source_exits(self):
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.module.main([])

    def test_dependency_failure_exits(self):
        self.write_doc("a.md", "# A")
        with mock.patch.object(self.module, "_download", return_value=False):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.module.main([])

    def test_build_does_not_touch_user_files(self):
        self.write_doc("a.md", "# A")
        (self.md / "images").mkdir()
        (self.md / "images" / "pic.png").write_bytes(b"img")
        (self.md / "notes.txt").write_text("keep", encoding="utf-8")
        self.seed_assets()
        with redirect_stdout(io.StringIO()):
            self.module.main([])
        self.assertEqual((self.md / "images" / "pic.png").read_bytes(), b"img")
        self.assertEqual((self.md / "notes.txt").read_text(encoding="utf-8"), "keep")
        self.assertTrue((self.md / "a.md").exists())
```

- [x] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `EndToEndTests` 失败（旧 `main` 使用 `args.source_md_dirs` 等已删除字段）。

- [x] **Step 3: 实现**

用下面实现整体替换 `main`：

```python
def main(argv=None):
    args = parse_args(argv)

    print("=== Docsify 离线文档站 构建工具 ===\n")
    print(f"源文档目录: {display_path(MD_DIR)}")
    print(f"输出目录: {display_path(DOCS_DIR)}")
    print(f"站点标题: {args.title}\n")

    try:
        md_files = scan_markdown(MD_DIR)
    except (BuildError, OSError, UnicodeDecodeError) as error:
        print(f"  错误: {error}")
        sys.exit(1)

    print(f"共 {len(md_files)} 个文档\n")

    try:
        if args.index_only:
            print("=== 仅刷新搜索索引（跳过依赖与站点文件生成） ===\n")
            generate_search_index(md_files, args.title)
            generate_offline_data()
            print("\n=== 搜索索引刷新完成 ===")
            return

        print("1. 检查离线依赖...")
        ensure_assets()
        patch_docsify_file_router()
        patch_docsify_css()
        ensure_prism_components(MD_DIR, md_files)
        generate_custom_search_assets()

        print("2. 生成导航、首页与搜索索引...")
        generate_sidebar(md_files)
        generate_readme(md_files, args.title)
        generate_search_index(md_files, args.title)
        generate_offline_data()
        generate_index_html(args.title)

        print("\n=== 构建完成 ===")
        print("\n启动本地预览: python serve.py")
        print("本机打开: http://localhost:3000")
        print("局域网访问: http://<这台机器的IP>:3000")
    except (BuildError, OSError, UnicodeDecodeError) as error:
        print(f"  错误: {error}")
        sys.exit(1)
```

- [x] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 37 个用例通过（原 30 + EndToEndTests 7）。

- [x] **Step 5: 真实构建冒烟（离线）**

```powershell
python setup_docsify.py
```

Expected: 输出 `构建完成`；依赖全部 `[复用]`（`docs/lib` 已存在），无 `[下载]`；生成 `docs/index.html`、`docs/README.md`、`docs/_sidebar.md`、`docs/search-index.json`，并把 `docs/lib/offline-data.js` 从 18MB 旧快照替换为当前小文件。

- [x] **Step 6: 提交**

```powershell
git add -A
git commit -m "refactor: 单源构建主流程"
```

---

### Task 5: README 重写与收尾验证

**Files:**
- Modify: `README.md`（整体重写）
- Modify: `specs/2026-09-14-md2web-single-source-design.md`（状态改为"已实现"）
- Modify: `specs/2026-09-14-md2web-single-source-plan.md`（文末追加执行记录）

- [x] **Step 1: 重写 README.md**

用下面内容整体覆盖（可小幅润色，事实与命令必须一致）：

````markdown
# Markdown 离线文档站生成器（md2web）

把 `docs/md/` 里的 Markdown 一键转换成**完全离线可用**的 Docsify 文档站：产物自包含，拷贝到任意机器双击即可浏览与搜索；需要 Python 3.8+，仅用标准库，无需 pip/Node.js，支持 Windows 与 Linux。

## 特性

- 单目录维护：源文档就在 `docs/md/`，构建**不复制、不移动、不删除**任何文档
- 完全离线：依赖保存在 `docs/lib/`，运行时零外部请求；依赖存在时重建全程不联网
- 预构建搜索：构建时生成全文索引，支持侧边栏搜索、`Ctrl+K` 全局搜索、标题锚点跳转
- 离线代码高亮：按文档实际用到的语言准备 Prism 组件，cuda/p4/asm 自动近似高亮
- 跨平台预览：`python serve.py` 一键启动，Windows/Linux 通用；也可直接双击 `docs/index.html`
- 目录即导航：`docs/md/` 下的子文件夹自动成为分组，无需额外配置

## 目录结构

```
md2web/
├── docs/                     # 唯一目录：源文档 + 站点 + 离线依赖
│   ├── md/                   # 源文档（唯一需要手动维护）
│   │   ├── 使用说明/快速开始.md
│   │   ├── 子文件夹1/*.md
│   │   └── images/…          # 图片任意位置，相对路径引用
│   ├── lib/                  # 离线 JS/CSS 与生成资源
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   └── search-index.json     # 搜索索引（生成）
├── specs/                    # 设计文档
├── tests/                    # 离线回归测试
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台预览
├── start_windows.bat / start_linux.sh
└── README.md                 # 本文件
```

## 快速开始

### 1. 放文档

在 `docs/md/` 下创建子文件夹并放入 `.md` 文件：

```
docs/md/
├── 指南/
│   ├── 入门.md
│   └── images/flow.png
└── 常见问题.md
```

图片放在文档旁边或 `images/` 目录，用相对路径引用；支持 `.png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.ico`。文档仅支持 UTF-8 编码。

### 2. 构建与预览

```bash
python setup_docsify.py     # 首次构建需联网下载依赖，之后离线可用
python serve.py             # 打开 http://localhost:3000
```

| 场景 | 命令 |
|------|------|
| 完整构建 | `python setup_docsify.py` |
| 自定义标题 | `python setup_docsify.py --title "我的文档"` |
| 仅刷新索引与离线数据 | `python setup_docsify.py --index-only` |
| 预览 | `python serve.py`（`--port 8080`、`--bind 127.0.0.1`、`--no-browser`） |

Windows 可双击 `start_windows.bat`，Linux 可执行 `sh start_linux.sh`。也可以直接双击 `docs/index.html`（file:// 模式，内容与索引内嵌）。

> `--index-only` 只重建搜索索引与离线数据，不重新生成侧边栏与首页；新增文件要出现在导航中需执行一次完整构建。

预览服务默认绑定 `0.0.0.0`，同一局域网内可访问；仅本机访问可执行 `python serve.py --bind 127.0.0.1`。

### 3. 分发与备份

拷贝整个 `docs/` 目录即可：接收方双击 `docs/index.html` 或用任意静态服务器打开即可浏览、搜索、代码高亮。`docs/` 同时包含源文档，因此它也是唯一的备份对象。

> `docs/` 下除 `md/` 与 `lib/` 外的文件（`index.html`、`README.md`、`_sidebar.md`、`search-index.json`）由构建生成，请勿手工维护。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试全程离线（临时目录 + 伪依赖），覆盖扫描与导航、搜索索引、离线数据、依赖复用与报错、主流程端到端与预览服务。

## 常见问题

- **搜索无结果或过时**：搜索索引在构建时生成，修改文档后重新运行 `python setup_docsify.py`（或 `--index-only`）
- **依赖缺失且下载失败**：联网重跑，或把完整依赖文件复制到 `docs/lib/`
- **图片不显示**：确认图片在 `docs/md/` 内且相对路径大小写正确，重新构建
- **代码块不高亮**：检查围栏语言标记；`cuda`/`p4`/`asm` 会自动按近似语法高亮，其余 Prism 不支持的语言需自备组件，否则不高亮
- **文档编码要求**：仅支持 UTF-8 文档；非 UTF-8 文档构建会报错并指明具体文件
- **文件名限制**：文件名包含 `#`、`?`、`%` 时链接与搜索路由可能失效，请避免使用这些字符
- **想彻底重建**：删除 `docs/` 中除 `md/` 外的生成文件后重新构建（依赖缺失时需要联网一次）
````

- [x] **Step 2: 更新设计文档状态**

`specs/2026-09-14-md2web-single-source-design.md` 第 4 行「状态：已确认」改为「状态：已实现（2026-09-14）」。

- [x] **Step 3: 运行完整测试**

Run: `python -m unittest discover -s tests -v`
Expected: 41 个用例全部通过。

- [x] **Step 4: 最终检查**

```powershell
git status --short
Test-Path md; Test-Path md_sources.json; Test-Path webtool
python setup_docsify.py
```

Expected: 工作区仅 README/设计文档变更；三个 `Test-Path` 为 `False`；构建成功且无 `[下载]`。

- [x] **Step 5: 提交**

```powershell
git add -A
git commit -m "docs: 重写 README 适配单源就地架构"
```

---

## 完成标准

1. `python -m unittest discover -s tests -v` 全部通过（无网络访问）
2. `python setup_docsify.py` 离线构建成功，`docs/index.html` 可浏览、搜索、代码高亮
3. 构建前后 `docs/md` 内容逐字节不变（`test_build_does_not_touch_user_files` 覆盖）
4. 仓库不再包含 `md/`、`md_sources.json`、`webtool/`
5. README 与实际行为一致

---

## 实现后加固记录（2026-09-14）

Task 4 实现后的代码审查加固，提交 `fix: 预校验编码并收紧离线数据范围`：

1. **离线数据显式白名单**：`generate_offline_data(md_files)` 不再 `rglob("*.md")` 扫描 `docs/`，只内嵌 `README.md`、`_sidebar.md` 与 `scan_markdown` 返回的 `md/<rel>`。隐藏目录（如 `docs/md/.hidden/`）和 `docs/` 下用户自建的 `.md` 不再进入发布产物，非 UTF-8 的隐藏文档也不会在部分写入后才报错。
2. **扫描后编码预校验**：`main` 在 `scan_markdown` 之后立即逐个 `read_markdown` 校验，编码/读取错误在 `ensure_assets`、`generate_sidebar`、`generate_readme` 等任何写入之前以退出码 1 结束，避免留下半成品（`_sidebar.md`/`README.md`/`search-index.json` 均不产生）。
3. **新增/加强的测试**（37 → 39 个用例）：
   - 新增 `GenerationTests.test_offline_data_ignores_files_outside_scan`：断言隐藏目录与 `docs/` 根下的 `.md` 不进入 `content`。
   - 新增 `EndToEndTests.test_invalid_encoding_fails_before_writes`：非 UTF-8 文档使 `main` 退出码为 1，且不生成站点文件。
   - 加强 `test_index_only_skips_site_files`：预置 `_sidebar.md` 哨兵，验证 `--index-only` 不改写站点文件且索引包含源文档。
   - 加强 `test_full_build_offline`/`test_full_build_custom_title`：断言首页索引 `pageTitle` 与标题参数一致。
   - 加强 `test_build_does_not_touch_user_files`：源 `a.md` 构建前后逐字节一致。
   - 三个失败路径用例（缺目录/空目录/依赖失败）统一断言退出码为 1。

- 2026-09-14 Task 5：README 重写；测试补强（隐藏文件、三级嵌套、端口断言）；端口回退用例改为确定性 mock 并新增非 EADDRINUSE 分支用例（41→42 个用例）
- 2026-09-14 最终审查修复：仅收集小写 .md（.MD 警告跳过）；移除搜索索引空壳条目；旧设计文档标注取代；README 补文件名限制字符
