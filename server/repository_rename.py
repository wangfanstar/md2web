"""Serialized local mount rename, retaining repository identity and immutable audit."""
import json
import os
import re
from pathlib import Path
from . import config as settings, config_profiles, entries, operations, folder_sources, policy
from .content_lock import serialized
from .file_transaction import rollback_paths, database_transaction


def moved(path, old, new):
    return new + path[len(old):] if path == old or path.startswith(old + '/') else path


@serialized
def rename(config, conn, lock, docs, payload):
    from . import database
    request_id = str(payload.get('requestId', ''))
    if not re.match(r'^[a-f0-9]{32}$', request_id):
        raise operations.OperationError(400, 'requestId 必须为 32 位十六进制操作号')
    journal_root = config_profiles.private_dir(docs) / 'renames'
    journal_root.mkdir(parents=True, exist_ok=True)
    journal = journal_root / (request_id + '.json')
    if journal.exists():
        saved = json.loads(journal.read_text(encoding='utf-8'))
        if saved['request'] != payload:
            raise operations.OperationError(409, '操作号已用于其他请求')
        if saved['state'] == 'complete':
            return saved['result']
        raise operations.OperationError(409, '改名日志需要核对后恢复：' + str(journal))
    if payload.get('expectedConfigVersion') != policy.version(settings.config_to_json(config)):
        raise operations.OperationError(409, '配置已变化，请重新读取')
    data = settings.config_to_json(config)
    repo = next((r for r in data['repositories'] if r['id'] == payload.get('repositoryId')), None)
    if repo is None:
        raise operations.OperationError(404, '请先保存该文件夹的仓库配置，再重命名')
    old = repo['mount']
    name = str(payload.get('newName', ''))
    if (not name or name != name.strip() or name.endswith('.') or
            re.search(r'[\\/:*?"<>|#%\[\]\x00-\x1f]', name) or name in ('.', '..', '回收站') or
            name.startswith('.') or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', name, re.I)):
        raise operations.OperationError(400, '文件夹名称无效或属于系统保留名称')
    if old != payload.get('expectedMount') or old == 'md':
        raise operations.OperationError(409, '原挂载目录已变化')
    new = old.rsplit('/', 1)[0] + '/' + name
    if old == new:
        return {'mount': old, 'id': repo['id']}
    source, target = Path(docs) / old, Path(docs) / new
    if folder_sources.has_link_ancestor(Path(docs) / 'md', old) and not folder_sources.is_directory_link(source):
        raise operations.OperationError(403, '不能修改父目录软链接中的挂载目录')
    if any(p.name.casefold() == name.casefold() and p.name != source.name for p in source.parent.iterdir()):
        raise operations.OperationError(409, '目标名称已存在')
    with lock:
        entries.check_drafts(conn, old)
        active = conn.execute("SELECT o.id FROM operations o JOIN repo_bindings b ON b.id=o.binding_id WHERE (b.mount_path=? OR substr(b.mount_path,1,?)=?) AND o.state IN ('running','uncertain','svn_committed')",
                              (old, len(old)+1, old+'/')).fetchone()
        if active or entries.pending(conn, old) or operations.pending_commit(conn, old):
            raise operations.OperationError(409, '仓库存在未完成操作，请先处理')
        for item in data['repositories']:
            item['mount'] = moved(item['mount'], old, new)
        data['folderGroups'] = {moved(k, old, new): v for k, v in data['folderGroups'].items()}
        aliases = data.setdefault('pathAliases', {})
        aliases.update({key: moved(value, old, new) for key, value in list(aliases.items())})
        aliases[old] = new
        result = dict(id=repo['id'], mount=new, oldMount=old)
        record = dict(request=payload, state='prepared', result=result)
        config_profiles.atomic_json(journal, record)
        profile = config_profiles.private_dir(docs)
        protected = [config['path'], profile / config['profile_name'], profile / (config['profile_name']+'.previous'),
                     profile / 'runtime.json', Path(docs)/'html'/config['profile_name']]
        moved_disk = False
        try:
            with rollback_paths(protected), database_transaction(conn):
                os.rename(str(source), str(target))
                moved_disk = True
                for table, column in (('repo_bindings','mount_path'), ('repository_documents','path'),
                                      ('local_document_versions','path'), ('document_snapshots','path'), ('drafts','document_path')):
                    conn.execute('UPDATE '+table+' SET '+column+'=? || substr('+column+',?) WHERE '+column+'=? OR substr('+column+',1,?)=?',
                                 (new,len(old)+1,old,len(old)+1,old+'/'))
                conn.execute("UPDATE operations SET state='failed', error_code='repository_renamed' WHERE state='prepared' AND binding_id IN (SELECT id FROM repo_bindings WHERE mount_path=? OR substr(mount_path,1,?)=?)", (new,len(new)+1,new+'/'))
                # Recycle metadata is mutable restoration state, not historical audit.
                metadata = [] if folder_sources.is_directory_link(target) else list(target.glob('回收站/*/meta.json'))
                with rollback_paths(metadata):
                    def transform(value):
                        if isinstance(value, str):
                            return moved(value, old, new)
                        if isinstance(value, list):
                            return [transform(v) for v in value]
                        if isinstance(value, dict):
                            return {k: transform(v) for k,v in value.items()}
                        return value
                    for path in metadata:
                        config_profiles.atomic_json(path, transform(json.loads(path.read_text(encoding='utf-8'))))
                    loaded = settings.save_config(config['path'], data, docs, create_mounts=False)
                    database.audit(conn, 'repository_rename', 'ok', resource=old+' -> '+new)
                    conn.commit()
        except Exception:
            if moved_disk:
                try:
                    os.rename(str(target), str(source))
                except OSError:
                    raise operations.OperationError(500, '回滚失败，请按日志恢复：' + str(journal))
            record['state'] = 'rolled_back'
            config_profiles.atomic_json(journal, record)
            raise
        config.clear()
        config.update(loaded)
        record['state'] = 'complete'
        config_profiles.atomic_json(journal, record)
        return result
