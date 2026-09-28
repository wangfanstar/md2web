"""Directory source classification and safe top-level link management."""
from __future__ import print_function

import os
import stat
import subprocess


_REPARSE = 0x0400
_TAG_MOUNT_POINT = 0xA0000003
_TAG_SYMLINK = 0xA000000C


class FolderLinkError(ValueError):
    """链接管理错误：code 供接口层直接回传前端。"""

    def __init__(self, code, message):
        super(FolderLinkError, self).__init__(message)
        self.code = code


def _path(value):
    return os.path.abspath(os.fspath(value))


def _windows_reparse_tag(path):
    """读取 Windows 重解析点标记（Python 3.6/3.7 无 st_reparse_tag 时的回退）。"""
    try:
        import ctypes
        import struct
        from ctypes import wintypes
    except (ImportError, AttributeError, ValueError):
        return None
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                         ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                         wintypes.HANDLE]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                                             ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        kernel32.DeviceIoControl.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.CreateFileW(_path(path), 0x80, 0x7, None, 3,
                                      0x02000000 | 0x00200000, None)
        if not handle or handle == ctypes.c_void_p(-1).value:
            return None
        try:
            buffer = ctypes.create_string_buffer(16384)
            returned = wintypes.DWORD(0)
            ok = kernel32.DeviceIoControl(handle, 0x000900A8, None, 0, buffer,
                                          ctypes.sizeof(buffer), ctypes.byref(returned), None)
            if not ok or returned.value < 8:
                return None
            return struct.unpack('<I', buffer.raw[0:4])[0]
        finally:
            kernel32.CloseHandle(handle)
    except (OSError, ValueError):
        return None


def is_directory_link(path):
    """Return true for a directory symlink, Windows junction, or dangling link."""
    path = _path(path)
    try:
        info = os.lstat(path)
    except (OSError, ValueError):
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attrs = getattr(info, 'st_file_attributes', 0)
    if not attrs & _REPARSE:
        return False
    tag = getattr(info, 'st_reparse_tag', None)
    if tag is None and os.name == 'nt':
        tag = _windows_reparse_tag(path)
    if tag is not None:
        return tag in (_TAG_MOUNT_POINT, _TAG_SYMLINK)
    try:
        real = os.path.normcase(os.path.realpath(path))
        return real != os.path.normcase(path)
    except (OSError, ValueError):
        return False


def describe(path):
    path = _path(path)
    if is_directory_link(path):
        try:
            target = os.path.realpath(path)
        except OSError:
            target = ''
        return {'sourceMode': 'symlink', 'linkTarget': target,
                'linkExists': bool(target and os.path.isdir(target))}
    return {'sourceMode': 'local', 'linkTarget': '',
            'linkExists': bool(os.path.isdir(path))}


def _ignored(name):
    return name.startswith('.') or name == '回收站'


def walk_paths(root):
    """Yield lexical paths; follow links directly below *root* only, never nested links."""
    root = _path(root)
    if not os.path.isdir(root):
        return
    seen = set()

    def visit(directory, lexical):
        real = os.path.realpath(directory)
        if real in seen:
            return
        seen.add(real)
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return
        for name in names:
            if _ignored(name):
                continue
            actual = os.path.join(directory, name)
            out = os.path.join(lexical, name)
            if os.path.isdir(actual):
                yield out
                if not is_directory_link(actual):
                    for child in visit(actual, out):
                        yield child
            elif os.path.isfile(actual):
                yield out

    for name in sorted(os.listdir(root)):
        if _ignored(name):
            continue
        actual = os.path.join(root, name)
        out = os.path.join(root, name)
        if os.path.isdir(actual):
            yield out
            for child in visit(actual, out):
                yield child
        elif os.path.isfile(actual):
            yield out


def _mount_path(md_dir, mount):
    root = _path(md_dir)
    value = str(mount).replace('\\', '/').strip('/')
    if value.startswith('md/'):
        value = value[3:]
    if not value or '/' in value or value in ('.', '..'):
        raise ValueError('mount 必须是 md 下的一级文件夹')
    return root, os.path.join(root, value)


def _inside(path, parent):
    try:
        return os.path.commonpath([_path(path), _path(parent)]) == _path(parent)
    except (ValueError, AttributeError):
        return False


def manage_link(md_dir, mount, target, action):
    """Check, create, or remove a safe top-level directory link."""
    root, link = _mount_path(md_dir, mount)
    action = str(action or 'check').lower()
    if action not in ('check', 'create', 'remove'):
        raise FolderLinkError('link_action_invalid', 'action 必须是 check、create 或 remove')
    if action == 'check':
        return describe(link)
    if action == 'remove':
        if not is_directory_link(link):
            raise FolderLinkError('not_a_link', '该位置不是目录链接，无需移除')
        if os.path.islink(link):
            os.unlink(link)
        else:
            os.rmdir(link)
        return describe(link)
    target = _path(target)
    if not os.path.isdir(target):
        raise FolderLinkError('link_target_invalid', '软链接目标必须是已存在的文件夹: %s' % target)
    if _inside(target, root) or _inside(root, target):
        raise FolderLinkError('link_target_invalid', '软链接目标不能位于 md 根目录及其内部')
    if os.path.lexists(link):
        if is_directory_link(link):
            raise FolderLinkError('link_exists', '目标位置已存在链接，请先移除链接')
        if not os.path.isdir(link) or os.listdir(link):
            raise FolderLinkError('link_not_empty', '目标位置已有非空目录，不能替换为软链接')
        os.rmdir(link)
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError:
        if os.name != 'nt':
            raise
        # Junctions do not require SeCreateSymbolicLinkPrivilege.
        try:
            subprocess.check_call(['cmd', '/c', 'mklink', '/J', link, target],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except (OSError, subprocess.CalledProcessError):
            raise
    return describe(link)


def has_link_ancestor(md_dir, relative):
    """Whether a path under md resolves through a linked directory."""
    root = _path(md_dir)
    rel = str(relative).replace('\\', '/').lstrip('/')
    if rel.startswith('md/'):
        rel = rel[3:]
    current = root
    for part in [x for x in rel.split('/') if x and x not in ('.', '..')]:
        current = os.path.join(current, part)
        if is_directory_link(current):
            return True
        if not os.path.isdir(current):
            break
    return False
