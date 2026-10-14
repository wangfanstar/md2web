"""用户确认后以 SVN 为准更新；覆盖前备份，草稿保持可下载。"""
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote

from . import config as server_config, database, documents, entries, folder_sources, operations
from .content_lock import serialized
from .svn import SvnError


@serialized
def update(conn, svn, config, md_dir, binding, credential, path=None, db_lock=None):
    if binding.get('source_mode', 'svn') != 'svn':
        raise operations.OperationError(400, '该仓库不是 SVN 库')
    md_dir = Path(md_dir)
    if path:
        path = documents.normalize_md_path(path)
        matched = server_config.match_repository(config, path)
        if not matched or matched['id'] != binding['id']:
            raise operations.OperationError(400, '指定文档不属于当前 SVN 仓库')
    with operations._db_guard(db_lock):
        if entries.pending(conn, binding['mount']):
            raise operations.OperationError(409, '有未完成的提交，请先核对提交结果后再更新')
    row = operations.ensure_binding(conn, binding, svn, config, credential, db_lock=db_lock)
    with operations._db_guard(db_lock), conn:
        unfinished = conn.execute("SELECT id FROM operations WHERE binding_id = ? AND state IN ('prepared', 'running', 'uncertain', 'svn_committed') LIMIT 1", (row['id'],)).fetchone()
        if unfinished:
            raise operations.OperationError(409, '仓库存在待完成或结果不确定的提交，请先处理后再更新')
        conn.execute("UPDATE repo_bindings SET sync_state = 'running' WHERE id = ?", (row['id'],))
    backup = md_dir.parent.parent / 'data' / 'svn-update-backups' / uuid.uuid4().hex
    changed, created, applied = [], [], []
    with tempfile.TemporaryDirectory(prefix='md2web-manual-update-') as temp:
        stage = Path(temp) / 'export'
        try:
            username, password = credential or (None, None)
            info = svn.info(binding['url'], temp, username=username, password=password)
            revision = int(info.get('revision') or 0)
            files = {}
            if path:
                relative = path[len(binding['mount']):].lstrip('/')
                url = binding['url'].rstrip('/') + '/' + quote(relative, safe='/')
                text = svn.cat(url, revision=revision, config_dir=temp, username=username, password=password)
                files[path] = text.encode('utf-8')
            else:
                svn.export(binding['url'], stage, revision=revision, config_dir=temp,
                           username=username, password=password)
                for source in sorted(stage.rglob('*.md')):
                    if source.is_symlink() or any(part.startswith('.') or part == '回收站' for part in source.relative_to(stage).parts):
                        continue
                    rel = binding['mount'] + '/' + source.relative_to(stage).as_posix()
                    matched = server_config.match_repository(config, rel)
                    if matched and matched['id'] == binding['id']:
                        source.read_text(encoding='utf-8')  # 全部校验通过后才发布。
                        files[rel] = source.read_bytes()
            for rel in files:
                target = documents.resolve_md_file(md_dir, rel)
                if target.is_symlink() or folder_sources.has_link_ancestor(md_dir, rel):
                    raise operations.OperationError(400, 'SVN 更新不能覆盖软链接：' + rel)
                if target.exists() and not target.is_file():
                    raise operations.OperationError(409, '文档路径被目录占用：' + rel)
            with operations._db_guard(db_lock):
                drafts = sorted(set(files) & operations.active_draft_paths(conn))
            # 先完整备份，再写入；发生错误恢复所有已写入文件。
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
            (backup / 'manifest.json').write_text(json.dumps({'revision': revision, 'at': database.now_iso(),
                'changed': changed, 'created': created, 'drafts': drafts}, ensure_ascii=False, indent=2), encoding='utf-8')
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
            with operations._db_guard(db_lock), conn:
                if not path:
                    conn.execute('UPDATE repo_bindings SET published_revision = ?, last_success_at = ?, last_checked_at = ?, sync_error = NULL WHERE id = ?',
                                 (revision, database.now_iso(), database.now_iso(), row['id']))
                database.audit(conn, 'manual_svn_update', 'ok', resource=path or binding['mount'])
            return {'revision': revision, 'files': list(files), 'overwritten': changed, 'drafts': drafts,
                    'backup': backup.relative_to(md_dir.parent.parent).as_posix()}
        except Exception as error:
            for rel in reversed(applied):
                source = backup / rel
                target = documents.resolve_md_file(md_dir, rel)
                if rel in changed and source.is_file():
                    os.replace(str(source), str(target))
                elif rel in created and target.is_file():
                    target.unlink()
            with operations._db_guard(db_lock), conn:
                conn.execute('UPDATE repo_bindings SET sync_error = ?, last_checked_at = ? WHERE id = ?',
                             (error.code if isinstance(error, SvnError) else 'update_failed', database.now_iso(), row['id']))
            if isinstance(error, operations.OperationError):
                raise
            raise operations.OperationError(502, 'SVN 更新失败，原文档已保留：' + str(error))
        finally:
            with operations._db_guard(db_lock), conn:
                conn.execute("UPDATE repo_bindings SET sync_state = 'idle' WHERE id = ?", (row['id'],))
