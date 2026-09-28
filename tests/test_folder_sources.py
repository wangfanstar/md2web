import os
import subprocess
import tempfile
import unittest

from server.folder_sources import (FolderLinkError, describe, has_link_ancestor,
                                    is_directory_link, manage_link, walk_paths)


def make_dir_link(link, target):
    """创建目录链接：优先符号链接，Windows 无权限时回退目录联接。"""
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    if os.name != 'nt':
        return False
    try:
        subprocess.check_call(['cmd', '/c', 'mklink', '/J', link, target],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


class FolderSourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.md = os.path.join(self.tmp, 'md')
        self.target = os.path.join(self.tmp, 'external')
        os.makedirs(self.md)
        os.makedirs(os.path.join(self.target, 'docs'))
        with open(os.path.join(self.target, 'docs', 'a.md'), 'w') as fh:
            fh.write('a')

    def test_create_describe_remove_and_guard(self):
        info = manage_link(self.md, 'md/ext', self.target, 'create')
        self.assertEqual(info['sourceMode'], 'symlink')
        self.assertTrue(info['linkExists'])
        self.assertTrue(is_directory_link(os.path.join(self.md, 'ext')))
        self.assertTrue(has_link_ancestor(self.md, 'ext/docs/a.md'))
        self.assertFalse(has_link_ancestor(self.md, 'local/a.md'))
        manage_link(self.md, 'ext', self.target, 'remove')
        self.assertFalse(os.path.lexists(os.path.join(self.md, 'ext')))

    def test_reject_unsafe_and_overwrite(self):
        with self.assertRaises(ValueError):
            manage_link(self.md, 'md/a/b', self.target, 'create')
        with self.assertRaises(ValueError):
            manage_link(self.md, 'md/md', self.md, 'create')
        os.makedirs(os.path.join(self.md, 'existing'))
        with open(os.path.join(self.md, 'existing', 'keep.md'), 'w') as fh:
            fh.write('x')
        with self.assertRaises(ValueError):
            manage_link(self.md, 'existing', self.target, 'create')

    def test_broken_link_is_reported_as_symlink(self):
        try:
            os.symlink(os.path.join(self.tmp, 'missing'), os.path.join(self.md, 'broken'),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        info = describe(os.path.join(self.md, 'broken'))
        self.assertEqual(info['sourceMode'], 'symlink')
        self.assertFalse(info['linkExists'])
        self.assertTrue(is_directory_link(os.path.join(self.md, 'broken')))

    def test_empty_directory_can_be_replaced_by_link(self):
        os.makedirs(os.path.join(self.md, 'empty'))
        info = manage_link(self.md, 'empty', self.target, 'create')
        self.assertEqual(info['sourceMode'], 'symlink')
        self.assertTrue(info['linkExists'])
        with self.assertRaises(FolderLinkError) as caught:
            manage_link(self.md, 'empty', self.target, 'create')
        self.assertEqual(caught.exception.code, 'link_exists')

    def test_non_empty_directory_cannot_be_replaced(self):
        os.makedirs(os.path.join(self.md, 'busy'))
        with open(os.path.join(self.md, 'busy', 'x.md'), 'w') as fh:
            fh.write('x')
        with self.assertRaises(FolderLinkError) as caught:
            manage_link(self.md, 'busy', self.target, 'create')
        self.assertEqual(caught.exception.code, 'link_not_empty')

    def test_nested_links_inside_target_are_not_followed(self):
        nested_target = os.path.join(self.tmp, 'nested-target')
        os.makedirs(os.path.join(nested_target, 'deep'))
        with open(os.path.join(nested_target, 'deep', 'deep.md'), 'w') as fh:
            fh.write('deep')
        if not make_dir_link(os.path.join(self.target, 'nested-link'), nested_target):
            self.skipTest('symlink unavailable')
        manage_link(self.md, 'ext', self.target, 'create')
        paths = [p.replace('\\', '/') for p in walk_paths(self.md)]
        self.assertIn(self.md.replace('\\', '/') + '/ext/docs/a.md', paths)
        self.assertIn(self.md.replace('\\', '/') + '/ext/nested-link', paths)
        self.assertNotIn(self.md.replace('\\', '/') + '/ext/nested-link/deep/deep.md', paths)

    def test_walk_follows_only_top_level_link(self):
        os.makedirs(os.path.join(self.target, 'nested'))
        with open(os.path.join(self.target, 'nested', 'b.md'), 'w') as fh:
            fh.write('b')
        nested_target = os.path.join(self.tmp, 'nested-target')
        os.makedirs(nested_target)
        if not make_dir_link(os.path.join(self.target, 'nested-link'), nested_target):
            self.skipTest('symlink unavailable')
        manage_link(self.md, 'ext', self.target, 'create')
        paths = [p.replace('\\', '/') for p in walk_paths(self.md)]
        self.assertIn(self.md.replace('\\', '/') + '/ext/docs/a.md', paths)
        self.assertIn(self.md.replace('\\', '/') + '/ext/nested/b.md', paths)
        # 嵌套链接只作为目录条目出现，不展开其内容（防循环）
        prefix = self.md.replace('\\', '/') + '/ext/nested-link'
        self.assertIn(prefix, paths)
        self.assertFalse([p for p in paths if p.startswith(prefix + '/')])


if __name__ == '__main__':
    unittest.main()
