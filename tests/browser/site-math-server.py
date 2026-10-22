"""Serve a server-only entry with intentionally stale asset versions."""
import json
import os
import re
import shutil
import sys
import threading
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_plan_integration import PlanIntegrationTests
from waitress import create_server
import serve

fixture = PlanIntegrationTests()
fixture.setUp()
try:
    root = Path(__file__).resolve().parents[2]
    shutil.copyfile(str(root / 'docs/index.html'), str(fixture.docs / 'index.html'))
    shutil.copytree(str(root / 'docs/lib'), str(fixture.docs / 'lib'))
    if os.environ.get('MD2WEB_STALE_FRONTEND'):
        (fixture.tmp / 'web').mkdir()
        for name in ('workspace.js', 'page-export.js', 'auth.js'):
            shutil.copyfile(str(root / 'web' / name), str(fixture.tmp / 'web' / name))
            (fixture.docs / 'lib' / name).write_bytes(b'/* stale deployed asset */')
        with mock.patch.object(serve, 'ROOT', fixture.tmp):
            assert len(serve.sync_frontend_assets(fixture.docs)) == 3
    for name in ('_sidebar.md', 'search-index.json'):
        shutil.copyfile(str(root / 'docs/html' / name), str(fixture.docs / 'html' / name))
    html = (root / 'docs/html/index_all.html').read_text(encoding='utf-8')
    html = re.sub(r'(lib/(?:math-init|md-editor)\.js)\?v=[a-z0-9]+', r'\1?v=stale', html)
    # Existing deployed repository pages cannot reference newly introduced files.
    html = re.sub(r'\s*<script src="lib/page-copy\.js[^"<>]*"></script>', '', html)
    page = fixture.docs / 'html/index_server_only.html'
    page.write_text(html, encoding='utf-8')
    (fixture.docs / 'md/old/math.md').write_text(os.environ['MD2WEB_MATH_SOURCE'], encoding='utf-8')
    if os.environ.get('MD2WEB_INTERNAL_FILES'):
        (fixture.docs / 'pdf').mkdir(exist_ok=True)
        (fixture.docs / 'pdf/协议 #1.pdf').write_bytes(b'%PDF-1.4 fixture')
        (fixture.docs / 'html/internal-report.html').write_text('<h1>Internal report</h1>', encoding='utf-8')
    if os.environ.get('MD2WEB_LINK_TARGETS'):
        from setup_docsify import build_page_index
        content = '# 中文链接文档\n\n## 重复标题\n\nFirst\n\n## 重复标题\n\nSecond'
        (fixture.docs / 'md/old/中文文档.md').write_text(content, encoding='utf-8')
        route = '/md/old/中文文档.md'
        entries = build_page_index(route, content, 6, '中文链接文档')
        entries['site'] = 'html/index_server_only.html'
        (fixture.docs / 'html/search-index.json').write_text(json.dumps({route: entries}), encoding='utf-8')
    server = create_server(fixture.app, host='127.0.0.1', port=0, threads=4)
    thread = threading.Thread(target=server.run)
    thread.daemon = True
    thread.start()
    print(json.dumps({'url': 'http://127.0.0.1:' + str(server.effective_port)}))
    sys.stdout.flush()
    for command in sys.stdin:
        if command.strip() == 'restart-auth':
            fixture.auth.on_startup()
            print(json.dumps({'reset': True}))
            sys.stdout.flush()
        else:
            break
    assert page.read_text(encoding='utf-8') == html, 'serving must not rewrite repository pages'
    server.close()
    server.task_dispatcher.shutdown()
finally:
    fixture.tearDown()
