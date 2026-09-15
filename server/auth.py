"""认证与会话：SVN 口令验证、会话 Cookie、CSRF、限速与审计。

要点：
- 会话 token 只存摘要；SVN 密码仅存在于内存中的验证调用，不写库。
- 服务重启与认证源变化都会让旧会话失效。
- 登录失败按 IP+用户名限速，审计记录脱敏。
"""

import hashlib
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from . import database
from .svn import SvnError

RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW = 300.0
TOUCH_INTERVAL = 60.0

ERROR_STATUS = {
    "invalid_request": 400,
    "auth_failed": 401,
    "disabled": 403,
    "rate_limited": 429,
    "anonymous_allowed": 503,
    "unreachable": 503,
    "timeout": 503,
    "cert_error": 502,
    "unsupported": 500,
    "not_found": 500,
    "parse_error": 502,
    "failed": 502,
}

ERROR_MESSAGES = {
    "invalid_request": "请输入用户名与密码",
    "disabled": "账号已被管理员停用",
    "rate_limited": "登录尝试过于频繁，请稍后再试",
}


class AuthError(Exception):
    def __init__(self, code, message=None, status=None):
        self.code = code
        self.status = status or ERROR_STATUS.get(code, 400)
        super().__init__(message or ERROR_MESSAGES.get(code, "认证失败"))


