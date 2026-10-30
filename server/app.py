"""Flask 应用：静态白名单 + 认证 API + 写接口守卫（阶段一）。

阶段一仅实现登录/退出与会话边界：
- 所有写接口要求登录 + CSRF，且不因缺少配置退回匿名写入。
- 草稿（阶段二）与 SVN 操作（阶段三）返回明确的未实现错误，不静默强制覆盖。
"""

import hmac
import queue
import uuid
import json
import shutil
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Response, Flask, jsonify, make_response, request, send_from_directory

from . import config as server_config
from . import database, documents as server_documents, drafts, operations, entries, recycle, references, folder_sources
from .auth import AuthError
from .config import authenticated_config, config_to_json, public_config, save_config
from .documents import MdSaveError
from .paths import is_blocked_static_path
from . import repositories
from . import config_profiles
from .content_lock import serialized
from . import policy


def server_documents_error():
    return MdSaveError

COOKIE_NAME = "md2web_session"
FEATURES = {"editDraft": True, "svnCommit": False, "localPublish": True}
MAX_BODY = policy.upload_request_bytes({})


def create_app(config, conn, auth_service, docs_dir, on_config_changed=None):
    docs_root = Path(docs_dir).resolve()
    ai_jobs = {}
    ai_jobs_lock = threading.Lock()
    auth_service.enable_config_profiles(docs_root)
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
    from .cache import MetadataCache
    cache_settings = config.get('cache', {})
    folder_cache = MetadataCache(cache_settings.get('maxEntries', 256), cache_settings.get('maxBytes', 33554432),
                                 cache_settings.get('metadataTtlSeconds', 60))
    if hasattr(app, "json"):
        app.json.ensure_ascii = False
        app.json.sort_keys = False
    else:  # 旧版 Flask 兼容
        app.config["JSON_AS_ASCII"] = False
        app.config["JSON_SORT_KEYS"] = False

    # ---- 工具 ----

    def current_session():
        return auth_service.resolve(request.cookies.get(COOKIE_NAME) or "")

    def json_error(status, code, message, **extra):
        payload = {"ok": False, "code": code, "error": message}
        payload.update(extra)
        response = jsonify(payload)
        response.status_code = status
        return response

    @app.before_request
    def upload_request_limit():
        if request.content_length is not None and request.content_length > policy.upload_request_bytes(config):
            return json_error(413, 'too_large', '本次上传总量过大，单文件上限 %d MB，请分批上传' %
                              (policy.upload_bytes(config) // (1024 * 1024)))

    def set_session_cookie(response, token, remember=False):
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=int(config['auth'].get('rememberSessionDays', 30) * 86400 if remember else float(config["auth"]["session_hours"]) * 3600),
            httponly=True,
            samesite="Lax",
            secure=bool(config["server"].get("secure_cookies")),
            path="/",
        )
        return response

    def require_same_origin():
        origin = request.headers.get("Origin")
        if not origin:
            return None
        host = origin.split("://", 1)[-1].split("/")[0].lower()
        if host != (request.host or "").lower():
            return json_error(403, "origin_rejected", "请求来源与站点不一致，已拒绝")
        return None

    def require_session():
        session = current_session()
        if session is None:
            return None, json_error(401, "login_required", "请先登录 SVN 账号")
        return session, None

    def require_csrf(session):
        token = request.headers.get("X-CSRF-Token") or (request.get_json(silent=True) or {}).get("csrfToken")
        if not token or not hmac.compare_digest(str(token), str(session["csrfToken"])):
            return json_error(403, "csrf_failed", "CSRF 校验失败，请刷新页面后重试")
        return None

    # ---- 安全响应头 ----

    @app.after_request
    def security_headers(response):
        if request.method in ('POST', 'PUT', 'DELETE') and response.status_code < 400 and request.path != '/__md/visit':
            folder_cache.clear()
            document_meta_cache.clear()
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cache-Control"] = 'private, no-store' if request.path.startswith('/__') else response.headers.get("Cache-Control", "no-cache")
        if not request.path.startswith('/__') and response.status_code in (200, 304):
            from .cache import static_policy
            candidate = (docs_root / request.path.lstrip('/')).resolve()
            if docs_root in candidate.parents and not is_blocked_static_path(request.path.lstrip('/')):
                response.headers['Cache-Control'] = static_policy(candidate, request.args.get('v'))
        page_path = request.path.lstrip('/') or 'index.html'
        if (request.method == 'GET' and response.status_code in (200, 304)
                and page_path.lower().endswith(('.html', '.htm'))
                and not page_path.startswith(('__', 'lib/'))
                and not is_blocked_static_path(page_path)):
            session = current_session()
            with auth_service._db_lock, conn:
                database.audit(conn, 'site_visit', 'ok', actor_id=session['user']['id'] if session else None,
                               resource=request.path, client_ip=request.remote_addr or '')
        return response

    # ---- 错误处理（不泄漏堆栈/秘密） ----

    @app.errorhandler(AuthError)
    def handle_auth_error(error):
        return json_error(error.status, error.code, str(error))

    @app.errorhandler(server_config.ConfigError)
    def handle_config_error(error):
        return json_error(400, 'config_invalid', str(error))

    @app.errorhandler(404)
    def handle_not_found(error):
        return json_error(404, "not_found", "资源不存在")

    @app.errorhandler(405)
    def handle_method(error):
        return json_error(405, "method_not_allowed", "方法不被允许")

    @app.errorhandler(413)
    def handle_too_large(error):
        return json_error(413, "too_large", "本次上传总量过大，单文件上限 %d MB，请分批上传" %
                          (policy.upload_bytes(config) // (1024 * 1024)))

    @app.errorhandler(Exception)
    def handle_error(error):
        app.logger.warning("请求处理失败: %s", type(error).__name__)
        return json_error(500, "internal_error", "服务内部错误，请查看服务端日志")

    # ---- 认证 API ----

    @app.get("/__auth/session")
    def session_info():
        session = current_session()
        site = authenticated_config(config) if session else public_config(config)
        return jsonify({
            "ok": True,
            "authenticated": session is not None,
            "user": session["user"] if session else None,
            "csrfToken": session["csrfToken"] if session else None,
            "features": FEATURES,
            "site": site,
            "serverManaged": True,
            "svnCredential": bool(session) and bool(auth_service.has_credential(session["sessionId"]) or auth_service.stored_credential(session['user'])),
        })

    @app.post("/__auth/login")
    def login():
        rejected = require_same_origin()
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
        if str(payload.get("mode") or "").strip() == "admin":
            result = auth_service.login_admin(
                payload.get("username"),
                payload.get("password"),
                request.remote_addr or "",
                request.headers.get("User-Agent", ""),
                remember=payload.get('rememberSession') is True,
            )
        else:
            result = auth_service.login(
                payload.get("username"),
                payload.get("password"),
                request.remote_addr or "",
                request.headers.get("User-Agent", ""),
                remember=payload.get('rememberSession') is True,
            )
        response = jsonify({"ok": True, "user": result["user"], "csrfToken": result["csrfToken"]})
        old_token = request.cookies.get(COOKIE_NAME)
        if old_token:
            auth_service.logout(old_token)
        if payload.get('rememberUsername') is True and config['auth'].get('rememberUsername', True):
            import secrets
            from .auth import _digest
            device = secrets.token_urlsafe(32)
            source = auth_service.resolve(result['token'], touch=False)['user']['authSourceId']
            with auth_service._db_lock, conn:
                conn.execute('DELETE FROM device_hints WHERE expires_at < ? OR token_hash = ?',
                             (auth_service._stamp(), _digest(request.cookies.get('md2web_device', ''))))
                expiry = (auth_service._moment() + timedelta(days=config['auth'].get('deviceHintDays', 30))).strftime('%Y-%m-%dT%H:%M:%SZ')
                conn.execute('INSERT INTO device_hints VALUES (?, ?, ?, ?, ?, ?)',
                             (_digest(device), source, result['user']['username'], request.remote_addr,
                              auth_service._stamp(), expiry))
            response.set_cookie('md2web_device', device, max_age=int(config['auth'].get('deviceHintDays', 30) * 86400),
                                httponly=True, samesite='Lax', secure=config['server'].get('secure_cookies', False))
        else:
            response.delete_cookie('md2web_device')
        return set_session_cookie(response, result["token"], payload.get('rememberSession') is True)

    @app.get('/__auth/login-hint')
    def login_hint():
        from .auth import _digest
        with auth_service._db_lock:
            row = conn.execute('SELECT * FROM device_hints WHERE token_hash = ? AND expires_at > ?',
                               (_digest(request.cookies.get('md2web_device', '')), auth_service._stamp())).fetchone()
        valid = row and row['auth_source_id'] in ('local-admin', auth_service.auth_source_id)
        return jsonify(ok=True, username=row['username'] if valid else '')

    @app.post('/__auth/forget-device')
    def forget_device():
        rejected = require_same_origin()
        if rejected:
            return rejected
        session = current_session()
        if session:
            rejected = require_csrf(session)
            if rejected:
                return rejected
        from .auth import _digest
        with auth_service._db_lock, conn:
            conn.execute('DELETE FROM device_hints WHERE token_hash = ?',
                         (_digest(request.cookies.get('md2web_device', '')),))
        auth_service.logout(request.cookies.get(COOKIE_NAME, ''))
        response = jsonify(ok=True)
        response.delete_cookie('md2web_device')
        response.delete_cookie(COOKIE_NAME)
        return response

    @app.post("/__auth/logout")
    def logout():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        auth_service.logout(request.cookies.get(COOKIE_NAME) or "")
        response = jsonify({"ok": True})
        response.delete_cookie(COOKIE_NAME, path="/")
        return response

    # ---- 管理员配置 API ----

    def require_admin():
        session, rejected = require_session()
        if rejected:
            return None, rejected
        if (session["user"].get("role") or "user") != "admin":
            return None, json_error(403, "admin_required", "需要管理员账号登录后才能修改配置")
        return session, None

    def public_config_json():
        """配置视图：剥离 security.secretKey（网页端不应接触本机加密密钥）。"""
        data = config_to_json(config)
        data.pop("security", None)
        data['expectedConfigVersion'] = policy.version(config_to_json(config))
        return data

    @app.get('/__admin/users')
    def list_users():
        _, rejected = require_admin()
        if rejected:
            return rejected
        try:
            limit = max(1, min(100, int(request.args.get('limit', 50))))
            cursor = max(0, int(request.args.get('cursor', 0)))
        except ValueError:
            return json_error(400, 'invalid_request', '分页参数无效')
        with auth_service._db_lock:
            rows = conn.execute('SELECT * FROM users WHERE id > ? AND svn_username LIKE ? ORDER BY id LIMIT ?',
                                (cursor, '%' + request.args.get('query', '')[:100] + '%', limit)).fetchall()
            result = []
            for row in rows:
                role, enabled = policy.effective(row, config)
                count = conn.execute('SELECT COUNT(*) FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > ?',
                                     (row['id'], auth_service._stamp())).fetchone()[0]
                result.append(dict(id=row['id'], authSourceId=row['auth_source_id'], username=row['svn_username'],
                                   displayName=row['display_name'], role=role, enabled=enabled,
                                   lastLoginAt=row['last_login_at'], sessionCount=count))
        return jsonify(ok=True, users=result, nextCursor=rows[-1]['id'] if len(rows) == limit else None,
                       expectedConfigVersion=policy.version(config_to_json(config)))

    @app.post('/__admin/users/permission')
    @app.post('/__admin/users/revoke-sessions')
    @serialized
    def manage_user():
        session, rejected = require_admin()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
        with auth_service._db_lock:
            user = database.find_user(conn, payload.get('authSourceId'), payload.get('username'))
        if user is None:
            return json_error(404, 'not_found', '用户不存在')
        if request.path.endswith('/permission'):
            if payload.get('expectedConfigVersion') != policy.version(config_to_json(config)):
                return json_error(409, 'config_conflict', '配置已变化，请刷新后重试')
            data = config_to_json(config)
            before = policy.effective(user, config)
            users = data['authorization'].get('users', [])
            data['authorization']['users'] = [item for item in users if
                (item['authSourceId'], item['username']) != (user['auth_source_id'], user['svn_username'])]
            data['authorization']['users'].append(dict(authSourceId=user['auth_source_id'], username=user['svn_username'],
                                                       role=payload.get('role'), enabled=payload.get('enabled')))
            loaded = save_config(config['path'], data, docs_root, create_mounts=False)
            config.clear()
            config.update(loaded)
            auth_service.on_config_changed()
            outcome = '{} -> {}'.format(before, policy.effective(user, config))
        else:
            outcome = 'revoke'
        with auth_service._db_lock, conn:
            if outcome == 'revoke' or not policy.effective(user, config)[1]:
                conn.execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
                             (auth_service._stamp(), user['id']))
            database.audit(conn, 'user_permission', outcome, actor_id=session['user']['id'],
                           resource=user['auth_source_id'] + ':' + user['svn_username'], client_ip=request.remote_addr)
        return jsonify(ok=True, expectedConfigVersion=policy.version(config_to_json(config)))

    @app.get('/__config/profiles')
    def read_profiles():
        session, rejected = require_admin()
        if rejected:
            return rejected
        return jsonify(dict(ok=True, **config_profiles.listing(config, docs_root)))

    @app.post('/__config/profiles')
    @serialized
    def change_profile():
        session, rejected = require_admin()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
        if payload.get('expectedConfigVersion') and payload['expectedConfigVersion'] != policy.version(config_to_json(config)):
            return json_error(409, 'config_conflict', '配置已变化，请重新读取并比较后再应用方案')
        try:
            action = payload.get('action')
            if action == 'restore':
                loaded = config_profiles.restore_previous(config, docs_root)
            elif action == 'write':
                loaded = config_profiles.apply_data(config, docs_root, config.get('profile_name', config_profiles.DEFAULT_NAME), payload.get('data'))
            elif action in ('select', 'create'):
                loaded = config_profiles.select(config, docs_root, payload.get('name'), create=action == 'create')
            else:
                raise server_config.ConfigError('未知的配置方案操作')
        except (server_config.ConfigError, OSError, TypeError, ValueError) as error:
            return json_error(400, 'profile_invalid', str(error))
        config.clear()
        config.update(loaded)
        auth_service.on_config_changed()
        auth_service.enable_config_profiles(docs_root)
        rebuilt = rebuild_repository_pages()
        return jsonify(ok=True, config=public_config_json(), rebuilt=rebuilt)

    @app.get('/__config/profile-content')
    def read_profile_content():
        _, rejected = require_admin()
        if rejected:
            return rejected
        try:
            data = config_profiles.read_profile(docs_root, request.args.get('name') or config.get('profile_name', config_profiles.DEFAULT_NAME))
        except server_config.ConfigError as error:
            return json_error(400, 'profile_invalid', str(error))
        response = jsonify(ok=True, data=data)
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/__config/sync-status')
    def config_sync_status():
        session, rejected = require_admin()
        if rejected:
            return rejected
        result = {}
        with auth_service._db_lock:
            for repo in config['repositories']:
                if repo.get('source_mode', 'svn') != 'svn':
                    continue
                row = conn.execute("SELECT * FROM repo_bindings WHERE mount_path = ? AND repository_id = ? AND rtrim(target_url, '/') = ?",
                                   (repo['mount'], repo['id'], repo['url'].rstrip('/'))).fetchone()
                result[repo['id']] = {'intervalSeconds': operations.sync_interval_of(repo, config),
                                      'state': row['sync_state'] if row else 'idle',
                                      'lastSuccessAt': row['last_success_at'] if row else None,
                                      'lastCheckedAt': row['last_checked_at'] if row else None,
                                      'error': row['sync_error'] if row else None,
                                      'revision': row['published_revision'] if row else None}
        return jsonify(ok=True, repositories=result)

    @app.get('/__svn/sync-status')
    def svn_sync_status():
        repo = next((r for r in config['repositories'] if r['id'] == request.args.get('binding')), None)
        if not repo or repo.get('source_mode', 'svn') != 'svn':
            return json_error(404, 'not_svn', '没有找到 SVN 仓库')
        with auth_service._db_lock:
            row = conn.execute("SELECT * FROM repo_bindings WHERE mount_path = ? AND rtrim(target_url, '/') = ?",
                               (repo['mount'], repo['url'].rstrip('/'))).fetchone()
            path = str(request.args.get('path') or '')
            if path and not path.endswith('.md'):
                path += '.md'
            last_file = conn.execute("SELECT created_at FROM audit_events WHERE action = 'manual_svn_update' AND result = 'ok' AND resource = ? ORDER BY id DESC LIMIT 1", (path,)).fetchone()
        return jsonify(ok=True, status={'intervalSeconds': operations.sync_interval_of(repo, config),
            'state': row['sync_state'] if row else 'idle', 'error': row['sync_error'] if row else None,
            'lastSuccessAt': row['last_success_at'] if row else None,
            'lastCheckedAt': row['last_checked_at'] if row else None,
            'revision': row['published_revision'] if row else None,
            'lastFileUpdateAt': last_file[0] if last_file else None})

    @app.post('/__svn/update')
    @serialized
    def manual_svn_update():
        # 手动更新以 SVN 库为准，不写回远端；单篇文档与整库都免登录，
        # 由仓库配置里的同步账号自动完成，仅要求同源请求以防跨站触发。
        rejected = require_same_origin()
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
        if payload.get('remoteWins') is not True:
            return json_error(409, 'confirm_remote', '请先下载当前文档，确认以 SVN 库为准覆盖本地版本')
        session = current_session()
        repo = next((r for r in config['repositories'] if r['id'] == payload.get('binding')), None)
        if not repo or repo.get('source_mode', 'svn') != 'svn':
            return json_error(400, 'not_svn', '请选择有效的 SVN 仓库')
        from . import svn_update
        try:
            result = svn_update.update(conn, auth_service.svn, config, md_dir(), repo,
                auth_service.repo_sync_credential(repo, credential_of(session) if session else None),
                payload.get('path'), auth_service._db_lock)
        except (operations.OperationError, MdSaveError) as error:
            return json_error(error.status, 'svn_update_failed', error.message)
        document_meta_cache.clear()
        return jsonify(ok=True, result=result, rebuilt=rebuild_repository_pages())

    @app.get("/__config")
    def read_config():
        session, rejected = require_admin()
        if rejected:
            return rejected
        return jsonify({"ok": True, "config": public_config_json()})

    @app.put("/__config")
    @serialized
    def write_config():
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True)
        if isinstance(payload, dict):
            old_mounts = {r['id']: r['mount'] for r in config['repositories']}
            if any(r.get('id') in old_mounts and r.get('mount') != old_mounts[r['id']] for r in payload.get('repositories', [])):
                return json_error(409, 'rename_required', '修改已有挂载目录请使用“重命名文件夹”')
        if isinstance(payload, dict) and payload.get('expectedConfigVersion') and payload['expectedConfigVersion'] != policy.version(config_to_json(config)):
            return json_error(409, 'config_conflict', '配置已变化，请重新读取后保存')
        if isinstance(payload, dict) and payload.get('profileName', config.get('profile_name')) != config.get('profile_name'):
            return json_error(409, 'profile_changed', '默认配置方案已变化，请重新读取配置后再保存')
        try:
            loaded = save_config(config["path"], payload, docs_root)
        except server_config.ConfigError as error:
            return json_error(400, "config_invalid", str(error))
        config.clear()
        config.update(loaded)
        auth_service.on_config_changed()
        rebuilt = rebuild_repository_pages()
        return jsonify({"ok": True, "config": public_config_json(), "authConfigured": bool(config["auth"]["url"]), "rebuilt": rebuilt})

    @app.route('/__ai/config', methods=['GET', 'PUT', 'DELETE'])
    def personal_ai_config():
        session, rejected = require_session()
        if rejected:
            return rejected
        return json_error(410, 'ai_personal_config_retired', '个人 AI 配置已停用，请使用公共 AI 服务')

    @app.get('/__ai/public')
    def public_ai():
        session, rejected = require_session()
        if rejected:
            return rejected
        from . import code_qa
        settings = code_qa.validate((config.get('ai') or {}).get('claude'))
        repos = []
        for repo in settings.get('repositories', []):
            ready, revision = False, ''
            try:
                path = code_qa.code_path(docs_root, repo, settings)
                marker = path / '.md2web-revision'
                ready = path.is_dir() and (not repo.get('url') or (marker.is_file() and not marker.is_symlink()))
                revision = (marker.read_text(encoding='utf-8').strip() if repo.get('url') else 'local') if ready else ''
            except (ValueError, OSError):
                ready = False
            repos.append({'id': repo['id'], 'name': repo.get('name') or repo['folder'], 'folder': repo['folder'], 'ready': ready,
                          'revision': revision, 'path': settings['codeFolder'] + '/' + repo['folder'],
                          'folders': code_qa.directory_choices(docs_root, settings['codeFolder'] + '/' + repo['folder']) if ready else []})
        folders = []
        for folder in settings['documentFolders']:
            try:
                available = code_qa.contained_folder(docs_root, folder).is_dir()
            except ValueError:
                available = False
            folders.append({'path': folder, 'available': available})
            if available:
                folders.extend({'path': child, 'available': True} for child in code_qa.directory_choices(docs_root, folder))

        return jsonify(ok=True, enabled=bool(settings.get('enabled')), repositories=repos,
                       defaultRepository='', documentFolders=folders, defaultDocumentFolders=['md'])

    @app.get('/__admin/code-repositories')
    def code_repository_status():
        session, rejected = require_admin()
        if rejected:
            return rejected
        from . import code_qa
        settings = code_qa.validate((config.get('ai') or {}).get('claude'))
        return jsonify(ok=True, state=code_qa.read_sync_state(auth_service),
                       discovered=code_qa.discover_repositories(docs_root, settings, auth_service.svn, str(Path(config['storage']['database']).parent / 'svn-discovery')))

    @app.post('/__admin/ai/personal-configs/clear')
    def clear_retired_ai_configs():
        session, rejected = require_admin()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        with auth_service._db_lock:
            with conn:
                count = conn.execute('SELECT COUNT(*) FROM user_ai_configs').fetchone()[0]
                conn.execute('DELETE FROM user_ai_configs')
                database.audit(conn, 'ai_personal_configs_clear', 'count:%s' % count,
                               actor_id=session['user']['id'])
        return jsonify(ok=True, cleared=count)

    @app.post('/__ai/chat')
    def code_chat():
        if request.content_length and request.content_length > 256 * 1024:
            return json_error(413, 'ai_request_too_large', 'AI 问答请求不能超过 256 KB')
        session, rejected = require_session()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        from . import code_qa
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or set(payload) - {'messages', 'codeRepositoryId', 'documentFolders', 'codeFolders'}:
            return json_error(400, 'invalid_request', '仅接受对话、代码库 ID 和开放的文档目录')
        if not code_qa.LOCK.acquire(False):
            return json_error(429, 'ai_busy', '正在问答或更新代码库，请稍后重试')
        job_id = uuid.uuid4().hex
        cancel = threading.Event()
        results = queue.Queue(maxsize=128)
        ai_snapshot = json.loads(json.dumps(config.get('ai') or {}))
        with ai_jobs_lock:
            ai_jobs[job_id] = (session['user']['id'], cancel)
        def emit(kind, data):
            while not cancel.is_set():
                try:
                    results.put((kind, data), timeout=0.2)
                    return
                except queue.Full:
                    continue
            if kind in ('complete', 'error'):
                try:
                    results.put_nowait(('error', {'message': '请求已取消'}))
                except queue.Full:
                    # Reserve a terminal event even if a slow consumer filled the queue.
                    try:
                        results.get_nowait()
                    except queue.Empty:
                        pass
                    results.put_nowait(('error', {'message': '请求已取消'}))
        def run():
            try:
                def send_delta(text):
                    emit('delta', {'text': text})
                    if cancel.is_set():
                        raise ValueError('请求已取消')
                result = code_qa.answer(docs_root, ai_snapshot, payload, cancel, on_delta=send_delta,
                                        on_progress=lambda data: emit('progress', data))
                emit('complete', result)
            except ValueError as error:
                emit('error', {'message': str(error)})
            except Exception:
                emit('error', {'message': 'Claude 执行失败，请检查安装、权限及代码库'})
            finally:
                with ai_jobs_lock:
                    ai_jobs.pop(job_id, None)
                code_qa.LOCK.release()
        threading.Thread(target=run, daemon=True).start()
        def events():
            try:
                yield 'event: start\ndata: %s\n\n' % json.dumps({'jobId': job_id})
                while True:
                    try:
                        kind, data = results.get(timeout=1)
                    except queue.Empty:
                        yield ': waiting\n\n'
                        continue
                    yield 'event: %s\ndata: %s\n\n' % (kind, json.dumps(data, ensure_ascii=False))
                    if kind in ('complete', 'error'):
                        break
            finally:
                cancel.set()
        return Response(events(), mimetype='text/event-stream', headers={'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache'})

    @app.post('/__ai/jobs/<job_id>/cancel')
    def cancel_ai_job(job_id):
        session, rejected = require_session()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        with ai_jobs_lock:
            job = ai_jobs.get(job_id)
            if job is None:
                return json_error(404, 'job_not_found', '任务已结束或不存在')
            if job[0] != session['user']['id'] and session['user'].get('role') != 'admin':
                return json_error(403, 'forbidden', '无权取消此任务')
            job[1].set()
        return jsonify(ok=True)

    @app.post('/__admin/code-repositories/<repo_id>/sync')
    def sync_code_repository(repo_id):
        session, rejected = require_admin()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        from . import code_qa
        if not code_qa.LOCK.acquire(False):
            return json_error(409, 'ai_busy', '正在问答或同步，请稍后重试')
        try:
            settings = code_qa.validate((config.get('ai') or {}).get('claude'))
            return jsonify(**code_qa.sync_repository(auth_service, docs_root, settings, repo_id))
        except ValueError as error:
            return json_error(400, 'code_sync_failed', str(error))
        except Exception:
            return json_error(502, 'code_sync_failed', '代码库同步失败，请检查 SVN 地址、版本和同步账号')
        finally:
            code_qa.LOCK.release()

    @app.put("/__admin/ai")
    @serialized
    def write_ai_config():
        """只更新 AI 配置（写进配置 JSON 的 ai 段），供 AI 面板保存全站默认值。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return json_error(400, "invalid_request", "AI 配置必须是 JSON 对象")
        unknown = set(payload) - set(server_config.AI_FIELDS) - {'expectedConfigVersion'}
        if unknown:
            return json_error(400, "unknown_ai_field", "AI 配置只接受 claude 字段；旧 API/Key/模型字段已移除")
        current = config_to_json(config)
        if payload.get('expectedConfigVersion') and payload['expectedConfigVersion'] != policy.version(current):
            return json_error(409, 'config_conflict', '配置已变化，请关闭并重新打开配置后再保存')
        ai = {}
        if 'claude' in payload:
            ai['claude'] = payload['claude']
        elif (current.get("ai") or {}).get('claude') is not None:
            ai['claude'] = current['ai']['claude']
        current["ai"] = ai
        try:
            loaded = save_config(config["path"], current, docs_root)
        except server_config.ConfigError as error:
            return json_error(400, "config_invalid", str(error))
        config.clear()
        config.update(loaded)
        auth_service.on_config_changed()
        return jsonify({"ok": True, "ai": loaded["ai"], "config": public_config_json()})

    @app.post('/__admin/repository-rename')
    @serialized
    def rename_repository():
        session, rejected = require_admin()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        from .repository_rename import rename
        try:
            result = rename(config, conn, auth_service._db_lock, docs_root, request.get_json(silent=True) or {})
        except operations.OperationError as error:
            return json_error(error.status, 'rename_failed', str(error))
        auth_service.on_config_changed()
        document_meta_cache.clear()
        rebuilt = rebuild_repository_pages()
        return jsonify(ok=True, result=result, rebuilt=rebuilt, config=public_config_json())

    @app.post("/__admin/verify-account")
    def verify_account_endpoint():
        """验证某个 SVN 账号密码是否合法（管理员，不切换当前会话）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        result = auth_service.verify_account(payload.get("username"), payload.get("password"),
                                             request.remote_addr or "")
        return jsonify({"ok": True, "result": result})

    @app.post("/__config/test-auth")
    def test_auth_config():
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        result = auth_service.test_auth_url(payload.get("url"))
        return jsonify({"ok": True, "result": result})

    @app.post('/__md/visit')
    def record_article_visit():
        session = current_session()
        rejected = require_same_origin() or (require_csrf(session) if session else None)
        if rejected:
            return rejected
        if not request.is_json:
            return json_error(415, 'json_required', '请使用 JSON 请求')
        payload = request.get_json(silent=True) or {}
        try:
            path = server_documents.normalize_md_path(payload.get('path', ''))
            if not server_documents.resolve_md_file(md_dir(), path).is_file():
                return json_error(404, 'not_found', 'Document not found')
        except MdSaveError as error:
            return json_error(400, 'invalid_path', str(error))
        with auth_service._db_lock, conn:
            database.audit(conn, 'article_visit', 'ok', actor_id=session['user']['id'] if session else None,
                           resource=path, client_ip=request.remote_addr or '')
        return jsonify(ok=True)

    @app.get('/__admin/user-records')
    def user_records():
        session, rejected = require_admin()
        if rejected:
            return rejected
        with auth_service._db_lock:
            return jsonify(ok=True, **database.user_records(conn))

    @app.get("/__admin/usage")
    def admin_usage():
        """管理员查看登录与使用情况：按 IP/账号聚合的登录记录、账号活动、最近提交、在线会话。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        try:
            days = int(request.args.get("days") or 7)
        except (TypeError, ValueError):
            days = 7
        days = max(1, min(days, 90))
        since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return jsonify({
            "ok": True,
            "days": days,
            "since": since,
            "logins": database.login_events(conn, since),
            "users": database.user_activity(conn, since),
            "userCount": database.user_count(conn),
            "operations": database.recent_operations(conn, 30),
            "audit": database.audit_events(conn, 200),
            "sessions": database.active_sessions(conn, now),
            "repositoryCount": len(config.get("repositories") or []),
        })

    def scan_documents():
        return server_documents.scan_md_tree(md_dir())

    def folder_sizes(entries):
        """按目录聚合文件大小与数量（含所有层级）。"""
        folders = {}
        for path, info in entries.items():
            parts = path.split("/")
            for depth in range(1, len(parts)):
                folder = "/".join(parts[:depth])
                item = folders.setdefault(folder, {"path": folder, "size": 0, "files": 0})
                item["size"] += info["size"]
                item["files"] += 1
        return sorted(folders.values(), key=lambda item: item["size"], reverse=True)

    @app.get("/__admin/documents")
    def admin_documents():
        """管理员查看文档统计：每个文档的大小/更新时间/更新次数、文件夹大小、增删记录。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        try:
            limit = int(request.args.get("limit") or 500)
        except (TypeError, ValueError):
            limit = 500
        limit = max(1, min(limit, 5000))
        entries = scan_documents()
        counts = database.document_update_counts(conn)
        documents = []
        for path, info in sorted(entries.items()):
            stat = counts.get(path) or {}
            documents.append({
                "path": path,
                "size": info["size"],
                "mtime": info["mtime"],
                "updates": stat.get("count", 0),
                "lastCommitAt": stat.get("lastAt"),
                "lastRevision": stat.get("lastRevision"),
            })
        documents.sort(key=lambda item: item["mtime"], reverse=True)
        return jsonify({
            "ok": True,
            "documents": documents[:limit],
            "totalDocuments": len(documents),
            "totalBytes": sum(item["size"] for item in documents),
            "folders": folder_sizes(entries),
            "events": database.document_events(conn, 200),
        })

    def folder_metrics():
        """每个一级文件夹的大小/文件数与最新文件时间。

        分类统计：mdFiles/mdBytes（Markdown 文档）、otherFiles/otherBytes（附件等其它文件）、
        subfolders（一级子文件夹数）、nestedFiles/nestedBytes（子文件夹内的文件，已计入前两类）。
        """
        metrics = {}
        root = md_dir()
        if not root.is_dir():
            return metrics
        for child in sorted(root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            size = files = newest = 0
            md_files = md_bytes = other_files = other_bytes = 0
            nested_files = nested_bytes = 0
            subfolders = 0
            for candidate in folder_sources.walk_paths(child):
                path = Path(candidate)
                if not path.is_file():
                    continue
                try:
                    relative = path.relative_to(child)
                except ValueError:
                    continue
                if ".svn" in relative.parts:
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                file_size = int(stat.st_size)
                files += 1
                size += file_size
                newest = max(newest, int(stat.st_mtime))
                if len(relative.parts) > 1:
                    nested_files += 1
                    nested_bytes += file_size
                if path.suffix.lower() == ".md":
                    md_files += 1
                    md_bytes += file_size
                else:
                    other_files += 1
                    other_bytes += file_size
            for entry in child.iterdir():
                if entry.is_dir() and not entry.name.startswith(".") and entry.name != ".svn":
                    subfolders += 1
            metrics["md/" + child.name] = {
                "sizeBytes": size,
                "files": files,
                "mdFiles": md_files,
                "mdBytes": md_bytes,
                "otherFiles": other_files,
                "otherBytes": other_bytes,
                "subfolders": subfolders,
                "nestedFiles": nested_files,
                "nestedBytes": nested_bytes,
                "mtime": (datetime.fromtimestamp(newest, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                          if newest else None),
            }
        return metrics

    @app.get('/__site/repositories')
    def homepage_repositories():
        from .site_catalog import repository_catalog
        return jsonify(ok=True, repositories=repository_catalog(docs_root, config))

    @app.get("/__folders")
    def list_folders():
        """列出 docs/md 下所有文件夹及其仓库配置（公开只读，供仓库配置页默认展示）。"""
        folders = operations.list_md_folders(md_dir(), config.get("repositories") or [])
        metrics = folder_metrics()
        latest = database.folder_latest_updates(conn)
        for folder in folders:
            source = folder_sources.describe(Path(md_dir()) / folder["path"].split("/", 1)[1])
            configured = next((item for item in config.get("repositories", [])
                               if item.get("mount") == folder["path"]), None)
            folder["sourceMode"] = (configured or {}).get("source_mode") or source.get("sourceMode", "local")
            folder["linkTarget"] = (configured or {}).get("link_target", "") or source.get("linkTarget", "")
            folder["linkExists"] = bool(source.get("linkExists", False))
            item = metrics.get(folder["path"]) or {}
            for name in ("sizeBytes", "files", "mdFiles", "mdBytes", "otherFiles", "otherBytes",
                         "subfolders", "nestedFiles", "nestedBytes"):
                folder[name] = int(item.get(name) or 0)
            # 最新更新：优先发布记录（作者+时间），没有记录时回退最新文件时间
            record = latest.get(folder["path"])
            if record:
                folder["latestUpdate"] = dict(record, source="publish")
            elif item.get("mtime"):
                folder["latestUpdate"] = {"author": "", "at": item["mtime"], "path": "",
                                          "source": "filesystem"}
            else:
                folder["latestUpdate"] = None
        return jsonify({"ok": True, "folders": folders})

    @app.get("/__folder")
    def folder_info():
        """文件夹信息（公开只读）：当前文件夹下的文档与子文件夹列表。"""
        path = request.args.get("path") or "md"
        try:
            recursive = request.args.get('recursive') == '1'
            compute = lambda: operations.folder_listing(md_dir(), path, recursive=recursive, config=config)
            listing = (folder_cache.get_or_compute((path, recursive), compute)
                       if config.get('cache', {}).get('enabled', True) else compute())
        except operations.OperationError as error:
            return json_error(error.status, "folder_error", error.message)
        return jsonify({"ok": True, "folder": listing})

    document_meta_cache = MetadataCache(cache_settings.get('maxEntries', 256), cache_settings.get('maxBytes', 33554432),
                                       cache_settings.get('metadataTtlSeconds', 60))

    def file_updated_at(path):
        try:
            stamp = path.stat().st_mtime
        except OSError:
            return None
        return datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def svn_document_meta(binding, path, target):
        signature = target.stat()
        key = (binding['id'], path, signature.st_mtime, signature.st_size)
        return document_meta_cache.get_or_compute(key, lambda: compute_svn_document_meta(binding, path, target))

    def compute_svn_document_meta(binding, path, target):
        """SVN 文档最后提交时间与作者：优先网页提交记录，其次缓存的 svn log。"""
        with auth_service._db_lock:
            record = database.document_last_update(conn, path)
        if record is not None:
            meta = {"path": path, "updatedAt": record.get("lastAt"), "source": "svn",
                    "revision": record.get("lastRevision"), "author": record.get("author") or ""}
        else:
            meta = {"path": path, "updatedAt": None, "source": "svn", "revision": None, "author": ""}
            config_dir = tempfile.mkdtemp(prefix="md2web-meta-")
            try:
                relative = path[len(binding["mount"]):].lstrip("/")
                url = binding["url"].rstrip("/") + "/" + relative
                credential = auth_service.repo_sync_credential(binding, None) or (None, None)
                entries = auth_service.svn.log(url, limit=1, config_dir=config_dir,
                                               username=credential[0], password=credential[1])
                if entries:
                    meta["updatedAt"] = entries[0].get("date") or None
                    meta["revision"] = entries[0].get("revision")
                    meta["author"] = entries[0].get("author") or ""
            except Exception:
                meta["updatedAt"] = None
            finally:
                shutil.rmtree(config_dir, ignore_errors=True)
            if not meta["updatedAt"]:
                meta["updatedAt"] = file_updated_at(target)
                meta["source"] = "file"
                meta["author"] = ""
        return meta

    @app.get("/__doc-meta")
    def document_meta():
        """文档更新信息（公开只读）：提交/文件时间，以及可靠记录中的作者。"""
        path = str(request.args.get("path") or "").strip()
        if not path.startswith("md/"):
            return json_error(400, "invalid_path", "仅支持 md/ 下的文档")
        try:
            path = server_documents.normalize_md_path(path)
            target = server_documents.resolve_md_file(md_dir(), path)
        except MdSaveError as error:
            return json_error(error.status, "meta_error", error.message)
        binding = server_config.match_repository(config, path)
        if binding is not None and (binding.get("source_mode") or "svn") == "svn":
            meta = svn_document_meta(binding, path, target)
        else:
            meta = {"path": path, "updatedAt": file_updated_at(target),
                    "source": "file", "revision": None, "author": ""}
            with auth_service._db_lock:
                saved = conn.execute(
                    'SELECT v.content, u.svn_username AS author FROM local_document_versions v'
                    ' LEFT JOIN users u ON u.id=v.actor_id WHERE v.path=? ORDER BY v.id DESC LIMIT 1',
                    (path,)).fetchone()
            if saved is not None:
                try:
                    current = target.read_text(encoding='utf-8')
                    if server_documents.normalize_eol(current) == server_documents.normalize_eol(saved['content']):
                        meta['author'] = saved['author'] or ''
                except (OSError, UnicodeError):
                    pass
        return jsonify({"ok": True, "meta": meta})

    @app.get("/__trash")
    def trash_info():
        session, rejected = require_session()
        if rejected:
            return rejected
        mount = (request.args.get("mount") or "md").replace("\\", "/").rstrip("/")
        return jsonify({"ok": True, "mount": mount, "entries": recycle.list_entries(md_dir(), mount)})

    @app.post("/__md/create")
    def create_entry():
        return mutate_entry("create")

    @app.post("/__md/rename")
    def rename_entry():
        return mutate_entry("rename")

    @app.post("/__md/move")
    def move_entry():
        return mutate_entry("move")

    @app.post("/__md/delete")
    def delete_entry():
        return mutate_entry("delete")

    @app.post("/__md/restore")
    def restore_entry():
        return mutate_entry("restore")

    @app.post("/__md/trash-empty")
    def empty_trash():
        return mutate_entry("trash-empty")

    def mutate_entry(action):
        """即时提交 SVN 后发布本地；所有入口共用权限与冲突检查。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            credential = credential_of(session)
            if not credential and payload.get("svnUsername") and payload.get("svnPassword"):
                auth_service.check_svn_credential(payload['svnUsername'], payload['svnPassword'])
                auth_service.remember_credential(session['sessionId'], payload['svnUsername'], payload['svnPassword'])
                credential = (payload['svnUsername'], payload['svnPassword'])
            result = entries.mutate(conn, auth_service._db_lock, auth_service.svn, config, md_dir(),
                                    session['user']['id'], credential, action, payload)
        except operations.OperationError as error:
            credential_invalidated(session, error)
            extra = dict(error.extra)
            code = extra.pop('code', 'entry_error')
            return json_error(error.status, code, error.message, **extra)
        # 重命名后页面立即刷新，必须等待导航重建，避免再次读到旧名称/路径。
        if action == 'rename':
            result['saved'] = True
            return jsonify({'ok': True, 'result': result, 'rebuilt': rebuild_repository_pages()})
        # 其他操作沿用后台重建。
        if on_config_changed is not None:
            def rebuild_after_publish():
                try:
                    on_config_changed()
                except Exception:
                    app.logger.exception("站点重建失败")
            threading.Thread(target=rebuild_after_publish, name="md2web-publish-rebuild",
                             daemon=True).start()
        result["saved"] = True
        return jsonify({"ok": True, "result": result})

    def repo_by_id(repo_id):
        for repo in config.get("repositories") or []:
            if repo["id"] == repo_id:
                return repo
        return None

    @app.post("/__admin/repo-health")
    def repo_health_endpoint():
        """检查一个仓库（或全部）的健康状态（管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        repo_id = str(payload.get("id") or "").strip()
        credential = credential_of(session) or auth_service.sync_credential()
        if repo_id == "site-backup":
            reports = auth_service.repo_health_reports(md_dir(), [], credential,
                                                       include_site_backup=True)
            return jsonify({"ok": True, "reports": reports})
        bindings = config.get("repositories") or []
        if repo_id:
            binding = repo_by_id(repo_id)
            if binding is None:
                return json_error(404, "not_found", "没有找到仓库：" + repo_id)
            bindings = [binding]
        # 本地模式仓库不做 SVN 检查：直接返回本地来源状态
        local = [item for item in bindings if item.get("source_mode") == "local"]
        remote = [item for item in bindings if item.get("source_mode") != "local"]
        reports = []
        if remote or not repo_id:
            reports = auth_service.repo_health_reports(md_dir(), remote, credential,
                                                       include_site_backup=not repo_id)
        reports.extend({
            "id": item["id"],
            "mount": item["mount"],
            "url": "",
            "indexPage": "",
            "localPath": "",
            "revision": 0,
            "syncError": None,
            "status": "本地模式",
            "level": "ok",
            "detail": "使用本地 SQLite 作为权威来源，不做 SVN 检查",
            "hints": [],
        } for item in local)
        return jsonify({"ok": True, "reports": reports})

    @app.post("/__admin/repo-repair")
    def repo_repair_endpoint():
        """修复仓库（id=site-backup 时只修复网站备份工作副本，管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        repo_id = str(payload.get("id") or "").strip()
        if repo_id == "site-backup":
            return jsonify({"ok": True, "notes": auth_service.repair_site_backup_workcopy()})
        binding = repo_by_id(repo_id)
        if binding is None:
            return json_error(404, "not_found", "没有找到仓库")
        credential = credential_of(session) or auth_service.sync_credential()
        try:
            result = auth_service.repair_repository(md_dir(), binding, credential)
        except operations.OperationError as error:
            return json_error(error.status, "repair_error", error.message)
        return jsonify({"ok": True, **result})

    @app.post("/__admin/repo-recreate")
    def repo_recreate_endpoint():
        """删除重建仓库（id=site-backup 时重建网站备份工作副本，管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        repo_id = str(payload.get("id") or "").strip()
        if repo_id == "site-backup":
            try:
                result = auth_service.recreate_site_backup_workcopy(docs_root.parent)
            except operations.OperationError as error:
                return json_error(error.status, "recreate_error", error.message)
            return jsonify({"ok": True, **result})
        binding = repo_by_id(repo_id)
        if binding is None:
            return json_error(404, "not_found", "没有找到仓库")
        credential = credential_of(session) or auth_service.sync_credential()
        try:
            result = auth_service.recreate_repository(md_dir(), binding, credential)
        except operations.OperationError as error:
            return json_error(error.status, "recreate_error", error.message)
        if on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, **result})

    @app.get("/__feedback")
    def list_feedback_endpoint():
        """反馈列表（公开只读）：登录用户可提交，管理员可更新进度。"""
        try:
            limit = int(request.args.get("limit") or 200)
        except (TypeError, ValueError):
            limit = 200
        limit = max(1, min(limit, 500))
        status = str(request.args.get("status") or "").strip() or None
        rows = database.list_feedback(conn, limit=limit, status=status)
        return jsonify({
            "ok": True,
            "statuses": [{"id": key, "label": label}
                         for key, label in database.FEEDBACK_STATUS_LABELS.items()],
            "feedback": rows,
        })

    def feedback_assets(payload, key, prefix, limit=12):
        """校验反馈附带的资产路径：必须是 prefix/ 下的已存在文件（防止任意路径入库）。"""
        values = payload.get(key) or []
        if not isinstance(values, list):
            return []
        result = []
        for raw in values[:limit]:
            value = str(raw or "").strip().replace("\\", "/")
            if not value.startswith(prefix + "/"):
                continue
            name = value[len(prefix) + 1:]
            if not name or "/" in name or ".." in name or name.startswith("."):
                continue
            if not (docs_root / prefix / name).is_file():
                continue
            if value not in result:
                result.append(value)
        return result

    @app.post("/__feedback/image")
    def upload_feedback_image():
        """反馈截图：写入 docs/html/images/，命名 fb-<时间戳>-<序号>.<扩展名>。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            result = server_documents.save_feedback_image(
                docs_root, payload.get("type"), payload.get("data"),
                max_bytes=policy.upload_bytes(config),
            )
        except MdSaveError as error:
            return json_error(error.status, "image_error", error.message)
        return jsonify({"ok": True, **result})

    @app.post("/__feedback/attachment")
    def upload_feedback_attachment():
        """反馈附件：写入 docs/html/uploads/，沿用原文件名（重名自动加序号）。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            result = server_documents.save_feedback_attachment(
                docs_root, payload.get("name"), payload.get("data"),
                max_bytes=policy.upload_bytes(config),
            )
        except MdSaveError as error:
            return json_error(error.status, "attachment_error", error.message)
        return jsonify({"ok": True, **result})

    @app.post("/__feedback")
    def create_feedback_endpoint():
        """提交反馈（登录用户 + CSRF）。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        title = str(payload.get("title") or "").strip()
        body = str(payload.get("body") or "").strip()
        page = str(payload.get("page") or "").strip()[:300]
        if len(title) < 2 or not body:
            return json_error(400, "invalid_request", "请填写标题（至少 2 个字）与问题描述")
        user = session["user"]
        images = feedback_assets(payload, "images", "html/images")
        attachments = feedback_assets(payload, "attachments", "html/uploads")
        feedback_id = database.create_feedback(
            conn, user.get("id"), user.get("displayName") or user.get("username") or "读者",
            title[:200], body[:8000], page, images=images, attachments=attachments,
        )
        database.audit(conn, "feedback_create", "ok", actor_id=user.get("id"), resource=str(feedback_id))
        return jsonify({"ok": True, "id": feedback_id})

    @app.post("/__feedback/delete")
    def delete_feedback_endpoint():
        """删除反馈：管理员可删任意一条，登录用户可删自己提交的（均需 CSRF）。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            feedback_id = int(payload.get("id") or 0)
        except (TypeError, ValueError):
            return json_error(400, "invalid_request", "缺少有效的反馈 id")
        row = database.get_feedback(conn, feedback_id)
        if row is None:
            return json_error(404, "not_found", "反馈不存在或已被删除")
        user = session["user"]
        is_admin = user.get("role") == "admin"
        if not is_admin and (row.get("author_id") is None or row["author_id"] != user.get("id")):
            return json_error(403, "forbidden", "只能删除自己提交的反馈（管理员可删除任意一条）")
        database.delete_feedback(conn, feedback_id)
        database.audit(conn, "feedback_delete", "ok", actor_id=user.get("id"), resource=str(feedback_id))
        return jsonify({"ok": True, "id": feedback_id})

    @app.post("/__admin/feedback")
    def update_feedback_endpoint():
        """更新反馈进度（管理员 + CSRF）：status 与 note。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            feedback_id = int(payload.get("id") or 0)
        except (TypeError, ValueError):
            return json_error(400, "invalid_request", "缺少有效的反馈 id")
        updated = database.update_feedback(conn, feedback_id, status=payload.get("status"),
                                           note=payload.get("note"))
        if updated is None:
            return json_error(404, "not_found", "反馈不存在")
        database.audit(conn, "feedback_update", "ok", actor_id=session["user"].get("id"),
                       resource=str(feedback_id))
        return jsonify({"ok": True, "feedback": updated})

    @app.post("/__admin/repo-credential")
    def set_repo_credential():
        """设置某个仓库（或 site-backup）的同步用户名与密码（加密入库）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        repo_id = str(payload.get("id") or "").strip()
        username = str(payload.get("username") or "").strip()
        password = payload.get("password") or ""
        if not repo_id or not username or not password:
            return json_error(400, "invalid_request", "需要 id、username 与 password")
        if not auth_service.store_repo_credential(repo_id, username, password):
            return json_error(500, "credential_error", "保存同步凭据失败（检查配置中的 security.secretKey）")
        return jsonify({"ok": True, "id": repo_id, "username": username})

    @app.get("/__admin/credentials")
    def list_repo_credentials():
        """列出已配置同步凭据的仓库与用户名（不含口令）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        rows = {}
        for repo in config.get("repositories") or []:
            name = auth_service.repo_credential_username(repo["id"])
            if name:
                rows[repo["id"]] = name
        site_name = auth_service.repo_credential_username("site-backup")
        if site_name:
            rows["site-backup"] = site_name
        return jsonify({"ok": True, "credentials": rows})

    @app.get("/__admin/default-credential")
    def get_default_credential():
        """默认同步凭据（只返回用户名）：未单独配置凭据的仓库同步时统一使用。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        username = auth_service.default_credential_username()
        return jsonify({"ok": True, "credential": {"configured": bool(username), "username": username or ""}})

    @app.post("/__admin/default-credential")
    def set_default_credential():
        """验证并保存默认同步凭据（管理员 + CSRF）：先经已配置的 SVN 认证路径校验。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username") or "").strip()
        password = payload.get("password") or ""
        if not username or not password:
            return json_error(400, "invalid_request", "需要 username 与 password")
        result = auth_service.verify_account(username, password, request.remote_addr or "")
        if result.get("admin"):
            return json_error(400, "admin_account_not_allowed",
                              "本机管理员账号没有 SVN 口令，不能作为同步凭据：请使用 SVN 账号")
        if not auth_service.store_default_credential(username, password):
            return json_error(500, "credential_error", "保存默认同步凭据失败（检查配置中的 security.secretKey）")
        return jsonify({"ok": True, "username": username,
                        "message": result.get("message") or "默认同步凭据已保存"})

    @app.post("/__admin/site-backup")
    def admin_site_backup():
        """立即把网站数据合入 SVN 库（管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        try:
            result = auth_service.backup_site_data(docs_root.parent)
        except operations.OperationError as error:
            return json_error(error.status, "site_backup_error", error.message)
        return jsonify({"ok": True, "result": result})

    @app.post("/__admin/group")
    def set_repo_group():
        """设置文件夹（仓库）的分组：更新配置并触发重建（管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        repo_id = str(payload.get("id") or "").strip()
        group = str(payload.get("group") or "").strip()
        if not repo_id:
            return json_error(400, "invalid_request", "缺少仓库 id")
        if not group:
            return json_error(400, "invalid_request", "缺少分组名称")
        data = config_to_json(config)
        found = False
        for repo in data.get("repositories") or []:
            if repo.get("id") == repo_id:
                repo["group"] = group
                found = True
        if not found:
            return json_error(404, "not_found", "没有找到仓库：" + repo_id)
        try:
            loaded = save_config(config["path"], data, docs_root)
        except server_config.ConfigError as error:
            return json_error(400, "config_invalid", str(error))
        config.clear()
        config.update(loaded)
        auth_service.on_config_changed()
        if on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, "group": group})

    @app.post("/__admin/folder-link")
    def manage_folder_link():
        """检查/创建/移除 md 下一级文件夹的软链接（管理员 + CSRF）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action") or "").strip().lower()
        try:
            result = folder_sources.manage_link(
                md_dir(), payload.get("mount"), payload.get("target"), action)
        except folder_sources.FolderLinkError as error:
            return json_error(400, error.code, str(error))
        except ValueError as error:
            return json_error(400, "link_error", str(error))
        except OSError as error:
            return json_error(500, "link_error", "链接操作失败：%s" % error)
        if action in ("create", "remove") and on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, "link": result})

    @app.post("/__admin/provision")
    def admin_provision():
        """创建 docs/md 下的仓库目录并从 SVN 拉取（配置页「创建并拉取」）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        repo_id = str(payload.get("id") or "").strip()
        binding = None
        for repo in config.get("repositories") or []:
            if repo["id"] == repo_id:
                binding = repo
                break
        if binding is None:
            return json_error(404, "not_found", "没有找到仓库：" + repo_id)
        credential = auth_service.repo_sync_credential(binding, credential_of(session))
        try:
            result = operations.provision_repository(conn, auth_service.svn, config, md_dir(), binding,
                                                     credential, db_lock=auth_service._db_lock)
        except operations.OperationError as error:
            return json_error(error.status, "provision_error", error.message, **error.extra)
        if on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, "result": result})

    def rebuild_repository_pages():
        if on_config_changed is None:
            return False
        try:
            return on_config_changed() is not False
        except Exception:
            app.logger.exception('仓库页面重建失败')
            return False

    @app.get('/__admin/repo-trash')
    def repository_trash():
        _, rejected = require_admin()
        if rejected:
            return rejected
        try:
            return jsonify({'ok': True, 'entries': repositories.listing(md_dir())})
        except (OSError, operations.OperationError) as error:
            return json_error(500, 'repo_trash_error', str(error))

    def mutate_repository(action):
        session, rejected = require_admin()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
        try:
            if action == 'delete':
                result = repositories.delete(config, conn, auth_service._db_lock, md_dir(), payload.get('id'), payload.get('mount'))
            else:
                result = repositories.restore(config, md_dir(), payload.get('entryId'))
            auth_service.on_config_changed()
            with auth_service._db_lock, conn:
                database.audit(conn, 'repository_' + action, 'ok', actor_id=session['user']['id'],
                               resource=result['mount'])
        except operations.OperationError as error:
            return json_error(error.status, 'repo_' + action + '_error', error.message)
        except (OSError, server_config.ConfigError, folder_sources.FolderLinkError) as error:
            return json_error(400, 'repo_' + action + '_error', str(error))
        rebuilt = rebuild_repository_pages()
        return jsonify({'ok': True, 'result': result, 'config': public_config_json(), 'rebuilt': rebuilt})

    @app.post('/__admin/repo-delete')
    def delete_repository():
        return mutate_repository('delete')

    @app.post('/__admin/repo-restore')
    def restore_repository():
        return mutate_repository('restore')

    @app.post("/__admin/sync")
    def admin_sync():
        """管理员手动同步忽略定时频率，并重建本地目录和仓库入口。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        results = auth_service.sync_repositories(md_dir(), force=True)
        rebuilt = rebuild_repository_pages()
        return jsonify({"ok": True, "results": results, "rebuilt": rebuilt})

    @app.post("/__admin/password")
    def change_password():
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        auth_service.change_admin_password(
            session["user"]["id"], payload.get("current"), payload.get("password")
        )
        return jsonify({"ok": True})

    # ---- 写接口守卫：阶段一统一只读，拒绝匿名与旧接口 ----

    @app.route("/__md/save", methods=["POST"])
    def legacy_save():
        session, rejected = require_session()
        if rejected:
            return rejected
        return json_error(
            410,
            "legacy_save_retired",
            "旧的无版本保存接口已停用：请使用草稿接口（阶段二）或提交 SVN（阶段三）",
        )

    # ---- 阶段二：个人草稿与版本历史 ----

    def md_dir():
        return docs_root / "md"

    def symlink_write_guard(path):
        """软链接目录：只读（默认）拒绝写入；配置为可读写时放行。"""
        if not path or not folder_sources.has_link_ancestor(md_dir(), path):
            return None
        binding = server_config.match_repository(config, path)
        if (binding is not None and (binding.get("source_mode") or "") == "symlink"
                and not binding.get("read_only") and binding.get("allow_commit", True)):
            return None
        return json_error(403, "symlink_readonly", "软链接目录只读，请在目标目录直接修改")

    def require_csrf_header(session):
        return require_csrf(session)

    @app.get("/__md/document")
    def read_document():
        session, rejected = require_session()
        if rejected:
            return rejected
        path = request.args.get("path") or ""
        binding = server_config.match_repository(config, path)
        try:
            state = drafts.document_state(conn, session["user"]["id"], md_dir(), path, binding)
        except server_documents_error() as error:
            return json_error(error.status, "invalid_path", error.message)
        return jsonify({"ok": True, "document": state})

    @app.put("/__md/draft")
    def put_draft():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        guard = symlink_write_guard(payload.get("path"))
        if guard is not None:
            return guard
        binding = server_config.match_repository(config, payload.get("path") or "")
        try:
            result = drafts.save_draft(
                conn,
                session["user"]["id"],
                md_dir(),
                payload.get("path"),
                payload.get("content"),
                expected_version=payload.get("expectedVersion"),
                binding_id=binding_row_id(binding),
            )
        except drafts.DraftError as error:
            return json_error(error.status, "draft_conflict" if error.status == 409 else "draft_error",
                              error.message, **error.extra)
        return jsonify({"ok": True, **result})

    @app.post("/__md/image")
    def upload_image():
        """粘贴图片：写入文档同级 images/，命名 <文档名>-<序号>-<时间戳>.<扩展名>。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        guard = symlink_write_guard(payload.get("path"))
        if guard is not None:
            return guard
        try:
            result = server_documents.save_document_image(
                md_dir(), payload.get("path"), payload.get("type"), payload.get("data"),
                max_bytes=policy.upload_bytes(config),
            )
        except MdSaveError as error:
            return json_error(error.status, "image_error", error.message)
        return jsonify({"ok": True, **result})

    @app.post("/__md/attachment")
    def upload_attachment():
        """上传附件：写入文档同级 附件/，沿用原文件名（同名自动加序号）。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        guard = symlink_write_guard(payload.get("path"))
        if guard is not None:
            return guard
        try:
            result = server_documents.save_document_attachment(
                md_dir(), payload.get("path"), payload.get("name"), payload.get("data"),
                max_bytes=policy.upload_bytes(config),
            )
        except MdSaveError as error:
            return json_error(error.status, "attachment_error", error.message)
        return jsonify({"ok": True, **result})

    def local_history_path(raw):
        from . import documents
        path = documents.normalize_md_path(raw)
        binding = server_config.match_repository(config, path)
        return path if not binding or binding.get('source_mode') == 'local' else None

    @app.get('/__md/compare')
    def compare_versions():
        session, rejected = require_session()
        if rejected:
            return rejected
        from . import local_history
        from .svn import SvnError
        try:
            path = server_documents.normalize_md_path(request.args.get('path', ''))
            binding = server_config.match_repository(config, path)
            def resolve(ref):
                if ref == 'published':
                    text = drafts.published_text(md_dir(), path)
                    if text is None:
                        raise drafts.DraftError(404, '文档不存在')
                    result = {'content': text}
                elif ref.startswith('local:'):
                    if local_history_path(path) is None:
                        raise drafts.DraftError(404, '不是本地文档')
                    with auth_service._db_lock:
                        result = local_history.get_revision(conn, path, ref)
                elif ref.startswith('draft:'):
                    with auth_service._db_lock:
                        row = conn.execute('SELECT r.*, u.svn_username AS author FROM revisions r JOIN drafts d ON d.id=r.draft_id JOIN users u ON u.id=r.actor_id WHERE r.id=? AND d.user_id=? AND d.document_path=?',
                                           (int(ref[6:]), session['user']['id'], path)).fetchone()
                    if row is None:
                        raise drafts.DraftError(404, '版本不存在或无权访问')
                    result = dict(content=row['content'], createdAt=row['created_at'], author=row['author'])
                elif ref.startswith('svn:r') and ref[5:].isdigit() and int(ref[5:]) > 0:
                    if not binding or binding.get('source_mode', 'svn') != 'svn':
                        raise drafts.DraftError(400, '不是 SVN 文档')
                    from urllib.parse import quote
                    relative = path[len(binding['mount']):].lstrip('/')
                    url = binding['url'].rstrip('/') + '/' + quote(relative)
                    credential = credential_of(session) or (None, None)
                    directory = tempfile.mkdtemp(prefix='md2web-compare-')
                    try:
                        text = auth_service.svn.cat(url, revision=int(ref[5:]), config_dir=directory,
                                                   username=credential[0], password=credential[1])
                    finally:
                        shutil.rmtree(directory, ignore_errors=True)
                    result = {'content': text}
                else:
                    raise drafts.DraftError(400, '无效的版本引用')
                result.update(ref=ref, label=ref, hash=server_documents.text_hash(result['content']),
                              size=len(result['content'].encode('utf-8')))
                return result
            return jsonify(ok=True, left=resolve(request.args.get('left', 'published')),
                           right=resolve(request.args.get('right', 'published')), options=config.get('historyCompare', {}))
        except (drafts.DraftError, MdSaveError) as error:
            return json_error(error.status, 'compare_failed', str(error))
        except (ValueError, SvnError) as error:
            return json_error(400, 'compare_failed', str(error))

    @app.get("/__md/revision")
    def read_revision():
        session, rejected = require_session()
        if rejected:
            return rejected
        if str(request.args.get('id') or '').startswith('local:'):
            from . import local_history
            try:
                path = local_history_path(request.args.get('path') or '')
                if path is None:
                    return json_error(404, 'not_found', '不是本地文档')
                with auth_service._db_lock:
                    revision = local_history.get_revision(conn, path, request.args.get('id'))
                return jsonify(ok=True, revision=revision)
            except (drafts.DraftError, server_documents_error()) as error:
                return json_error(error.status, 'history_error', error.message)
        try:
            revision_id = int(request.args.get("id") or 0)
        except (TypeError, ValueError):
            return json_error(400, "invalid_request", "缺少有效的版本 id")
        revision = drafts.get_revision(conn, session["user"]["id"], revision_id)
        if revision is None:
            return json_error(404, "not_found", "版本不存在或无权访问")
        return jsonify({"ok": True, "revision": {
            "id": revision["id"],
            "content": revision["content"],
            "hash": revision["after_hash"],
            "createdAt": revision["created_at"],
            "baseRevision": revision["base_svn_revision"],
        }})

    @app.get("/__md/history")
    def read_history():
        session, rejected = require_session()
        if rejected:
            return rejected
        try:
            from . import local_history
            path = local_history_path(request.args.get('path') or '')
            with auth_service._db_lock:
                limit = min(200, max(1, int(request.args.get('limit', 50))))
                cursor = int(request.args['cursor']) if request.args.get('cursor') else None
                history = (local_history.list_history(conn, md_dir(), path, cursor=cursor, limit=limit) if path else
                           drafts.list_history(conn, session['user']['id'], md_dir(), request.args.get('path') or '', limit=limit, cursor=cursor))
                # 兼容旧客户端对未绑定文档显式保存的个人草稿；新版本地编辑器明确请求 mode=local。
                if path and not history['revisions'] and request.args.get('mode') != 'local':
                    history = drafts.list_history(conn, session['user']['id'], md_dir(), path)
        except server_documents_error() as error:
            return json_error(error.status, "invalid_path", error.message)
        except ValueError:
            return json_error(400, 'invalid_request', '分页参数无效')
        return jsonify({"ok": True, "history": history})

    @app.get("/__md/diff")
    def read_diff():
        session, rejected = require_session()
        if rejected:
            return rejected
        try:
            from . import local_history
            path = local_history_path(request.args.get('path') or '')
            if path and request.args.get('to') != 'draft':
                with auth_service._db_lock:
                    result = local_history.diff_documents(conn, md_dir(), path,
                        request.args.get('from') or 'previous', request.args.get('to') or 'published')
                return jsonify(ok=True, diff=result)
            result = drafts.diff_documents(
                conn,
                session["user"]["id"],
                md_dir(),
                request.args.get("path") or "",
                request.args.get("from"),
                request.args.get("to"),
            )
        except drafts.DraftError as error:
            return json_error(error.status, "diff_error", error.message)
        except server_documents_error() as error:
            return json_error(error.status, "invalid_path", error.message)
        return jsonify({"ok": True, "diff": result})

    @app.post("/__md/discard")
    @serialized
    def discard_draft():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
            with auth_service._db_lock:
                result = drafts.discard_draft(conn, session["user"]["id"], payload.get("path"))
        except drafts.DraftError as error:
            return json_error(error.status, "draft_error", error.message)
        except server_documents_error() as error:
            return json_error(error.status, "invalid_path", error.message)
        return jsonify({"ok": True, **result})

    def binding_row_id(binding):
        """把配置中的仓库映射登记到 repo_bindings（阶段三提交时使用）。"""
        if not binding:
            return None
        row = conn.execute("SELECT id FROM repo_bindings WHERE mount_path = ?", (binding["mount"],)).fetchone()
        if row is not None:
            return row["id"]
        with conn:
            cursor = conn.execute(
                "INSERT INTO repo_bindings (repository_id, mount_path, credential_group, config_version,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (binding["id"], binding["mount"], binding["credential_group"],
                 str(config.get("path", "")), database.now_iso(), database.now_iso()),
            )
        return cursor.lastrowid

    @app.route("/__md/publish", methods=["POST"])
    @serialized
    def pending_publish():
        """无 SVN 库文档的一步保存：写入 docs/md（本地模式走 SQLite 主库）并触发站点重建。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        path = payload.get("path") or ""
        guard = symlink_write_guard(path)
        if guard is not None:
            return guard
        binding = server_config.match_repository(config, path)
        if binding is not None:
            guard = repo_write_guard(binding)
            if guard is not None:
                return guard
            if binding.get("source_mode", "svn") == "svn":
                return json_error(400, "use_svn_commit",
                                  "该文档关联 SVN 仓库：请先「本地暂存」，再用「提交 SVN」写入仓库")
        try:
            with auth_service._db_lock:
                if binding is not None and binding.get("source_mode") == "local":
                    result = operations.local_publish_content(
                        conn, config, md_dir(), session["user"]["id"], path,
                        payload.get("content"), payload.get("baseHash"))
                else:
                    result = operations.publish_file(
                        conn, md_dir(), session["user"]["id"], path,
                        payload.get("content"), payload.get("baseHash"))
        except operations.OperationError as error:
            extra = dict(error.extra)
            code = extra.pop("code", "publish_error")
            return json_error(error.status, code, error.message, **extra)
        except server_documents_error() as error:
            return json_error(error.status, "publish_error", error.message, **getattr(error, "extra", {}))
        if on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, "result": result})

    @app.get("/__md/drafts")
    def list_my_drafts():
        """当前用户未提交的本地暂存（活动草稿），供离开页面时的提醒。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        return jsonify({"ok": True, **drafts.list_active_drafts(conn, session["user"]["id"])})

    # ---- 阶段三：SVN 提交与同步 ----

    def repo_write_guard(binding):
        """只读仓库或关闭合入的仓库：拒绝写操作。"""
        if binding is None:
            return None
        if binding.get("read_only"):
            return json_error(403, "repo_read_only", "该仓库已设置为只读，禁止提交")
        if not binding.get("allow_commit", True):
            return json_error(403, "repo_commit_disabled", "该仓库已关闭合入（允许合入 = 否）")
        return None

    def commit_diff(operation_id):
        """本次提交的差异（来自冻结清单里的草稿版本快照）。"""
        row = conn.execute("SELECT reviewed_manifest FROM operations WHERE id = ?",
                           (operation_id,)).fetchone()
        if row is None:
            return ""
        try:
            manifest = json.loads(row["reviewed_manifest"] or "{}")
        except ValueError:
            return ""
        revision_id = manifest.get("draftRevisionId")
        if not revision_id:
            return ""
        revision = conn.execute("SELECT unified_diff FROM revisions WHERE id = ?", (revision_id,)).fetchone()
        return (revision["unified_diff"] or "") if revision else ""

    def credential_of(session):
        """提交/绑定时使用的 SVN 凭据：优先数据库中最新的（登录成功即更新），其次会话内存。"""
        stored = auth_service.stored_credential(session.get("user"))
        if stored is not None:
            return stored
        return auth_service.credential_for(session["sessionId"])

    def credential_invalidated(session, error):
        """SVN 拒绝口令（401 needs_auth）时清理库里的旧密文，避免一直用旧密码重试。"""
        if getattr(error, "status", None) != 401 or getattr(error, "extra", {}).get("code") == "svn_credentials_required":
            return
        auth_service.forget_stored_credential(session.get("user"))
        auth_service.forget_credential(session["sessionId"])

    @app.get("/__svn/info")
    def svn_info():
        session, rejected = require_session()
        if rejected:
            return rejected
        path = request.args.get("path") or ""
        binding = server_config.match_repository(config, path)
        if binding is None:
            return json_error(400, "no_binding", "该文档未关联 SVN")
        try:
            row = operations.ensure_binding(conn, binding, auth_service.svn, config, credential_of(session))
        except operations.OperationError as error:
            return json_error(error.status, "binding_error", error.message, **error.extra)
        return jsonify({"ok": True, "binding": {
            "id": binding["id"], "mount": binding["mount"], "targetUrl": binding["url"],
            "repositoryUuid": row.get("repository_uuid"),
            "publishedRevision": row.get("published_revision"),
            "lastCheckedAt": row.get("last_checked_at"),
            "syncError": row.get("sync_error"),
        }})

    @app.post("/__svn/prepare")
    def svn_prepare():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        guard = repo_write_guard(server_config.match_repository(config, payload.get("path") or ""))
        if guard is not None:
            return guard
        try:
            result = operations.prepare_commit(
                conn, session["user"]["id"], config, md_dir(),
                payload.get("path"), payload.get("message"), payload.get("expectedVersion"), db_lock=auth_service._db_lock,
            )
        except operations.OperationError as error:
            credential_invalidated(session, error)
            return json_error(error.status, "prepare_error", error.message, **error.extra)
        except MdSaveError as error:
            return json_error(error.status, "invalid_path", error.message)
        return jsonify({"ok": True, **result})

    @app.post('/__svn/cancel')
    def svn_cancel():
        session, rejected = require_session()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
        try:
            result = operations.cancel_commit(conn, session['user']['id'], payload.get('operationId'), db_lock=auth_service._db_lock)
        except operations.OperationError as error:
            return json_error(error.status, 'cancel_error', error.message)
        return jsonify(ok=True, result=result)

    @app.post("/__svn/commit")
    def svn_commit():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        operation_row = conn.execute("SELECT reviewed_manifest FROM operations WHERE id = ?",
                                     (payload.get("operationId"),)).fetchone()
        if operation_row is not None:
            try:
                operation_manifest = json.loads(operation_row["reviewed_manifest"] or "{}")
            except ValueError:
                operation_manifest = {}
            guard = repo_write_guard(
                server_config.match_repository(config, operation_manifest.get("path") or ""))
            if guard is not None:
                return guard
        credential = credential_of(session)
        supplied_user = str(payload.get("svnUsername") or "").strip()
        supplied_password = payload.get("svnPassword") or ""
        if credential is None and supplied_user and supplied_password:
            # 管理员（本机账号）没有 SVN 口令：提交时补充并校验，只存进程内存
            try:
                auth_service.check_svn_credential(supplied_user, supplied_password)
            except AuthError as error:
                return json_error(error.status, error.code, str(error))
            auth_service.remember_credential(session["sessionId"], supplied_user, supplied_password)
            credential = (supplied_user, supplied_password)
        try:
            result = operations.run_commit(
                conn, auth_service.svn, config, md_dir(), config["storage"]["workspaces"],
                payload.get("operationId"), session["user"]["id"], credential, db_lock=auth_service._db_lock,
            )
        except operations.OperationError as error:
            credential_invalidated(session, error)
            return json_error(error.status, "commit_error", error.message, **error.extra)
        result["diff"] = commit_diff(payload.get("operationId"))
        return jsonify({"ok": True, "result": result})

    @app.get("/__operations/<operation_id>")
    def operation_status(operation_id):
        session, rejected = require_session()
        if rejected:
            return rejected
        is_admin = (session["user"].get("role") or "user") == "admin"
        row = operations.get_operation(conn, operation_id, None if is_admin else session["user"]["id"])
        if row is None:
            return json_error(404, "not_found", "操作不存在或无权访问")
        return jsonify({"ok": True, "operation": {
            "id": row["id"], "state": row["state"], "kind": row["kind"],
            "svnRevision": row["svn_revision"], "errorCode": row["error_code"],
            "message": row["message"], "createdAt": row["created_at"], "finishedAt": row["finished_at"],
        }})

    @app.get("/__svn/status")
    def svn_status():
        """文档同步状态：远端版本、已发布版本、最近检查时间、同步错误、是否有活动草稿冲突。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        path = request.args.get("path") or ""
        binding = server_config.match_repository(config, path)
        if binding is None:
            return json_error(400, "no_binding", "该文档未配置 SVN 仓库")
        row = conn.execute("SELECT * FROM repo_bindings WHERE mount_path = ?", (binding["mount"],)).fetchone()
        draft = conn.execute(
            "SELECT COUNT(*) FROM drafts WHERE state = 'active' AND document_path = ?", (path,),
        ).fetchone()[0]
        credential = credential_of(session) or auth_service.sync_credential()
        remote_revision = None
        if credential is not None:
            try:
                remote_revision = operations.remote_revision(conn, auth_service.svn, config, binding, credential)
            except operations.OperationError:
                remote_revision = None
        published = int(row["published_revision"] or 0) if row else 0
        sync_error = row["sync_error"] if row else None
        needs_merge = bool(draft) and (
            sync_error == "conflicts" or (remote_revision is not None and remote_revision > published)
        )
        return jsonify({"ok": True, "status": {
            "binding": {"id": binding["id"], "mount": binding["mount"], "url": binding["url"]},
            "remoteRevision": remote_revision,
            "publishedRevision": published,
            "lastCheckedAt": row["last_checked_at"] if row else None,
            "syncError": sync_error,
            "hasDraft": bool(draft),
            "needsMerge": needs_merge,
            "intervalSeconds": operations.sync_interval_of(binding, config),
            "syncCredential": bool(auth_service.sync_credential()),
        }})

    @app.get("/__svn/remote-diff")
    def svn_remote_diff():
        """远端最新内容与本地文件的统一差异（合并前对比）。"""
        session, rejected = require_session()
        if rejected:
            return rejected
        path = request.args.get("path") or ""
        binding = server_config.match_repository(config, path)
        if binding is None:
            return json_error(400, "no_binding", "该文档未配置 SVN 仓库")
        credential = credential_of(session)
        if credential is None and not auth_service.sync_credential():
            return json_error(401, "needs_auth", "需要 SVN 凭据：请登录 SVN 账号，或配置同步凭据环境变量")
        try:
            result = operations.remote_diff(conn, auth_service.svn, config, md_dir(), binding, path,
                                            credential or auth_service.sync_credential())
        except operations.OperationError as error:
            return json_error(error.status, "remote_diff_error", error.message)
        return jsonify({"ok": True, **result})

    @app.get("/__svn/log")
    def svn_log():
        session, rejected = require_session()
        if rejected:
            return rejected
        path = request.args.get("path") or ""
        binding = server_config.match_repository(config, path)
        if binding is None:
            return json_error(400, "no_binding", "该文档未关联 SVN")
        try:
            limit = min(50, max(1, int(request.args.get("limit") or 20)))
        except (TypeError, ValueError):
            limit = 20
        username, password = credential_of(session) or (None, None)
        import shutil as _shutil
        import tempfile as _tempfile
        config_dir = _tempfile.mkdtemp(prefix="md2web-svn-log-")
        try:
            entries = auth_service.svn.log(binding["url"], limit=limit, config_dir=config_dir,
                                           username=username, password=password)
        except Exception as error:  # SvnError 内部已脱敏
            return json_error(502, "svn_log_failed", str(error))
        finally:
            _shutil.rmtree(config_dir, ignore_errors=True)
        return jsonify({"ok": True, "entries": entries})

    @app.post("/__svn/refresh")
    @serialized
    def svn_refresh():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        targets = [repo for repo in config.get("repositories") or [] if repo.get("source_mode", "svn") == "svn"]
        if payload.get("binding"):
            targets = [repo for repo in targets if repo["id"] == payload.get("binding")]
        results = []
        for binding in targets:
            try:
                result = operations.sync_binding(conn, auth_service.svn, config, md_dir(), binding,
                                                 auth_service.repo_sync_credential(binding, credential_of(session)),
                                                 db_lock=auth_service._db_lock)
                results.append({"binding": binding["id"], "ok": True, **result})
            except operations.OperationError as error:
                results.append({"binding": binding["id"], "ok": False, "error": error.message})
        return jsonify({"ok": True, "results": results, "rebuilt": rebuild_repository_pages()})

    reference_web_lock = threading.Lock()

    @app.get("/__reference-web/list")
    def reference_web_list():
        from setup_docsify import scan_reference_web
        try:
            return jsonify({"ok": True, "items": scan_reference_web(docs_root)})
        except OSError as error:
            return json_error(500, "reference_web_error", "读取参考网页失败：" + str(error))

    @app.post("/__reference-web/refresh")
    def reference_web_refresh():
        session, rejected = require_session()
        if rejected:
            return rejected
        rejected = require_csrf(session)
        if rejected:
            return rejected
        from setup_docsify import scan_reference_web, generate_reference_web, BuildError
        try:
            with reference_web_lock:
                items = scan_reference_web(docs_root)
                generate_reference_web(items, docs_root)
            return jsonify({"ok": True, "items": items, "saved": True})
        except (OSError, BuildError) as error:
            return json_error(500, "reference_web_error", "更新参考网页索引失败：" + str(error))

    @app.get('/__md/internal-files')
    def internal_file_search():
        session, rejected = require_session()
        if rejected:
            return rejected
        from . import internal_files
        query = str(request.args.get('q') or '')[:200]
        try:
            offset = max(0, int(request.args.get('offset') or 0))
        except ValueError:
            offset = 0
        try:
            rows = (internal_files.markdown_links(docs_root, query, request.args.get('path') or '') if request.args.get('kind') == 'markdown'
                    else internal_files.search(docs_root, query))
        except (OSError, ValueError):
            return json_error(503, 'index_unavailable', '文档索引暂不可用，请完成网站构建后重试')
        return jsonify(ok=True, items=rows[offset:offset + 50], total=len(rows))

    @app.get("/__references/list")
    def reference_list():
        try:
            kind = request.args.get("kind") or "pdf"
            return jsonify({"ok": True, "listing": references.listing(docs_root, kind, request.args.get("path") or "")})
        except references.ReferenceError as error:
            return json_error(error.status, "reference_error", error.message)

    @app.get("/__references/tree")
    def reference_tree():
        try:
            kind = request.args.get("kind") or "pdf"
            return jsonify({"ok": True, "kind": kind, "folders": references.tree(docs_root, kind)})
        except references.ReferenceError as error:
            return json_error(error.status, "reference_error", error.message)

    @app.get("/__references/search")
    def reference_search():
        try:
            kind = request.args.get("kind") or "all"
            query = request.args.get("q") or ""
            return jsonify({"ok": True, "results": references.search(docs_root, query, kind)})
        except references.ReferenceError as error:
            return json_error(error.status, "reference_error", error.message)

    @app.get("/__references/trash")
    def reference_trash():
        session, rejected = require_session()
        if rejected: return rejected
        try:
            kind = request.args.get("kind") or "pdf"
            return jsonify({"ok": True, "kind": kind, "entries": references.trash_listing(docs_root, kind)})
        except references.ReferenceError as error:
            return json_error(error.status, "reference_error", error.message)

    @app.post("/__references/upload")
    def reference_upload():
        session, rejected = require_session()
        if rejected: return rejected
        csrf_error = require_csrf(session)
        if csrf_error: return csrf_error
        kind = request.form.get("kind") or "pdf"
        try:
            _, folder, _ = references.safe_path(docs_root, kind, request.form.get("path") or "")
            uploads = request.files.getlist("file")
            if not uploads or not any(item.filename for item in uploads):
                raise references.ReferenceError(400, "未选择文件")
            folder.mkdir(parents=True, exist_ok=True)
            results = []
            for uploaded in uploads:
                if not uploaded.filename:
                    continue
                name = references.check_name(uploaded.filename)
                uploaded.stream.seek(0, 2)
                size = uploaded.stream.tell()
                uploaded.stream.seek(0)
                if size > policy.upload_bytes(config):
                    results.append({'name': name, 'ok': False, 'error': '文件过大（上限 %d MB）' %
                                    (policy.upload_bytes(config) // (1024 * 1024))})
                    continue
                if Path(name).suffix.lower() not in references.KINDS[kind]:
                    results.append({"name": name, "ok": False, "error": "文件扩展名与资料类型不匹配"})
                    continue
                target = folder / name
                if target.exists():
                    results.append({"name": name, "ok": False, "error": "目标已存在"})
                    continue
                uploaded.save(str(target))
                results.append({"name": name, "ok": True,
                                "path": target.relative_to(references.root_for(docs_root, kind)).as_posix()})
            return jsonify({"ok": True, "results": results})
        except references.ReferenceError as error:
            return json_error(error.status, "reference_error", error.message)

    def reference_mutation(action):
        session, rejected = require_session()
        if rejected: return rejected
        csrf_error = require_csrf(session)
        if csrf_error: return csrf_error
        payload = request.get_json(silent=True) or {}; kind = payload.get("kind") or "pdf"
        try:
            if action == "mkdir": result = {"path": references.mkdir(docs_root, kind, payload.get("parent", ""), payload.get("name"))}
            elif action == "rename": result = {"path": references.rename(docs_root, kind, payload.get("path"), payload.get("name"))}
            elif action == "move": result = {"path": references.move(docs_root, kind, payload.get("path"), payload.get("parent", ""))}
            elif action == "delete": result = references.delete(docs_root, kind, payload.get("path"))
            elif action == "restore": result = {"path": references.restore(docs_root, kind, payload.get("entryId"))}
            else: result = {"count": references.purge(docs_root, kind, payload.get("entryId"))}
            return jsonify({"ok": True, "result": result})
        except references.ReferenceError as error: return json_error(error.status, "reference_error", error.message)

    for _action in ("mkdir", "rename", "move", "delete", "restore", "purge"):
        app.add_url_rule("/__references/" + _action, "reference_" + _action,
                         lambda action=_action: reference_mutation(action), methods=["POST"])

    # ---- 静态站点（白名单，无目录列表） ----

    def send_site_file(filename):
        from .cache import is_site_entry, refresh_html_assets
        if not is_site_entry(filename):
            return send_from_directory(docs_root, filename)
        # A deployed server may have repository pages that do not exist in Git.
        # Refresh their asset URLs without rebuilding or replacing their catalog.
        response = send_from_directory(docs_root, filename, conditional=False)
        response.direct_passthrough = False
        response.set_data(refresh_html_assets(response.get_data(as_text=True), docs_root))
        response.headers.pop('ETag', None)
        response.headers.pop('Last-Modified', None)
        return response

    @app.get("/")
    def index():
        return send_site_file("index.html")

    @app.get("/<path:filename>")
    def static_file(filename):
        if is_blocked_static_path(filename):
            return json_error(404, "not_found", "资源不存在")
        target = (docs_root / filename)
        if target.is_dir():
            return json_error(404, "not_found", "资源不存在")
        return send_site_file(filename)

    return app
