import errno
import importlib.util
import io
import json
import os
import shutil
import tempfile
import threading
import time
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

    def test_parse_args_refresh_index_alias(self):
        args = self.module.parse_args(["--refresh-index-only"])
        self.assertTrue(args.index_only)


class ScanTests(TempDirTestCase):
    def test_scan_markdown_collects_nested_and_skips_hidden(self):
        self.write_doc("a.md", "# A")
        self.write_doc("sub/b.md", "# B")
        self.write_doc("sub/Images/pic.png", "x")
        self.write_doc(".hidden/c.md", "# C")
        self.write_doc("note.txt", "x")
        self.assertEqual(self.scan(), ["a.md", "sub/b.md"])

    def test_scan_markdown_skips_hidden_file(self):
        self.write_doc("a.md", "# A")
        self.write_doc(".draft.md", "# D")
        self.assertEqual(self.scan(), ["a.md"])

    def test_scan_markdown_skips_uppercase_extension(self):
        self.write_doc("UP.MD", "# A")
        self.write_doc("a.md", "# A")
        with redirect_stdout(io.StringIO()) as output:
            files = self.module.scan_markdown(self.md)
        self.assertEqual(files, ["a.md"])
        self.assertIn("警告", output.getvalue())

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

    def test_build_doc_tree_three_levels(self):
        tree = self.module.build_doc_tree(["a/b/c/深.md"])
        lines = []
        self.module.render_doc_tree(tree, "/md", "", lines, lambda route: route)
        self.assertEqual(
            lines,
            [
                "- **a**",
                "  - **b**",
                "    - [深](/md/a/b/c/深.md)",
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
                    opener = urllib.request.build_opener(
                        urllib.request.ProxyHandler({})
                    )
                    with opener.open(
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
        attempts = []

        class FakeServer:
            def __init__(self, address, handler):
                attempts.append(address[1])
                if len(attempts) == 1:
                    raise OSError(errno.EADDRINUSE, "in use")
                self.server_address = address

            def server_close(self):
                pass

        with mock.patch.object(serve, "PreviewServer", FakeServer):
            server, port = serve.make_server(Path("."), "127.0.0.1", 3000)
        self.assertEqual(port, 3001)
        self.assertEqual(attempts, [3000, 3001])

    def test_make_server_reports_bind_error(self):
        serve = load_module("serve", "serve.py")

        class FakeServer:
            def __init__(self, address, handler):
                raise PermissionError(13, "denied")

        with mock.patch.object(serve, "PreviewServer", FakeServer):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    serve.make_server(Path("."), "0.0.0.0", 3000)
        self.assertIn("无法监听", str(ctx.exception))

    def test_main_requires_index_html(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    serve.main(["--dir", str(tmp), "--no-browser"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_parse_args_no_build_flag(self):
        serve = load_module("serve", "serve.py")
        self.assertFalse(serve.parse_args([]).no_build)
        self.assertTrue(serve.parse_args(["--no-build"]).no_build)

    def test_needs_rebuild_detects_newer_markdown(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (tmp / "setup_docsify.py").write_text("", encoding="utf-8")
            index_path = docs / "search-index.json"
            index_path.write_text('{"/": {}, "/md/a.md": {}}', encoding="utf-8")
            doc_path = docs / "md" / "a.md"
            doc_path.write_text("# A", encoding="utf-8")
            old = time.time() - 100
            os.utime(index_path, (old, old))
            with mock.patch.object(serve, "ROOT", tmp):
                self.assertTrue(serve.needs_rebuild(docs))
                os.utime(doc_path, (old, old))
                self.assertFalse(serve.needs_rebuild(docs))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_needs_rebuild_detects_deleted_document(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (tmp / "setup_docsify.py").write_text("", encoding="utf-8")
            doc_path = docs / "md" / "a.md"
            doc_path.write_text("# A", encoding="utf-8")
            (docs / "search-index.json").write_text(
                '{"/": {}, "/md/a.md": {}}', encoding="utf-8"
            )
            with mock.patch.object(serve, "ROOT", tmp):
                self.assertFalse(serve.needs_rebuild(docs))
                doc_path.unlink()
                self.assertTrue(serve.needs_rebuild(docs))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_needs_rebuild_without_index(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (tmp / "setup_docsify.py").write_text("", encoding="utf-8")
            (docs / "md" / "a.md").write_text("# A", encoding="utf-8")
            with mock.patch.object(serve, "ROOT", tmp):
                self.assertTrue(serve.needs_rebuild(docs))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_needs_rebuild_skips_custom_directory(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (tmp / "setup_docsify.py").write_text("", encoding="utf-8")
            with mock.patch.object(serve, "ROOT", tmp):
                self.assertFalse(serve.needs_rebuild(tmp / "elsewhere"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_rebuild_if_needed_only_rebuilds_when_needed(self):
        serve = load_module("serve", "serve.py")
        with mock.patch.object(serve, "needs_rebuild", return_value=False):
            with mock.patch.object(serve, "rebuild") as rebuild:
                self.assertFalse(serve.rebuild_if_needed(Path(".")))
        rebuild.assert_not_called()
        with mock.patch.object(serve, "needs_rebuild", return_value=True):
            with mock.patch.object(serve, "rebuild") as rebuild:
                self.assertTrue(serve.rebuild_if_needed(Path(".")))
        rebuild.assert_called_once()

    def test_start_watcher_polls_until_stopped(self):
        serve = load_module("serve", "serve.py")
        called = threading.Event()

        def fake_rebuild_if_needed(directory):
            called.set()
            return False

        with mock.patch.object(
            serve, "rebuild_if_needed", side_effect=fake_rebuild_if_needed
        ):
            stop_event = serve.start_watcher(Path("."), interval=0.01)
            try:
                self.assertTrue(called.wait(2.0))
            finally:
                stop_event.set()

    def test_stop_other_servers_kills_listed_pids(self):
        serve = load_module("serve", "serve.py")
        with mock.patch.object(serve, "find_other_servers", return_value=[111, 222]):
            with mock.patch.object(serve.os, "kill") as kill:
                with redirect_stdout(io.StringIO()):
                    stopped = serve.stop_other_servers()
        self.assertEqual(stopped, [111, 222])
        self.assertEqual(kill.call_count, 2)

    def test_stop_other_servers_ignores_missing_process(self):
        serve = load_module("serve", "serve.py")
        with mock.patch.object(serve, "find_other_servers", return_value=[333]):
            with mock.patch.object(serve.os, "kill", side_effect=OSError("gone")):
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(serve.stop_other_servers(), [])


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
            self.module.generate_offline_data(md_files)
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

    def test_search_index_has_no_empty_shell_entry(self):
        self.build_site()
        index = json.loads(
            (self.docs / "search-index.json").read_text(encoding="utf-8")
        )
        page = index["/md/指南/入门.md"]
        self.assertNotIn("/md/指南/入门.md", page)
        self.assertIn("/md/指南/入门.md?id=入门", page)

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
                self.module.generate_offline_data(["bad.md"])
        self.assertIn("bad.md", str(ctx.exception))

    def test_offline_data_ignores_files_outside_scan(self):
        self.write_doc("a.md", "# A")
        (self.md / ".hidden").mkdir()
        (self.md / ".hidden" / "h.md").write_text("# H", encoding="utf-8")
        (self.docs / "extra.md").write_text("# X", encoding="utf-8")
        md_files = self.scan()
        with redirect_stdout(io.StringIO()):
            self.module.generate_offline_data(md_files)
        text = (self.docs / "lib" / "offline-data.js").read_text(encoding="utf-8")
        payload = json.loads(text.split("=", 1)[1].rstrip().rstrip(";"))
        self.assertIn("md/a.md", payload["content"])
        self.assertNotIn("extra.md", payload["content"])
        self.assertNotIn(".hidden", payload["content"])


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
        index = json.loads(
            (self.docs / "search-index.json").read_text(encoding="utf-8")
        )
        self.assertTrue(
            any(entry["pageTitle"] == "文档中心" for entry in index["/"].values())
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
        index = json.loads(
            (self.docs / "search-index.json").read_text(encoding="utf-8")
        )
        self.assertTrue(
            any(entry["pageTitle"] == "E2E" for entry in index["/"].values())
        )

    def test_index_only_skips_site_files(self):
        self.write_doc("a.md", "# A")
        (self.docs / "_sidebar.md").write_text("SENTINEL", encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            self.module.main(["--index-only"])
        self.assertEqual(
            (self.docs / "_sidebar.md").read_text(encoding="utf-8"), "SENTINEL"
        )
        index = json.loads(
            (self.docs / "search-index.json").read_text(encoding="utf-8")
        )
        self.assertIn("/md/a.md", index)
        self.assertFalse((self.docs / "index.html").exists())

    def test_missing_source_exits(self):
        shutil.rmtree(self.md)
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                self.module.main([])
        self.assertEqual(ctx.exception.code, 1)

    def test_empty_source_exits(self):
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                self.module.main([])
        self.assertEqual(ctx.exception.code, 1)

    def test_dependency_failure_exits(self):
        self.write_doc("a.md", "# A")
        with mock.patch.object(self.module, "_download", return_value=False):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    self.module.main([])
        self.assertEqual(ctx.exception.code, 1)

    def test_invalid_encoding_fails_before_writes(self):
        self.write_doc("a.md", "# A")
        (self.md / "bad.md").write_bytes(b"\xff\xfe\x00bad")
        self.seed_assets()
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                self.module.main([])
        self.assertEqual(ctx.exception.code, 1)
        self.assertFalse((self.docs / "_sidebar.md").exists())
        self.assertFalse((self.docs / "README.md").exists())
        self.assertFalse((self.docs / "search-index.json").exists())

    def test_build_does_not_touch_user_files(self):
        self.write_doc("a.md", "# A")
        (self.md / "images").mkdir()
        (self.md / "images" / "pic.png").write_bytes(b"img")
        (self.md / "notes.txt").write_text("keep", encoding="utf-8")
        self.seed_assets()
        before = (self.md / "a.md").read_bytes()
        with redirect_stdout(io.StringIO()):
            self.module.main([])
        self.assertEqual((self.md / "a.md").read_bytes(), before)
        self.assertEqual((self.md / "images" / "pic.png").read_bytes(), b"img")
        self.assertEqual((self.md / "notes.txt").read_text(encoding="utf-8"), "keep")
        self.assertTrue((self.md / "a.md").exists())
