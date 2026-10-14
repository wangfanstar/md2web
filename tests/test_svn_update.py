import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server import config, database, drafts, operations, svn_update
from server.auth import AuthService
from server.svn import SvnError


class Remote:
    def __init__(self):
        self.files = {'文档 空格.md': '# remote\n', 'other.md': '# other remote\n'}
        self.urls = []

    def info(self, url, config_dir, **kwargs):
        return {'uuid': 'repo-uuid', 'url': url, 'root_url': url, 'revision': 12}

    def cat(self, url, **kwargs):
        self.urls.append(url)
        return '# selected remote\n'

    def export(self, url, destination, **kwargs):
        for name, text in self.files.items():
            target = Path(destination) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding='utf-8')


class ManualSvnUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.docs = self.root / 'docs'
        self.md = self.docs / 'md'
        payload = config.default_config()
        payload['repositories'] = [{'id': 'repo', 'mount': 'md/repo', 'url': 'https://svn.example.com/repo'}]
        self.config = config.save_config(self.root / 'config/server.local.json', payload, self.docs)
        self.binding = self.config['repositories'][0]
        self.path = 'md/repo/文档 空格.md'
        self.file = self.md / 'repo/文档 空格.md'
        self.file.write_text('# local\n', encoding='utf-8')
        (self.md / 'repo/other.md').write_text('# local other\n', encoding='utf-8')
        self.conn = database.connect(self.root / 'data/test.sqlite3')
        database.migrate(self.conn)
        database.ensure_admin(self.conn)
        self.svn = Remote()

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def update(self, path=None):
        return svn_update.update(self.conn, self.svn, self.config, self.md, self.binding, ('user', 'pass'), path)

    def test_selected_document_does_not_touch_siblings_or_advance_whole_repo_revision(self):
        result = self.update(self.path)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# selected remote\n')
        self.assertEqual((self.md / 'repo/other.md').read_text(encoding='utf-8'), '# local other\n')
        self.assertEqual((self.root / result['backup'] / self.path).read_text(encoding='utf-8'), '# local\n')
        self.assertIn('%20', self.svn.urls[0])
        self.assertFalse(self.conn.execute('SELECT published_revision FROM repo_bindings').fetchone()[0])

    def test_remote_wins_but_keeps_personal_draft_and_server_backup(self):
        user_id = self.conn.execute('SELECT id FROM users').fetchone()[0]
        drafts.save_draft(self.conn, user_id, self.md, self.path, '# personal draft\n')
        result = self.update()
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# remote\n')
        self.assertEqual(result['drafts'], [self.path])
        self.assertEqual(drafts.document_state(self.conn, user_id, self.md, self.path)['draft']['content'], '# personal draft\n')
        self.assertTrue(self.conn.execute('SELECT last_success_at FROM repo_bindings').fetchone()[0])

    def test_network_failure_keeps_original(self):
        with mock.patch.object(self.svn, 'export', side_effect=SvnError('timeout', 'timeout')):
            with self.assertRaises(operations.OperationError):
                self.update()
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertEqual(self.conn.execute('SELECT sync_state FROM repo_bindings').fetchone()[0], 'idle')

    def test_failed_second_file_write_restores_first(self):
        original = svn_update.os.replace
        count = [0]
        def fail_second(source, target):
            count[0] += 1
            if count[0] == 2:
                raise OSError('disk full')
            return original(source, target)
        with mock.patch.object(svn_update.os, 'replace', side_effect=fail_second):
            with self.assertRaises(operations.OperationError):
                self.update()
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertEqual((self.md / 'repo/other.md').read_text(encoding='utf-8'), '# local other\n')

    def test_api_requires_login_csrf_confirmation_and_rebuilds(self):
        from server.app import create_app
        auth = AuthService(self.conn, self.svn, self.config)
        rebuilt = mock.Mock(return_value=True)
        client = create_app(self.config, self.conn, auth, self.docs, rebuilt).test_client()
        payload = {'binding': 'repo', 'path': self.path, 'remoteWins': True}
        self.assertEqual(client.post('/__svn/update', json=payload).status_code, 401)
        login = client.post('/__auth/login', json={'username': 'admin', 'password': 'admin', 'mode': 'admin'}).get_json()
        self.assertEqual(client.post('/__svn/update', json=payload).status_code, 403)
        headers = {'X-CSRF-Token': login['csrfToken']}
        self.assertEqual(client.post('/__svn/update', json={'binding': 'repo'}, headers=headers).status_code, 409)
        response = client.post('/__svn/update', json=payload, headers=headers)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        rebuilt.assert_called_once()
        self.assertTrue(client.get('/__svn/sync-status?binding=repo&path=' + self.path).get_json()['status']['lastFileUpdateAt'])
        payload['path'] = 'md/other/invalid.md'
        self.assertEqual(client.post('/__svn/update', json=payload, headers=headers).status_code, 400)


if __name__ == '__main__':
    unittest.main()
