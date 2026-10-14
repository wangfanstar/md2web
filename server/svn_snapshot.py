"""Validated SVN Markdown snapshots and rollback-safe local publication."""
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from . import config, database, documents, folder_sources


def collect(stage, binding, settings):
    stage = Path(stage)
    files = {}
    for source in sorted(stage.rglob('*.md')):
        relative = source.relative_to(stage)
        if any(part.startswith('.') or part == '回收站' for part in relative.parts):
            continue
        ancestors = [source] + [parent for parent in source.parents if stage in parent.parents]
        if any(folder_sources.is_directory_link(parent) for parent in ancestors):
            raise ValueError('SVN 快照不能包含链接：' + relative.as_posix())
        rel = binding['mount'] + '/' + relative.as_posix()
        matched = config.match_repository(settings, rel)
        if matched and matched['id'] == binding['id']:
            content = source.read_bytes()
            content.decode('utf-8')
            files[rel] = content
    return files


def publish(md_dir, files, revision, drafts=()):
    md_dir = Path(md_dir)
    backup = md_dir.parent.parent / 'data' / 'svn-update-backups' / uuid.uuid4().hex
    changed, created, applied = [], [], []
    for rel, content in files.items():
        content.decode('utf-8')
        target = documents.resolve_md_file(md_dir, rel)
        if target.is_symlink() or folder_sources.has_link_ancestor(md_dir, rel):
            raise ValueError('SVN 更新不能覆盖软链接：' + rel)
        if target.exists() and not target.is_file():
            raise ValueError('文档路径被目录占用：' + rel)
    for rel, content in files.items():
        target = documents.resolve_md_file(md_dir, rel)
        if target.is_file():
            if target.read_bytes() == content:
                continue
            copy = backup / rel
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(target), str(copy))
            changed.append(rel)
        else:
            created.append(rel)
    backup.mkdir(parents=True, exist_ok=True)
    (backup / 'manifest.json').write_text(json.dumps({
        'revision': revision, 'at': database.now_iso(), 'changed': changed,
        'created': created, 'drafts': list(drafts)}, ensure_ascii=False, indent=2), encoding='utf-8')
    try:
        for rel in changed + created:
            target = documents.resolve_md_file(md_dir, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            handle = tempfile.NamedTemporaryFile(dir=str(target.parent), prefix='.svn-update-', delete=False)
            try:
                with handle:
                    handle.write(files[rel])
                os.replace(handle.name, str(target))
                applied.append(rel)
            finally:
                if os.path.exists(handle.name):
                    os.unlink(handle.name)
    except Exception as error:
        failures = []
        for rel in reversed(applied):
            try:
                target = documents.resolve_md_file(md_dir, rel)
                if rel in changed:
                    os.replace(str(backup / rel), str(target))
                else:
                    target.unlink()
            except OSError:
                failures.append(rel)
        if failures:
            raise OSError('部分文件回滚失败，请从 %s 恢复：%s' % (backup, ', '.join(failures))) from error
        raise
    return {'files': list(files), 'overwritten': changed, 'drafts': list(drafts),
            'backup': backup.relative_to(md_dir.parent.parent).as_posix(), 'revision': revision}
