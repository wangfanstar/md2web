"""Isolated real HTTP fixture for home search and source browser regressions."""
import json
import sys
import threading
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_plan_integration import PlanIntegrationTests
from waitress import create_server

fixture = PlanIntegrationTests()
fixture.setUp()
try:
    root = Path(__file__).resolve().parents[2]
    (fixture.docs / 'html').mkdir(exist_ok=True)
    (fixture.docs / 'lib').mkdir(exist_ok=True)
    for name in ('index.html', 'html/reference_code.html'):
        (fixture.docs / name).write_bytes((root / 'docs' / name).read_bytes())
    for name in ('home.css', 'home-search.js', 'home-repositories.js', 'auth.js', 'auth.css',
                 'ai-assistant.js', 'ai-assistant.css', 'ai-retrieval.js', 'purify.min.js',
                 'marked.min.js', 'sanitize.js', 'md2web-feedback.js', 'reference-code.js', 'reference-code.css'):
        (fixture.docs / 'lib' / name).write_bytes((root / 'docs/lib' / name).read_bytes())
    (fixture.docs / 'html/search-index.json').write_text(json.dumps({
        '/md/old/main.md': {'entry': {'title': 'main', 'body': 'main source example', 'route': '/md/old/main.md'}}
    }), encoding='utf-8')
    code = fixture.docs / 'code' / 'project' / 'trunk' / 'src' / 'nested'
    code.mkdir(parents=True)
    (code / 'main.c').write_text('/* source example */\nint main(void) {\n    return 42;\n}\n', encoding='utf-8')
    fixture.config['ai']['claude'] = {'enabled': True, 'repositories': [
        {'id': 'project', 'folder': 'project/trunk', 'name': 'trunk'}]}

    def answer(docs, ai, payload, cancel=None, on_delta=None, on_progress=None):
        on_progress({'kind': 'scope', 'directories': payload.get('codeFolders') or ['md']})
        on_delta('First streamed paragraph')
        time.sleep(0.7)
        if cancel.is_set():
            raise ValueError('cancelled')
        return {'answer': 'First streamed paragraph\n\n**Completed answer**', 'documentFolders': ['md'], 'model': payload.get('model', '')}

    with mock.patch('server.code_qa.answer', side_effect=answer):
        server = create_server(fixture.app, host='127.0.0.1', port=0, threads=8)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        print(json.dumps({'url': 'http://127.0.0.1:' + str(server.effective_port)}))
        sys.stdout.flush()
        sys.stdin.readline()
        server.close()
        server.task_dispatcher.shutdown()
finally:
    fixture.tearDown()
