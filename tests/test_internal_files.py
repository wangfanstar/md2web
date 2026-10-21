import tempfile
import unittest
from pathlib import Path
from server import internal_files


class InternalFileTests(unittest.TestCase):
    def test_search_safe_files_and_office_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('pdf/协议 #1.pdf', 'ppt/demo.pptx', 'html/report.html',
                         'html/md2web_config_private.json', '.hidden/private.pdf',
                         'reference-trash/a.pdf', 'lib/example.html', 'config/a.pdf'):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('fixture', encoding='utf-8')
            rows = internal_files.search(root, '')
            self.assertEqual(len(rows), 3)
            item = internal_files.search(root, '协议')[0]
            self.assertIn('%23', item['href'])
            ppt = internal_files.search(root, 'demo')[0]
            self.assertEqual(ppt['href'], 'html/reference_preview.html?kind=ppt&path=demo.pptx')
