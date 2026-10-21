import hashlib
import tempfile
import unittest
import functools
import http.server
import threading
import urllib.request
from pathlib import Path
from server import cache
import test_plan_integration
import serve


class AssetRefreshTests(unittest.TestCase):
    def test_preview_revalidates_html_when_only_script_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'lib').mkdir()
            asset = root / 'lib/math-init.js'
            asset.write_bytes(b'old')
            (root / 'index.html').write_text('<script src="lib/math-init.js?v=stale"></script>', encoding='utf-8')
            server = http.server.HTTPServer(('127.0.0.1', 0), functools.partial(serve.PreviewHandler, directory=str(root)))
            worker = threading.Thread(target=server.serve_forever)
            worker.daemon = True
            worker.start()
            try:
                url = 'http://127.0.0.1:' + str(server.server_port) + '/'
                with urllib.request.urlopen(url) as response:
                    etag = response.headers['ETag']
                asset.write_bytes(b'new content')
                request = urllib.request.Request(url, headers={'If-None-Match': etag})
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                    self.assertNotEqual(response.headers['ETag'], etag)
                    self.assertIn(hashlib.sha1(b'new content').hexdigest()[:10], response.read().decode('utf-8'))
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_updates_existing_versions_and_leaves_external_urls_alone(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'lib').mkdir()
            asset = root / 'lib/math-init.js'
            asset.write_bytes(b'new formula parser')
            digest = hashlib.sha1(asset.read_bytes()).hexdigest()[:10]
            html = '<script src="lib/math-init.js?v=old"></script><script src="https://example.com/lib/a.js?v=old"></script>'
            result = cache.refresh_html_assets(html, root)
            self.assertIn('lib/math-init.js?v=' + digest, result)
            self.assertIn('https://example.com/lib/a.js?v=old', result)

    def test_existing_server_repository_page_uses_current_assets_without_rebuild(self):
        fixture = test_plan_integration.PlanIntegrationTests()
        fixture.setUp()
        try:
            (fixture.docs / 'html').mkdir(exist_ok=True)
            (fixture.docs / 'lib').mkdir(exist_ok=True)
            asset = fixture.docs / 'lib/math-init.js'
            asset.write_bytes(b'updated')
            page = fixture.docs / 'html/index_server_only.html'
            original = '<!doctype html><base href="../"><script src="lib/math-init.js?v=old"></script>'
            page.write_text(original, encoding='utf-8')
            response = fixture.client.get('/html/index_server_only.html')
            try:
                self.assertEqual(response.status_code, 200)
                self.assertIn('lib/math-init.js?v=' + hashlib.sha1(b'updated').hexdigest()[:10], response.get_data(as_text=True))
                self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                self.assertEqual(page.read_text(encoding='utf-8'), original)
            finally:
                response.close()
        finally:
            fixture.tearDown()
