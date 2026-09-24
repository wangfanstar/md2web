"""Flask 应用：静态白名单 + 认证 API + 写接口守卫（阶段一）。

阶段一仅实现登录/退出与会话边界：
- 所有写接口要求登录 + CSRF，且不因缺少配置退回匿名写入。
- 草稿（阶段二）与 SVN 操作（阶段三）返回明确的未实现错误，不静默强制覆盖。
"""

import hmac
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, make_response, request, send_from_directory

from . import config as server_config
from . import database, documents as server_documents, drafts, operations, entries
from .auth import AuthError
from .config import authenticated_config, config_to_json, public_config, save_config
from .documents import MdSaveError
from .paths import is_blocked_static_path


def server_documents_error():
    return MdSaveError

COOKIE_NAME = "md2web_session"
FEATURES = {"editDraft": True, "svnCommit": False, "localPublish": False}
MAX_BODY = 2 * 1024 * 1024


def create_app(config, conn, auth_service, docs_dir, on_config_changed=None):
    docs_root = Path(docs_dir).resolve()
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
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

    def set_session_cookie(response, token):
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=int(float(config["auth"]["session_hours"]) * 3600),
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
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cache-Control"] = response.headers.get("Cache-Control", "no-store")
        return response

    # ---- 错误处理（不泄漏堆栈/秘密） ----

    @app.errorhandler(AuthError)
    def handle_auth_error(error):
        return json_error(error.status, error.code, str(error))

    @app.errorhandler(404)
    def handle_not_found(error):
        return json_error(404, "not_found", "资源不存在")

    @app.errorhandler(405)
    def handle_method(error):
        return json_error(405, "method_not_allowed", "方法不被允许")

    @app.errorhandler(413)
    def handle_too_large(error):
        return json_error(413, "too_large", "请求体过大")

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
            "svnCredential": bool(session) and auth_service.has_credential(session["sessionId"]),
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
            )
        else:
            result = auth_service.login(
                payload.get("username"),
                payload.get("password"),
                request.remote_addr or "",
                request.headers.get("User-Agent", ""),
            )
        response = jsonify({"ok": True, "user": result["user"], "csrfToken": result["csrfToken"]})
        return set_session_cookie(response, result["token"])

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
        return data

    @app.get("/__config")
    def read_config():
        session, rejected = require_admin()
        if rejected:
            return rejected
        return jsonify({"ok": True, "config": public_config_json()})

    @app.put("/__config")
    def write_config():
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True)
        try:
            loaded = save_config(config["path"], payload, docs_root)
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
        return jsonify({"ok": True, "config": public_config_json(), "authConfigured": bool(config["auth"]["url"])})

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
            for item in child.rglob("*"):
                if not item.is_file() or ".svn" in item.parts:
                    continue
                try:
                    stat = item.stat()
                except OSError:
                    continue
                file_size = int(stat.st_size)
                files += 1
                size += file_size
                newest = max(newest, int(stat.st_mtime))
                if len(item.relative_to(child).parts) > 1:
                    nested_files += 1
                    nested_bytes += file_size
                if item.suffix.lower() == ".md":
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

    @app.get("/__folders")
    def list_folders():
        """列出 docs/md 下所有文件夹及其仓库配置（公开只读，供仓库配置页默认展示）。"""
        folders = operations.list_md_folders(md_dir(), config.get("repositories") or [])
        metrics = folder_metrics()
        latest = database.folder_latest_updates(conn)
        for folder in folders:
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
            listing = operations.folder_listing(md_dir(), path, recursive=request.args.get('recursive') == '1')
        except operations.OperationError as error:
            return json_error(error.status, "folder_error", error.message)
        return jsonify({"ok": True, "folder": listing})

    @app.post("/__md/create")
    def create_entry():
        return mutate_entry("create")

    @app.post("/__md/rename")
    def rename_entry():
        return mutate_entry("rename")

    @app.post("/__md/delete")
    def delete_entry():
        return mutate_entry("delete")

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
        if on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
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
        svn = [item for item in bindings if item.get("source_mode") != "local"]
        reports = []
        if svn or not repo_id:
            reports = auth_service.repo_health_reports(md_dir(), svn, credential,
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
        credential = (auth_service.repo_credential(binding["id"])
                      or credential_of(session) or auth_service.sync_credential())
        try:
            result = operations.provision_repository(conn, auth_service.svn, config, md_dir(), binding,
                                                     credential)
        except operations.OperationError as error:
            return json_error(error.status, "provision_error", error.message, **error.extra)
        if on_config_changed is not None:
            try:
                on_config_changed()
            except Exception:
                pass
        return jsonify({"ok": True, "result": result})

    @app.post("/__admin/sync")
    def admin_sync():
        """管理员立即按频率同步所有配置了 SVN 的仓库（返回每个仓库的结果）。"""
        session, rejected = require_admin()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        results = auth_service.sync_repositories(md_dir())
        return jsonify({"ok": True, "results": results})

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
        try:
            result = server_documents.save_document_image(
                md_dir(), payload.get("path"), payload.get("type"), payload.get("data"),
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
        try:
            result = server_documents.save_document_attachment(
                md_dir(), payload.get("path"), payload.get("name"), payload.get("data"),
            )
        except MdSaveError as error:
            return json_error(error.status, "attachment_error", error.message)
        return jsonify({"ok": True, **result})

    @app.get("/__md/revision")
    def read_revision():
        session, rejected = require_session()
        if rejected:
            return rejected
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
            history = drafts.list_history(conn, session["user"]["id"], md_dir(), request.args.get("path") or "")
        except server_documents_error() as error:
            return json_error(error.status, "invalid_path", error.message)
        return jsonify({"ok": True, "history": history})

    @app.get("/__md/diff")
    def read_diff():
        session, rejected = require_session()
        if rejected:
            return rejected
        try:
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
    def discard_draft():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        try:
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
    def pending_publish():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        return json_error(501, "not_implemented", "未关联 SVN 的本地发布将在后续版本提供")

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
                payload.get("path"), payload.get("message"), payload.get("expectedVersion"),
            )
        except operations.OperationError as error:
            credential_invalidated(session, error)
            return json_error(error.status, "prepare_error", error.message, **error.extra)
        except MdSaveError as error:
            return json_error(error.status, "invalid_path", error.message)
        return jsonify({"ok": True, **result})

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
                payload.get("operationId"), session["user"]["id"], credential,
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
    def svn_refresh():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        payload = request.get_json(silent=True) or {}
        targets = list(config.get("repositories") or [])
        if payload.get("binding"):
            targets = [repo for repo in targets if repo["id"] == payload.get("binding")]
        results = []
        for binding in targets:
            try:
                result = operations.sync_binding(conn, auth_service.svn, config, md_dir(), binding,
                                                 credential_of(session))
                results.append({"binding": binding["id"], "ok": True, **result})
            except operations.OperationError as error:
                results.append({"binding": binding["id"], "ok": False, "error": error.message})
        return jsonify({"ok": True, "results": results})

    # ---- 静态站点（白名单，无目录列表） ----

    @app.get("/")
    def index():
        return send_from_directory(docs_root, "index.html")

    @app.get("/<path:filename>")
    def static_file(filename):
        if is_blocked_static_path(filename):
            return json_error(404, "not_found", "资源不存在")
        target = (docs_root / filename)
        if target.is_dir():
            return json_error(404, "not_found", "资源不存在")
        return send_from_directory(docs_root, filename)

    return app
