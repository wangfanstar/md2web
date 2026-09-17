"""跨平台预览 / 认证编辑服务入口。

- 默认启动**认证编辑服务**（Flask + Waitress，Python 3.6.8+ 同一套依赖 server/requirements.txt），
  地址与端口取 `--config`（默认 config/server.local.json）：匿名只读，登录后可编辑草稿并提交 SVN。
- `--preview`：只读预览。静态站点、自动重建与本机 AI 代理可用，写接口一律拒绝。
- 监听地址：`--bind` 优先；认证服务其次取配置 server.bind（默认 127.0.0.1），预览默认 0.0.0.0。
- 只管理本项目自身的实例（pidfile），不再扫描并终止所有 serve.py 进程。
"""

import argparse
import errno
import functools
import http.server
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from server.paths import is_blocked_static_path

ROOT = Path(__file__).parent
AI_API_PREFIX = "/__ai/"
AI_MAX_BODY = 4 * 1024 * 1024
AI_HOP_HEADERS = {"host", "content-length", "connection", "transfer-encoding", "accept-encoding", "content-type"}
WRITE_PREFIXES = ("/__md/", "/__svn/", "/__operations/")
DEFAULT_PIDFILE = ROOT / "data" / "serve.pid"


if hasattr(http.server, "ThreadingHTTPServer"):
    _ThreadingHTTPServer = http.server.ThreadingHTTPServer
else:  # Python 3.6 及更早版本没有 ThreadingHTTPServer
    import socketserver

    class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True


class PreviewServer(_ThreadingHTTPServer):
    # Windows 的 SO_REUSEADDR 允许重复绑定同一端口，会掩盖端口占用检测
    allow_reuse_address = os.name != "nt"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="启动 docs/ 预览或认证编辑服务")
    parser.add_argument(
        "--dir", dest="directory", type=Path, default=ROOT / "docs",
        help="要预览的目录，默认脚本同级的 docs/",
    )
    parser.add_argument("--port", type=int, default=8882, help="起始端口，默认 8882（0-65535）")
    parser.add_argument(
        "--bind", default=None,
        help="监听地址：认证服务默认取配置 server.bind（默认 127.0.0.1），预览默认 0.0.0.0；局域网访问用 0.0.0.0",
    )
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="不自动重建，直接预览现有产物",
    )
    parser.add_argument(
        "--config", type=Path, default=ROOT / "config" / "server.local.json",
        help="认证编辑服务配置（JSON），默认 config/server.local.json（缺失会自动生成）",
    )
    parser.add_argument(
        "--preview", action="store_true",
        help="只读预览模式（静态站点 + 自动重建 + 本机 AI 代理，写接口一律拒绝）",
    )
    parser.add_argument(
        "--pidfile", type=Path, default=DEFAULT_PIDFILE,
        help="记录本服务实例的 PID 文件，默认 data/serve.pid",
    )
    parser.add_argument(
        "--reset-admin-password", action="store_true",
        help="把本机管理员密码强制恢复为默认 admin（忘记密码时使用；会写入数据库并继续启动服务）",
    )
    parser.add_argument(
        "--svn-command", default=None,
        help="svn 可执行文件（可含参数，如 \"C:/Program Files/.../svn.exe\"）；默认使用 PATH 中的 svn",
    )
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("端口必须在 0-65535 之间")
    return args


# ---- 实例管理（只处理本项目自身实例） ----


def read_pidfile(path):
    try:
        text = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None


def write_pidfile(path, pid):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(str(pid), encoding="utf-8")
    return target


def remove_pidfile(path):
    try:
        Path(path).unlink()
    except OSError:
        pass


def process_is_project_serve(pid):
    """判断 PID 是否为本项目 serve.py 进程（跨平台）。"""
    if os.name == "nt":
        script = (
            f"Get-CimInstance Win32_Process -Filter \"ProcessId = {int(pid)}\" | "
            "Select-Object -ExpandProperty CommandLine"
        )
        for executable in ("powershell", "pwsh"):
            try:
                result = subprocess.run(
                    [executable, "-NoProfile", "-NonInteractive", "-Command", script],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                    timeout=15,
                )
            except (OSError, subprocess.SubprocessError):
                continue
            text = (result.stdout or "").strip()
            return bool(text) and "serve.py" in text and str(ROOT) in text
        return False
    try:
        cmdline = Path(f"/proc/{int(pid)}/cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", "ignore")
    except OSError:
        return False
    return "serve.py" in cmdline and str(ROOT) in cmdline


