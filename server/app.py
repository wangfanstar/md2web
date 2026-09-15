"""Flask 应用：静态白名单 + 认证 API + 写接口守卫（阶段一）。

阶段一仅实现登录/退出与会话边界：
- 所有写接口要求登录 + CSRF，且不因缺少配置退回匿名写入。
- 草稿（阶段二）与 SVN 操作（阶段三）返回明确的未实现错误，不静默强制覆盖。
"""

import hmac
from pathlib import Path

from flask import Flask, jsonify, make_response, request, send_from_directory

from . import database
from .auth import AuthError
from .config import public_config
from .paths import is_blocked_static_path

COOKIE_NAME = "md2web_session"
FEATURES = {"editDraft": False, "svnCommit": False, "localPublish": False}
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

    def json_error(status, code, message):
        response = jsonify({"ok": False, "code": code, "error": message})
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
        return jsonify({
            "ok": True,
            "authenticated": session is not None,
            "user": session["user"] if session else None,
            "csrfToken": session["csrfToken"] if session else None,
            "features": FEATURES,
            "site": public_config(config),
            "serverManaged": True,
        })

    @app.post("/__auth/login")
    def login():
        rejected = require_same_origin()
        if rejected:
            return rejected
        payload = request.get_json(silent=True) or {}
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

    @app.route("/__md/draft", methods=["PUT", "POST"])
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
