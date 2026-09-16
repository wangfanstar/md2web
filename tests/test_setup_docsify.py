import sys
import errno
import http.server
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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))



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
    def write_all_assets(self):
        for filename in self.module.ASSETS:
            path = self.docs / "lib" / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x", encoding="utf-8")

    def test_ensure_assets_reuses_existing(self):
        (self.docs / "lib").mkdir(parents=True)
        self.write_all_assets()
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
        self.write_all_assets()
        (self.docs / "lib" / "docsify.min.js").write_text("", encoding="utf-8")
        with mock.patch.object(self.module, "_download", return_value=True) as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_assets()
        self.assertEqual(download.call_count, 1)
        self.assertEqual(download.call_args[0][1].name, "docsify.min.js")

    def test_marked_and_katex_assets_registered(self):
        assets = self.module.ASSETS
        self.assertIn("marked.min.js", assets)
        self.assertIn("katex/katex.min.js", assets)
        self.assertIn("katex/katex.min.css", assets)
        self.assertIn("katex/auto-render.min.js", assets)
        fonts = [name for name in assets if name.startswith("katex/fonts/") and name.endswith(".woff2")]
        self.assertEqual(len(fonts), 20)
        for name, url in assets.items():
            self.assertTrue(url.startswith("https://cdn.jsdelivr.net/npm/"), name)
            self.assertIn("@", url.split("/npm/")[1].split("/")[0], name)

    def test_ensure_assets_creates_nested_directories(self):
        def fake_download(url, dest):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"x")
            return True

        with mock.patch.object(self.module, "_download", side_effect=fake_download):
            with redirect_stdout(io.StringIO()):
                self.module.ensure_assets()
        self.assertTrue((self.docs / "lib" / "katex" / "fonts" / "KaTeX_Main-Regular.woff2").exists())

    def test_index_html_includes_math_tools(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html("T")
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        for marker in ("lib/marked.min.js", "lib/katex/katex.min.css", "lib/katex/katex.min.js",
                       "lib/katex/auto-render.min.js", "lib/math-init.js", "lib/prism-init.js"):
            self.assertIn(marker, html_text)
        self.assertLess(html_text.index("lib/docsify.min.js"), html_text.index("lib/prism-autoloader.min.js"))
        self.assertNotIn("lib/prism.min.js", html_text)

    def test_generate_assets_copies_math_init(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_custom_search_assets()
        self.assertTrue((self.docs / "lib" / "math-init.js").exists())
        self.assertTrue((self.docs / "lib" / "prism-init.js").exists())
        self.assertTrue((self.docs / "lib" / "ai-assistant.js").exists())
        self.assertTrue((self.docs / "lib" / "ai-retrieval.js").exists())
        self.assertTrue((self.docs / "lib" / "ai-assistant.css").exists())
        self.assertTrue((self.docs / "lib" / "auth.js").exists())
        self.assertTrue((self.docs / "lib" / "auth.css").exists())
        self.assertTrue((self.docs / "lib" / "sanitize.js").exists())

    def test_index_html_includes_ai_assistant(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html("T")
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        for marker in ("lib/ai-assistant.css", "lib/ai-retrieval.js", "lib/ai-assistant.js",
                       "lib/auth.css", "lib/auth.js", "lib/sanitize.js", "lib/purify.min.js"):
            self.assertIn(marker, html_text)
        self.assertLess(
            html_text.index("lib/ai-retrieval.js"),
            html_text.index("lib/ai-assistant.js"),
        )
        self.assertLess(
            html_text.index("lib/purify.min.js"),
            html_text.index("lib/sanitize.js"),
        )


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

    def test_parse_args_defaults_to_authenticated_service(self):
        serve = load_module("serve", "serve.py")
        args = serve.parse_args([])
        self.assertFalse(args.preview)
        self.assertEqual(args.config.name, "server.local.json")
        self.assertTrue(serve.parse_args(["--preview"]).preview)

    def test_is_loopback_host(self):
        serve = load_module("serve", "serve.py")
        self.assertTrue(serve.is_loopback_host("127.0.0.1"))
        self.assertTrue(serve.is_loopback_host("::1"))
        self.assertFalse(serve.is_loopback_host("192.168.1.8"))

    def test_ai_target_url_validation(self):
        serve = load_module("serve", "serve.py")
        self.assertEqual(serve.ai_target_url("https://api.example.com/v1/chat"), "https://api.example.com/v1/chat")
        self.assertEqual(serve.ai_target_url("http://127.0.0.1:11434/api/chat"), "http://127.0.0.1:11434/api/chat")
        for value in ("", "file:///etc/passwd", "ftp://example.com/x", "not-a-url"):
            with self.assertRaises(ValueError, msg=value):
                serve.ai_target_url(value)

    def test_ai_proxy_forwards_json(self):
        serve = load_module("serve", "serve.py")
        received = {}

        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                received["body"] = self.rfile.read(length).decode("utf-8")
                received["auth"] = self.headers.get("Authorization")
                payload = json.dumps({"choices": [{"message": {"content": "pong"}}]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        upstream = serve.PreviewServer(("127.0.0.1", 0), Upstream)  # 兼容 Python 3.6
        upstream_port = upstream.server_address[1]
        tmp = Path(tempfile.mkdtemp(prefix="md2web-ai-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (docs / "index.html").write_text("ok", encoding="utf-8")
            server, port = serve.make_server(docs, "127.0.0.1", 0)
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                payload = json.dumps({
                    "url": f"http://127.0.0.1:{upstream_port}/v1/chat",
                    "apiKey": "sk-test",
                    "payload": {"model": "m", "messages": [{"role": "user", "content": "ping"}]},
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/__ai/chat",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                )
                with opener.open(req) as response:
                    result = json.loads(response.read().decode("utf-8"))
                self.assertEqual(result["choices"][0]["message"]["content"], "pong")
                self.assertEqual(received["auth"], "Bearer sk-test")
                self.assertIn("ping", received["body"])
            finally:
                server.shutdown()
                server.server_close()
                upstream.shutdown()
                upstream.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_ai_proxy_streams_sse(self):
        serve = load_module("serve", "serve.py")

        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for chunk in (b'data: {"a":1}\n\n', b'data: {"a":2}\n\n', b"data: [DONE]\n\n"):
                    self.wfile.write(chunk)
                    self.wfile.flush()

            def log_message(self, *args):
                pass

        upstream = serve.PreviewServer(("127.0.0.1", 0), Upstream)  # 兼容 Python 3.6
        upstream_port = upstream.server_address[1]
        tmp = Path(tempfile.mkdtemp(prefix="md2web-ai-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (docs / "index.html").write_text("ok", encoding="utf-8")
            server, port = serve.make_server(docs, "127.0.0.1", 0)
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                payload = json.dumps({
                    "url": f"http://127.0.0.1:{upstream_port}/v1/chat",
                    "stream": True,
                    "payload": {"stream": True},
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/__ai/chat",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                )
                with opener.open(req) as response:
                    body = response.read().decode("utf-8")
                self.assertIn('data: {"a":1}', body)
                self.assertIn("data: [DONE]", body)
            finally:
                server.shutdown()
                server.server_close()
                upstream.shutdown()
                upstream.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_ai_proxy_rejects_bad_url(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-ai-"))
        try:
            docs = tmp / "docs"
            (docs / "md").mkdir(parents=True)
            (docs / "index.html").write_text("ok", encoding="utf-8")
            server, port = serve.make_server(docs, "127.0.0.1", 0)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                payload = json.dumps({"url": "file:///etc/passwd", "payload": {}}).encode("utf-8")
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/__ai/chat",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    opener.open(req)
                self.assertEqual(ctx.exception.code, 400)
            finally:
                server.shutdown()
                server.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

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

    def test_threading_http_server_fallback_defined(self):
        serve = load_module("serve", "serve.py")
        self.assertTrue(hasattr(serve, "_ThreadingHTTPServer"))
        self.assertTrue(issubclass(serve.PreviewServer, serve._ThreadingHTTPServer))

    def test_missing_auth_dependencies_downgrade_to_preview(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-deps-"))
        try:
            (tmp / "index.html").write_text("ok", encoding="utf-8")
            args = serve.parse_args(["--no-browser", "--dir", str(tmp),
                                     "--pidfile", str(tmp / "serve.pid")])
            with mock.patch.dict("sys.modules", {"flask": None, "server.app": None, "waitress": None}):
                with redirect_stdout(io.StringIO()) as output:
                    result = serve.run_authenticated_service(args, tmp)
            self.assertIsNone(result)
            self.assertTrue(args.preview)
            self.assertIn("只读预览", output.getvalue())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_manage_instance_stops_only_project_instance(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-pid-"))
        try:
            pidfile = tmp / "serve.pid"
            serve.write_pidfile(pidfile, 4321)
            killed = []
            stopped = serve.manage_instance(
                pidfile,
                is_ours=lambda pid: pid == 4321,
                terminate=lambda pid: killed.append(pid),
                log=lambda *args: None,
            )
            self.assertTrue(stopped)
            self.assertEqual(killed, [4321])
            self.assertFalse(pidfile.exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_manage_instance_skips_foreign_process(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-pid-"))
        try:
            pidfile = tmp / "serve.pid"
            serve.write_pidfile(pidfile, 987654)
            killed = []
            stopped = serve.manage_instance(
                pidfile,
                is_ours=lambda pid: False,
                terminate=lambda pid: killed.append(pid),
                log=lambda *args: None,
            )
            self.assertFalse(stopped)
            self.assertEqual(killed, [])
            self.assertFalse(pidfile.exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_read_pidfile_ignores_invalid_content(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-pid-"))
        try:
            pidfile = tmp / "serve.pid"
            self.assertIsNone(serve.read_pidfile(pidfile))
            pidfile.write_text("not-a-pid", encoding="utf-8")
            self.assertIsNone(serve.read_pidfile(pidfile))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_preview_server_rejects_writes_and_blocked_paths(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            (tmp / "md").mkdir(parents=True)
            (tmp / "index.html").write_text("ok", encoding="utf-8")
            (tmp / "md" / "a.md").write_text("# A", encoding="utf-8")
            (tmp / ".svn").mkdir()
            (tmp / ".svn" / "entries").write_text("svn", encoding="utf-8")
            server, port = serve.make_server(tmp, "127.0.0.1", 0)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with opener.open(f"http://127.0.0.1:{port}/md/a.md") as response:
                    self.assertEqual(response.status, 200)
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    opener.open(f"http://127.0.0.1:{port}/.svn/entries")
                self.assertEqual(ctx.exception.code, 404)
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/__md/save",
                    data=b'{"path": "md/a.md"}',
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    opener.open(request)
                self.assertEqual(ctx.exception.code, 403)
                payload = json.loads(ctx.exception.read().decode("utf-8"))
                self.assertEqual(payload["code"], "read_only_preview")
            finally:
                server.shutdown()
                server.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Python36CompatibilityTests(unittest.TestCase):
    """保证随包发布的 Python 代码能在 Python 3.6.8（服务器环境）上解析并避免 3.7+ 专用 API。"""

    FORBIDDEN = {
        "capture_output=": "subprocess.run(capture_output) 需要 3.7+",
        "text=True": "subprocess.run(text=) 需要 3.7+",
        "missing_ok=": "Path.unlink(missing_ok=) 需要 3.8+",
        "removeprefix(": "str.removeprefix 需要 3.9+",
        "removesuffix(": "str.removesuffix 需要 3.9+",
        "is_relative_to(": "Path.is_relative_to 需要 3.9+",
        "importlib.metadata": "importlib.metadata 需要 3.8+",
        "fromisoformat(": "datetime.fromisoformat 需要 3.7+",
        "time_ns(": "time.time_ns 需要 3.7+",
        "nullcontext(": "contextlib.nullcontext 需要 3.7+",
        "functools.cache": "functools.cache 需要 3.9+",
        "zoneinfo": "zoneinfo 需要 3.9+",
    }

    def shipped_files(self):
        files = [ROOT / "serve.py", ROOT / "setup_docsify.py"]
        files += sorted((ROOT / "server").glob("*.py"))
        return files

    def test_sources_parse_as_python36(self):
        import ast
        for path in self.shipped_files():
            source = path.read_text(encoding="utf-8")
            try:
                try:
                    ast.parse(source, feature_version=(3, 6))
                except TypeError:
                    # Python 3.8 以下没有 feature_version 参数
                    ast.parse(source)
            except SyntaxError as error:
                self.fail(f"{path.name} 在 Python 3.6 下存在语法错误: {error}")

    def test_sources_avoid_newer_only_apis(self):
        problems = []
        for path in self.shipped_files():
            for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
                if "SQLITE" in line or "兼容" in line:
                    continue
                for needle, reason in self.FORBIDDEN.items():
                    if needle in line:
                        problems.append(f"{path.name}:{number} {needle} -> {reason}")
        self.assertEqual(problems, [], "\n".join(problems))


class DrawingExamplesTests(unittest.TestCase):
    def test_doc_covers_every_playground_sample(self):
        import re
        html = (ROOT / "web" / "plot-playground.html").read_text(encoding="utf-8")
        doc = (ROOT / "docs" / "md" / "使用说明" / "绘图示例.md").read_text(encoding="utf-8")
        mermaid_labels = re.findall(r"\{ id: '[^']+', label: '([^']+)'", html)
        self.assertGreaterEqual(len(mermaid_labels), 20, "playground 中的 Mermaid 类型不足")
        for label in mermaid_labels:
            self.assertIn(label, doc, label)
        extra_labels = re.findall(r"'ext-[\w-]+': \{\s*label: '([^']+)'", html)
        self.assertGreaterEqual(len(extra_labels), 3, "playground 中的 PacketDiag 扩展模板不足")
        for label in extra_labels:
            self.assertIn(label, doc, label)
        for preset in ("packet", "tcp", "ipv4", "udp", "ethernet", "standard"):
            self.assertIn("（" + preset + "）", doc, preset)
        self.assertGreaterEqual(doc.count("```mermaid"), len(mermaid_labels))
        self.assertGreaterEqual(doc.count("```packetdiag"), len(extra_labels) + 6)
        # 每个绘图围栏都必须有内容，避免生成空白图（历史问题：预设源取错字段）
        empty = []
        for language in ("mermaid", "packetdiag"):
            blocks = re.findall(r"```" + language + r"\n(.*?)\n```", doc, re.S)
            self.assertGreaterEqual(len(blocks), 1, language)
            for index, block in enumerate(blocks):
                if not block.strip():
                    empty.append(language + "#" + str(index))
        self.assertEqual(empty, [], "存在空白的绘图源码块: " + ",".join(empty))


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

    def test_index_html_has_sidebar_alias_and_favicon(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html("T")
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertIn("'/.*/_sidebar.md': '/_sidebar.md'", html_text)
        self.assertIn('rel="icon"', html_text)

    def test_index_html_includes_mermaid(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html("T")
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertIn("lib/mermaid.min.js", html_text)
        self.assertIn("lib/mermaid-init.js", html_text)

    def test_generate_assets_copies_mermaid_init(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_custom_search_assets()
        self.assertTrue((self.docs / "lib" / "mermaid-init.js").exists())

    def test_index_html_includes_plot_tools(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html("T")
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        for marker in ("lib/packetdiag.js", "lib/packetdiag-init.js", "lib/page-export.js", "lib/md-editor.js"):
            self.assertIn(marker, html_text)

    def test_generate_assets_copies_plot_tools(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_custom_search_assets()
        for name in ("packetdiag.js", "packetdiag-init.js", "page-export.js", "plot-playground.html", "md-editor.js"):
            self.assertTrue((self.docs / "lib" / name).exists(), name)

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
        requested = " ".join(str(call[0][0]) for call in download.call_args_list)
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
        requested = " ".join(str(call[0][0]) for call in download.call_args_list)
        self.assertIn("prism-cpp.min.js", requested)
        self.assertIn("prism-c.min.js", requested)
        self.assertNotIn("prism-cuda", requested)

    def test_collect_fence_languages_ignores_mermaid(self):
        self.write_doc(
            "a.md", "```mermaid\ngraph TD\nA-->B\n```\n\n```python\nprint(1)\n```"
        )
        self.assertEqual(
            self.module.collect_fence_languages(self.md, ["a.md"]), {"python"}
        )

    def test_collect_fence_languages_ignores_packetdiag(self):
        self.write_doc(
            "a.md",
            "```packetdiag\npacketdiag { 0-7: A; }\n```\n\n```c\nint x;\n```",
        )
        self.assertEqual(
            self.module.collect_fence_languages(self.md, ["a.md"]), {"c"}
        )


class EndToEndTests(TempDirTestCase):
    def seed_assets(self):
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        for filename in self.module.ASSETS:
            path = self.docs / "lib" / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x", encoding="utf-8")
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