def default_terminate(pid):
    os.kill(int(pid), signal.SIGTERM)


def manage_instance(pidfile, is_ours=None, terminate=None, log=print):
    """按 pidfile 停止旧的自身实例；不属于本项目则跳过并清理 PID 文件。"""
    pid = read_pidfile(pidfile)
    if pid is None or pid == os.getpid():
        return False
    matcher = is_ours or process_is_project_serve
    killer = terminate or default_terminate
    if matcher(pid):
        try:
            killer(pid)
            log(f"已停止旧的自身实例: PID {pid}")
        except OSError:
            pass
        remove_pidfile(pidfile)
        time.sleep(0.3)
        return True
    log(f"PID 文件记录的进程 {pid} 不属于本服务，跳过终止")
    remove_pidfile(pidfile)
    return False


# ---- 构建与自动重建 ----


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


# ---- 本机 AI 代理（保留，仅 loopback 可用） ----


def split_command(value):
    """拆分 --svn-command：Windows 下保留反斜杠，并支持用双引号包住带空格的路径。"""
    text = str(value or "").strip()
    if not text:
        return ()
    if os.name != "nt":
        return tuple(shlex.split(text))
    parts = []
    current = ""
    quoted = False
    for char in text:
        if char == '"':
            quoted = not quoted
            continue
        if char == " " and not quoted:
            if current:
                parts.append(current)
                current = ""
            continue
        current += char
    if current:
        parts.append(current)
    return tuple(parts)


def is_loopback_host(host):
    host = str(host or "")
    return host in ("::1", "localhost") or host.startswith("127.")


def ai_target_url(raw):
    """校验 AI 接口地址（仅允许 http/https），非法时抛 ValueError。"""
    value = str(raw or "").strip()
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("AI 接口地址必须是 http/https URL")
    return value


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    """只读预览：静态文件 + 本机 AI 代理；写接口一律拒绝。

    Python 3.6 的 SimpleHTTPRequestHandler 不支持 directory 参数，
    这里用 translate_path 兼容（3.7+ 走原生实现）。
    """

    def __init__(self, *args, **kwargs):
        directory = kwargs.pop("directory", None)
        self._directory = Path(directory) if directory else None
        if sys.version_info >= (3, 7):
            super().__init__(*args, directory=directory, **kwargs)
        else:
            super().__init__(*args, **kwargs)

    def translate_path(self, path):
        if sys.version_info >= (3, 7) or self._directory is None:
            return super().translate_path(path)
        # 复刻 3.6 实现，只把根目录替换为指定目录
        import posixpath

        path = path.split("?", 1)[0].split("#", 1)[0]
        path = posixpath.normpath(urllib.parse.unquote(path))
        words = [word for word in path.split("/") if word]
        resolved = str(self._directory)
        for word in words:
            drive, word = os.path.splitdrive(word)
            head, word = os.path.split(word)
            if word in (os.curdir, os.pardir):
                continue
            resolved = os.path.join(resolved, word)
        return resolved

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

    def do_GET(self):
        rel = urllib.parse.unquote(urllib.parse.urlparse(self.path).path).lstrip("/")
        if rel and is_blocked_static_path(rel):
            self.send_error(404, "Not Found")
            return
        if rel == "":
            self.path = "/index.html"
        elif rel.endswith("/"):
            self.send_error(404, "Not Found")
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith(AI_API_PREFIX):
            self._handle_ai_api()
            return
        if self.path.startswith(WRITE_PREFIXES):
            self._send_json(403, {
                "ok": False,
                "code": "read_only_preview",
                "error": "只读预览：写接口已停用，请使用 --config 启动认证编辑服务",
            })
            return
        self.send_error(405, "Method Not Allowed")

    def _handle_ai_api(self):
        """把浏览器请求转发到用户配置的 AI 接口（解决跨域，仅本机调用）。"""
        if not self._client_is_local():
            self._send_json(403, {"ok": False, "error": "AI 代理仅允许本机调用"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > AI_MAX_BODY:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("请求体必须是 JSON 对象")
            target = ai_target_url(payload.get("url"))
            body = json.dumps(payload.get("payload") or {}, ensure_ascii=False).encode("utf-8")
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "User-Agent": "md2web-ai-proxy",
            }
            api_key = payload.get("apiKey")
            if api_key:
                headers["Authorization"] = "Bearer " + str(api_key)
            for name, value in (payload.get("headers") or {}).items():
                if isinstance(value, str) and name.lower() not in AI_HOP_HEADERS:
                    headers[name] = value
            request = urllib.request.Request(target, data=body, headers=headers, method="POST")
            self.close_connection = True
            try:
                upstream = urllib.request.urlopen(request, timeout=180)
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")
                self._send_json(error.code, {"ok": False, "error": detail[:4000]})
                return
            except (urllib.error.URLError, OSError) as error:
                self._send_json(502, {"ok": False, "error": f"无法访问 AI 接口: {error}"})
                return
            with upstream:
                self.send_response(200)
                self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                while True:
                    chunk = upstream.read(2048)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except ValueError as error:
            self._send_json(400, {"ok": False, "error": str(error)})
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "请求体不是有效的 JSON"})

    def log_message(self, fmt, *args):
        if self.path.startswith(AI_API_PREFIX):
            return
        super().log_message(fmt, *args)