def _digest(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _now():
    return datetime.now(timezone.utc)


def _iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(value):
    return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


class AuthService:
    def __init__(self, conn, svn_client, config, clock=None):
        self.conn = conn
        self.svn = svn_client
        self.config = config
        self.clock = clock or time.time
        self.auth_source_id = _digest(
            config["auth"]["url"] + "|" + config["auth"]["credential_group"]
        )[:16]
        self.process_epoch = secrets.token_hex(8)
        self._attempts = {}
        self._lock = threading.Lock()
        self._db_lock = threading.RLock()

    def _moment(self):
        return datetime.fromtimestamp(self.clock(), tz=timezone.utc)

    def _stamp(self):
        return _iso(self._moment())

    # ---- 生命周期 ----

    def on_startup(self):
        """重启后不恢复需要密码的会话；同时记录审计。"""
        with self._db_lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL",
                (self._stamp(),),
            )
            database.audit(self.conn, "session_reset", "ok", resource="startup")

    def auth_source_changed(self):
        """配置的认证源与库中账号不同 → 旧会话全部失效。"""
        with self._db_lock:
            row = self.conn.execute(
                "SELECT COUNT(*) AS total FROM users WHERE auth_source_id != ?",
                (self.auth_source_id,),
            ).fetchone()
        return bool(row and row["total"])

    # ---- 限速 ----

    def _rate_key(self, client_ip, username):
        return f"{client_ip}|{str(username).lower()}"

    def _check_rate(self, key):
        now = self.clock()
        with self._lock:
            stamps = [stamp for stamp in self._attempts.get(key, []) if now - stamp < RATE_LIMIT_WINDOW]
            self._attempts[key] = stamps
            if len(stamps) >= RATE_LIMIT_MAX:
                raise AuthError("rate_limited")

    def _record_attempt(self, key):
        with self._lock:
            self._attempts.setdefault(key, []).append(self.clock())

    # ---- 登录/退出 ----

    def login(self, username, password, client_ip, user_agent=""):
        username = str(username or "").strip()
        if not username or password is None or password == "":
            raise AuthError("invalid_request")
        key = self._rate_key(client_ip, username)
        self._check_rate(key)
        try:
            self.svn.verify_credentials(self.config["auth"]["url"], username, password)
        except SvnError as error:
            self._record_attempt(key)
            with self._db_lock, self.conn:
                database.audit(self.conn, "login", f"failed:{error.code}", resource=username)
            raise AuthError(error.code, str(error))
        moment = self._moment()
        with self._db_lock, self.conn:
            row = self.conn.execute(
                "SELECT * FROM users WHERE auth_source_id = ? AND svn_username = ?",
                (self.auth_source_id, username),
            ).fetchone()
            if row is not None and row["disabled"]:
                database.audit(self.conn, "login", "failed:disabled", actor_id=row["id"], resource=username)
                raise AuthError("disabled")
            if row is None:
                cursor = self.conn.execute(
                    "INSERT INTO users (auth_source_id, svn_username, display_name, created_at, last_login_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (self.auth_source_id, username, username, _iso(moment), _iso(moment)),
                )
                user_id = cursor.lastrowid
            else:
                user_id = row["id"]
                self.conn.execute(
                    "UPDATE users SET last_login_at = ? WHERE id = ?",
                    (_iso(moment), user_id),
                )
            token = secrets.token_urlsafe(32)
            csrf_token = secrets.token_urlsafe(24)
            expires_at = moment + timedelta(hours=float(self.config["auth"]["session_hours"]))
            self.conn.execute(
                "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at,"
                " expires_at, process_epoch, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    _digest(token),
                    user_id,
                    csrf_token,
                    _iso(moment),
                    _iso(moment),
                    _iso(expires_at),
                    self.process_epoch,
                    str(user_agent or "")[:200],
                ),
            )
            database.audit(self.conn, "login", "ok", actor_id=user_id, resource=username)
        return {
            "token": token,
            "csrfToken": csrf_token,
            "user": {"id": user_id, "username": username, "displayName": username},
            "expiresAt": _iso(expires_at),
        }

    def resolve(self, token, touch=True):
        """校验会话；返回 {user, csrfToken, sessionId} 或 None。"""
        if not token:
            return None
        with self._db_lock:
            row = self.conn.execute(
                "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL",
                (_digest(token),),
            ).fetchone()
        if row is None:
            return None
        now = self._moment()
        if row["process_epoch"] != self.process_epoch:
            return None
        if now >= _parse(row["expires_at"]):
            self._revoke(row["token_hash"], "expired")
            return None
        idle_seconds = float(self.config["auth"]["idle_minutes"]) * 60
        if (now - _parse(row["last_seen_at"])).total_seconds() > idle_seconds:
            self._revoke(row["token_hash"], "idle")
            return None
        with self._db_lock:
            user = self.conn.execute(
                "SELECT * FROM users WHERE id = ?", (row["user_id"],)
            ).fetchone()
        if user is None or user["disabled"]:
            self._revoke(row["token_hash"], "disabled")
            return None
        if user["auth_source_id"] != self.auth_source_id:
            self._revoke(row["token_hash"], "auth_source_changed")
            return None
        if touch:
            self._touch(row)
        return {
            "sessionId": row["id"],
            "csrfToken": row["csrf_token"],
            "user": {
                "id": user["id"],
                "username": user["svn_username"],
                "displayName": user["display_name"] or user["svn_username"],
            },
        }

    def _touch(self, row):
        last_seen = _parse(row["last_seen_at"])
        if (self._moment() - last_seen).total_seconds() < TOUCH_INTERVAL:
            return
        with self._db_lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
                (self._stamp(), row["id"]),
            )
            database.audit(self.conn, "session_touch", "ok", actor_id=row["user_id"])

    def _revoke(self, token_hash, reason):
        with self._db_lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
                (self._stamp(), token_hash),
            )
            database.audit(self.conn, "session_revoke", f"ok:{reason}")

    def logout(self, token):
        if not token:
            return False
        with self._db_lock:
            row = self.conn.execute(
                "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL",
                (_digest(token),),
            ).fetchone()
        if row is None:
            return False
        self._revoke(row["token_hash"], "logout")
        with self._db_lock, self.conn:
            database.audit(self.conn, "logout", "ok", actor_id=row["user_id"])
        return True

    def revoke_all(self, reason="admin"):
        with self._db_lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL",
                (self._stamp(),),
            )
            database.audit(self.conn, "session_reset", f"ok:{reason}")
