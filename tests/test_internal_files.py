import tempfile
import unittest
import json
from pathlib import Path
from server import internal_files


class InternalFileTests(unittest.TestCase):
    def test_markdown_link_search_includes_document_and_heading(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'html').mkdir()
            (root / 'md/A').mkdir(parents=True)
            (root / 'md/A/read.md').write_text('# Title', encoding='utf-8')
            route = '/md/A/read.md'
            index = {route: {'site': 'html/index_A.html',
                route+'?id=重复-1': {'slug': route+'?id=重复-1', 'pageTitle': '说明', 'headingTitle': '重复'}}}
            (root / 'html/search-index.json').write_text(json.dumps(index), encoding='utf-8')
            rows = internal_files.markdown_links(root, '')
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['kind'], 'document')
            self.assertEqual(internal_files.markdown_links(root, '重复'), [])
            self.assertEqual(internal_files.markdown_links(root, '', 'md/A/other.md'), [])
            self.assertEqual(internal_files.markdown_links(root, '重复', 'md/A/read.md')[0]['href'],
                             'html/index_A.html#/md/A/read.md?id=重复-1')
            (root / 'md/A/read.md').unlink()
            self.assertEqual(internal_files.markdown_links(root, ''), [])
            self.assertEqual(internal_files.markdown_links(root, '', 'md/A/read.md'), [])

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
            self.assertIn('协议', item['href'])
            ppt = internal_files.search(root, 'demo')[0]
            self.assertEqual(ppt['href'], 'html/reference_preview.html?kind=ppt&path=demo.pptx')

    def test_readable_url_keeps_unicode_and_escapes_delimiters(self):
        self.assertEqual(internal_files.readable_quote('中文/标题 #?%&"', safe='/'),
                         '中文/标题%20%23%3F%25%26%22')
