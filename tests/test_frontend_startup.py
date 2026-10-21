import tempfile
import io
from contextlib import redirect_stdout
import unittest
from pathlib import Path
from unittest import mock
import serve


class FrontendStartupTests(unittest.TestCase):
    def test_restart_syncs_assets_even_when_document_rebuild_is_disabled(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'web').mkdir()
            (root / 'web/workspace.js').write_bytes(b'new button')
            (root / 'docs/lib').mkdir(parents=True)
            (root / 'docs/lib/workspace.js').write_bytes(b'old button')
            (root / 'docs/index.html').write_bytes(b'existing server overview')
            with mock.patch.object(serve, 'ROOT', root), \
                    mock.patch.object(serve, 'manage_instance'), \
                    mock.patch.object(serve, 'write_pidfile'), \
                    mock.patch.object(serve, 'remove_pidfile'), \
                    mock.patch.object(serve, 'set_process_title', return_value=False), \
                    mock.patch.object(serve, 'run_authenticated_service'), \
                    redirect_stdout(io.StringIO()):
                serve.main(['--dir', str(root / 'docs'), '--no-build'])
            self.assertEqual((root / 'docs/lib/workspace.js').read_bytes(), b'new button')
            self.assertEqual((root / 'docs/index.html').read_bytes(), b'existing server overview')

    def test_sync_updates_stale_assets_without_rebuilding_server_repositories(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            web = root / 'web'
            docs = root / 'docs'
            web.mkdir()
            (docs / 'lib').mkdir(parents=True)
            (docs / 'md/server-only').mkdir(parents=True)
            (docs / 'html').mkdir()
            (web / 'workspace.js').write_bytes(b'new copy button')
            (web / 'auth.js').write_bytes(b'new session checks')
            (web / 'auth.css').write_bytes(b'new style')
            (docs / 'lib/workspace.js').write_bytes(b'old')
            doc = docs / 'md/server-only/a.md'
            page = docs / 'html/index_server-only.html'
            doc.write_bytes(b'server document')
            page.write_bytes(b'server page')
            with mock.patch.object(serve, 'ROOT', root):
                self.assertEqual(len(serve.sync_frontend_assets(docs)), 3)
                self.assertEqual(serve.sync_frontend_assets(docs), [])
            self.assertEqual((docs / 'lib/workspace.js').read_bytes(), b'new copy button')
            self.assertEqual(doc.read_bytes(), b'server document')
            self.assertEqual(page.read_bytes(), b'server page')

    def test_sync_skips_custom_preview_directories(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'web').mkdir()
            with mock.patch.object(serve, 'ROOT', root):
                self.assertEqual(serve.sync_frontend_assets(root / 'custom'), [])
            self.assertFalse((root / 'custom').exists())
