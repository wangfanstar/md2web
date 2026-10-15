"""Renames must remain renamed after SQLite materialization."""
import threading
import unittest

import test_svn_update as fixtures
from server import documents, entries, operations


class RenameStorageTests(unittest.TestCase):
    setUp = fixtures.ManualSvnUpdateTests.setUp
    tearDown = fixtures.ManualSvnUpdateTests.tearDown

    def initialize(self):
        self.binding.update(source_mode='local', url='')
        self.uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        operations.local_import_repository(self.conn, self.config, self.md, self.binding)

    def rename(self, path, name):
        return entries.mutate(self.conn, threading.RLock(), self.svn, self.config,
                              self.md, self.uid, None, 'rename', {'path': path, 'name': name})

    def save(self, path):
        target = self.docs / path
        operations.local_publish_content(self.conn, self.config, self.md, self.uid,
                                         path, '# saved\n', documents.text_hash(documents.read_md_text(target)))

    def test_rename_then_save_does_not_resurrect_original(self):
        self.initialize()
        result = self.rename(self.path, '新 名称.md')
        self.assertFalse(self.file.exists())
        self.save(result['path'])
        self.save('md/repo/other.md')
        self.assertFalse(self.file.exists())
        self.assertEqual((self.docs / result['path']).read_text(encoding='utf-8'), '# saved\n')
        self.assertIsNone(self.conn.execute('SELECT id FROM repository_documents WHERE path=?', (self.path,)).fetchone())

    def test_folder_rename_updates_descendants_only(self):
        folder = self.md / 'repo/sub'
        folder.mkdir()
        (folder / 'a.md').write_text('# nested\n', encoding='utf-8')
        sibling = self.md / 'repo/sub-extra'
        sibling.mkdir()
        (sibling / 'a.md').write_text('# sibling\n', encoding='utf-8')
        self.initialize()
        self.rename('md/repo/sub', 'renamed')
        self.save('md/repo/other.md')
        self.assertFalse(folder.exists())
        self.assertTrue((self.md / 'repo/renamed/a.md').is_file())
        self.assertEqual((sibling / 'a.md').read_text(encoding='utf-8'), '# sibling\n')

    def test_database_failure_rolls_back_rename(self):
        self.initialize()
        self.conn.execute("CREATE TRIGGER fail_rename BEFORE UPDATE OF path ON repository_documents BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(operations.OperationError):
            self.rename(self.path, 'new.md')
        self.assertTrue(self.file.is_file())
        self.assertFalse((self.md / 'repo/new.md').exists())

    def test_rename_can_reuse_deleted_database_path(self):
        self.initialize()
        with self.conn:
            self.conn.execute("UPDATE repository_documents SET state='deleted' WHERE path='md/repo/other.md'")
        (self.md / 'repo/other.md').unlink()
        result = self.rename(self.path, 'other.md')
        self.save(result['path'])
        self.assertFalse(self.file.exists())
        self.assertTrue((self.md / 'repo/other.md').is_file())

    def test_rename_without_database_snapshot_stays_usable(self):
        self.binding.update(source_mode='local', url='')
        self.uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        result = self.rename(self.path, 'new.md')
        self.save(result['path'])
        self.assertFalse(self.file.exists())

