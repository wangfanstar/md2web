"""2026-10-14 SVN review regressions; all repositories are temporary."""
import threading
import unittest
from pathlib import Path
from unittest import mock

import test_svn_update as fixtures
from server import database, drafts, operations, svn_update, svn_snapshot
from server.auth import AuthService


class ReviewTests(unittest.TestCase):
    setUp = fixtures.ManualSvnUpdateTests.setUp
    tearDown = fixtures.ManualSvnUpdateTests.tearDown

    def prepare(self):
        self.uid = self.conn.execute('SELECT id FROM users').fetchone()[0]
        drafts.save_draft(self.conn, self.uid, self.md, self.path, 'draft')
        return operations.prepare_commit(self.conn, self.uid, self.config, self.md, self.path, 'review')['operationId']

    def commit_client(self, remote_text='# local\n'):
        client = mock.Mock()
        client.info.side_effect = self.svn.info
        client.checkout.side_effect = lambda url, target, **kw: Path(target).mkdir(parents=True, exist_ok=True)
        client.update.side_effect = lambda target, **kw: Path(target).write_text(remote_text, encoding='utf-8')
        client.diff.return_value = 'changed'
        client.commit.return_value = 13
        return client

    def run_commit(self, client, operation):
        return operations.run_commit(self.conn, client, self.config, self.md,
                                     self.config['storage']['workspaces'], operation, self.uid, ('u', 'p'))

    def test_commit_rejects_remote_changes(self):
        operation = self.prepare()
        client = self.commit_client('other person')
        with self.assertRaises(operations.OperationError) as caught:
            self.run_commit(client, operation)
        self.assertEqual(caught.exception.status, 409)
        client.commit.assert_not_called()
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')

    def test_prepare_preserves_original_draft_baseline(self):
        self.prepare()
        self.file.write_text('new published', encoding='utf-8')
        with self.assertRaises(operations.OperationError):
            operations.prepare_commit(self.conn, self.uid, self.config, self.md, self.path, 'again')

    def test_single_commit_does_not_skip_sibling_sync(self):
        row = operations.ensure_binding(self.conn, self.binding, self.svn, self.config, ('u', 'p'))
        operations.publish_committed(self.conn, self.md, self.path, 'published', 12, row['id'])
        result = operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertTrue(result['updated'])
        self.assertEqual((self.md / 'repo/other.md').read_text(encoding='utf-8'), '# other remote\n')

    def test_nested_repository_is_not_overwritten(self):
        self.config['repositories'].append(dict(self.binding, id='nested', mount='md/repo/nested', source_mode='local', url=''))
        self.svn.files = {'nested/a.md': 'wrong repo'}
        operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertFalse((self.md / 'repo/nested/a.md').exists())

    def test_changed_url_requires_rebind(self):
        operations.ensure_binding(self.conn, self.binding, self.svn, self.config)
        self.binding['url'] += '/different'
        with self.assertRaises(operations.OperationError) as caught:
            operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertEqual(caught.exception.status, 409)

    def test_invalid_snapshot_leaves_all_files_untouched(self):
        def export(url, target, **kw):
            target.mkdir(parents=True, exist_ok=True)
            (target / 'a.md').write_text('new', encoding='utf-8')
            (target / 'z.md').write_bytes(b'\xff')
        self.svn.export = export
        with self.assertRaises(operations.OperationError):
            operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertFalse((self.md / 'repo/a.md').exists())
        self.assertTrue(self.conn.execute('SELECT sync_error FROM repo_bindings').fetchone()[0])

    def test_running_and_legacy_null_operations_block_update(self):
        operation = self.prepare()
        self.assertIsNotNone(self.conn.execute('SELECT binding_id FROM operations WHERE id=?', (operation,)).fetchone()[0])
        operations._set_state(self.conn, operation, 'running')
        for legacy in (False, True):
            if legacy:
                self.conn.execute('UPDATE operations SET binding_id=NULL WHERE id=?', (operation,))
                self.conn.commit()
            with self.assertRaises(operations.OperationError):
                svn_update.update(self.conn, self.svn, self.config, self.md, self.binding, ('u', 'p'))

    def test_publish_failure_can_resume_without_second_commit(self):
        operation = self.prepare()
        client = self.commit_client()
        with mock.patch.object(operations, 'publish_committed', side_effect=OSError('disk full')):
            with self.assertRaises((OSError, operations.OperationError)):
                self.run_commit(client, operation)
        result = self.run_commit(client, operation)
        self.assertEqual(result['state'], 'published')
        self.assertEqual(self.file.read_text(encoding='utf-8'), 'draft')
        self.assertEqual(client.commit.call_count, 1)

    def test_successful_commit_finishes_only_committed_draft(self):
        operation = self.prepare()
        self.run_commit(self.commit_client(), operation)
        self.assertNotIn(self.path, operations.active_draft_paths(self.conn))
        drafts.save_draft(self.conn, self.uid, self.md, self.path, 'second draft')
        operations.prepare_commit(self.conn, self.uid, self.config, self.md, self.path, 'second commit')

    def test_auto_sync_rolls_back_first_write_when_second_fails(self):
        before = {p: p.read_bytes() for p in (self.md / 'repo').glob('*.md')}
        original = svn_snapshot.os.replace
        count = [0]
        def fail_second(source, target):
            count[0] += 1
            if count[0] == 2:
                raise OSError('disk full')
            return original(source, target)
        with mock.patch.object(svn_snapshot.os, 'replace', side_effect=fail_second):
            with self.assertRaises(operations.OperationError):
                operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertEqual(self.conn.execute('SELECT sync_state FROM repo_bindings').fetchone()[0], 'idle')

    def test_auto_sync_rejects_link_ancestor_before_writing(self):
        with mock.patch.object(svn_snapshot.folder_sources, 'has_link_ancestor', return_value=True):
            with self.assertRaises(operations.OperationError):
                operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')

    def test_sync_uuid_change_is_rejected_and_recorded(self):
        operations.ensure_binding(self.conn, self.binding, self.svn, self.config)
        original = self.svn.info
        self.svn.info = lambda *a, **kw: dict(original(*a, **kw), uuid='different')
        with self.assertRaises(operations.OperationError):
            operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertTrue(self.conn.execute('SELECT sync_error FROM repo_bindings').fetchone()[0])

    def test_backup_rejects_explicit_private_file(self):
        self.config['site_backup'].update(url='https://svn.example.com/backup', include=['docs/html/md2web_config.json'])
        with self.assertRaises(operations.OperationError):
            operations.backup_site(self.conn, mock.Mock(), self.config, self.root)

    def test_upgrade_resets_old_svn_watermark_only_once(self):
        operations.ensure_binding(self.conn, self.binding, self.svn, self.config)
        self.conn.execute('UPDATE repo_bindings SET published_revision=42')
        self.conn.execute('PRAGMA user_version=9')
        self.conn.commit()
        database.migrate(self.conn)
        self.assertEqual(self.conn.execute('SELECT published_revision FROM repo_bindings').fetchone()[0], 0)
        self.conn.execute('UPDATE repo_bindings SET published_revision=43')
        self.conn.commit()
        database.migrate(self.conn)
        self.assertEqual(self.conn.execute('SELECT published_revision FROM repo_bindings').fetchone()[0], 43)

    def test_backup_excludes_private_profiles(self):
        self.config['site_backup']['url'] = 'https://svn.example.com/backup'
        client = mock.Mock()
        client.status.return_value = 'A docs'
        client.commit.return_value = 13
        def add(path, **kw):
            self.assertFalse((Path(path) / 'docs/html/md2web_config.json').exists())
        client.add.side_effect = add
        operations.backup_site(self.conn, client, self.config, self.root)

    def test_repair_network_does_not_hold_database_lock(self):
        auth = AuthService(self.conn, self.svn, self.config)
        acquired = []
        def repair(*args, **kwargs):
            def probe():
                ok = auth._db_lock.acquire(timeout=0.2)
                acquired.append(ok)
                if ok:
                    auth._db_lock.release()
            thread = threading.Thread(target=probe)
            thread.start()
            thread.join(1)
        with mock.patch.object(operations, 'repair_repo', side_effect=repair):
            auth.repair_repository(self.md, self.binding)
        self.assertEqual(acquired, [True])
