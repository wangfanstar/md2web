"""Authenticated source browsing and optional GNU Global indexes."""
import os
import shutil
import subprocess
from pathlib import Path
from . import code_qa, folder_sources


def build_index(root):
    executable = shutil.which('gtags')
    if not executable:
        return 'gtags 未安装，使用文件检索'
    try:
        subprocess.run([executable], cwd=str(root), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=300, check=True)
        return 'gtags 索引已更新'
    except (OSError, subprocess.SubprocessError):
        for name in ('GTAGS', 'GRTAGS', 'GPATH'):
            try:
                (root / name).unlink()
            except OSError:
                pass
        return 'gtags 索引失败，使用文件检索'


def safe_path(root, relative=''):
    current = root
    for part in relative.split('/') if relative else []:
        if not part or part.startswith('.') or part in ('GTAGS', 'GRTAGS', 'GPATH', 'node_modules') or ':' in part or '\\' in part:
            raise ValueError('代码路径无效')
        current = current / part
        if current.is_symlink() or folder_sources.is_directory_link(current):
            raise ValueError('代码路径不能包含链接')
    if current != root and root not in current.resolve().parents:
        raise ValueError('代码路径越界')
    return current


def files(root):
    count = 0
    for parent, dirs, names in os.walk(str(root), followlinks=False):
        dirs[:] = sorted(n for n in dirs if not n.startswith('.') and n not in ('node_modules', '__pycache__') and not folder_sources.is_directory_link(Path(parent) / n))
        for name in sorted(names):
            try:
                path = safe_path(root, (Path(parent) / name).relative_to(root).as_posix())
                if path.is_file() and path.stat().st_size <= 2 * 1024 * 1024:
                    yield path
                    count += 1
                    if count >= 10000:
                        return
            except (ValueError, OSError):
                continue


def text(path):
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('文件超过 2 MB')
    raw = path.read_bytes()
    if len(raw) > 2 * 1024 * 1024 or b'\x00' in raw:
        raise ValueError('文件为二进制或超过 2 MB')
    try:
        return raw.decode('utf-8-sig')
    except UnicodeError:
        return raw.decode('gb18030', errors='replace')


def global_search(root, query, mode):
    executable = shutil.which('global')
    if not executable or not (root / 'GTAGS').is_file():
        return None
    import re
    args = [executable, '--result=grep', '-e', re.escape(query)]
    args.insert(1, '-P' if mode == 'path' else '-g')
    env = os.environ.copy()
    env['GTAGSROOT'] = str(root)
    env['GTAGSDBPATH'] = str(root)
    try:
        output = subprocess.run(args, cwd=str(root), env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=15, check=False)
        if output.returncode not in (0, 1) or len(output.stdout) > 4 * 1024 * 1024:
            return None
        hits = []
        for line in output.stdout.decode('utf-8', errors='replace').splitlines():
            parts = line.split(':', 2)
            relative = parts[0][2:] if parts[0].startswith('./') else parts[0]
            safe_path(root, relative)
            number = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 1
            hits.append({'path': relative, 'line': number, 'text': parts[2][:300] if len(parts) > 2 else relative})
            if len(hits) >= 200:
                break
        return hits
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
