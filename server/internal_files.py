"""Search public document assets without exposing configuration or runtime files."""
import os
from pathlib import Path
from urllib.parse import quote
from .paths import is_blocked_static_path
from . import folder_sources

EXTENSIONS = {'.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx',
              '.html', '.htm', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip'}
EXCLUDED = {'lib', 'reference-trash', '回收站', 'images', 'uploads'}


def search(root, query):
    root = Path(root)
    words = str(query or '').lower().split()
    result = []
    for directory, folders, names in os.walk(str(root), followlinks=False):
        folders[:] = [name for name in folders if name not in EXCLUDED
                      and not is_blocked_static_path((Path(directory) / name).relative_to(root).as_posix())
                      and not folder_sources.is_directory_link(Path(directory) / name)]
        for name in names:
            target = Path(directory) / name
            rel = target.relative_to(root).as_posix()
            if target.suffix.lower() not in EXTENSIONS or is_blocked_static_path(rel):
                continue
            if target.is_symlink() or not all(word in rel.lower() for word in words):
                continue
            try:
                size = target.stat().st_size
            except OSError:
                continue
            href = quote(rel, safe='/')
            kind, _, path = rel.partition('/')
            if (kind, target.suffix.lower()) in {('ppt', '.pptx'), ('word', '.docx'), ('excel', '.xlsx')}:
                href = 'html/reference_preview.html?kind=' + kind + '&path=' + quote(path, safe='')
            result.append(dict(path=rel, name=name, href=href, size=size))
    return sorted(result, key=lambda item: item['path'].lower())