def resolve_bind(cli_bind, config_bind=None):
    """监听地址：命令行优先，其次配置文件（认证服务），最后 0.0.0.0（预览）。"""
    value = cli_bind if cli_bind else config_bind
    value = str(value or "").strip()
    return value or "0.0.0.0"


def _is_usable_ipv4(address):
    return bool(address) and not address.startswith("127.") and address != "0.0.0.0"


def local_ipv4_addresses():
    """本机局域网 IPv4 列表（不发起真实网络流量）。"""
    addresses = []
    try:
        for address in socket.gethostbyname_ex(socket.gethostname())[2]:
            if _is_usable_ipv4(address):
                addresses.append(address)
    except (OSError, socket.error):
        pass
    if not addresses:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("10.255.255.255", 1))
            address = probe.getsockname()[0]
            if _is_usable_ipv4(address):
                addresses.append(address)
        except (OSError, socket.error):
            pass
        finally:
            probe.close()
    return sorted(set(addresses))


def access_urls(bind, port):
    """返回 (本机地址, 其他可访问地址)：0.0.0.0 时给出局域网 IP。"""
    local = "http://localhost:%d" % port
    others = []
    if is_loopback_host(bind):
        return local, others
    if bind in ("0.0.0.0", "::", "*"):
        for address in local_ipv4_addresses():
            others.append("http://%s:%d" % (address, port))
    else:
        others.append("http://%s:%d" % (bind, port))
    return local, others


def print_access_hints(bind, port):
    """打印可访问地址；局域网监听时给出放行端口命令，本机监听时提示如何开放。"""
    local, others = access_urls(bind, port)
    print("本机访问: " + local)
    for url in others:
        print("局域网访问: " + url)
    if others:
        print("  若局域网打不开：确认服务器防火墙已放行端口，例如")
        print("    RHEL/CentOS 7（root）: sudo firewall-cmd --add-port=%d/tcp --permanent && sudo firewall-cmd --reload" % port)
        print("    Ubuntu/Debian: sudo ufw allow %d/tcp" % port)
    elif is_loopback_host(bind):
        print("当前仅本机可访问；需要局域网访问请加 --bind 0.0.0.0（或修改配置 server.bind）")


def make_server(directory, bind, port):
    """从 port 起连续尝试 20 个端口，返回 (server, 实际端口)。"""
    handler = functools.partial(PreviewHandler, directory=str(directory))
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


# ---- 认证编辑服务 ----


