import threading
import unittest
from unittest import mock

import test_svn_update as fixtures
from server import documents, entries, local_history, operations


class LocalConsistencyTests(unittest.TestCase):
    setUp = fixtures.ManualSvnUpdateTests.setUp
    tearDown = fixtures.ManualSvnUpdateTests.tearDown

    def initialize(self, bound=True):
        self.binding.update(source_mode='local', url='')
        self.uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        if not bound:
            self.config['repositories'] = []
        self.save(self.path, '# local\n')
        self.save('md/repo/other.md', '# local other\n')

    def save(self, path, text='# saved\n'):
        old = documents.read_md_text(self.docs / path)
        if self.config['repositories']:
            return operations.local_publish_content(self.conn, self.config, self.md, self.uid,
                                                    path, text, documents.text_hash(old))
        return operations.publish_file(self.conn, self.md, self.uid, path, text, documents.text_hash(old))

    def mutate(self, action, **payload):
        return entries.mutate(self.conn, threading.RLock(), self.svn, self.config, self.md,
                              self.uid, None, action, payload)

    def test_move_updates_database_and_history(self):
        self.initialize()
        (self.md / 'repo/sub').mkdir()
        result = self.mutate('move', path=self.path, parent='md/repo/sub')
        self.save('md/repo/other.md')
        operations._materialize_repository(self.conn, self.md,
            self.conn.execute('SELECT id FROM repo_bindings').fetchone()[0], 'md/repo')
        self.assertFalse(self.file.exists())
        self.assertTrue((self.docs / result['path']).exists())
        self.assertEqual(len(local_history.list_history(self.conn, self.md, result['path'])['revisions']), 1)

    def test_delete_restore_keeps_database_in_sync(self):
        self.initialize()
        result = self.mutate('delete', path=self.path)
        self.save('md/repo/other.md')
        self.assertFalse(self.file.exists())
        row = self.conn.execute('SELECT state FROM repository_documents WHERE path=?', (self.path,)).fetchone()
        self.assertEqual(row['state'], 'deleted')
        self.mutate('restore', mount='md/repo', entryId=result['id'])
        self.save('md/repo/other.md')
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, self.path)['revisions']), 1)
        self.assertEqual(self.conn.execute('SELECT state FROM repository_documents WHERE path=?',
                                          (self.path,)).fetchone()[0], 'published')

    def test_save_does_not_overwrite_other_document(self):
        self.initialize()
        other = self.md / 'repo/other.md'
        other.write_text('# external\n', encoding='utf-8')
        self.save(self.path)
        self.assertEqual(other.read_text(encoding='utf-8'), '# external\n')

    def test_history_failure_rolls_back_file_and_database(self):
        self.initialize()
        self.conn.execute("CREATE TRIGGER fail_history BEFORE INSERT ON local_document_versions BEGIN SELECT RAISE(ABORT, 'failure'); END")
        with self.assertRaises(operations.OperationError):
            self.save(self.path)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertEqual(self.conn.execute('SELECT content FROM repository_documents WHERE path=?', (self.path,)).fetchone()[0], '# local\n')

    def test_unbound_history_failure_preserves_crlf_bytes(self):
        self.initialize(bound=False)
        self.file.write_bytes(b'# local\r\n')
        with mock.patch.object(local_history, 'record', side_effect=RuntimeError('failure')):
            with self.assertRaises(Exception):
                self.save(self.path)
        self.assertEqual(self.file.read_bytes(), b'# local\r\n')

    def test_unbound_rename_moves_history(self):
        self.initialize(bound=False)
        self.save(self.path)
        result = self.mutate('rename', path=self.path, name='new.md')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, result['path'])['revisions']), 2)

    def test_move_database_failure_restores_document_and_assets(self):
        self.initialize()
        (self.md / 'repo/sub').mkdir()
        (self.md / 'repo/images').mkdir()
        asset = self.md / 'repo/images/a.png'
        asset.write_bytes(b'image')
        self.save(self.path, '![a](images/a.png)\n')
        self.conn.execute("CREATE TRIGGER fail_move BEFORE UPDATE OF path ON repository_documents BEGIN SELECT RAISE(ABORT, 'failure'); END")
        with self.assertRaises(operations.OperationError):
            self.mutate('move', path=self.path, parent='md/repo/sub')
        self.assertTrue(self.file.exists())
        self.assertEqual(asset.read_bytes(), b'image')
        self.assertFalse((self.md / 'repo/sub' / self.file.name).exists())
        self.assertFalse((self.md / 'repo/sub/images/a.png').exists())

    def test_delete_database_failure_restores_source(self):
        self.initialize()
        self.conn.execute("CREATE TRIGGER fail_delete BEFORE UPDATE OF state ON repository_documents BEGIN SELECT RAISE(ABORT, 'failure'); END")
        with self.assertRaises(operations.OperationError):
            self.mutate('delete', path=self.path)
        self.assertTrue(self.file.exists())

    def test_restore_database_failure_preserves_trash(self):
        self.initialize()
        result = self.mutate('delete', path=self.path)
        self.conn.execute("CREATE TRIGGER fail_restore BEFORE INSERT ON repository_documents BEGIN SELECT RAISE(ABORT, 'failure'); END")
        with self.assertRaises(operations.OperationError):
            self.mutate('restore', mount='md/repo', entryId=result['id'])
        self.assertFalse(self.file.exists())
        from server import recycle
        self.assertEqual(len(recycle.list_entries(self.md, 'md/repo')), 1)

    def test_commit_failure_rolls_back_saved_file(self):
        self.initialize()
        self.conn.execute('CREATE TABLE commit_failure (uid INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)')
        self.conn.execute('CREATE TRIGGER fail_commit AFTER INSERT ON local_document_versions BEGIN INSERT INTO commit_failure VALUES (999999); END')
        with self.assertRaises(operations.OperationError):
            self.save(self.path)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, self.path)['revisions']), 1)

    def test_file_replace_failure_rolls_back_database(self):
        self.initialize()
        with mock.patch.object(documents.os, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(operations.OperationError):
                self.save(self.path)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertEqual(self.conn.execute('SELECT content FROM repository_documents WHERE path=?', (self.path,)).fetchone()[0], '# local\n')

    def test_folder_delete_restore_and_reused_name_keep_histories_separate(self):
        self.initialize()
        folder = self.md / 'repo/sub'
        folder.mkdir()
        file = folder / 'a.md'
        file.write_text('# original\n', encoding='utf-8')
        self.save('md/repo/sub/a.md', '# version two\n')
        deleted = self.mutate('delete', path='md/repo/sub')
        self.mutate('create', parent='md/repo', name='sub', kind='folder')
        self.mutate('create', parent='md/repo/sub', name='a', kind='document')
        self.save('md/repo/sub/a.md', '# different document\n')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, 'md/repo/sub/a.md')['revisions']), 2)
        self.mutate('rename', path='md/repo/sub', name='new-folder')
        self.mutate('restore', mount='md/repo', entryId=deleted['id'])
        self.save('md/repo/other.md')
        self.assertEqual(file.read_text(encoding='utf-8'), '# version two\n')
        self.assertEqual(len(local_history.list_history(self.conn, self.md, 'md/repo/sub/a.md')['revisions']), 2)

    def test_entry_audit_failure_restores_files_and_database(self):
        self.initialize()
        self.conn.execute("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='entry_delete' BEGIN SELECT RAISE(ABORT,'failure'); END")
        with self.assertRaises(operations.OperationError):
            self.mutate('delete', path=self.path)
        self.assertTrue(self.file.exists())
        self.assertEqual(self.conn.execute('SELECT state FROM repository_documents WHERE path=?', (self.path,)).fetchone()[0], 'published')

    def test_trash_empty_removes_only_archived_history(self):
        self.initialize(bound=False)
        deleted = self.mutate('delete', path=self.path)
        self.mutate('trash-empty', mount='md', entryId=deleted['id'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM local_document_versions').fetchone()[0], 1)
