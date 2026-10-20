import sys
import json
import threading
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_setup_docsify import TempDirTestCase


class HomeRepositoryTests(TempDirTestCase):
    def test_catalog_discovers_folders_missing_from_build_snapshot(self):
        from server.site_catalog import repository_catalog
        self.write_doc('使用说明/start.md', '# Start')
        self.write_doc('原有资料/guide.md', '# Guide')
        self.write_doc('.hidden/private.md', '# Private')
        self.write_doc('回收站/deleted.md', '# Deleted')
        config = {'repositories': [{'id': 'stable', 'mount': 'md/原有资料',
                                   'display_name': '原有资料库', 'source_mode': 'local',
                                   'password': 'not-public'}], 'folder_groups': {'md/原有资料': '原分组'}}
        result = repository_catalog(self.docs, config)
        self.assertEqual({item['mount'] for item in result}, {'md/使用说明', 'md/原有资料'})
        original = next(item for item in result if item['id'] == 'stable')
        self.assertEqual(original['display_name'], '原有资料库')
        self.assertEqual(original['group'], '原分组')
        self.assertTrue(original['href'].startswith('html/index_all.html#/md/'))
        self.assertNotIn('not-public', str(result))
        self.assertEqual(config['repositories'][0]['id'], 'stable')

    def test_existing_entry_and_unprovisioned_configured_repository_are_retained(self):
        from server.site_catalog import repository_catalog
        (self.docs / 'html').mkdir()
        (self.docs / 'html/index_stable.html').write_text('entry')
        config = {'repositories': [{'id': 'stable', 'mount': 'md/not-yet-synced', 'source_mode': 'svn'}]}
        result = repository_catalog(self.docs, config)
        self.assertEqual(result[0]['href'], 'html/index_stable.html')
        self.assertEqual(result[0]['mount'], 'md/not-yet-synced')

    def test_home_includes_runtime_catalog_without_removing_offline_cards(self):
        self.module.generate_master_index_html([{'id': 'original', 'mount': 'md/original', 'group': '组', 'source_mode': 'local'}], reference_web=[])
        page = (self.docs / 'index.html').read_text(encoding='utf-8')
        self.assertIn('data-master-repositories', page)
        self.assertIn('lib/home-repositories.js', page)
        self.assertIn('html/index_original.html', page)
        self.assertIn('md2web:repositories', page)

    def test_preview_catalog_uses_served_directory_without_authentication(self):
        import serve
        self.write_doc('existing-on-server/a.md', '# Server document')
        server, port = serve.make_server(self.docs, '127.0.0.1', 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open('http://127.0.0.1:%d/__site/repositories' % port) as response:
                data = json.loads(response.read().decode('utf-8'))
            self.assertTrue(data['ok'])
            self.assertEqual([r['mount'] for r in data['repositories']], ['md/existing-on-server'])
        finally:
            server.shutdown()
            server.server_close()
