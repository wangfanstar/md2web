import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server import code_qa
from tests import test_server


class CodeQaTests(unittest.TestCase):
    def setUp(self):
        self.f = test_server.AppTests()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.settings = {'enabled': True, 'defaultRepository': 'a', 'repositories': [
            {'id': 'a', 'folder': 'a', 'url': 'https://svn.example.com/a', 'revision': '12'}]}
        self.f.config['ai']['claude'] = self.settings
        self.f.config['ai']['baseUrl'] = 'http://127.0.0.1:8787'
        self.path = self.f.docs / 'code' / 'a'
        self.path.mkdir(parents=True)
        (self.path / '.md2web-revision').write_text('12', encoding='utf-8')
        (self.path / 'main.py').write_text('def frobnicate():\n    return 42\n', encoding='utf-8')

    def test_public_permissions_secrets_and_retired_config(self):
        f = self.f
        self.assertEqual(f.client.get('/__ai/public').status_code, 401)
        csrf = f.login()
        f.config['ai']['apiKey'] = 'never-publish-me'
        self.assertNotIn('never-publish-me', f.client.get('/__auth/session').get_data(as_text=True))
        public = f.client.get('/__ai/public').get_json()
        self.assertEqual(public['repositories'][0]['revision'], '12')
        self.assertNotIn('url', public['repositories'][0])
        self.assertEqual(f.client.put('/__admin/ai', json={}, headers={'X-CSRF-Token': csrf}).status_code, 403)
        self.assertEqual(f.client.post('/__ai/chat', json={}).status_code, 403)
        self.assertEqual(f.client.get('/code/a/main.py').status_code, 404)
        self.assertEqual(f.client.post('/__ai/chat', json={'path': '/etc'}, headers={'X-CSRF-Token': csrf}).status_code, 400)

    def test_real_retrieval_and_tool_free_process(self):
        process = mock.Mock(returncode=0)
        process.poll.return_value = 0
        process.communicate.return_value = (json.dumps({'result': '42'}).encode('utf-8'), b'')
        with mock.patch('server.code_qa.subprocess.Popen', return_value=process) as launch:
            data = code_qa.answer(self.f.docs, self.f.config['ai'], {'messages': [{'role': 'user', 'content': 'frobnicate'}]})
        self.assertEqual(data['revision'], '12')
        self.assertEqual(data['sources'], ['main.py'])
        self.assertEqual(data['answer'], '42')
        self.assertIn(b'return 42', process.communicate.call_args[0][0])
        args = launch.call_args[0][0]
        self.assertEqual(args[args.index('--tools') + 1], '')
        self.assertNotIn('--dangerously-skip-permissions', args)
        self.assertEqual(launch.call_args[1]['cwd'], str(self.f.docs.resolve()))

    def test_cancel_terminates_process(self):
        import threading
        cancel = threading.Event()
        cancel.set()
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch('server.code_qa.subprocess.Popen', return_value=process), mock.patch('server.code_qa.terminate') as stop:
            with self.assertRaises(ValueError):
                code_qa.answer(self.f.docs, self.f.config['ai'], {'messages': [{'role': 'user', 'content': 'frobnicate'}]}, cancel)
        stop.assert_called_once_with(process)

    def test_private_files_and_path_validation(self):
        (self.path / '.env').write_text('frobnicate secret', encoding='utf-8')
        (self.path / 'credentials.json').write_text('frobnicate secret', encoding='utf-8')
        content, sources = code_qa.retrieve(self.path, 'frobnicate')
        self.assertNotIn('secret', content)
        self.assertEqual(sources, ['main.py'])
        for field, value in [('folder', '../escape'), ('id', ''), ('revision', '-1'), ('url', 'file:///etc')]:
            settings = json.loads(json.dumps(self.settings))
            settings['repositories'][0][field] = value
            with self.assertRaises(ValueError):
                code_qa.validate(settings)
        with self.assertRaises(ValueError):
            code_qa.repository(self.settings, 'unknown')

    def test_busy_returns_without_launch(self):
        f = self.f
        csrf = f.login()
        code_qa.LOCK.acquire()
        try:
            self.assertEqual(f.client.post('/__ai/chat', json={'messages': []}, headers={'X-CSRF-Token': csrf}).status_code, 429)
        finally:
            code_qa.LOCK.release()

    def test_sse_completes_and_releases_lock(self):
        f = self.f
        csrf = f.login()
        with mock.patch('server.code_qa.answer', return_value={'answer': 'ok', 'revision': '12'}):
            response = f.client.post('/__ai/chat', json={'messages': [{'role': 'user', 'content': 'test'}]},
                                     headers={'X-CSRF-Token': csrf})
            body = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('event: start', body)
        self.assertIn('event: complete', body)
        self.assertFalse(code_qa.LOCK.locked())

    def test_sync_pins_revision_and_preserves_old_version_on_failure(self):
        f = self.f
        test_server.server_database.ensure_admin(f.conn)
        login = f.client.post('/__auth/login', json={'username': 'admin', 'password': 'admin', 'mode': 'admin'})
        headers = {'X-CSRF-Token': login.get_json()['csrfToken']}
        def export(url, target, **kwargs):
            self.assertEqual(kwargs['revision'], '12')
            target.mkdir()
            (target / 'new.c').write_text('updated', encoding='utf-8')
        with mock.patch.object(f.svn, 'info', return_value={'revision': '99'}), mock.patch.object(f.svn, 'export', side_effect=export, create=True):
            response = f.client.post('/__admin/code-repositories/a/sync', json={}, headers=headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual((self.path / '.md2web-revision').read_text(encoding='utf-8'), '12')
        with mock.patch.object(f.svn, 'info', side_effect=ValueError('failed')):
            response = f.client.post('/__admin/code-repositories/a/sync', json={}, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual((self.path / 'new.c').read_text(encoding='utf-8'), 'updated')
