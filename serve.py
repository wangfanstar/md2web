"""跨平台本地预览服务器：python serve.py [--port 3000] [--no-browser]"""

import argparse
import functools
import http.server
import socket
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="启动 docs/ 本地预览服务")
    parser.add_argument(
        "--dir", dest="directory", type=Path, default=ROOT / "docs",
        help="要预览的目录，默认脚本同级的 docs/",
    )
    parser.add_argument("--port", type=int, default=3000, help="起始端口，默认 3000")
    parser.add_argument("--bind", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    return parser.parse_args(argv)


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def make_server(directory, bind, port):
    """在 port 起连续尝试 20 个端口，返回 (server, 实际端口)。"""
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(directory)
    )
    for candidate in range(port, port + 20):
        try:
            server = http.server.ThreadingHTTPServer((bind, candidate), handler)
        except OSError:
            continue
        return server, server.server_address[1]
    raise SystemExit(f"错误: 端口 {port}-{port + 19} 都被占用")


def main(argv=None):
    args = parse_args(argv)
    directory = args.directory.expanduser().resolve()
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
        threading.Timer(0.5, webbrowser.open, args=(f"http://localhost:{port}",)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
