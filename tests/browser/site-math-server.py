"""Serve a server-only entry with intentionally stale asset versions."""
import json
import os
import re
import shutil
import sys
import threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_plan_integration import PlanIntegrationTests
from waitress import create_server

fixture = PlanIntegrationTests()
fixture.setUp()
try:
    root = Path(__file__).resolve().parents[2]
    shutil.copytree(str(root / 'docs/lib'), str(fixture.docs / 'lib'))
    for name in ('_sidebar.md', 'search-index.json'):
        shutil.copyfile(str(root / 'docs/html' / name), str(fixture.docs / 'html' / name))
    html = (root / 'docs/html/index_all.html').read_text(encoding='utf-8')
    html = re.sub(r'(lib/(?:math-init|md-editor)\.js)\?v=[a-z0-9]+', r'\1?v=stale', html)
    # Existing deployed repository pages cannot reference newly introduced files.
    html = re.sub(r'\s*<script src="lib/page-copy\.js[^"<>]*"></script>', '', html)
    page = fixture.docs / 'html/index_server_only.html'
    page.write_text(html, encoding='utf-8')
    (fixture.docs / 'md/old/math.md').write_text(os.environ['MD2WEB_MATH_SOURCE'], encoding='utf-8')
    server = create_server(fixture.app, host='127.0.0.1', port=0, threads=4)
    thread = threading.Thread(target=server.run)
    thread.daemon = True
    thread.start()
    print(json.dumps({'url': 'http://127.0.0.1:' + str(server.effective_port)}))
    sys.stdout.flush()
    sys.stdin.readline()
    assert page.read_text(encoding='utf-8') == html, 'serving must not rewrite repository pages'
    server.close()
    server.task_dispatcher.shutdown()
finally:
    fixture.tearDown()
