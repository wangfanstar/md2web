"""Flask 应用：静态白名单 + 认证 API + 写接口守卫（阶段一）。

阶段一仅实现登录/退出与会话边界：
- 所有写接口要求登录 + CSRF，且不因缺少配置退回匿名写入。
- 草稿（阶段二）与 SVN 操作（阶段三）返回明确的未实现错误，不静默强制覆盖。
"""

import hmac
from pathlib import Path

from flask import Flask, jsonify, make_response, request, send_from_directory

from . import config as server_config
from . import database, drafts
from .auth import AuthError
from .config import authenticated_config, config_to_json, public_config, save_config
from .documents import MdSaveError
from .paths import is_blocked_static_path


def server_documents_error():
    return MdSaveError

COOKIE_NAME = "md2web_session"
FEATURES = {"editDraft": True, "svnCommit": False, "localPublish": False}
MAX_BODY = 2 * 1024 * 1024


def create_app(config, conn, auth_service, docs_dir):
    docs_root = Path(docs_dir).resolve()
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
    app.json.ensure_ascii = False
    app.json.sort_keys = False

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

    @app.get("/__config")
    def read_config():
        session, rejected = require_admin()
        if rejected:
            return rejected
        return jsonify({"ok": True, "config": config_to_json(config)})

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
        return jsonify({"ok": True, "config": config_to_json(config), "authConfigured": bool(config["auth"]["url"])})

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
    @app.route("/__svn/prepare", methods=["POST"])
    @app.route("/__svn/commit", methods=["POST"])
    @app.route("/__svn/refresh", methods=["POST"])
    def pending_write():
        session, rejected = require_session()
        if rejected:
            return rejected
        csrf_error = require_csrf(session)
        if csrf_error:
            return csrf_error
        return json_error(501, "not_implemented", "该功能将在后续阶段启用（草稿 / SVN 提交）")

    @app.get("/__svn/log")
    @app.get("/__svn/info")
    @app.get("/__svn/status")
    def pending_read():
        session, rejected = require_session()
        if rejected:
            return rejected
        return json_error(501, "not_implemented", "SVN 查询将在后续阶段启用")

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
