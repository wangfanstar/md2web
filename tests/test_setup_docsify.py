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
        self.module.HTML_DIR = self.docs / "html"

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

    def test_set_process_title_is_safe(self):
        serve = load_module("serve", "serve.py")
        self.assertIn("md2web", serve.PROCESS_TITLE)
        self.assertLessEqual(len(serve.PROCESS_TITLE), 15, "Linux comm 最多 15 字节")
        # 在任意平台调用都不应抛错（Linux 下会改进程名，Windows 仅改控制台标题）
        self.assertIsInstance(serve.set_process_title(), bool)
        self.assertIsInstance(serve.set_process_title("md2web-test"), bool)

    def test_is_loopback_host(self):
        serve = load_module("serve", "serve.py")
        self.assertTrue(serve.is_loopback_host("127.0.0.1"))
        self.assertTrue(serve.is_loopback_host("::1"))
        self.assertFalse(serve.is_loopback_host("192.168.1.8"))

    def test_resolve_bind_cli_overrides_config(self):
        serve = load_module("serve", "serve.py")
        self.assertEqual(serve.resolve_bind("0.0.0.0", "127.0.0.1"), "0.0.0.0")
        self.assertEqual(serve.resolve_bind(None, "127.0.0.1"), "127.0.0.1")
        self.assertEqual(serve.resolve_bind(None, None), "0.0.0.0")
        self.assertEqual(serve.resolve_bind("  ", ""), "0.0.0.0")
        self.assertIsNone(serve.parse_args([]).bind, "--bind 默认应为 None（认证服务回落配置）")
        self.assertIsNone(serve.parse_args([]).port, "--port 默认应为 None（认证服务回落配置）")
        self.assertEqual(serve.resolve_port(None, 8800), 8800)
        self.assertEqual(serve.resolve_port(8891, 8800), 8891)
        self.assertEqual(serve.resolve_port(None, None), 8882)
        self.assertEqual(serve.resolve_port(None, 8891), 8891)

    def test_access_urls_reports_lan_and_local(self):
        serve = load_module("serve", "serve.py")
        serve.local_ipv4_addresses = lambda: ["192.168.1.50", "10.0.0.8"]
        local, others = serve.access_urls("0.0.0.0", 8882)
        self.assertEqual(local, "http://localhost:8882")
        self.assertEqual(others, ["http://192.168.1.50:8882", "http://10.0.0.8:8882"])
        local, others = serve.access_urls("127.0.0.1", 8882)
        self.assertEqual(others, [], "仅本机监听不应给出局域网地址")
        local, others = serve.access_urls("192.168.1.9", 8882)
        self.assertEqual(others, ["http://192.168.1.9:8882"])

    def test_local_ipv4_addresses_skips_loopback(self):
        serve = load_module("serve", "serve.py")
        for address in serve.local_ipv4_addresses():
            self.assertFalse(address.startswith("127."), address)
            self.assertNotEqual(address, "0.0.0.0")

    def test_print_access_hints_firewall_commands(self):
        import io
        from contextlib import redirect_stdout
        serve = load_module("serve", "serve.py")
        serve.local_ipv4_addresses = lambda: ["192.168.1.50"]
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            serve.print_access_hints("0.0.0.0", 8882)
        output = buffer.getvalue()
        self.assertIn("http://192.168.1.50:8882", output)
        self.assertIn("firewall-cmd --add-port=8882/tcp", output)
        self.assertIn("ufw allow 8882/tcp", output)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            serve.print_access_hints("127.0.0.1", 8882)
        self.assertIn("--bind 0.0.0.0", buffer.getvalue())

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
            (docs / "html").mkdir(parents=True, exist_ok=True)
            index_path = docs / "html" / "search-index.json"
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
            (docs / "html").mkdir(parents=True, exist_ok=True)
            (docs / "html" / "search-index.json").write_text(
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


class OfflineWheelsTests(unittest.TestCase):
    """Linux 离线依赖包：server/wheels 必须覆盖 requirements.txt 的全部依赖。"""

    def test_wheels_cover_requirements(self):
        import re

        requirement_lines = []
        for line in (ROOT / "server" / "requirements.txt").read_text(encoding="ascii").split("\n"):
            line = line.split("#", 1)[0].strip()
            if line:
                requirement_lines.append(line)
        wheel_names = [path.name.lower() for path in (ROOT / "server" / "wheels").glob("*.whl")]
        self.assertTrue(wheel_names, "缺少 server/wheels 离线包")
        missing = []
        for entry in requirement_lines:
            spec = entry.split(";", 1)[0].strip()
            match = re.match(r"([A-Za-z0-9_.-]+)==([^\s]+)", spec)
            if not match:
                continue
            name = match.group(1).lower().replace("-", "_")
            version = match.group(2)
            if not any(wheel.startswith(name + "-" + version + "-") for wheel in wheel_names):
                missing.append(entry)
        self.assertEqual(missing, [], "离线包缺少: " + ", ".join(missing))

    def test_wheels_include_linux_markupsafe(self):
        names = [path.name for path in (ROOT / "server" / "wheels").glob("*.whl")]
        self.assertTrue(
            any("manylinux" in name.lower() and "markupsafe" in name.lower() for name in names),
            "缺少 MarkupSafe 的 manylinux cp36 wheel",
        )


class LauncherScriptsTests(unittest.TestCase):
    """启动脚本的行尾/权限约定：Linux 脚本必须 LF 且可执行，Windows 脚本保持 CRLF。"""

    def test_gitattributes_declares_line_endings(self):
        text = (ROOT / ".gitattributes").read_text(encoding="utf-8")
        self.assertIn("*.sh text eol=lf", text)
        self.assertIn("*.bat text eol=crlf", text)

    def test_start_linux_shebang_and_self_heal(self):
        raw = (ROOT / "start_linux.sh").read_bytes()
        first_line = raw.split(b"\n", 1)[0]
        self.assertEqual(first_line.rstrip(b"\r"), b"#!/usr/bin/env sh")
        self.assertIn(b"tr -d '\\r'", raw, "缺少 CRLF 自愈逻辑")
        self.assertIn(b"grep -q", raw, "缺少 CRLF 检测逻辑")
        self.assertIn(b"python3 serve.py", raw)

    def test_start_linux_has_no_cr_bytes(self):
        raw = (ROOT / "start_linux.sh").read_bytes()
        self.assertNotIn(b"\r", raw, "start_linux.sh 必须为 LF（CRLF 会导致 ./start_linux.sh: No such file or directory）")
        import subprocess as subprocess_module
        result = subprocess_module.run(["git", "-C", str(ROOT), "show", "HEAD:start_linux.sh"],
                                       stdout=subprocess_module.PIPE, stderr=subprocess_module.PIPE)
        if result.returncode == 0 and result.stdout:
            self.assertNotIn(b"\r", result.stdout, "仓库中的 start_linux.sh 含 CRLF")

    def test_start_linux_is_executable_in_git(self):
        import shutil
        import subprocess
        if not shutil.which("git"):
            self.skipTest("git 不可用")
        result = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "-s", "start_linux.sh"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        line = (result.stdout or b"").decode("utf-8", "replace").strip()
        if not line:
            self.skipTest("非 git 工作副本")
        self.assertTrue(line.startswith("100755"), "start_linux.sh 需要可执行位: " + line)

    def test_start_linux_supports_background_stop_status(self):
        raw = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        for needle in ("nohup", "--stop", "--status", "--foreground", "data/serve.log",
                       "md2web-serve", "serve.pid", "--restart", "port_holders", "kill_port_holder"):
            self.assertIn(needle, raw, "start_linux.sh 缺少：" + needle)
        # 端口占用时提示可用 --restart
        self.assertIn("--restart 强制结束占用进程后重启", raw)
        # 容错：`-- restart` / `restart` 写法（多打空格或漏写 --）也能识别
        self.assertIn("--restart|restart)", raw)
        self.assertIn("--stop|stop)", raw)
        self.assertIn("--) ;;", raw, "应忽略多余的分隔符 --")
        self.assertIn("exec \"$PY\" serve.py", raw, "前台模式应保持 exec 语义")

    def test_start_linux_prompts_before_killing_port_holder(self):
        raw = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        self.assertIn("confirm_port_conflict", raw, "启动前应先检查端口占用")
        self.assertIn("read -t 10", raw, "端口占用询问应支持 10 秒超时")
        self.assertIn("10 秒无操作，自动强制结束占用进程", raw, "超时应自动强制结束占用进程")
        self.assertIn("已取消启动", raw, "回答 n 应取消启动")
        self.assertIn("非交互式启动：自动强制结束占用进程", raw, "非交互启动应自动结束占用进程")
        # 进程信息优先 /proc（ps -o 字段在不同发行版上有兼容问题）
        self.assertIn("process_info", raw, "应打印占用进程的详细信息")
        self.assertIn("/proc/$pid/cmdline", raw, "应用 /proc 读取命令行")
        self.assertIn("human_duration", raw, "应展示可读的运行时长")

    def test_start_linux_supports_port_option(self):
        raw = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        # 显式 --port / --port= / 裸端口号三种写法
        self.assertIn("--port 8891", raw, "脚本头部应说明 --port 用法")
        self.assertIn('set -- "$@" --port "$arg"', raw, "纯数字参数应转换为 --port")
        self.assertIn("validate_port", raw, "应校验端口范围")
        self.assertIn("端口必须在 1-65535 之间", raw)
        self.assertIn('--port|--pidfile|--bind|--config|--title|--svn-command)', raw,
                      "带值参数的下一个参数不应被当作端口")

    def test_start_linux_prompt_survives_dash(self):
        """dash 的 read 不支持 -t：必须用 timeout/read -t 组合保证 10 秒超时仍然生效。"""
        raw = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        self.assertIn("command -v timeout", raw, "应优先用 coreutils timeout 实现超时")
        self.assertIn("read -t 10 answer", raw, "不支持 timeout 时回退 read -t")
        self.assertIn("[ -t 0 ] || [ -r /dev/tty ]", raw, "有终端（含 /dev/tty）时都应先询问")

    def test_start_linux_prompt_accepts_single_key(self):
        """输入 y/n 不应要求回车：stty 关行缓冲 + dd 读一个字符，终端驱动负责 10 秒超时。"""
        raw = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        self.assertIn("stty -icanon -echo min 0 time 100", raw, "应关闭行缓冲并由终端驱动 10 秒超时")
        self.assertIn("dd bs=1 count=1", raw, "应读取单个按键，无需回车")
        self.assertIn('stty "$saved_tty"', raw, "读取后必须恢复终端设置")
        self.assertIn("single_key=1", raw)

    def test_start_linux_readiness_uses_pid_and_port(self):
        raw = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        # 就绪判断：pidfile 进程存活 + 端口监听（日志未刷新时也能判断成功）
        self.assertIn('port_holders "$target_port"', raw, "就绪判断应检查端口监听")
        self.assertIn('nohup "$PY" -u serve.py', raw, "后台启动应关闭 Python 输出缓冲，日志即时可用")
        # 失败时给出诊断（进程/端口/日志）
        self.assertIn("日志为空：$LOG_FILE", raw, "日志为空时应明确提示")
        self.assertIn("端口 $target_port 尚未监听", raw, "应区分“进程在但端口未监听”")

    def test_launchers_default_to_lan_bind(self):
        linux = (ROOT / "start_linux.sh").read_text(encoding="utf-8")
        self.assertIn("--bind 0.0.0.0", linux, "start_linux.sh 默认应监听所有网卡")
        self.assertIn("--bind 127.0.0.1", linux, "应提示仅本机监听的用法")
        windows = (ROOT / "start_windows.bat").read_text(encoding="ascii")
        self.assertIn("--bind 0.0.0.0", windows, "start_windows.bat 默认应监听所有网卡")
        self.assertIn("%APP_ARGS%", windows)

    def test_default_config_binds_all_interfaces(self):
        from server import config as server_config
        example = json.loads((ROOT / "config" / "server.example.json").read_text(encoding="utf-8"))
        self.assertEqual(example["server"]["bind"], "0.0.0.0", "示例配置应默认局域网可访问")
        default = server_config.default_config()
        self.assertEqual(default["server"]["bind"], "0.0.0.0")

    def test_start_windows_is_ascii_only(self):
        raw = (ROOT / "start_windows.bat").read_bytes()
        try:
            raw.decode("ascii")
        except UnicodeDecodeError as error:
            self.fail("start_windows.bat 必须保持纯 ASCII（cmd 用 OEM 代码页解析）: " + str(error))


class SourceDocumentsTests(unittest.TestCase):
    """docs/md 是唯一需要人工维护的目录：防止源文档被误删或误替换。"""

    EXPECTED = (
        "docs/md/使用说明/快速开始.md",
        "docs/md/使用说明/绘图示例.md",
        "docs/md/硬件设计/时钟树设计.md",
        "docs/md/硬件设计/寄存器手册.md",
        "docs/md/软件工具链/编译工具链.md",
        "docs/md/验证指南/仿真环境搭建.md",
    )

    def test_repo_source_documents_exist(self):
        missing = [name for name in self.EXPECTED if not (ROOT / name).is_file()]
        self.assertEqual(
            missing, [],
            "docs/md 源文档缺失（构建不会修改该目录，删除必须由人工确认）: " + ", ".join(missing),
        )
        for name in self.EXPECTED:
            self.assertGreater((ROOT / name).stat().st_size, 0, name + " 为空文件")


class MultiRepoTests(TempDirTestCase):
    """多仓库站点：每仓库一个入口页 + 分组总览页 + 独立搜索/离线数据。"""

    REPOS = [
        {"id": "hardware", "mount": "md/硬件设计", "url": "https://svn.example.invalid/hardware/",
         "group": "硬件", "read_only": False, "allow_commit": True, "sync_interval": 120},
        {"id": "software", "mount": "md/软件工具链", "url": "https://svn.example.invalid/software/",
         "group": "软件", "read_only": True, "allow_commit": False, "sync_interval": None},
    ]

    def test_repo_page_name_and_mount_subpath(self):
        self.assertEqual(self.module.repo_page_name("hardware"), "index_hardware.html")
        self.assertEqual(self.module.repo_page_name("a/b c"), "index_a-b-c.html")
        self.assertEqual(self.module.mount_subpath("md/硬件设计"), "硬件设计")

    def test_auto_folder_repos_cover_unconfigured_folders(self):
        self.write_doc("硬件设计/时钟树设计.md", "# A")
        self.write_doc("验证指南/仿真环境搭建.md", "# B")
        auto = self.module.auto_folder_repos(self.REPOS)
        ids = {item["id"] for item in auto}
        self.assertEqual(ids, {"验证指南"}, "只应为未配置仓库的文件夹生成入口页")
        item = auto[0]
        self.assertTrue(item["auto"])
        self.assertEqual(item["mount"], "md/验证指南")
        self.assertEqual(item["url"], "")
        self.assertEqual(self.module.repo_page_name(item["id"]), "index_验证指南.html",
                         "中文文件夹名应保留在入口页文件名中")
        with mock.patch.object(self.module, "load_repositories", lambda: list(self.REPOS)):
            with redirect_stdout(io.StringIO()):
                repos = self.module.load_all_repos()
        self.assertEqual([item["id"] for item in repos], ["hardware", "software", "验证指南"])

    def test_repo_for_route_uses_longest_prefix(self):
        repos = self.REPOS + [{"id": "deep", "mount": "md/硬件设计/接口", "group": "硬件",
                               "read_only": False, "allow_commit": True, "sync_interval": None}]
        repo, relative = self.module.repo_for_route("/md/硬件设计/接口/uart.md", repos)
        self.assertEqual(repo["id"], "deep")
        self.assertEqual(relative, "uart.md")
        repo, relative = self.module.repo_for_route("/md/硬件设计/时钟树设计.md", repos)
        self.assertEqual(repo["id"], "hardware")
        self.assertEqual(relative, "时钟树设计.md")
        repo, relative = self.module.repo_for_route("/md/其他/x.md", repos)
        self.assertIsNone(repo)

    def test_files_for_mount_filters_documents(self):
        files = ["硬件设计/a.md", "硬件设计/b/c.md", "软件工具链/d.md"]
        self.assertEqual(self.module.files_for_mount(files, "md/硬件设计"),
                         ["硬件设计/a.md", "硬件设计/b/c.md"])

    def test_master_page_lists_groups_and_links(self):
        self.module.generate_master_index_html(self.REPOS, "测试站")
        html = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertIn("index_hardware.html", html)
        self.assertIn("index_software.html", html)
        self.assertIn("硬件", html)
        self.assertIn("软件", html)
        self.assertIn("只读", html)
        self.assertIn("index_all.html", html)
        self.assertIn("md2web_config.html", html)

    def test_repo_page_uses_own_sidebar_index_and_flags(self):
        lib = self.docs / "lib"
        lib.mkdir(parents=True, exist_ok=True)
        for name in ("custom-search.js", "workspace.js", "settings.js"):
            (lib / name).write_text("// " + name + "\n", encoding="utf-8")
        repo = self.REPOS[1]
        self.module.generate_index_html("测试站", path=self.docs / "index_software.html",
                                        sidebar="_sidebar_software.md",
                                        search_index="search-index_software.json",
                                        offline_data="lib/offline-data_software.js",
                                        read_only=repo["read_only"], allow_commit=repo["allow_commit"],
                                        repo=repo, home_link="index_all.html")
        html = (self.docs / "index_software.html").read_text(encoding="utf-8")
        self.assertIn("_sidebar_software.md", html)
        self.assertIn("search-index_software.json", html)
        self.assertIn("offline-data_software.js", html)
        self.assertIn("repoReadOnly: true", html)
        self.assertIn("repoAllowCommit: false", html)
        self.assertIn('homeLink: "index_all.html"', html)

    def test_index_all_links_home_to_overview(self):
        lib = self.docs / "lib"
        lib.mkdir(parents=True, exist_ok=True)
        for name in ("custom-search.js", "workspace.js", "settings.js"):
            (lib / name).write_text("// " + name + "\n", encoding="utf-8")
        self.module.generate_index_html("测试站", path=self.docs / "index_all.html",
                                        route_sidebar=True, repos=self.REPOS, home_link="index.html")
        html = (self.docs / "index_all.html").read_text(encoding="utf-8")
        self.assertIn('homeLink: "index.html"', html)
        self.assertIn("routeSidebar: true", html)
        self.assertIn("folderView: true", html)


class ThirdPartyNoticeTests(unittest.TestCase):
    """本项目基于 docsify 构建：需保留版权/许可声明与第三方组件清单。"""

    def test_notices_file_lists_components(self):
        notices = (ROOT / "THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8")
        for needle in ("docsify", "4.13.1", "MIT", "Prism", "Mermaid", "KaTeX", "THIRD-PARTY"):
            self.assertIn(needle, notices, needle)

    def test_docsify_banner_and_page_comment(self):
        built = (ROOT / "docs" / "lib" / "docsify.min.js").read_text(encoding="utf-8", errors="ignore")
        self.assertTrue(built.startswith("/*!"), "docsify.min.js 缺少版权/许可横幅")
        self.assertIn("docsify v4.13.1", built)
        self.assertIn("THIRD-PARTY-NOTICES.md", built)
        page = (ROOT / "docs" / "html" / "index_all.html").read_text(encoding="utf-8")
        self.assertIn("docsify 4.13.1", page, "页面缺少 docsify 版本声明注释")

    def test_readme_mentions_docsify_based(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("docsify", readme)
        self.assertIn("THIRD-PARTY-NOTICES.md", readme)


class FolderViewTests(unittest.TestCase):
    """index_all 的文件夹视图只在文件夹路由生效；文档路由保留正文与右侧本文目录。"""

    def test_folder_view_guards_document_routes(self):
        source = (ROOT / "web" / "folder-view.js").read_text(encoding="utf-8")
        self.assertIn("isFolderRoute", source)
        self.assertIn("\\.md$", source, "应识别 .md 文档路由并跳过文件夹视图")
        self.assertIn("folder-view-active", source)
        built = (ROOT / "docs" / "lib" / "folder-view.js").read_text(encoding="utf-8")
        self.assertIn("isFolderRoute", built, "构建产物未同步 folder-view.js")

    def test_index_all_keeps_toc_container(self):
        page = (ROOT / "docs" / "html" / "index_all.html").read_text(encoding="utf-8")
        self.assertIn("folderView: true", page)
        self.assertIn("customToc", page, "页面仍应启用右侧本文目录")


class HtmlLayoutTests(unittest.TestCase):
    """docs 根目录只保留 index.html，其余页面与数据都在 docs/html/ 下。"""

    def test_docs_root_keeps_only_index_html(self):
        docs = ROOT / "docs"
        files = sorted(path.name for path in docs.iterdir() if path.is_file())
        self.assertEqual(files, ["index.html"], "docs 根目录只应有 index.html")
        for name in ("html", "lib", "md"):
            self.assertTrue((docs / name).is_dir(), name)

    def test_html_dir_contains_pages_and_data(self):
        html_dir = ROOT / "docs" / "html"
        for name in ("index_all.html", "md2web_config.html", "md2web_feedback.html",
                     "README.md", "_sidebar.md", "search-index.json"):
            self.assertTrue((html_dir / name).is_file(), name)
        self.assertTrue(list(html_dir.glob("index_*.html")), "每个文件夹都应有入口页")
        self.assertTrue(list(html_dir.glob("search-index_*.json")))
        self.assertTrue(list(html_dir.glob("_sidebar_*.md")))

    def test_html_pages_use_base_and_prefixed_paths(self):
        page = (ROOT / "docs" / "html" / "index_all.html").read_text(encoding="utf-8")
        self.assertIn('<base href="../">', page)
        self.assertIn('basePath: "../"', page)
        self.assertIn("'/_sidebar.md': 'html/_sidebar.md'", page)
        self.assertIn("indexPath: 'html/search-index.json'", page)
        self.assertIn('homeLink: "index.html"', page)
        repo_page = next(path for path in (ROOT / "docs" / "html").glob("index_*.html")
                         if path.name != "index_all.html")
        repo_html = repo_page.read_text(encoding="utf-8")
        self.assertIn('<base href="../">', repo_html)
        self.assertIn('homeLink: "html/index_all.html"', repo_html)

    def test_master_page_links_into_html_dir(self):
        master = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="html/index_all.html"', master)
        # 总览页只做文件名/标题搜索，需在输入框与提示中引导到 index_all.html 做全文检索
        self.assertIn("仅按文件名/标题搜索", master)
        self.assertIn("只匹配文件名与标题", master)
        self.assertIn("全文检索", master)
        self.assertIn('href="html/md2web_config.html"', master)
        self.assertIn('href="html/md2web_feedback.html"', master)
        self.assertIn("fetch('html/search-index.json')", master)
        self.assertRegex(master, r'href="html/index_[^"]+\.html"')

    def test_merged_offline_data_uses_html_keys(self):
        text = (ROOT / "docs" / "lib" / "offline-data.js").read_text(encoding="utf-8")
        payload = json.loads(text.split("=", 1)[1].rstrip().rstrip(";"))
        self.assertIn("html/README.md", payload["content"])
        self.assertIn("html/_sidebar.md", payload["content"])
        self.assertIn("md/使用说明/快速开始.md", payload["content"])

    def test_sidebar_navigation_targets(self):
        """侧栏导航：返回上一层→index_all、返回首页→index.html、一级分组名→仓库入口页。"""
        script = (ROOT / "web" / "custom-search.js").read_text(encoding="utf-8")
        self.assertIn('href="html/index_all.html"', script, "返回上一层应指向 index_all.html")
        self.assertIn("返回上一层", script)
        self.assertIn("return 'index.html';", script, "返回首页应指向总览 index.html")
        sidebar = (ROOT / "docs" / "html" / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn('<a class="sidebar-group-link" href="html/index_', sidebar,
                      "全局侧栏的一级分组名应链接到仓库入口页")
        self.assertIn('href="html/index_all.html">**所有文档**</a>', sidebar,
                      "侧栏标题应为「所有文档」并链接到合并视图")
        repo_sidebar = next((ROOT / "docs" / "html").glob("_sidebar_*.md"))
        self.assertIn("所有文档", repo_sidebar.read_text(encoding="utf-8"),
                      "各仓库侧栏标题同样应为「所有文档」")
        workspace = (ROOT / "web" / "workspace.js").read_text(encoding="utf-8")
        self.assertNotIn("filterByCurrentRepo", workspace,
                         "index_all 合并视图不应再按仓库过滤左侧导航")
        # 文件数量只统计文档链接（分组名链接指向 index_*.html，不应计入）
        self.assertIn("':scope > ul a[href]'", workspace)
        self.assertIn("indexOf('.html') === -1", workspace)
        css = (ROOT / "web" / "workspace.css").read_text(encoding="utf-8")
        self.assertIn("a.sidebar-group-link", css, "分组行需要单行 flex 布局样式")
        built = (ROOT / "docs" / "lib" / "custom-search.js").read_text(encoding="utf-8")
        self.assertIn('href="html/index_all.html"', built, "构建产物未同步 custom-search.js")

    def test_search_reading_highlight_robustness(self):
        """正文命中高亮：标题文字在 a.anchor 内不能被排除；DOM 重渲染后失效的 Range 要重新采集。"""
        source = (ROOT / "web" / "custom-search.js").read_text(encoding="utf-8")
        self.assertNotIn(".anchor, .search-reading-toolbar", source,
                         "docsify 标题文字包在 a.anchor 中，排除 .anchor 会导致标题命中不高亮")
        self.assertIn("readingRangesValid", source, "应用高亮前应校验 Range 是否失效")
        self.assertIn("refreshReadingMatches", source, "Range 失效后应按当前 DOM 重新采集")
        self.assertIn("ensureReadingMatches", source)
        self.assertIn("wrapReadingMatches();", source, "无 Highlight API 的浏览器刷新后应重新包裹 <mark>")
        css = (ROOT / "web" / "custom-search.css").read_text(encoding="utf-8")
        self.assertIn("::highlight(docsify-search-hl)", css)
        self.assertIn("background-color", css.split("::highlight(docsify-search-hl)")[1][:120],
                      "::highlight() 应使用 background-color")
        built = (ROOT / "docs" / "lib" / "custom-search.js").read_text(encoding="utf-8")
        self.assertIn("readingRangesValid", built, "构建产物未同步 custom-search.js")

    def test_search_query_handoff_across_pages_and_tabs(self):
        """关键词交接用 localStorage（跨标签页有效）并带有效期；总览页搜索点击结果也交接。"""
        source = (ROOT / "web" / "custom-search.js").read_text(encoding="utf-8")
        self.assertIn("READING_STATE_TTL", source)
        self.assertIn("localStorage.setItem(READING_STATE_KEY", source)
        self.assertIn("localStorage.getItem(READING_STATE_KEY", source)
        self.assertNotIn("sessionStorage.setItem(READING_STATE_KEY", source,
                         "sessionStorage 不跨标签页，应改用 localStorage")
        master = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
        self.assertIn("md2web:search-reading", master, "总览页搜索结果应把关键词交接给目标文档页")
        self.assertIn("rememberReadingQuery", master)

    def test_search_restores_query_across_pages(self):
        """跨页搜索结果会整页导航：关键词要暂存并在目标页恢复，否则正文命中高亮丢失。"""
        source = (ROOT / "web" / "custom-search.js").read_text(encoding="utf-8")
        for needle in ("READING_STATE_KEY", "rememberReadingQuery", "restoreReadingQuery",
                       "handleSearchResultNavigate", "localStorage.setItem", "localStorage.removeItem"):
            self.assertIn(needle, source, needle)
        self.assertIn("restoreReadingQuery();", source, "索引就绪后应恢复关键词")
        built = (ROOT / "docs" / "lib" / "custom-search.js").read_text(encoding="utf-8")
        self.assertIn("restoreReadingQuery", built, "构建产物未同步 custom-search.js")

    def test_hash_links_stay_on_current_page(self):
        """<base> 下纯 hash 链接（侧栏/本文目录）必须在当前文档内跳转，否则会整页跳回站点根。"""
        source = (ROOT / "web" / "workspace.js").read_text(encoding="utf-8")
        self.assertIn("handleHashLinkClick", source)
        self.assertIn("a[href]", source)
        self.assertIn("window.location.hash = href", source)
        built = (ROOT / "docs" / "lib" / "workspace.js").read_text(encoding="utf-8")
        self.assertIn("handleHashLinkClick", built, "构建产物未同步 workspace.js")


class FeedbackPageTests(unittest.TestCase):
    """读者反馈页与每页入口链接。"""

    def test_feedback_page_and_links(self):
        page = (ROOT / "docs" / "html" / "md2web_feedback.html").read_text(encoding="utf-8")
        self.assertIn("md2web-feedback.js", page)
        self.assertIn("提交反馈", page)
        script = (ROOT / "web" / "md2web-feedback.js").read_text(encoding="utf-8")
        for needle in ("__feedback", "__admin/feedback", "登录后即可提交反馈"):
            self.assertIn(needle, script, needle)
        sidebar = (ROOT / "docs" / "lib" / "custom-search.js").read_text(encoding="utf-8")
        self.assertIn("md2web_feedback.html", sidebar, "侧栏应包含反馈链接")
        master = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
        self.assertIn("md2web_feedback.html", master)
        config_page = (ROOT / "docs" / "html" / "md2web_config.html").read_text(encoding="utf-8")
        self.assertIn("md2web_feedback.html", config_page)

    def test_feedback_delete_and_dialog_style(self):
        script = (ROOT / "web" / "md2web-feedback.js").read_text(encoding="utf-8")
        for needle in ("__feedback/delete", 'data-action="delete-feedback"', "canDelete",
                       "feedback-card", "feedback-badge", "fd-head", "fd-section", "FeedbackDialog"):
            self.assertIn(needle, script, needle)
        app = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
        self.assertIn('@app.post("/__feedback/delete")', app)
        database = (ROOT / "server" / "database.py").read_text(encoding="utf-8")
        self.assertIn("def delete_feedback", database)
        self.assertIn("def get_feedback", database)


class PlaygroundCopyTests(unittest.TestCase):
    """绘图在线预览：复制源码支持勾选是否带围栏（默认带）。"""

    def test_copy_options_exist(self):
        html = (ROOT / "web" / "plot-playground.html").read_text(encoding="utf-8")
        for needle in ("pgPacketFence", "pgMermaidFence", "fencedSource"):
            self.assertIn(needle, html, needle)
        self.assertIn("带围栏", html)
        self.assertIn("已复制（纯源码）", html)


class FolderGroupTests(TempDirTestCase):
    """未配置 SVN 的文件夹也能分组（folderGroups）。"""

    def test_auto_folder_repos_use_configured_groups(self):
        for name in ("硬件设计", "未配置目录"):
            (self.md / name).mkdir(parents=True, exist_ok=True)
            (self.md / name / "a.md").write_text("# A\n", encoding="utf-8")
        (self.tmp / "config").mkdir(parents=True, exist_ok=True)
        config_path = self.tmp / "config" / "server.local.json"
        config_path.write_text(json.dumps({
            "folderGroups": {"md/未配置目录": "自定义组"},
            "repositories": [{"id": "hardware", "mount": "md/硬件设计",
                              "url": "https://svn.example.invalid/hw/"}],
        }, ensure_ascii=False), encoding="utf-8")
        original = self.module.ROOT
        self.module.ROOT = self.tmp
        try:
            repos = self.module.auto_folder_repos([{"id": "hardware", "mount": "md/硬件设计",
                                                    "group": "默认"}])
        finally:
            self.module.ROOT = original
        groups = {repo["id"]: repo["group"] for repo in repos}
        self.assertEqual(groups.get("未配置目录"), "自定义组")


class AssetVersionTests(TempDirTestCase):
    """index.html 里的本地 lib 资源要带内容版本号，避免浏览器缓存旧脚本（修复放大丢字等问题）。"""

    def test_local_assets_are_versioned(self):
        self.write_doc("使用说明/a.md", "# A\n")
        lib = self.docs / "lib"
        lib.mkdir(parents=True, exist_ok=True)
        for name in ("mermaid-init.js", "media-viewer.js", "md-editor.js", "workspace.css"):
            (lib / name).write_text("/* " + name + " */\n", encoding="utf-8")
        self.module.generate_index_html("测试站")
        html = (self.docs / "index.html").read_text(encoding="utf-8")
        for name in ("lib/mermaid-init.js", "lib/media-viewer.js", "lib/md-editor.js", "lib/workspace.css"):
            self.assertIn(name + "?v=", html, name + " 缺少内容版本号")

    def test_version_changes_with_content(self):
        target = self.docs / "lib"
        target.mkdir(parents=True, exist_ok=True)
        script = target / "demo.js"
        script.write_text("console.log(1);\n", encoding="utf-8")
        first = self.module.version_asset_urls('<script src="lib/demo.js"></script>')
        script.write_text("console.log(2);\n", encoding="utf-8")
        second = self.module.version_asset_urls('<script src="lib/demo.js"></script>')
        self.assertNotEqual(first, second)
        self.assertIn("lib/demo.js?v=", first)
        # 已带查询串或缺失文件保持原样
        self.assertEqual(self.module.version_asset_urls('<script src="lib/demo.js?v=1"></script>'),
                         '<script src="lib/demo.js?v=1"></script>')
        self.assertEqual(self.module.version_asset_urls('<script src="lib/missing.js"></script>'),
                         '<script src="lib/missing.js"></script>')


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

    SKIP_MARKERS = ("SQLITE", "兼容", "3.7+", "3.8+", "3.9+", "as_text=True")

    def shipped_files(self):
        files = [ROOT / "serve.py", ROOT / "setup_docsify.py"]
        files += sorted((ROOT / "server").glob("*.py"))
        return files

    def compatibility_files(self):
        # 测试脚本也在 Python 3.6 上运行，同样受 3.7+ API 限制
        return self.shipped_files() + sorted((ROOT / "tests").glob("*.py"))

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
        for path in self.compatibility_files():
            for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
                if any(marker in line for marker in self.SKIP_MARKERS):
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
        html = self.module.HTML_DIR
        with redirect_stdout(io.StringIO()):
            self.module.generate_sidebar(md_files, path=html / "_sidebar.md")
            self.module.generate_readme(md_files, "测试站点", path=html / "README.md")
            self.module.generate_search_index(md_files, "测试站点", path=html / "search-index.json")
            self.module.generate_offline_data(md_files, sidebar="html/_sidebar.md")
        return md_files

    def test_sidebar_tree(self):
        self.build_site()
        sidebar = (self.module.HTML_DIR / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn("- **指南**", sidebar)
        self.assertIn("[入门](/md/指南/入门.md)", sidebar)
        self.assertIn("[常见问题](/md/常见问题.md)", sidebar)

    def test_readme_index(self):
        self.build_site()
        readme = (self.module.HTML_DIR / "README.md").read_text(encoding="utf-8")
        self.assertIn("# 测试站点", readme)
        self.assertIn("[入门](md/指南/入门.md)", readme)

    def test_search_index_routes(self):
        self.build_site()
        index = json.loads(
            (self.module.HTML_DIR / "search-index.json").read_text(encoding="utf-8")
        )
        self.assertIn("/", index)
        self.assertIn("/md/指南/入门.md", index)
        entry = index["/md/指南/入门.md"]["/md/指南/入门.md?id=安装"]
        self.assertEqual(entry["route"], "/md/指南/入门.md")

    def test_search_index_has_no_empty_shell_entry(self):
        self.build_site()
        index = json.loads(
            (self.module.HTML_DIR / "search-index.json").read_text(encoding="utf-8")
        )
        page = index["/md/指南/入门.md"]
        self.assertNotIn("/md/指南/入门.md", page)
        self.assertIn("/md/指南/入门.md?id=入门", page)

    def test_offline_data_contains_all_md(self):
        self.build_site()
        text = (self.docs / "lib" / "offline-data.js").read_text(encoding="utf-8")
        payload = json.loads(text.split("=", 1)[1].rstrip().rstrip(";"))
        self.assertIn("md/指南/入门.md", payload["content"])
        self.assertIn("html/_sidebar.md", payload["content"])
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
        self.assertTrue((self.docs / "html" / "_sidebar.md").exists())
        self.assertTrue((self.docs / "html" / "README.md").exists())
        self.assertTrue((self.docs / "html" / "search-index.json").exists())
        self.assertTrue((self.md / "a.md").exists())
        self.assertIn(
            "<title>文档中心</title>",
            (self.docs / "index.html").read_text(encoding="utf-8"),
        )
        index = json.loads(
            (self.docs / "html" / "search-index.json").read_text(encoding="utf-8")
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
        self.assertIn("# E2E", (self.docs / "html" / "README.md").read_text(encoding="utf-8"))
        index = json.loads(
            (self.docs / "html" / "search-index.json").read_text(encoding="utf-8")
        )
        self.assertTrue(
            any(entry["pageTitle"] == "E2E" for entry in index["/"].values())
        )

    def test_full_build_creates_entry_page_per_folder(self):
        self.write_doc("使用说明/a.md", "# A")
        self.write_doc("硬件设计/b.md", "# B")
        self.seed_assets()
        with mock.patch.object(self.module, "load_repositories", lambda: []):
            with redirect_stdout(io.StringIO()):
                self.module.main([])
        self.assertTrue((self.docs / "html" / "index_使用说明.html").is_file())
        self.assertTrue((self.docs / "html" / "index_硬件设计.html").is_file())
        self.assertTrue((self.docs / "html" / "_sidebar_硬件设计.md").is_file())
        self.assertTrue((self.docs / "html" / "search-index_硬件设计.json").is_file())
        overview = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertIn("index_使用说明.html", overview)
        self.assertIn("未配置 SVN", overview)
        # 文件夹被删除后重建：入口页等产物应被清理
        shutil.rmtree(self.md / "硬件设计")
        with mock.patch.object(self.module, "load_repositories", lambda: []):
            with redirect_stdout(io.StringIO()):
                self.module.main([])
        self.assertFalse((self.docs / "html" / "index_硬件设计.html").exists())
        self.assertFalse((self.docs / "html" / "_sidebar_硬件设计.md").exists())

    def test_index_only_skips_site_files(self):
        self.write_doc("a.md", "# A")
        (self.docs / "html").mkdir(parents=True, exist_ok=True)
        (self.docs / "html" / "_sidebar.md").write_text("SENTINEL", encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            self.module.main(["--index-only"])
        self.assertEqual(
            (self.docs / "html" / "_sidebar.md").read_text(encoding="utf-8"), "SENTINEL"
        )
        index = json.loads(
            (self.docs / "html" / "search-index.json").read_text(encoding="utf-8")
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
        self.assertFalse((self.docs / "html" / "_sidebar.md").exists())
        self.assertFalse((self.docs / "html" / "README.md").exists())
        self.assertFalse((self.docs / "html" / "search-index.json").exists())

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
