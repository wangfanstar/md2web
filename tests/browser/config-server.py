"""Isolated authenticated fixture for the configuration browser regression."""
import json
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
    (fixture.docs / 'html').mkdir(exist_ok=True)
    (fixture.docs / 'lib').mkdir(exist_ok=True)
    (fixture.docs / 'html/md2web_config.html').write_bytes((root / 'web/md2web_config.html').read_bytes())
    for name in ('auth.js','auth.css','md2web-feedback.js','md2web-config.js','md2web-config.css','config-layout.js','config-draft.js'):
        (fixture.docs / 'lib' / name).write_bytes((root / 'web' / name).read_bytes())
    server = create_server(fixture.app, host='127.0.0.1', port=0, threads=8)
    thread = threading.Thread(target=server.run)
    thread.daemon = True
    thread.start()
    print(json.dumps({'url': 'http://127.0.0.1:' + str(server.effective_port)}))
    sys.stdout.flush()
    sys.stdin.readline()
    server.close()
    server.task_dispatcher.shutdown()
finally:
    fixture.tearDown()
