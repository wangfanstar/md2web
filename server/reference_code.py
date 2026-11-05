"""Authenticated source browsing and optional GNU Global indexes."""
import os
import json
import shutil
import subprocess
import re
import collections
import threading
import time
from itertools import chain, islice
from pathlib import Path
from . import code_qa, folder_sources

# 源码页会反复打开同一文件、实时搜索也会重复读取；用有界缓存避免重复解码。
_TEXT_CACHE = collections.OrderedDict()
_TEXT_CACHE_LOCK = threading.Lock()
_TEXT_CACHE_BYTES = 16 * 1024 * 1024
_TEXT_CACHE_ENTRIES = 32
_SKIP_NAMES = ('GTAGS', 'GRTAGS', 'GPATH', 'node_modules', '__pycache__')


def _cached_text(key):
    with _TEXT_CACHE_LOCK:
        value = _TEXT_CACHE.get(key)
        if value is not None:
            _TEXT_CACHE.move_to_end(key)
        return value


def _remember_text(key, value):
    with _TEXT_CACHE_LOCK:
        _TEXT_CACHE[key] = value
        _TEXT_CACHE.move_to_end(key)
        while _TEXT_CACHE and (len(_TEXT_CACHE) > _TEXT_CACHE_ENTRIES or
                               sum(len(item) for item in _TEXT_CACHE.values()) > _TEXT_CACHE_BYTES):
            _TEXT_CACHE.popitem(last=False)


def clear_text_cache():
    with _TEXT_CACHE_LOCK:
        _TEXT_CACHE.clear()


