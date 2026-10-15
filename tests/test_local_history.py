import unittest
import test_svn_update as fixtures
from server import documents, operations, local_history
import test_server


class LocalHistoryTests(unittest.TestCase):
    setUp = fixtures.ManualSvnUpdateTests.setUp
    tearDown = fixtures.ManualSvnUpdateTests.tearDown

    def save(self, text):
        self.binding.update(source_mode='local', url='')
        uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        return operations.local_publish_content(self.conn, self.config, self.md, uid,
            self.path, text, documents.text_hash(documents.read_md_text(self.file)))

    def test_saves_record_initial_and_published_versions(self):
        self.save('# first\n')
        self.save('# second\n')
        history = local_history.list_history(self.conn, self.md, self.path)
        self.assertEqual(len(history['revisions']), 3)
        diff = local_history.diff_documents(self.conn, self.md, self.path, 'previous', 'published')
        self.assertIn('-# first', diff['diff'])
        self.assertIn('+# second', diff['diff'])
        self.assertNotIn('-# local', diff['diff'])

    def test_identical_save_does_not_duplicate_history(self):
        self.save('# first\n')
        self.save('# first\n')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, self.path)['revisions']), 2)

    def test_rejected_save_does_not_create_version_or_draft(self):
        self.save('# first\n')
        uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        with self.assertRaises(operations.OperationError):
            operations.local_publish_content(self.conn, self.config, self.md, uid, self.path, '# rejected', 'stale')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, self.path)['revisions']), 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM drafts WHERE state='active'").fetchone()[0], 0)

    def test_unbound_file_save_also_records_history(self):
        uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        operations.publish_file(self.conn, self.md, uid, self.path, '# new\n', documents.text_hash('# local\n'))
        diff = local_history.diff_documents(self.conn, self.md, self.path, 'previous', 'published')
        self.assertIn('-# local', diff['diff'])
        self.assertIn('+# new', diff['diff'])

    def test_missing_history_is_clear(self):
        from server.drafts import DraftError
        with self.assertRaises(DraftError) as caught:
            local_history.diff_documents(self.conn, self.md, self.path, 'previous', 'published')
        self.assertEqual(caught.exception.status, 404)

    def test_revision_cannot_be_read_as_another_document(self):
        self.save('# first\n')
        ref = local_history.list_history(self.conn, self.md, self.path)['revisions'][0]['id']
        from server.drafts import DraftError
        with self.assertRaises(DraftError):
            local_history.get_revision(self.conn, 'md/repo/other.md', ref)


class LocalHistoryApiTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_server.LocalPublishTests()
        self.fixture.setUp()
        self.client = self.fixture.client

    def tearDown(self):
        self.fixture.tearDown()

    def test_history_diff_and_load_after_saving_and_rename(self):
        path = 'md/本地库/a.md'
        headers = {'X-CSRF-Token': self.fixture.csrf()}
        for text in ('# first\n', '# current\n'):
            before = documents.read_md_text(self.fixture.docs / path)
            response = self.client.post('/__md/publish', json={'path': path, 'content': text,
                'baseHash': documents.text_hash(before)}, headers=headers)
            self.assertEqual(response.status_code, 200, response.get_json())
        history = self.client.get('/__md/history', query_string={'path': path}).get_json()['history']
        self.assertEqual(len(history['revisions']), 3)
        diff = self.client.get('/__md/diff', query_string={'path': path}).get_json()['diff']
        self.assertIn('-# first', diff['diff'])
        self.assertIn('+# current', diff['diff'])
        ref = history['revisions'][1]['id']
        loaded = self.client.get('/__md/revision', query_string={'path': path, 'id': ref})
        self.assertEqual(loaded.get_json()['revision']['content'], '# first\n')
        response = self.client.post('/__md/rename', json={'path': path, 'name': 'new'}, headers=headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        renamed = response.get_json()['result']['path']
        self.assertEqual(len(self.client.get('/__md/history', query_string={'path': renamed}).get_json()['history']['revisions']), 3)
        self.assertEqual(self.fixture.app.test_client().get('/__md/history', query_string={'path': renamed}).status_code, 401)
