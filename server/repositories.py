"""管理员删除/恢复仓库：配置和本地资料一起存档，不修改 SVN 远端。"""
import json
import os
import re
import uuid
from pathlib import Path

from . import config as settings, database, entries, folder_sources, operations
from .content_lock import serialized


def trash_root(md_dir):
    root = Path(md_dir) / '.repository-trash'
    if folder_sources.is_directory_link(root):
        raise operations.OperationError(400, '仓库回收站不能是目录链接')
    return root


def listing(md_dir):
    root = trash_root(md_dir)
    if not root.exists():
        return []
    result = []
    for entry in root.iterdir():
        if not re.match(r'^[a-f0-9]{32}$', entry.name) or folder_sources.is_directory_link(entry):
            continue
        try:
            meta = json.loads((entry / 'meta.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if meta.get('state') == 'deleted':
            result.append({'entryId': entry.name, 'id': meta['repository']['id'],
                           'mount': meta['repository']['mount'], 'deletedAt': meta['deletedAt']})
    return sorted(result, key=lambda item: item['deletedAt'], reverse=True)


@serialized
def delete(config, conn, db_lock, md_dir, repo_id, mount=None):
    payload = settings.config_to_json(config)
    selected = [item for item in payload['repositories'] if item['id'] == repo_id]
    configured = bool(selected)
    if configured:
        repo = selected[0]
        if mount and mount != repo['mount']:
            raise operations.OperationError(409, '仓库映射已变化，请刷新页面后重试')
    else:
        # 总览也展示尚未配置映射的一级文件夹，允许管理员删除这些本地仓库。
        mount = str(mount or '').rstrip('/')
        if not re.match(r'^md/[^/]+$', mount) or any(
                item['mount'] == mount or mount.startswith(item['mount'] + '/') for item in payload['repositories']):
            raise operations.OperationError(404, '仓库不存在，请刷新配置')
        target = operations._managed_path(md_dir, mount)
        if not target.is_dir() and not folder_sources.is_directory_link(target):
            raise operations.OperationError(404, '仓库文件夹不存在')
        repo = {'id': target.name, 'mount': mount, 'sourceMode': folder_sources.describe(target)['sourceMode']}
    mount = repo['mount']
    if mount == 'md' or any(item['mount'].startswith(mount + '/') for item in payload['repositories'] if item != repo):
        raise operations.OperationError(409, '请先删除嵌套仓库，不能直接删除文档根目录')
    target = operations._managed_path(md_dir, mount)
    # 嵌套链接内的仓库不能移动目标内容；一级链接只移除链接本身。
    linked = folder_sources.is_directory_link(target)
    if folder_sources.has_link_ancestor(md_dir, mount) and not linked:
        raise operations.OperationError(403, '请先在配置页处理父目录软链接')
    with db_lock:
        entries.check_drafts(conn, mount)
        if entries.pending(conn, mount) or operations.pending_commit(conn, mount):
            raise operations.OperationError(409, '仓库有待核对操作，请先处理后再删除')
        active = conn.execute("SELECT o.id FROM operations o JOIN repo_bindings b ON o.binding_id = b.id "
                              "WHERE b.mount_path = ? AND o.state IN ('prepared','running','uncertain','svn_committed')",
                              (mount,)).fetchone()
        if active:
            raise operations.OperationError(409, '仓库存在未完成的提交，请先核对后再删除')
    entry_id = uuid.uuid4().hex
    archive = trash_root(md_dir) / entry_id
    archive.mkdir(parents=True)
    meta = {'repository': repo, 'deletedAt': database.now_iso(), 'state': 'prepared',
            'configured': configured,
            'linked': linked, 'linkTarget': folder_sources.describe(target).get('linkTarget') if linked else '',
            'hadDirectory': target.exists() or linked}
    meta_path = archive / 'meta.json'
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
    moved = False
    try:
        if meta['hadDirectory']:
            # 同一 md 根目录内重命名；链接只移动链接本身，不遍历目标。
            os.rename(str(target), str(archive / 'folder'))
            moved = True
        if configured:
            payload['repositories'] = [item for item in payload['repositories'] if item['id'] != repo_id]
        meta['state'] = 'deleted'
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
        loaded = settings.save_config(config['path'], payload, Path(md_dir).parent)
    except Exception:
        if moved:
            os.rename(str(archive / 'folder'), str(target))
        meta['state'] = 'rolled_back'
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
        raise
    config.clear()
    config.update(loaded)
    return {'entryId': entry_id, 'id': repo['id'], 'mount': mount}


@serialized
def restore(config, md_dir, entry_id):
    if not re.match(r'^[a-f0-9]{32}$', str(entry_id or '')):
        raise operations.OperationError(400, '回收站条目无效')
    archive = trash_root(md_dir) / entry_id
    if folder_sources.is_directory_link(archive):
        raise operations.OperationError(400, '回收站条目不能是链接')
    try:
        meta = json.loads((archive / 'meta.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise operations.OperationError(404, '仓库回收站条目不存在')
    if meta.get('state') != 'deleted':
        raise operations.OperationError(409, '该仓库已恢复或删除未完成')
    repo = meta['repository']
    payload = settings.config_to_json(config)
    if any(item['id'] == repo['id'] or item['mount'] == repo['mount'] for item in payload['repositories']):
        raise operations.OperationError(409, '仓库 ID 或挂载目录已被使用，请先处理后恢复')
    target = operations._managed_path(md_dir, repo['mount'])
    if os.path.lexists(str(target)) or folder_sources.has_link_ancestor(md_dir, repo['mount']):
        raise operations.OperationError(409, '原目录已有内容或父目录是链接，不能覆盖恢复')
    target.parent.mkdir(parents=True, exist_ok=True)
    moved = False
    try:
        if meta['hadDirectory']:
            os.rename(str(archive / 'folder'), str(target))
            moved = True
        if meta.get('configured', True):
            payload['repositories'].append(repo)
        loaded = settings.save_config(config['path'], payload, Path(md_dir).parent)
    except Exception:
        if moved:
            os.rename(str(target), str(archive / 'folder'))
        raise
    config.clear()
    config.update(loaded)
    meta['state'] = 'restored'
    (archive / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
    return {'id': repo['id'], 'mount': repo['mount']}