def validate_symbol(symbol):
    if not isinstance(symbol, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', symbol):
        raise ValueError('符号名称无效')
    return symbol


def build_index(root):
    executable = shutil.which('gtags')
    if not executable:
        return 'gtags 未安装，使用文件检索'
    names = ('GTAGS', 'GRTAGS', 'GPATH')
    backups = {}
    for name in names:
        source = root / name
        if source.is_file():
            target = root / ('.md2web-gtags-backup-' + name)
            try:
                os.replace(str(source), str(target))
                backups[name] = target
            except OSError:
                pass
    try:
        subprocess.run([executable], cwd=str(root), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=300, check=True)
        return 'gtags 索引已更新'
    except (OSError, subprocess.SubprocessError):
        # 保留上一份完整索引，避免一次失败的重建让符号搜索退化为文本扫描。
        for name in names:
            try:
                (root / name).unlink()
            except OSError:
                pass
        for name, target in backups.items():
            try:
                os.replace(str(target), str(root / name))
            except OSError:
                pass
        return 'gtags 索引失败，使用文件检索'
    finally:
        for target in backups.values():
            try:
                target.unlink()
            except OSError:
                pass


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
        dirs[:] = sorted(n for n in dirs if not n.startswith('.') and n not in _SKIP_NAMES
                         and not folder_sources.is_directory_link(Path(parent) / n))
        for name in sorted(names):
            if name.startswith('.') or name in _SKIP_NAMES:
                continue
            path = Path(parent) / name
            try:
                if path.is_symlink() or not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
                    continue
            except OSError:
                continue
            yield path
            count += 1
            if count >= 10000:
                return


def text(path):
    try:
        info = path.stat()
    except OSError:
        raise ValueError('文件不存在或无法读取')
    if info.st_size > 2 * 1024 * 1024:
        raise ValueError('文件超过 2 MB')
    key = (str(path), getattr(info, 'st_mtime_ns', info.st_mtime), info.st_size)
    cached = _cached_text(key)
    if cached is not None:
        return cached
    raw = path.read_bytes()
    if len(raw) > 2 * 1024 * 1024 or b'\x00' in raw:
        raise ValueError('文件为二进制或超过 2 MB')
    try:
        value = raw.decode('utf-8-sig')
    except UnicodeError:
        value = raw.decode('gb18030', errors='replace')
    _remember_text(key, value)
    return value


_SEARCH_CACHE = collections.OrderedDict()
_SEARCH_CACHE_LOCK = threading.Lock()


def global_search(root, query, mode, timeout=15):
    try:
        signature = tuple((name, (root / name).stat().st_mtime, (root / name).stat().st_size)
                          for name in ('GTAGS', 'GRTAGS', 'GPATH') if (root / name).is_file())
    except OSError:
        signature = ()
    key = (str(root.resolve()), query, mode, signature)
    with _SEARCH_CACHE_LOCK:
        cached = _SEARCH_CACHE.get(key)
        if cached and cached[0] > time.monotonic():
            _SEARCH_CACHE.move_to_end(key)
            return [dict(hit) for hit in cached[1]]
    hits = _global_search(root, query, mode, timeout)
    if hits is not None:
        with _SEARCH_CACHE_LOCK:
            _SEARCH_CACHE[key] = (time.monotonic() + 5, hits)
            _SEARCH_CACHE.move_to_end(key)
            while len(_SEARCH_CACHE) > 128:
                _SEARCH_CACHE.popitem(last=False)
    return None if hits is None else [dict(hit) for hit in hits]


def _global_search(root, query, mode, timeout=15):
    executable = shutil.which('global')
    if not executable or not (root / 'GTAGS').is_file():
        return None
    flags = {'path': '-P', 'text': '-g', 'definition': '-d', 'reference': '-r',
             'symbol': '-s', 'symbol_partial': '-s',
             'definition_partial': '-d', 'reference_partial': '-r'}
    pattern = query if mode in ('definition', 'reference', 'symbol') else re.escape(query)
    if mode.endswith('_partial'):
        # A plain identifier is an exact tag lookup in Global, even with -e.
        pattern = '.*' + re.escape(query) + '.*'
    args = [executable, flags[mode], '--result=grep', '-e', pattern]
    if mode.endswith('_partial'):
        args.insert(2, '-i')
    env = os.environ.copy()
    env['GTAGSROOT'] = str(root)
    env['GTAGSDBPATH'] = str(root)
    try:
        output = subprocess.run(args, cwd=str(root), env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        if output.returncode not in (0, 1):
            return None
        hits = []
        for line in output.stdout.decode('utf-8', errors='replace').splitlines():
            parts = line.split(':', 2)
            relative = parts[0][2:] if parts[0].startswith('./') else parts[0]
            try:
                safe_path(root, relative)
            except ValueError:
                continue
            number = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 1
            hits.append({'path': relative, 'line': number, 'text': parts[2][:300] if len(parts) > 2 else relative})
            if len(hits) >= 200:
                break
        return hits
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def symbol_occurrences(root, query, quick=False, preferred=None):
    """按片段匹配函数/符号名；没有 GNU Global 时用于实时符号搜索。"""
    validate_symbol(query)
    needle = query.lower()
    identifier = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
    hits = []
    candidates = files(root)
    if quick:
        candidates = islice(candidates, 48)
        if preferred:
            first = safe_path(root, preferred)
            if first.is_file():
                candidates = chain([first], (path for path in candidates if path != first))
        deadline = time.monotonic() + 0.5
    for path in candidates:
        if quick and time.monotonic() >= deadline:
            break
        try:
            lines = text(path).splitlines()
        except (OSError, ValueError):
            continue
        for number, line in enumerate(lines, 1):
            if needle not in line.lower():
                continue
            if not any(needle in token.lower() for token in identifier.findall(line)):
                continue
            hits.append({'path': path.relative_to(root).as_posix(), 'line': number, 'text': line[:300]})
            if len(hits) >= (8 if quick else 200):
                return {'hits': hits, 'engine': '文本匹配（最多 200 条）'}
    return {'hits': hits, 'engine': '文本匹配'}


def rg_symbols(root, query, quick=False):
    executable = shutil.which('rg')
    if not executable:
        return None
    args = [executable, '--json', '--fixed-strings', '--ignore-case', '--max-filesize', '2M',
            '--max-count', '8', '--glob', '!GTAGS', '--glob', '!GRTAGS', '--glob', '!GPATH',
            '--glob', '!node_modules/**', '--glob', '!__pycache__/**', '--glob', '!回收站/**',
            '--', query, '.']
    try:
        result = subprocess.run(args, cwd=str(root), stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=1 if quick else 5, check=False)
        if result.returncode not in (0, 1):
            return None
        hits = []
        needle = query.lower()
        for raw in result.stdout.decode('utf-8', errors='replace').splitlines():
            record = json.loads(raw)
            if record.get('type') != 'match':
                continue
            data = record['data']
            relative = data.get('path', {}).get('text', '')
            relative = relative.replace('\\', '/')
            if relative.startswith('./'):
                relative = relative[2:]
            if not relative or any(part in ('node_modules', '__pycache__', '回收站') for part in relative.split('/')):
                continue
            try:
                safe_path(root, relative)
            except ValueError:
                continue
            line = data.get('lines', {}).get('text', '').rstrip('\r\n')
            if not any(needle in token.lower() for token in re.findall(r'[A-Za-z_][A-Za-z0-9_]*', line)):
                continue
            hits.append({'path': relative, 'line': data['line_number'], 'text': line[:300]})
            if len(hits) >= (8 if quick else 200):
                break
        return {'hits': hits, 'engine': 'ripgrep · 源码匹配'}
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def search_symbols(root, query, quick=False, preferred=None):
    """Search definitions first, then references and other indexed symbols."""
    validate_symbol(query)
    # Bare identifiers use Global's direct tag lookup; anchored regexps scan tags.
    hits = global_search(root, query, 'definition', timeout=2)
    if hits:
        return {'hits': hits, 'engine': 'GNU Global · 精确函数定义'}
    definitions = global_search(root, query, 'definition_partial', timeout=3) if hits is not None else None
    if definitions:
        return {'hits': definitions, 'engine': 'GNU Global · 函数与定义'}
    if quick:
        result = symbol_occurrences(root, query, quick=True, preferred=preferred)
        if not result['hits']:
            result = rg_symbols(root, query, quick=True) or result
        result.update(limited=True, engine='源码快速匹配')
        return result
    groups = [global_search(root, query, mode, timeout=5) for mode in
              ('reference_partial', 'symbol_partial')] if definitions is not None else []
    if all(not group for group in groups):
        fast = rg_symbols(root, query)
        return fast if fast is not None else symbol_occurrences(root, query)
    hits, seen = [], set()
    for group in groups:
        for hit in group or []:
            key = (hit['path'], hit['line'])
            if key not in seen:
                seen.add(key)
                hits.append(hit)
                if len(hits) >= 200:
                    return {'hits': hits, 'engine': 'GNU Global'}
    return {'hits': hits, 'engine': 'GNU Global'}


def symbol_locations(root, symbol):
    validate_symbol(symbol)
    definitions = global_search(root, symbol, 'definition')
    references = global_search(root, symbol, 'reference')
    if references == []:
        references = global_search(root, symbol, 'symbol')
    if definitions is not None and references is not None:
        return {'definitions': definitions, 'references': references, 'engine': 'GNU Global', 'indexed': True}
    occurrences = []
    pattern = re.compile(r'\b' + re.escape(symbol) + r'\b')
    for path in files(root):
        try:
            lines = text(path).splitlines()
        except (OSError, ValueError):
            continue
        for number, line in enumerate(lines, 1):
            if pattern.search(line):
                occurrences.append({'path': path.relative_to(root).as_posix(), 'line': number, 'text': line[:300]})
                if len(occurrences) >= 200:
                    return {'definitions': [], 'references': occurrences, 'engine': '文本匹配（最多 200 条）', 'indexed': False}
    return {'definitions': [], 'references': occurrences, 'engine': '文本匹配', 'indexed': False}
