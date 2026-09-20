"""Regression coverage for multi-folder navigation and engineering search."""
import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from test_setup_docsify import TempDirTestCase


class WorkspaceTests(TempDirTestCase):
    def test_offline_build_never_downloads_missing_dependencies(self):
        self.write_doc('a.md', '# A')
        with mock.patch.object(self.module, '_download') as download:
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    self.module.main(['--offline'])
        self.assertEqual(error.exception.code, 1)
        download.assert_not_called()
        self.assertFalse((self.docs / 'index.html').exists())

    def test_offline_language_component_missing_only_warns(self):
        self.write_doc('a.md', '```python\nprint(1)\n```')
        with mock.patch.object(self.module, '_download') as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_prism_components(self.md, ['a.md'], offline=True)
        download.assert_not_called()

    def test_single_document_folders_keep_identity(self):
        paths = ['硬件/接口/README.md', '软件/接口/README.md']
        with redirect_stdout(io.StringIO()):
            self.module.generate_sidebar(paths)
        text = (self.module.HTML_DIR / '_sidebar.md').read_text(encoding='utf-8')
        self.assertIn('**硬件**', text)
        self.assertIn('**软件**', text)
        self.assertEqual(text.count('**接口**'), 2)
        self.assertIn('/md/硬件/接口/README.md', text)
        self.assertIn('/md/软件/接口/README.md', text)

    def test_home_groups_counts_and_offline_instructions(self):
        paths = ['硬件/接口/a.md', '硬件/b.md', '软件/c.md', 'root.md']
        with redirect_stdout(io.StringIO()):
            self.module.generate_readme(paths, '工程文档')
        text = (self.module.HTML_DIR / 'README.md').read_text(encoding='utf-8')
        self.assertIn('workspace-folder-grid', text)
        self.assertEqual(text.count('class="workspace-folder-card"'), 3)
        self.assertIn('4 篇文档', text)
        self.assertIn('3 个文件夹', text)
        self.assertIn('Ctrl', text)
        self.assertIn('setup_docsify.py', text)
        self.assertIn('[a](md/硬件/接口/a.md)', text)

    def test_home_escapes_folder_and_title_html(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_readme(['A&B/<b>.md'], '<img src=x>')
        text = (self.module.HTML_DIR / 'README.md').read_text(encoding='utf-8')
        self.assertNotIn('<img src=x>', text)
        self.assertIn('A&amp;B', text)

    def test_code_is_searchable_without_creating_fake_heading(self):
        content = '# API\n\n```python\n# CODE_COMMENT\nREG_CTRL = 0x80\n```\n\n## Next\nend'
        page = self.module.build_page_index('/md/a.md', content, 4)
        self.assertEqual(len(page), 2)
        self.assertIn('REG_CTRL = 0x80', page['/md/a.md?id=api']['body'])
        self.assertIn('# CODE_COMMENT', page['/md/a.md?id=api']['body'])

    def test_short_fence_inside_code_does_not_end_section(self):
        content = '# A\n````md\n```\n# not a heading\n````\n## B\nbody'
        page = self.module.build_page_index('/md/a.md', content, 4)
        self.assertEqual(set(page), {'/md/a.md?id=a', '/md/a.md?id=b'})
        self.assertIn('# not a heading', page['/md/a.md?id=a']['body'])

    def test_generated_html_loads_local_workspace_assets(self):
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html()
        text = (self.docs / 'index.html').read_text(encoding='utf-8')
        self.assertIn('src="lib/workspace.js"', text)
        self.assertIn('href="lib/workspace.css"', text)


if __name__ == '__main__':
    unittest.main()
