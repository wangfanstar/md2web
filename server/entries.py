"""文件管理：独立工作副本提交 SVN 后发布本地，保留可核对的操作状态。"""
import hashlib
import json
import re
import shutil
import tempfile
import uuid
from pathlib import Path

from . import database, operations
from .config import match_repository
from .content_lock import serialized
from .svn import SvnError


def signature(path):
    """包括空目录和二进制附件；不包含 SVN 管理目录。"""
    path = Path(path)
    if not path.exists():
        return None
    if path.is_symlink():
        raise operations.OperationError(400, '不支持符号链接操作')
    if path.is_file():
        return hashlib.sha256(path.read_bytes()).hexdigest()
    result = {}
    for item in sorted(path.rglob('*')):
        if '.svn' in item.relative_to(path).parts:
            continue
        if item.is_symlink():
            raise operations.OperationError(400, '目录中含符号链接，不能在线操作')
        result[item.relative_to(path).as_posix()] = (hashlib.sha256(item.read_bytes()).hexdigest()
                                                     if item.is_file() else 'directory')
    return result


def canonical(md_dir, raw):
    target = operations._managed_path(md_dir, raw)
    relative = target.relative_to(Path(md_dir).resolve()).as_posix()
    return target, 'md' if relative == '.' else 'md/' + relative


def pending(conn, mount):
    for row in conn.execute("SELECT * FROM operations WHERE kind LIKE 'entry_%' "
                            "AND state IN ('running', 'uncertain', 'svn_committed')").fetchall():
        manifest = json.loads(row['reviewed_manifest'] or '{}')
        if manifest.get('mount') == mount:
            return dict(row)
    return None


def check_drafts(conn, path):
    for row in conn.execute("SELECT document_path FROM drafts WHERE state = 'active'").fetchall():
        if row['document_path'] == path or row['document_path'].startswith(path + '/'):
            raise operations.OperationError(409, '目标存在活动草稿，请先提交或放弃草稿再操作')


