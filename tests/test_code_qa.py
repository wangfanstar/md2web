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
            data = code_qa.answer(self.f.docs, self.f.config['ai'], {'messages': [{'role': 'user', 'content': 'frobnicate'}], 'codeRepositoryId': 'a'})
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

    def fake_process(self):
        process = mock.Mock(returncode=0)
        process.poll.return_value = 0
        process.communicate.return_value = (b'{"result":"ok"}', b'')
        return process

    def test_default_scope_is_all_md_without_legacy_default_code(self):
        (self.f.docs / 'md' / 'guide.md').write_text('frobnicate document-only', encoding='utf-8')
        process = self.fake_process()
        with mock.patch('server.code_qa.subprocess.Popen', return_value=process):
            data = code_qa.answer(self.f.docs, self.f.config['ai'], {'messages': [{'role': 'user', 'content': 'frobnicate'}]})
        prompt = process.communicate.call_args[0][0].decode('utf-8')
        self.assertIn('document-only', prompt)
        self.assertNotIn('return 42', prompt)
        self.assertEqual(data['repository'], '')
        self.assertEqual(data['documentFolders'], ['md'])
        self.assertIn('md/guide.md', data['documentSources'])

    def test_selected_extra_folder_excludes_unselected_md_and_code(self):
        (self.f.docs / 'md' / 'guide.md').write_text('frobnicate excluded-default', encoding='utf-8')
        extra = self.f.docs / 'manuals'
        extra.mkdir()
        (extra / 'guide.txt').write_text('frobnicate selected-manual', encoding='utf-8')
        self.settings['documentFolders'] = ['md', 'manuals']
        payload = {'messages': [{'role': 'user', 'content': 'frobnicate'}], 'documentFolders': ['manuals']}
        process = self.fake_process()
        with mock.patch('server.code_qa.subprocess.Popen', return_value=process):
            data = code_qa.answer(self.f.docs, self.f.config['ai'], payload)
        prompt = process.communicate.call_args[0][0].decode('utf-8')
        self.assertIn('selected-manual', prompt)
        self.assertNotIn('excluded-default', prompt)
        self.assertNotIn('return 42', prompt)
        self.assertEqual(data['documentSources'], ['manuals/guide.txt'])
        for folder in ('../private', 'code', 'html', 'unconfigured'):
            payload['documentFolders'] = [folder]
            with self.assertRaises(ValueError):
                code_qa.answer(self.f.docs, self.f.config['ai'], payload)

    def test_local_version_and_configurable_code_subfolder(self):
        self.settings.update(codeFolder='code/versions', repositories=[{'id': 'local', 'folder': '项目/v1'}])
        self.settings['defaultRepository'] = ''
        local = self.f.docs / 'code/versions/项目/v1'
        local.mkdir(parents=True)
        (local / 'main.c').write_text('frobnicate local-version', encoding='utf-8')
        with mock.patch('server.code_qa.subprocess.Popen', return_value=self.fake_process()):
            data = code_qa.answer(self.f.docs, self.f.config['ai'], {'messages': [{'role': 'user', 'content': 'frobnicate'}], 'codeRepositoryId': 'local'})
        self.assertEqual(data['revision'], 'local')
        self.assertEqual(data['sources'], ['main.c'])

    def test_daily_sync_uses_account_once_per_day_and_persists(self):
        from datetime import datetime, timedelta
        self.settings['repositories'][0].update(username='sync-user', password='private-password')
        settings = code_qa.validate(self.settings)
        now = datetime(2026, 10, 30, 4, 0)
        def export(url, target, **kwargs):
            self.assertEqual(kwargs['username'], 'sync-user')
            self.assertEqual(kwargs['password'], 'private-password')
            self.assertEqual(kwargs['revision'], '12')
            target.mkdir()
            (target / 'main.c').write_text('version12', encoding='utf-8')
        with mock.patch.object(self.f.svn, 'info', return_value={'revision': '99'}), mock.patch.object(self.f.svn, 'export', side_effect=export, create=True) as exported:
            self.assertEqual(code_qa.sync_daily(self.f.auth, self.f.docs, now=now - timedelta(hours=2)), [])
            self.assertTrue(code_qa.sync_daily(self.f.auth, self.f.docs, now=now)[0]['ok'])
            self.assertEqual(code_qa.sync_daily(self.f.auth, self.f.docs, now=now + timedelta(hours=1)), [])
            self.assertTrue(code_qa.sync_daily(self.f.auth, self.f.docs, now=now + timedelta(days=1))[0]['ok'])
            self.assertEqual(exported.call_count, 2)
        stored = code_qa.state_path(self.f.auth).read_text(encoding='utf-8')
        self.assertNotIn('private-password', stored)
        self.assertEqual(code_qa.read_sync_state(self.f.auth)['a']['lastSuccessDate'], '2026-10-31')

    def test_daily_sync_failure_retries_without_destroying_old_code(self):
        from datetime import datetime, timedelta
        now = datetime(2026, 10, 30, 4, 0)
        with mock.patch.object(self.f.auth, 'repo_sync_credential', return_value=None):
            result = code_qa.sync_daily(self.f.auth, self.f.docs, now=now)
            self.assertFalse(result[0]['ok'])
            self.assertEqual(code_qa.sync_daily(self.f.auth, self.f.docs, now=now + timedelta(minutes=1)), [])
            self.assertFalse(code_qa.sync_daily(self.f.auth, self.f.docs, now=now + timedelta(minutes=16))[0]['ok'])
        self.assertTrue((self.path / 'main.py').exists())
        self.assertEqual(code_qa.read_sync_state(self.f.auth)['a']['error'], result[0]['error'])

    def test_admin_settings_roundtrip_without_public_credential_leak(self):
        f = self.f
        test_server.server_database.ensure_admin(f.conn)
        login = f.client.post('/__auth/login', json={'username': 'admin', 'password': 'admin', 'mode': 'admin'})
        headers = {'X-CSRF-Token': login.get_json()['csrfToken']}
        settings = dict(self.settings, codeFolder='code', documentFolders=['md', 'manuals'], dailySyncTime='04:30')
        settings['repositories'][0].update(username='sync-user', password='private-password')
        response = f.client.put('/__admin/ai', json={'claude': settings}, headers=headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        saved = json.loads(Path(f.config['path']).read_text(encoding='utf-8'))['ai']['claude']
        self.assertEqual(saved['dailySyncTime'], '04:30')
        self.assertEqual(saved['repositories'][0]['username'], 'sync-user')
        self.assertEqual(saved['repositories'][0]['password'], 'private-password')
        self.assertNotIn('private-password', f.client.get('/__ai/public').get_data(as_text=True))
        self.assertEqual(f.client.get('/__ai/public').get_json()['defaultRepository'], '')
