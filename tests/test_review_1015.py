"""Regression cases from the 2026-10-15 review; no real SVN or user data."""
import sqlite3
import sys
import unittest
import io
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import test_review_regressions as fixtures
import setup_docsify as build
from server import database, drafts, operations, svn_update
from server.svn import SvnClient, SvnError
from server.auth import AuthService
from server.app import create_app


class Review1015Tests(unittest.TestCase):
    setUp = fixtures.ReviewTests.setUp
    tearDown = fixtures.ReviewTests.tearDown
    prepare = fixtures.ReviewTests.prepare
    run_commit = fixtures.ReviewTests.run_commit
    commit_client = fixtures.ReviewTests.commit_client

    def test_discard_cancels_prepared_and_unblocks_sync(self):
        operation = self.prepare()
        drafts.discard_draft(self.conn, self.uid, self.path)
        self.assertEqual(operations.get_operation(self.conn, operation)['state'], 'cancelled')
        self.assertTrue(operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)['updated'])

    def test_reprepare_replaces_old_preview(self):
        first = self.prepare()
        second = operations.prepare_commit(self.conn, self.uid, self.config, self.md, self.path, 'again')['operationId']
        self.assertEqual(operations.get_operation(self.conn, first)['state'], 'cancelled')
        self.assertEqual(operations.get_operation(self.conn, second)['state'], 'prepared')

    def test_cancel_api_requires_login_csrf_and_safe_state(self):
        operation = self.prepare()
        client = create_app(self.config, self.conn, AuthService(self.conn, self.svn, self.config), self.docs).test_client()
        payload = {'operationId': operation}
        self.assertEqual(client.post('/__svn/cancel', json=payload).status_code, 401)
        self.assertEqual(client.post('/__auth/login', json={'mode': 'admin', 'username': 'admin', 'password': 'admin'}).status_code, 200)
        csrf = client.get('/__auth/session').get_json()['csrfToken']
        self.assertEqual(client.post('/__svn/cancel', json=payload).status_code, 403)
        headers = {'X-CSRF-Token': csrf}
        for state in ('running', 'uncertain', 'svn_committed'):
            operations._set_state(self.conn, operation, state)
            self.assertEqual(client.post('/__svn/cancel', json=payload, headers=headers).status_code, 409)
        operations._set_state(self.conn, operation, 'prepared')
        self.assertEqual(client.post('/__svn/cancel', json=payload, headers=headers).status_code, 200)

    def test_cancel_cannot_change_other_users_operation(self):
        operation = self.prepare()
        with self.assertRaises(operations.OperationError) as caught:
            operations.cancel_commit(self.conn, self.uid + 1000, operation)
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(operations.get_operation(self.conn, operation)['state'], 'prepared')

    def test_abandoned_preview_does_not_block_explicit_update(self):
        self.prepare()
        self.assertTrue(svn_update.update(self.conn, self.svn, self.config, self.md, self.binding, ('u', 'p'))['files'])

    def test_resume_keeps_new_local_modification(self):
        operation = self.prepare()
        client = self.commit_client()
        with mock.patch.object(operations, 'publish_committed', side_effect=OSError('disk full')):
            with self.assertRaises(operations.OperationError):
                self.run_commit(client, operation)
        self.file.write_text('new local work', encoding='utf-8')
        with self.assertRaises(operations.OperationError) as caught:
            self.run_commit(client, operation)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.file.read_text(encoding='utf-8'), 'new local work')
        self.assertEqual(operations.get_operation(self.conn, operation)['state'], 'svn_committed')
        self.assertEqual(client.commit.call_count, 1)

    def test_resume_accepts_already_published_content(self):
        operation = self.prepare()
        client = self.commit_client()
        with mock.patch.object(operations, 'finish_commit', side_effect=OSError('disk full')):
            with self.assertRaises(operations.OperationError):
                self.run_commit(client, operation)
        self.assertEqual(self.run_commit(client, operation)['state'], 'published')
        self.assertEqual(client.commit.call_count, 1)

    def test_backup_switch_rejected_before_copy_or_commit(self):
        self.config['site_backup']['url'] = 'https://svn.example.com/new'
        root = operations.site_workcopy_path(self.config)
        (root / '.svn').mkdir(parents=True)
        (root / 'keep.txt').write_text('keep', encoding='utf-8')
        client = mock.Mock()
        client.info.return_value = {'url': 'https://svn.example.com/old', 'uuid': 'old'}
        with self.assertRaises(operations.OperationError) as caught:
            operations.backup_site(self.conn, client, self.config, self.root)
        self.assertEqual(caught.exception.status, 409)
        client.add.assert_not_called()
        client.commit.assert_not_called()
        self.assertEqual((root / 'keep.txt').read_text(encoding='utf-8'), 'keep')

    def test_manual_audit_failure_rolls_back_file(self):
        with mock.patch.object(database, 'audit', side_effect=sqlite3.OperationalError('disk I/O error')):
            with self.assertRaises(operations.OperationError):
                svn_update.update(self.conn, self.svn, self.config, self.md, self.binding, ('u', 'p'), self.path)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')

    def test_auto_audit_failure_rolls_back_files_and_revision(self):
        with mock.patch.object(database, 'audit', side_effect=sqlite3.OperationalError('disk I/O error')):
            with self.assertRaises(operations.OperationError):
                operations.sync_binding(self.conn, self.svn, self.config, self.md, self.binding)
        self.assertEqual(self.file.read_text(encoding='utf-8'), '# local\n')
        self.assertFalse(self.conn.execute('SELECT published_revision FROM repo_bindings').fetchone()[0])

    def test_cat_rejects_invalid_utf8(self):
        client = SvnClient(command=(sys.executable, '-c', "import sys;sys.stdout.buffer.write(b'\\xff')"))
        with self.assertRaises(SvnError):
            client.cat('https://svn.example.com/bad.md')

    def test_cat_preserves_crlf(self):
        client = SvnClient(command=(sys.executable, '-c', "import sys;sys.stdout.buffer.write(b'a\\r\\nb\\r\\n')"))
        self.assertEqual(client.cat('https://svn.example.com/good.md'), 'a\r\nb\r\n')

    def test_folder_names_reserve_all_repositories_and_ignore_case(self):
        repos = [{'id': 'A', 'mount': 'md/A'}, {'id': 'C', 'mount': 'md/C'}, {'id': 'A_B', 'mount': 'md/C/Y'}]
        pages = build.folder_page_names(['A', 'C', 'A/B', 'A/b', 'C/Y'], repos)
        self.assertEqual(pages['C/Y'], 'index_A_B.html')
        self.assertNotEqual(pages['A/B'].lower(), pages['C/Y'].lower())
        self.assertEqual(len(pages), len({name.lower() for name in pages.values()}))

    def test_build_does_not_overwrite_nested_repository_page(self):
        repos = [{'id': name, 'mount': mount, 'url': '', 'group': 'test',
                  'source_mode': 'local', 'read_only': False, 'allow_commit': True, 'sync_interval': 0}
                 for name, mount in [('A', 'md/A'), ('C', 'md/C'), ('A_B', 'md/C/Y')]]
        for rel in ('A/B/one.md', 'C/Y/two.md'):
            path = self.md / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# ' + rel, encoding='utf-8')
        lib = self.docs / 'lib'
        lib.mkdir(exist_ok=True)
        with mock.patch.multiple(build, DOCS_DIR=self.docs, MD_DIR=self.md, HTML_DIR=self.docs / 'html', LIB_DIR=lib), \
                mock.patch.object(build, 'load_all_repos', return_value=repos), \
                mock.patch.object(build, 'config_candidates', return_value=[]), \
                mock.patch.object(build, 'ensure_assets'), \
                mock.patch.object(build, 'patch_docsify_file_router'), \
                mock.patch.object(build, 'patch_docsify_css'), \
                mock.patch.object(build, 'ensure_prism_components'), redirect_stdout(io.StringIO()):
            build.main(['--offline'])
        repository = (self.docs / 'html/index_A_B.html').read_text(encoding='utf-8')
        folder = (self.docs / 'html/index_A_B-2.html').read_text(encoding='utf-8')
        self.assertIn('md/C/Y', repository)
        self.assertNotIn('md/A/B/one.md', repository)
        self.assertIn('md/A/B', folder)
