"""跨平台本地预览服务器：python serve.py [--port 3000] [--no-browser]

额外提供源文档保存接口（仅本机可调用）：
  GET  /__md/meta?path=md/a.md       读取源文档 hash 与 mtime
  POST /__md/save                    {path, content, baseHash?, force?} 写回 docs/md
"""

import argparse
import errno
import functools
import hashlib
import http.server
import io
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent
MD_API_PREFIX = "/__md/"
MD_MAX_BODY = 8 * 1024 * 1024


class MdSaveError(Exception):
    """源文档读写失败：status 为建议的 HTTP 状态码。"""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def is_loopback_host(host):
    host = str(host or "")
    return host in ("::1", "localhost") or host.startswith("127.")


def normalize_md_path(raw):
    """规范化 md/<相对路径>.md；非法路径抛 MdSaveError(400)。"""
    value = str(raw or "").strip().replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    value = value.lstrip("/")
    if not value:
        raise MdSaveError(400, "缺少 path 参数")
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if not parts or parts[0] != "md":
        raise MdSaveError(400, "仅允许编辑 docs/md 下的 Markdown 源文档")
    if any(part == ".." for part in parts):
        raise MdSaveError(400, "path 不能包含 ..")
    if any(part.startswith(".") for part in parts):
        raise MdSaveError(400, "path 不能包含隐藏目录")
    if Path(*parts).suffix.lower() != ".md":
        raise MdSaveError(400, "仅支持 .md 文件")
    return "/".join(parts)


def resolve_md_file(md_dir, raw):
    rel = normalize_md_path(raw)
    root = Path(md_dir).resolve()
    candidate = (root / rel.split("/", 1)[1]).resolve()
    if candidate != root and root not in candidate.parents:
        raise MdSaveError(400, "path 越界，超出 docs/md 目录")
    return candidate


def normalize_eol(text):
    return str(text).replace("\r\n", "\n").replace("\r", "\n")


def text_hash(text):
    return hashlib.sha256(normalize_eol(text).encode("utf-8")).hexdigest()


def detect_eol(text, default="\n"):
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    if crlf and crlf >= lf:
        return "\r\n"
    if lf:
        return "\n"
    return default


def read_md_meta(md_dir, raw):
    path = resolve_md_file(md_dir, raw)
    if not path.is_file():
        return {"path": normalize_md_path(raw), "exists": False, "mtime": None, "hash": None}
    with io.open(path, "r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    return {
        "path": normalize_md_path(raw),
        "exists": True,
        "mtime": int(path.stat().st_mtime),
        "hash": text_hash(text),
    }


