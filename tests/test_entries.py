"""目录操作：远端提交与本地发布之间的一致性。"""
import json
import shutil
import threading
import unittest
from pathlib import Path
from unittest import mock

try:
    import test_server
except ImportError:
    from tests import test_server
from server import database, operations
from server.svn import SvnError


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_server.FolderOpsTests('test_folder_listing_is_public')
        self.fixture.setUp()
        self.client = self.fixture.client
        self.config = self.fixture.config
        self.root = self.fixture.docs / 'md' / '硬件设计'
        self.headers = {'X-CSRF-Token': self.fixture.csrf()}
        self.remote = self.fixture.tmp / 'remote'
        shutil.copytree(str(self.root), str(self.remote))
        self.calls = []
        self.revision = 7
        self.svn = self.fixture.auth.svn
        self.svn.info = mock.Mock(return_value={'uuid': 'uuid-1', 'url': self.config['repositories'][0]['url'],
                                                'root_url': 'https://svn.example.invalid/', 'revision': 7})
        self.svn.checkout = self.checkout
        self.svn.add = lambda path, **kwargs: self.calls.append('add')
        self.svn.move = self.move
        self.svn.delete = self.delete
        self.svn.commit = self.commit
        self.fixture.auth.stored_credential = lambda user: ('alice', 'good')

    def tearDown(self):
        self.fixture.tearDown()

    def checkout(self, url, target, **kwargs):
        shutil.copytree(str(self.remote), str(target))
        self.wc = Path(target)

    def move(self, source, target, **kwargs):
        self.calls.append('move')
        Path(source).rename(target)

    def delete(self, target, **kwargs):
        self.calls.append('delete')
        target = Path(target)
        shutil.rmtree(str(target)) if target.is_dir() else target.unlink()

    def commit(self, path, message, **kwargs):
        self.calls.append('commit')
        shutil.rmtree(str(self.remote))
        shutil.copytree(str(self.wc), str(self.remote))
        self.revision += 1
        return self.revision

    def post(self, action, **payload):
        return self.client.post('/__md/' + action, json=payload, headers=self.headers)

    def test_svn_create_rename_delete_publish_only_after_commit(self):
        response = self.post('create', parent='md/硬件设计', name='新文档', kind='document')
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()['result']['svnRevision'], 8)
        self.assertTrue((self.remote / '新文档.md').exists())
        response = self.post('rename', path='md/硬件设计/新文档.md', name='重命名')
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertIn('move', self.calls)
        self.assertFalse((self.remote / '新文档.md').exists())
        self.assertTrue((self.remote / '重命名.md').exists())
        response = self.post('delete', path='md/硬件设计/重命名.md')
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse((self.remote / '重命名.md').exists())
        self.assertTrue(Path(response.get_json()['result']['trash']).is_dir())

    def test_failed_svn_commit_does_not_change_local_files(self):
        self.svn.commit = mock.Mock(side_effect=SvnError('conflict'))
        response = self.post('rename', path='md/硬件设计/时钟树设计.md', name='新名')
        self.assertGreaterEqual(response.status_code, 400)
        self.assertTrue((self.root / '时钟树设计.md').exists())
        self.assertFalse((self.root / '新名.md').exists())

    def test_remote_change_blocks_delete(self):
        (self.remote / '时钟树设计.md').write_text('# 远端新内容\n', encoding='utf-8')
        response = self.post('delete', path='md/硬件设计/时钟树设计.md')
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertNotIn('commit', self.calls)
        self.assertTrue((self.root / '时钟树设计.md').exists())

    def test_readonly_and_repository_root_are_protected(self):
        self.config['repositories'][0]['read_only'] = True
        self.assertEqual(self.post('create', parent='md/硬件设计', name='x').status_code, 403)
        self.config['repositories'][0]['read_only'] = False
        self.assertEqual(self.post('delete', path='md/硬件设计').status_code, 400)
        self.assertEqual(self.post('rename', path='md', name='other').status_code, 400)

    def test_duplicate_request_does_not_commit_twice(self):
        payload = {'parent': 'md/硬件设计', 'name': '一次', 'requestId': 'a' * 32}
        first = self.post('create', **payload)
        second = self.post('create', **payload)
        self.assertEqual(first.status_code, 200, first.get_json())
        self.assertEqual(second.status_code, 200, second.get_json())
        self.assertEqual(self.calls.count('commit'), 1)

    def test_uncertain_commit_blocks_retry_and_background_sync(self):
        self.svn.commit = mock.Mock(side_effect=SvnError('timeout'))
        response = self.post('delete', path='md/硬件设计/时钟树设计.md', requestId='b' * 32)
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertEqual(response.get_json()['state'], 'uncertain')
        response = self.post('delete', path='md/硬件设计/时钟树设计.md', requestId='c' * 32)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.svn.commit.call_count, 1)
        with self.assertRaises(operations.OperationError):
            operations.sync_binding(self.fixture.conn, self.svn, self.config, self.root.parent,
                                    self.config['repositories'][0], ('alice', 'good'))

    def test_local_repository_does_not_contact_svn(self):
        self.config['repositories'][0]['source_mode'] = 'local'
        self.config['repositories'][0]['url'] = ''
        response = self.post('create', parent='md/硬件设计', name='本地')
        self.assertEqual(response.status_code, 200, response.get_json())
        self.svn.info.assert_not_called()

    def test_delete_moves_referenced_assets_and_restore_returns_them(self):
        self.config['repositories'][0]['source_mode'] = 'local'
        self.config['repositories'][0]['url'] = ''
        image = self.root / 'images' / 'diagram.png'
        attachment = self.root / '附件' / '说明.pdf'
        image.parent.mkdir(exist_ok=True)
        attachment.parent.mkdir(exist_ok=True)
        image.write_bytes(b'png')
        attachment.write_bytes(b'pdf')
        document = self.root / '带资源.md'
        document.write_text('![图](images/diagram.png)\n[附件](附件/说明.pdf)\n', encoding='utf-8')
        deleted = self.post('delete', path='md/硬件设计/带资源.md').get_json()
        self.assertTrue(deleted['ok'], deleted)
        self.assertFalse(document.exists())
        self.assertFalse(image.exists())
        self.assertFalse(attachment.exists())
        listed = self.client.get('/__trash?mount=md/硬件设计').get_json()['entries']
        entry = next(item for item in listed if item['path'].endswith('带资源.md'))
        restored = self.post('restore', mount='md/硬件设计', entryId=entry['id']).get_json()
        self.assertTrue(restored['ok'], restored)
        self.assertTrue(document.exists())
        self.assertTrue(image.exists())
        self.assertTrue(attachment.exists())
        emptied = self.post('trash-empty', mount='md/硬件设计').get_json()
        self.assertTrue(emptied['ok'], emptied)

    def test_active_draft_blocks_rename(self):
        actor = self.fixture.conn.execute('SELECT id FROM users LIMIT 1').fetchone()[0]
        with self.fixture.conn:
            self.fixture.conn.execute("INSERT INTO drafts (user_id, document_path, state, created_at, updated_at) "
                                      "VALUES (?, ?, 'active', ?, ?)",
                                      (actor, 'md/硬件设计/时钟树设计.md', database.now_iso(), database.now_iso()))
        self.assertEqual(self.post('rename', path='md/硬件设计/时钟树设计.md', name='其他').status_code, 409)
