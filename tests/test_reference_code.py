import tempfile
import unittest
from pathlib import Path
from unittest import mock
from server import reference_code
from tests.test_server import AppTests

class ReferenceCodeTests(unittest.TestCase):
    def test_local_working_copy_exposes_svn_address_and_commit_date(self):
        fixture = AppTests()
        fixture.setUp()
        try:
            fixture.config['ai']['claude'] = {'repositories': [{'id': 'pzz', 'folder': 'PZZ/trunk', 'name': 'trunk'}]}
            root = fixture.docs / 'code' / 'PZZ' / 'trunk'
            root.mkdir(parents=True)
            metadata = root.parent / '.svn'
            metadata.mkdir()
            (metadata / 'wc.db').write_bytes(b'local marker')
            fixture.login()
            info = {'url': 'https://user:secret@svn.example.com/PZZ/trunk', 'revision': '42',
                    'last_changed_date': '2026-11-03T02:00:00Z', 'last_changed_author': 'alice'}
            with mock.patch.object(fixture.svn, 'info', return_value=info) as read:
                public = fixture.client.get('/__ai/public').get_json()['repositories'][0]
                fixture.client.get('/__ai/public')
            self.assertEqual(public['svnUrl'], 'https://svn.example.com/PZZ/trunk')
            self.assertEqual(public['revision'], '42')
            self.assertEqual(public['revisionDate'], '2026-11-03T02:00:00Z')
            self.assertNotIn('secret', str(public))
            self.assertEqual(read.call_count, 1)
        finally:
            fixture.tearDown()

    def test_paths_and_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'a.c').write_text('int main() {}', encoding='utf-8')
            self.assertEqual(reference_code.text(reference_code.safe_path(root, 'a.c')), 'int main() {}')
            for path in ('../secret', '/etc/passwd', '.git/config', 'GTAGS', 'a\\b'):
                with self.assertRaises(ValueError):
                    reference_code.safe_path(root, path)

    def test_gtags_missing_is_nonfatal(self):
        with mock.patch('server.reference_code.shutil.which', return_value=None):
            self.assertIn('gtags', reference_code.build_index(Path('.')))

    def test_gtags_failure_keeps_previous_index(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'GTAGS').write_text('previous', encoding='utf-8')
            (root / 'GRTAGS').write_text('previous-tags', encoding='utf-8')
            with mock.patch('server.reference_code.shutil.which', return_value='gtags'), \
                    mock.patch('server.reference_code.subprocess.run', side_effect=OSError('failed')):
                message = reference_code.build_index(root)
            self.assertIn('失败', message)
            self.assertEqual((root / 'GTAGS').read_text(encoding='utf-8'), 'previous')
            self.assertEqual((root / 'GRTAGS').read_text(encoding='utf-8'), 'previous-tags')
            self.assertFalse(list(root.glob('.md2web-gtags-backup-*')))

    def test_symbol_partial_search_matches_prefixes_without_anchors(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'GTAGS').write_text('', encoding='utf-8')
            (root / 'main.c').write_text('int main(void) {}\nint main_extra(void) {}\n', encoding='utf-8')
            output = mock.Mock(returncode=0, stdout=b'main.c:1:int main(void) {}\nmain.c:2:int main_extra(void) {}\n')
            with mock.patch('server.reference_code.shutil.which', return_value='global'), \
                    mock.patch('server.reference_code.subprocess.run', return_value=output) as run:
                for mode, flag in (('symbol_partial', '-s'), ('definition_partial', '-d'), ('reference_partial', '-r')):
                    hits = reference_code.global_search(root, 'ql_port', mode)
                    self.assertEqual(len(hits), 2)
                    self.assertEqual(run.call_args[0][0][1], flag)
                    # Force regexp lookup: a bare ql_port only finds that exact tag.
                    self.assertEqual(run.call_args[0][0][-1], '.*ql_port.*')

    def test_symbol_occurrences_fallback_matches_partial_identifiers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'main.c').write_text('int main(void);\nint main_extra(void);\nint other(void);\n', encoding='utf-8')
            with mock.patch('server.reference_code.shutil.which', return_value=None):
                result = reference_code.symbol_occurrences(root, 'mai')
            self.assertFalse(result['engine'].startswith('GNU'))
            self.assertEqual([hit['line'] for hit in result['hits']], [1, 2])

    def test_quick_search_includes_definitions_missing_from_symbol_table(self):
        definition = {'path': 'driver.c', 'line': 2646, 'text': 'gt_status_t ql_macw_am_scale_get(void)'}
        reference = {'path': 'caller.c', 'line': 338, 'text': 'ql_macw_am_scale_get();'}
        def indexed(root, query, mode):
            return {'definition_partial': [definition], 'reference_partial': [reference, definition],
                    'symbol_partial': []}[mode]
        with mock.patch('server.reference_code.global_search', side_effect=indexed):
            for query in ('ql_macw_am_scale_get', 'macw_am'):
                result = reference_code.search_symbols(Path('.'), query)
                self.assertEqual(result['engine'], 'GNU Global')
                self.assertEqual(result['hits'], [definition, reference])

    def test_quick_search_falls_back_when_index_is_unavailable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'test.c').write_text('int ql_macw_am_scale_get(void);', encoding='utf-8')
            with mock.patch('server.reference_code.global_search', return_value=None):
                result = reference_code.search_symbols(root, 'macw_am')
            self.assertIn('文本匹配', result['engine'])
            self.assertEqual(len(result['hits']), 1)

    def test_symbol_queries_use_separate_definition_and_reference_indexes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'GTAGS').write_text('', encoding='utf-8')
            (root / 'main.c').write_text('int main(void) {}', encoding='utf-8')
            output = mock.Mock(returncode=0, stdout=b'main.c:1:int main(void) {}\n')
            with mock.patch('server.reference_code.shutil.which', return_value='global'), mock.patch('server.reference_code.subprocess.run', return_value=output) as run:
                result = reference_code.symbol_locations(root, 'main')
            self.assertTrue(result['indexed'])
            self.assertEqual(result['definitions'][0]['line'], 1)
            self.assertEqual(run.call_args_list[0][0][0][1], '-d')
            self.assertEqual(run.call_args_list[1][0][0][1], '-r')
            self.assertEqual(run.call_args_list[0][0][0][-1], '^main$')

    def test_symbol_fallback_is_explicit_and_matches_whole_identifiers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'main.c').write_text('int main(void);\nint main_extra(void);\n', encoding='utf-8')
            with mock.patch('server.reference_code.shutil.which', return_value=None):
                result = reference_code.symbol_locations(root, 'main')
            self.assertFalse(result['indexed'])
            self.assertEqual(result['definitions'], [])
            self.assertEqual(len(result['references']), 1)
            for invalid in ('--flag', 'main\n', '../private', ''):
                with self.assertRaises(ValueError):
                    reference_code.symbol_locations(root, invalid)

    def test_authenticated_browse_and_search(self):
        fixture = AppTests()
        fixture.setUp()
        try:
            fixture.config['ai']['claude'] = {'repositories': [{'id': 'repo', 'folder': 'repo'}]}
            root = fixture.docs / 'code' / 'repo'
            root.mkdir(parents=True)
            (root / 'main.c').write_text('int main() {return 0;}\n', encoding='utf-8')
            self.assertEqual(fixture.client.get('/__code/repos').status_code, 401)
            fixture.login()
            self.assertEqual(fixture.client.get('/__code/file?repo=repo&path=main.c').status_code, 200)
            data = fixture.client.get('/__code/search?repo=repo&q=return&mode=text').get_json()
            self.assertEqual(data['hits'][0]['line'], 1)
            self.assertEqual(fixture.client.get('/__code/file?repo=repo&path=../secret').status_code, 400)
            self.assertEqual(fixture.client.get('/__code/symbol?repo=repo&symbol=main').status_code, 200)
            self.assertEqual(fixture.client.get('/__code/symbol?repo=repo&symbol=--flag').status_code, 400)
            self.assertEqual(fixture.client.get('/__code/search?repo=repo&q=main&mode=bad').status_code, 400)
            symbols = fixture.client.get('/__code/search?repo=repo&q=main&mode=symbol').get_json()
            self.assertTrue(symbols['hits'])
            self.assertEqual(symbols['hits'][0]['path'], 'main.c')
            partial = fixture.client.get('/__code/search?repo=repo&q=mai&mode=symbol').get_json()
            self.assertTrue(partial['hits'])
            self.assertEqual(partial['hits'][0]['path'], 'main.c')
            self.assertEqual(fixture.client.get('/__code/search?repo=repo&q=main%28&mode=symbol').status_code, 400)
            self.assertEqual(fixture.client.post('/__code/index?repo=repo').status_code, 403)
            from server import database
            database.ensure_admin(fixture.conn)
            admin = fixture.client.post('/__auth/login', json={'username': 'admin', 'password': 'admin', 'mode': 'admin'}).get_json()
            self.assertEqual(fixture.client.get('/__code/index?repo=repo').status_code, 405)
            self.assertEqual(fixture.client.post('/__code/index?repo=repo').status_code, 403)
            with mock.patch('server.reference_code.build_index', return_value='ready') as build:
                response = fixture.client.post('/__code/index?repo=repo', headers={'X-CSRF-Token': admin['csrfToken']})
                self.assertEqual(response.status_code, 200)
                build.assert_called_once_with(root.resolve())
        finally:
            fixture.tearDown()

    def test_sync_metadata_is_exposed_to_reference_browser(self):
        fixture = AppTests()
        fixture.setUp()
        try:
            fixture.config['ai']['claude'] = {'repositories': [
                {'id': 'repo', 'folder': 'repo', 'url': 'https://svn.example.com/repo'}]}
            root = fixture.docs / 'code' / 'repo'
            root.mkdir(parents=True)
            (root / 'main.c').write_text('int main(void) {}\n', encoding='utf-8')
            (root / '.md2web-revision').write_text('42', encoding='utf-8')
            (root / '.md2web-revision-info').write_text(
                '{"revision": "42", "url": "https://svn.example.com/repo", "date": "2026-10-30T07:20:00.000000Z", "author": "alice"}',
                encoding='utf-8')
            fixture.login()
            public = fixture.client.get('/__ai/public').get_json()['repositories'][0]
            self.assertEqual(public['revision'], '42')
            self.assertEqual(public['revisionDate'], '2026-10-30T07:20:00.000000Z')
            self.assertEqual(public['revisionAuthor'], 'alice')
            tree = fixture.client.get('/__code/tree?repo=repo').get_json()
            self.assertEqual(tree['revisionDate'], '2026-10-30T07:20:00.000000Z')
        finally:
            fixture.tearDown()

    def test_text_cache_invalidates_when_file_changes(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            path = root / 'main.c'
            path.write_text('int a;', encoding='utf-8')
            self.assertEqual(reference_code.text(path), 'int a;')
            path.write_text('int b;', encoding='utf-8')
            info = path.stat()
            os.utime(str(path), (info.st_atime + 2, info.st_mtime + 2))
            self.assertEqual(reference_code.text(path), 'int b;')

    def test_svn_info_commit_fields_are_parsed(self):
        from server import svn
        xml = ('<?xml version="1.0"?><info><entry kind="dir" path="trunk" revision="42">'
               '<url>https://svn.example.com/trunk</url><repository><root>https://svn.example.com</root>'
               '<uuid>abc</uuid></repository><commit revision="42"><author>alice</author>'
               '<date>2026-10-30T07:20:00.000000Z</date></commit></entry></info>')
        info = svn.parse_info_xml(xml)
        self.assertEqual(info['last_changed_revision'], '42')
        self.assertEqual(info['last_changed_date'], '2026-10-30T07:20:00.000000Z')
        self.assertEqual(info['last_changed_author'], 'alice')
