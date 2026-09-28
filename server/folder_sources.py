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


def _windows_reparse_info(path):
    """读取 Windows 重解析点 (tag, 替代名)（Python 3.6/3.7 无 st_reparse_tag 时的回退）。"""
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
            tag = struct.unpack_from('<I', buffer.raw, 0)[0]
            target = ''
            if tag in (_TAG_MOUNT_POINT, _TAG_SYMLINK) and returned.value >= 16:
                offset, length = struct.unpack_from('<HH', buffer.raw, 8)
                if length:
                    raw = buffer.raw[16 + offset:16 + offset + length]
                    target = raw.decode('utf-16-le', 'replace')
                    for prefix in ('\\??\\', '\\\\?\\'):
                        if target.startswith(prefix):
                            target = target[len(prefix):]
                            break
            return tag, target
        finally:
            kernel32.CloseHandle(handle)
    except (OSError, ValueError):
        return None


def _windows_final_path(path):
    """跟随链接取得最终本地路径（Python 3.6 的 realpath 不解析 Windows 联接）。"""
    try:
        import ctypes
        from ctypes import wintypes
    except (ImportError, AttributeError, ValueError):
        return ''
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                         ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                         wintypes.HANDLE]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR,
                                                       wintypes.DWORD, wintypes.DWORD]
        kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.CreateFileW(_path(path), 0, 0x7, None, 3, 0x02000000, None)
        if not handle or handle == ctypes.c_void_p(-1).value:
            return ''
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            length = kernel32.GetFinalPathNameByHandleW(handle, buffer, 32768, 0)
            if not length or length >= 32768:
                return ''
            value = buffer.value
            for prefix in ('\\\\?\\UNC\\', '\\\\?\\'):
                if value.startswith(prefix):
                    value = value[len(prefix):]
                    if prefix.startswith('\\\\?\\UNC'):
                        value = '\\\\' + value
                    break
            return value
        finally:
            kernel32.CloseHandle(handle)
    except (OSError, ValueError):
        return ''


def _link_target(path):
    """链接目标：优先 realpath，Windows 3.6 走句柄解析，悬空链接退回重解析点替代名。"""
    path = _path(path)
    real = os.path.realpath(path)
    if os.path.normcase(real) != os.path.normcase(path):
        return real
    if os.name == 'nt':
        final = _windows_final_path(path)
        if final:
            return final
        info = _windows_reparse_info(path)
        if info and info[1]:
            return info[1]
    return real


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
        reparse = _windows_reparse_info(path)
        tag = reparse[0] if reparse else None
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
        target = _link_target(path)
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