@serialized
def mutate(conn, db_lock, svn, config, md_dir, actor_id, credential, action, payload):
    request_id = payload.get('requestId') or uuid.uuid4().hex
    if not re.match(r'^[a-fA-F0-9]{32}$', str(request_id)):
        raise operations.OperationError(400, '操作 ID 不合法')
    request_data = {key: payload.get(key) for key in ('parent', 'path', 'name', 'kind')}
    with db_lock:
        previous = operations.get_operation(conn, request_id)
        if previous:
            manifest = json.loads(previous['reviewed_manifest'])
            if (previous['actor_id'] != actor_id or previous['kind'] != 'entry_' + action
                    or manifest.get('request') != request_data):
                raise operations.OperationError(409, '操作 ID 已用于其他请求')
            if previous['state'] == 'published':
                return manifest['result']
            raise operations.OperationError(409, '该操作已执行，请核对操作状态，勿重复提交',
                                             operationId=request_id, state=previous['state'])
    target, path = canonical(md_dir, payload.get('parent', 'md') if action == 'create' else payload.get('path'))
    binding = match_repository(config, path)
    if binding and (binding.get('read_only') or not binding.get('allow_commit', True)):
        raise operations.OperationError(403, '该仓库只读或未允许在线修改 / 合入 SVN')
    if action != 'create':
        if path == 'md' or any(repo['mount'] == path or repo['mount'].startswith(path + '/')
                               for repo in config.get('repositories', [])):
            raise operations.OperationError(400, '仓库根目录请在仓库配置页管理，不能在此删除或重命名')
        if not target.exists():
            raise operations.OperationError(404, '目标不存在，请刷新列表')
        if target.is_file() and target.suffix.lower() != '.md':
            raise operations.OperationError(400, '只允许操作 Markdown 文档或文件夹')
    destination = None
    kind = payload.get('kind') or 'document'
    if action in ('create', 'rename'):
        name = operations._safe_name(payload.get('name'))
        if any(char in name for char in '#%[]') or name.endswith('.') or name.endswith(' '):
            raise operations.OperationError(400, '名称不能包含 # % [ ] 或以点/空格结尾')
        is_document = kind == 'document' if action == 'create' else target.is_file()
        if is_document and not name.endswith('.md'):
            name = re.sub(r'\.md$', '', name, flags=re.I) + '.md'
        destination = (target if action == 'create' else target.parent) / name
        if destination.exists():
            raise operations.OperationError(409, '同名目标已存在')
        if action == 'create' and (not target.is_dir() or kind not in ('folder', 'document')):
            raise operations.OperationError(400, '请选择有效目录及文档/文件夹类型')
    with db_lock:
        if action != 'create':
            check_drafts(conn, path)
        blocked = pending(conn, binding['mount'] if binding else path)
        if blocked:
            raise operations.OperationError(409, '该仓库有待核对的操作，请先由管理员核对 SVN 日志及本地文件',
                                             operationId=blocked['id'], state=blocked['state'])
    svn_enabled = bool(binding and binding.get('url') and binding.get('source_mode') != 'local')
    if svn_enabled and not credential:
        raise operations.OperationError(401, '请登录 SVN 账号，或补充 SVN 凭据后执行', code='svn_credentials_required')
    manifest = {'request': request_data, 'path': path, 'mount': binding['mount'] if binding else path}
    with db_lock, conn:
        conn.execute("INSERT INTO operations (id, actor_id, kind, state, reviewed_manifest, message, created_at) "
                     "VALUES (?, ?, ?, 'running', ?, ?, ?)",
                     (request_id, actor_id, 'entry_' + action, json.dumps(manifest, ensure_ascii=False),
                      '文档管理：' + action + ' ' + path, database.now_iso()))
    staging = None
    committed = False
    committing = False
    revision = None
    baseline = signature(target) if action != 'create' else None
    try:
        if svn_enabled:
            staging = Path(tempfile.mkdtemp(prefix='md2web-entry-'))
            auth = {'config_dir': str(staging / 'config'), 'username': credential[0], 'password': credential[1]}
            info = svn.info(binding['url'], **auth)
            with db_lock:
                row = operations._binding_row(conn, binding)
                if row and ((row.get('repository_uuid') and row['repository_uuid'] != info.get('uuid')) or
                            (row.get('target_url') and row['target_url'].rstrip('/') != binding['url'].rstrip('/'))):
                    raise operations.OperationError(409, '仓库身份发生变化，请先检查仓库配置')
            wc = staging / 'wc'
            svn.checkout(binding['url'], wc, revision=info.get('revision'), depth='infinity', **auth)
            relative = path[len(binding['mount']):].lstrip('/')
            source = wc / relative
            remote_destination = (source if action == 'create' else source.parent) / destination.name if destination else None
            if action != 'create' and signature(source) != baseline:
                raise operations.OperationError(409, '远端与本地内容不同，请先同步并检查后再操作')
            if remote_destination and remote_destination.exists():
                raise operations.OperationError(409, 'SVN 中已存在同名目标，请先同步')
            if action == 'create':
                if not source.is_dir():
                    raise operations.OperationError(409, 'SVN 中不存在目标目录，请先同步')
                if kind == 'folder':
                    remote_destination.mkdir()
                else:
                    remote_destination.write_text('# ' + destination.stem + '\n\n', encoding='utf-8')
                svn.add(remote_destination, **auth)
            elif action == 'rename':
                svn.move(source, remote_destination, **auth)
            else:
                svn.delete(source, **auth)
            committing = True
            revision = svn.commit(wc, '文档管理：%s %s [%s]' % (action, path, request_id), **auth)
            if not revision:
                raise operations.OperationError(409, '未获得提交版本号，请核对 SVN 日志', state='uncertain')
            committed = True
            with db_lock:
                operations._set_state(conn, request_id, 'svn_committed', svn_revision=revision)
        # 外部文件写入或提交期间出现的新草稿不能被覆盖。
        with db_lock:
            if action != 'create':
                check_drafts(conn, path)
        if action != 'create' and signature(target) != baseline:
            raise operations.OperationError(409, '本地内容在操作期间变化，请核对后再同步')
        if action == 'create':
            result = operations.create_entry(md_dir, path, kind, destination.name)
        elif action == 'rename':
            result = operations.rename_entry(md_dir, path, destination.name)
        else:
            result = operations.delete_entry(md_dir, path, config['storage']['database'].parent / 'trash')
        result.update({'operationId': request_id, 'svnRevision': revision, 'state': 'published'})
        manifest['result'] = result
        with db_lock:
            operations._set_state(conn, request_id, 'published',
                                  reviewed_manifest=json.dumps(manifest, ensure_ascii=False),
                                  finished_at=database.now_iso())
            with conn:
                database.audit(conn, 'entry_' + action, 'ok', actor_id=actor_id, resource=path, operation_id=request_id)
        return result
    except Exception as error:
        uncertain = (committing and not committed and
                     (not isinstance(error, SvnError) or error.code not in ('auth_failed', 'conflict', 'forbidden')))
        state = 'svn_committed' if committed else ('uncertain' if uncertain else 'failed')
        with db_lock:
            operations._set_state(conn, request_id, state, error_code=getattr(error, 'code', 'entry_failed'))
        if state in ('uncertain', 'svn_committed'):
            raise operations.OperationError(409, 'SVN %s，本地操作未完成。请核对 SVN 日志与本地文件，不要重复提交。操作号：%s' %
                                             ('已提交 r%s' % revision if committed else '提交结果待核对', request_id),
                                             operationId=request_id, state=state)
        if isinstance(error, operations.OperationError):
            raise
        if isinstance(error, SvnError):
            raise operations.OperationError(401 if error.code == 'auth_failed' else 409,
                                             'SVN 操作失败：' + str(error), operationId=request_id, state=state)
        raise operations.OperationError(500, '文件操作失败，本地文件未发布，请检查服务端目录权限',
                                         operationId=request_id, state=state)
    finally:
        if staging:
            shutil.rmtree(str(staging), ignore_errors=True)
