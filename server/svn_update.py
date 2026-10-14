"""用户确认后以 SVN 为准更新；覆盖前备份，草稿保持可下载。"""
import os
import tempfile
from pathlib import Path
from urllib.parse import quote

from . import config as server_config, database, documents, entries, operations, svn_snapshot
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
        if entries.pending(conn, binding['mount']) or operations.pending_commit(conn, binding['mount']):
            raise operations.OperationError(409, '有未完成的提交，请先核对提交结果后再更新')
    row = operations.ensure_binding(conn, binding, svn, config, credential, db_lock=db_lock)
    with operations._db_guard(db_lock), conn:
        unfinished = conn.execute("SELECT id FROM operations WHERE binding_id = ? AND state IN ('prepared', 'running', 'uncertain', 'svn_committed') LIMIT 1", (row['id'],)).fetchone()
        if unfinished:
            raise operations.OperationError(409, '仓库存在待完成或结果不确定的提交，请先处理后再更新')
        conn.execute("UPDATE repo_bindings SET sync_state = 'running' WHERE id = ?", (row['id'],))
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
                files = svn_snapshot.collect(stage, binding, config)
            with operations._db_guard(db_lock):
                drafts = sorted(set(files) & operations.active_draft_paths(conn))
            result = svn_snapshot.publish(md_dir, files, revision, drafts)
            with operations._db_guard(db_lock), conn:
                if not path:
                    conn.execute('UPDATE repo_bindings SET published_revision = ?, last_success_at = ?, last_checked_at = ?, sync_error = NULL WHERE id = ?',
                                 (revision, database.now_iso(), database.now_iso(), row['id']))
                database.audit(conn, 'manual_svn_update', 'ok', resource=path or binding['mount'])
            return result
        except Exception as error:
            with operations._db_guard(db_lock), conn:
                conn.execute('UPDATE repo_bindings SET sync_error = ?, last_checked_at = ? WHERE id = ?',
                             (error.code if isinstance(error, SvnError) else 'update_failed', database.now_iso(), row['id']))
            if isinstance(error, operations.OperationError):
                raise
            raise operations.OperationError(502, 'SVN 更新失败：' + str(error))
        finally:
            with operations._db_guard(db_lock), conn:
                conn.execute("UPDATE repo_bindings SET sync_state = 'idle' WHERE id = ?", (row['id'],))