def save_md(md_dir, raw, content, base_hash=None, force=False):
    """写回源文档：EOL 与现有文件一致、原子替换、可选冲突检测。"""
    path = resolve_md_file(md_dir, raw)
    rel = normalize_md_path(raw)
    if not path.is_file():
        raise MdSaveError(404, "源文件不存在：" + rel)
    if content is None:
        raise MdSaveError(400, "缺少 content")
    with io.open(path, "r", encoding="utf-8", newline="") as handle:
        existing = handle.read()
    current_hash = text_hash(existing)
    if not force and base_hash is not None and base_hash != current_hash:
        raise MdSaveError(
            409,
            "文件已在外部被修改，请重新加载后再保存",
            currentHash=current_hash,
            current=existing,
        )
    eol = detect_eol(existing)
    text = normalize_eol(content)
    if eol != "\n":
        text = text.replace("\n", eol)
    tmp = path.with_name(path.name + ".md2web-save.tmp")
    with io.open(tmp, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(tmp, path)
    return {
        "path": rel,
        "hash": text_hash(content),
        "mtime": int(path.stat().st_mtime),
        "bytes": path.stat().st_size,
    }


class PreviewServer(http.server.ThreadingHTTPServer):
    # Windows 的 SO_REUSEADDR 允许重复绑定同一端口，会掩盖端口占用检测
    allow_reuse_address = os.name != "nt"


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    """静态文件 + /__md/ 源文档读写接口（仅本机）。"""

    def __init__(self, *args, directory=None, md_dir=None, **kwargs):
        self.md_dir = Path(md_dir)
        super().__init__(*args, directory=directory, **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _client_is_local(self):
        return is_loopback_host(self.client_address[0])

    def _handle_md_api(self, method):
        if not self._client_is_local():
            self._send_json(403, {"ok": False, "error": "仅允许本机保存源文档"})
            return
        try:
            if method == "GET":
                params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                meta = read_md_meta(self.md_dir, params.get("path", [""])[0])
                self._send_json(200, dict(meta, ok=True))
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MD_MAX_BODY:
                raise MdSaveError(400, "请求体为空或超过 8 MB 限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise MdSaveError(400, "请求体必须是 JSON 对象")
            result = save_md(
                self.md_dir,
                payload.get("path"),
                payload.get("content"),
                base_hash=payload.get("baseHash"),
                force=bool(payload.get("force")),
            )
            self._send_json(200, dict(result, ok=True))
        except MdSaveError as error:
            self._send_json(error.status, dict(error.extra, ok=False, error=error.message))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "请求体不是有效的 JSON"})
        except OSError as error:
            self._send_json(500, {"ok": False, "error": f"写入失败: {error}"})

    def do_GET(self):
        if self.path.startswith(MD_API_PREFIX):
            self._handle_md_api("GET")
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith(MD_API_PREFIX):
            self._handle_md_api("POST")
            return
        self.send_error(405, "Method Not Allowed")

    def log_message(self, fmt, *args):
        if self.path.startswith(MD_API_PREFIX):
            return
        super().log_message(fmt, *args)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="启动 docs/ 本地预览服务")
    parser.add_argument(
        "--dir", dest="directory", type=Path, default=ROOT / "docs",
        help="要预览的目录，默认脚本同级的 docs/",
    )
    parser.add_argument("--port", type=int, default=3000, help="起始端口，默认 3000（0-65535）")
    parser.add_argument(
        "--bind", default="0.0.0.0",
        help="监听地址，默认 0.0.0.0（局域网可见；仅本机用 127.0.0.1）",
    )
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="不自动重建，直接预览现有产物",
    )
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("端口必须在 0-65535 之间")
    return args


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def needs_rebuild(directory):
    """判断默认 docs/ 目录是否需要重新构建。

    仅当脚本同级存在 setup_docsify.py、预览目录就是默认 docs/ 时生效。
    以下任一情况返回 True：缺少搜索索引；docs/md 的文件集合与索引不一致
    （新增、删除、重命名）；存在比索引更新的 Markdown（内容修改）。
    """
    setup_script = ROOT / "setup_docsify.py"
    docs_dir = (ROOT / "docs").resolve()
    if not setup_script.exists() or Path(directory).resolve() != docs_dir:
        return False
    md_dir = docs_dir / "md"
    if not md_dir.is_dir():
        return False
    index_path = docs_dir / "search-index.json"
    if not index_path.exists():
        return True

    current = set()
    newest_mtime = 0.0
    for path in md_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() != ".md":
            continue
        rel = path.relative_to(md_dir)
        if any(part.startswith(".") for part in rel.parts):
            continue
        current.add(f"/md/{rel.as_posix()}")
        newest_mtime = max(newest_mtime, path.stat().st_mtime)

    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return True
    indexed = {key for key in index if key.startswith("/md/")}
    if current != indexed:
        return True
    return newest_mtime > index_path.stat().st_mtime


def rebuild():
    """调用 setup_docsify.py 重新构建；失败时提示并继续使用现有产物。"""
    print("检测到 docs/md 有更新，正在重新构建...")
    result = subprocess.run(
        [sys.executable, str(ROOT / "setup_docsify.py")], cwd=str(ROOT)
    )
    if result.returncode != 0:
        print("警告: 重新构建失败，将使用现有产物预览。")
    else:
        print("重建完成，请刷新浏览器页面。")


def rebuild_if_needed(directory):
    """检测到 docs/md 变化时重建，返回是否执行了重建。"""
    if not needs_rebuild(directory):
        return False
    rebuild()
    return True


