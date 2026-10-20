import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_docsify as build


class NavigationPlanTests(unittest.TestCase):
    def test_navigation_uses_authoritative_pages_and_public_fields(self):
        repos = [{'id': 'stable', 'mount': 'md/中文', 'display_name': '显示名',
                  'password': 'MUST NOT LEAK'}]
        data = build.navigation_data({'中文': 'index_stable.html',
                                      '中文/子目录': 'index_stable_child-2.html'}, repos)
        self.assertEqual(data['folders']['md/中文/子目录']['href'],
                         'html/index_stable_child-2.html')
        self.assertEqual(data['folders']['md/中文']['label'], '显示名')
        self.assertNotIn('MUST NOT LEAK', str(data))

    def test_version_changes_with_content_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'html').mkdir()
            (root / 'html/search-index.json').write_text('{}')
            first = build.publish_site_version(root)
            self.assertEqual(first, build.publish_site_version(root))
            (root / 'html/search-index.json').write_text('{"new":1}')
            second = build.publish_site_version(root)
            self.assertNotEqual(first['searchVersion'], second['searchVersion'])

