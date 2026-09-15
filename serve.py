"""跨平台本地预览服务器：python serve.py [--port 3000] [--no-browser]"""

import argparse
import errno
import functools
import http.server
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent


class PreviewServer(http.server.ThreadingHTTPServer):
    # Windows 的 SO_REUSEADDR 允许重复绑定同一端口，会掩盖端口占用检测
    allow_reuse_address = os.name != "nt"


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

    仅当脚本同级存在 setup_docsify.py、预览目录就是默认 docs/、
    且 docs/md 下有比 search-index.json 更新的 Markdown 时返回 True。
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
    index_mtime = index_path.stat().st_mtime
    for path in md_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() != ".md":
            continue
        rel = path.relative_to(md_dir)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if path.stat().st_mtime > index_mtime:
            return True
    return False


def rebuild():
    """调用 setup_docsify.py 重新构建；失败时提示并继续使用现有产物。"""
    print("检测到 docs/md 有更新，正在重新构建...")
    result = subprocess.run(
        [sys.executable, str(ROOT / "setup_docsify.py")], cwd=str(ROOT)
    )
    if result.returncode != 0:
        print("警告: 重新构建失败，将使用现有产物预览。")


def make_server(directory, bind, port):
    """从 port 起连续尝试 20 个端口，返回 (server, 实际端口)。"""
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(directory)
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
    if not args.no_build and needs_rebuild(directory):
        rebuild()
    if not (directory / "index.html").exists():
        raise SystemExit(f"错误: {directory} 下没有 index.html，请先运行 python setup_docsify.py")
    server, port = make_server(directory, args.bind, args.port)
    print(f"预览目录: {directory}")
    print(f"本机访问: http://localhost:{port}")
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
        server.server_close()


if __name__ == "__main__":
    main()
