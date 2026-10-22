"""Search public document assets without exposing configuration or runtime files."""
import os
import json
from pathlib import Path
from urllib.parse import quote
from .paths import is_blocked_static_path
from . import folder_sources

EXTENSIONS = {'.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx',
              '.html', '.htm', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip'}
EXCLUDED = {'lib', 'reference-trash', '回收站', 'images', 'uploads'}


def markdown_links(root, query, selected_path=''):
    """Use the build's exact heading IDs, including duplicate-title suffixes."""
    root = Path(root)
    index = json.loads((root / 'html/search-index.json').read_text(encoding='utf-8'))
    words = str(query or '').lower().split()
    results = []
    for route, page in sorted(index.items()):
        path = route.lstrip('/')
        if selected_path and path != selected_path:
            continue
        if (not path.startswith('md/') or not path.endswith('.md')
                or is_blocked_static_path(path) or not (root / path).is_file() or not isinstance(page, dict)):
            continue
        entries = [entry for entry in page.values() if isinstance(entry, dict)]
        title = next((entry.get('pageTitle') for entry in entries if entry.get('pageTitle')), Path(path).stem)
        site = page.get('site') or 'html/index_all.html'
        if not site.startswith('html/index_') or not site.endswith('.html') or is_blocked_static_path(site):
            site = 'html/index_all.html'
        base = site + '#/' + quote(path, safe='/')
        candidates = [] if selected_path else [dict(name=title, path=path, href=base, kind='document')]
        for entry in entries if selected_path else []:
            slug = entry.get('slug') or ''
            if '?id=' not in slug:
                continue
            heading = entry.get('headingTitle') or entry.get('title') or ''
            candidates.append(dict(name=title + ' · ' + heading, path=path,
                                   href=base + '?id=' + quote(slug.split('?id=', 1)[1], safe=''), kind='heading'))
        results.extend(item for item in candidates if all(word in (item['name']+' '+path).lower() for word in words))
    return results


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