def run_authenticated_service(args, directory):
    """按配置启动 Flask + Waitress 认证编辑服务。"""
    try:
        from server import database
        from server.app import create_app
        from server.auth import AuthService
        from server.config import ConfigError, default_config, load_config, save_config
        from server.svn import SvnClient
        from waitress import serve as waitress_serve
    except (ModuleNotFoundError, ImportError) as error:
        print("警告: 未安装认证编辑服务依赖（缺少 " + str(error.name) + "），已降级为只读预览。")
        print("  当前解释器: Python " + ".".join(str(v) for v in sys.version_info[:3]))
        print("  离线安装（推荐）: python3 -m pip install --user --no-index --find-links server/wheels -r server/requirements.txt")
        print("  联网安装: python3 -m pip install --user -r server/requirements.txt")
        print("  系统目录权限不足时加 --user；必要时用 sudo；pip 过旧先执行: python3 -m pip install --user --upgrade \"pip<22\"")
        args.preview = True
        return None

    config_path = Path(args.config)
    if not config_path.exists():
        try:
            save_config(config_path, default_config(), directory)
        except ConfigError as error:
            raise SystemExit(f"错误: {error}")
        print(f"已生成默认配置: {config_path}（SVN 认证路径与仓库映射可在网页「设置」中填写）")
    try:
        config = load_config(config_path, directory, allow_incomplete=True)
    except ConfigError as error:
        raise SystemExit(f"错误: {error}")

    database_path = config["storage"]["database"]
    workspaces = config["storage"]["workspaces"]
    workspaces.mkdir(parents=True, exist_ok=True)
    conn = database.connect(database_path)
    database.migrate(conn)
    if database.ensure_admin(conn):
        print("已创建默认管理员账号: admin / admin（请在网页「设置」中尽快修改密码）")
    if args.reset_admin_password:
        reset_user = database.reset_admin_password(conn)
        if reset_user is None:
            database.ensure_admin(conn)
            reset_user = database.reset_admin_password(conn)
        print(f"已强制恢复管理员密码: {reset_user or 'admin'} / admin（请登录后立即修改）")

    svn_client = SvnClient(command=split_command(args.svn_command) if args.svn_command else ("svn",))
    auth_service = AuthService(conn, svn_client, config)
    auth_service.on_startup()
    if auth_service.auth_source_changed():
        auth_service.revoke_all("auth_source_changed")

    docs_dir = directory if (directory / "index.html").exists() else ROOT / "docs"
    app = create_app(config, conn, auth_service, docs_dir)

    stop_watcher = None
    if not args.no_build and (ROOT / "setup_docsify.py").exists():
        rebuild_if_needed(docs_dir)
        stop_watcher = start_watcher(docs_dir)
        print("已开启自动重建：docs/md 有变化时自动重建（每 2 秒检测）")

    bind = resolve_bind(args.bind, config["server"]["bind"])
    port = config["server"]["port"]
    print(f"认证编辑服务: http://{bind}:{port}")
    print_access_hints(bind, port)
    if config["auth"]["url"]:
        print(f"SVN 认证地址: {config['auth']['url']}")
    else:
        print("SVN 认证地址: 未配置（请在网页右上角/侧栏「设置」中用 admin 登录后填写）")
    print(f"数据库: {database_path}")
    print(f"工作副本目录: {workspaces}")
    print("匿名可阅读；写接口要求 SVN 账号登录（阶段一实现登录边界）")
    if not args.no_browser:
        timer = threading.Timer(0.5, webbrowser.open, args=(f"http://127.0.0.1:{port}",))
        timer.daemon = True
        timer.start()
    try:
        waitress_serve(app, host=bind, port=port, threads=8)
    except KeyboardInterrupt:
        print("\n已停止")
    except OSError as error:
        if getattr(error, "errno", None) in (errno.EADDRINUSE, 10048):
            print("错误: 端口 " + str(port) + " 已被占用（可能有另一个服务实例在运行）。")
            print("  请关闭占用该端口的程序，或修改配置中的 server.port；"
                  "重复启动本脚本时会先按 pidfile 关闭自己的旧实例。")
        else:
            print("错误: 无法在 " + bind + ":" + str(port) + " 启动服务: " + str(error))
    finally:
        if stop_watcher is not None:
            stop_watcher.set()
        conn.close()


def main(argv=None):
    if sys.version_info < (3, 6):
        raise SystemExit("错误: 需要 Python 3.6 及以上（当前 "
                         + ".".join(str(v) for v in sys.version_info[:3]) + "）")
    args = parse_args(argv)
    directory = args.directory.expanduser().resolve()
    if not (directory / "index.html").exists():
        raise SystemExit(f"错误: {directory} 下没有 index.html，请先运行 python setup_docsify.py")

    print("Python: " + sys.version.split()[0] + " (" + sys.executable + ")")

    manage_instance(args.pidfile)
    write_pidfile(args.pidfile, os.getpid())

    if not args.preview:
        run_authenticated_service(args, directory)
        if not args.preview:
            remove_pidfile(args.pidfile)
            return
        print("已切换到只读预览模式。")

    if (ROOT / "setup_docsify.py").exists() and not args.no_build:
        rebuild_if_needed(directory)
        stop_watcher = start_watcher(directory)
        print("已开启自动重建：docs/md 有新增/删除/修改时会自动重建（每 2 秒检测）")
    else:
        stop_watcher = None

    bind = resolve_bind(args.bind)
    server, port = make_server(directory, bind, args.port)
    print(f"预览目录: {directory}")
    print_access_hints(bind, port)
    print("模式: 只读预览（写接口已停用；认证编辑去掉 --preview 即可）")
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
        remove_pidfile(args.pidfile)


if __name__ == "__main__":
    main()
