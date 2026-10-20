"""Public homepage catalog from this server's configuration and actual mount folders."""
from pathlib import Path
from urllib.parse import quote
from . import folder_sources


def repository_catalog(docs_dir, config=None):
    from setup_docsify import repo_page_name
    config = config or {}
    docs = Path(docs_dir)
    md = docs / 'md'
    configured = list(config.get('repositories') or [])
    covered = {item['mount'].split('/')[1] for item in configured if item.get('mount', '').startswith('md/')}
    items = list(configured)
    if md.is_dir():
        for folder in sorted(md.iterdir(), key=lambda p: p.name.casefold()):
            if folder.name.startswith('.') or folder.name == '回收站' or folder.name in covered:
                continue
            if folder.is_dir() or folder_sources.is_directory_link(folder):
                source = folder_sources.describe(folder)
                linked = source.get('sourceMode') == 'symlink'
                items.append(dict(id=folder.name, mount='md/' + folder.name,
                                  source_mode='symlink' if linked else 'local',
                                  read_only=linked, allow_commit=not linked))
    result = []
    for item in items:
        mount = item['mount']
        if not mount.startswith('md/') or any(part in ('', '.', '..') or part.startswith('.') for part in mount.split('/')[1:]):
            continue
        name = repo_page_name(item['id'])
        # A freshly copied homepage can precede the server rebuild. The merged
        # entry can still browse a real directory without its generated entry.
        href = ('html/' + name if (docs / 'html' / name).is_file() else
                'html/index_all.html#/' + quote(mount, safe='/') + '/')
        result.append(dict(id=item['id'], mount=mount, href=href,
                           display_name=item.get('display_name') or item['id'],
                           group=config.get('folder_groups', {}).get(mount) or item.get('group') or '默认',
                           source_mode=item.get('source_mode', 'svn'),
                           read_only=bool(item.get('read_only')), allow_commit=bool(item.get('allow_commit', True))))
    return result