def start_watcher(directory, interval=2.0):
    """后台轮询 docs/md，有变化时自动重建；返回停止事件。"""
    stop_event = threading.Event()

    def run():
        while not stop_event.is_set():
            try:
                rebuild_if_needed(directory)
            except Exception as error:
                print(f"警告: 自动重建检测失败: {error}")
            stop_event.wait(interval)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return stop_event


def find_other_servers():
    """返回其他正在运行的 serve.py 进程 PID 列表（跨平台，仅标准库）。"""
    pids = []
    current = os.getpid()
    if os.name == "nt":
        script = (
            "Get-CimInstance Win32_Process -Filter \"Name like '%python%'\" | "
            "Where-Object { $_.CommandLine -like '*serve.py*' } | "
            "Select-Object -ExpandProperty ProcessId"
        )
        for executable in ("powershell", "pwsh"):
            try:
                result = subprocess.run(
                    [executable, "-NoProfile", "-NonInteractive", "-Command", script],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            except (OSError, subprocess.SubprocessError):
                continue
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.isdigit() and int(line) != current:
                    pids.append(int(line))
            break
        return pids

    proc_dir = Path("/proc")
    if proc_dir.is_dir():
        for entry in proc_dir.iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            if pid == current:
                continue
            try:
                cmdline = (
                    (entry / "cmdline")
                    .read_bytes()
                    .replace(b"\x00", b" ")
                    .decode("utf-8", "ignore")
                )
            except OSError:
                continue
            if "serve.py" in cmdline:
                pids.append(pid)
        return pids

    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,args="],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return pids
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit() and "serve.py" in parts[1]:
            pid = int(parts[0])
            if pid != current:
                pids.append(pid)
    return pids


def stop_other_servers():
    """关闭旧的 serve.py 实例，返回成功关闭的 PID 列表。"""
    stopped = []
    for pid in find_other_servers():
        try:
            os.kill(pid, signal.SIGTERM)
            stopped.append(pid)
        except OSError:
            continue
    if stopped:
        print(f"已关闭旧的预览服务进程: {', '.join(str(pid) for pid in stopped)}")
        time.sleep(0.5)
    return stopped


def make_server(directory, bind, port):
    """从 port 起连续尝试 20 个端口，返回 (server, 实际端口)。"""
    handler = functools.partial(
        PreviewHandler,
        directory=str(directory),
        md_dir=Path(directory) / "md",
    )
    last = min(port + 20, 65536)
    for candidate in range(port, last):
        try:
            server = PreviewServer((bind, candidate), handler)
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise SystemExit(f"错误: 无法监听 {bind}:{candidate} ({error})")
            continue
        return server, server.server_address[1]
    raise SystemExit(f"错误: 端口 {port}-{last - 1} 都被占用")


def main(argv=None):
    args = parse_args(argv)
    directory = args.directory.expanduser().resolve()
    if (ROOT / "setup_docsify.py").exists():
        stop_other_servers()
    stop_watcher = None
    if not args.no_build and (ROOT / "setup_docsify.py").exists():
        rebuild_if_needed(directory)
        stop_watcher = start_watcher(directory)
        print("已开启自动重建：docs/md 有新增/删除/修改时会自动重建（每 2 秒检测）")
    if not (directory / "index.html").exists():
        raise SystemExit(f"错误: {directory} 下没有 index.html，请先运行 python setup_docsify.py")
    server, port = make_server(directory, args.bind, args.port)
    print(f"预览目录: {directory}")
    print(f"本机访问: http://localhost:{port}")
    print("编辑保存: 已启用（仅本机页面可写回 docs/md 源文件）")
    ip = lan_ip()
    if ip and args.bind == "0.0.0.0":
        print(f"局域网访问: http://{ip}:{port}")
    print("按 Ctrl+C 停止")
    if not args.no_browser:
        timer = threading.Timer(0.5, webbrowser.open, args=(f"http://localhost:{port}",))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        if stop_watcher is not None:
            stop_watcher.set()
        server.server_close()


if __name__ == "__main__":
    main()
