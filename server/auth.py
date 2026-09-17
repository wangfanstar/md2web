"""认证与会话：SVN 口令验证、会话 Cookie、CSRF、限速与审计。

要点：
- 会话 token 只存摘要；SVN 密码仅存在于内存中的验证调用，不写库。
- 服务重启与认证源变化都会让旧会话失效。
- 登录失败按 IP+用户名限速，审计记录脱敏。
"""

import hashlib
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from . import database, documents, operations, passwords
from .secrets import decrypt, encrypt
from .svn import SvnError

RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW = 300.0
TOUCH_INTERVAL = 60.0

ERROR_STATUS = {
    "invalid_request": 400,
    "auth_failed": 401,
    "forbidden": 403,
    "disabled": 403,
    "not_configured": 503,
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
    "forbidden": "没有权限执行该操作",
    "not_configured": "尚未配置 SVN 认证路径：请用管理员账号在「设置」中填写后再登录",
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
        # 会话凭据只存在进程内存：{session_id: {"username": ..., "password": ...}}
        self._credentials = {}

    def _moment(self):
        return datetime.fromtimestamp(self.clock(), tz=timezone.utc)

    def _stamp(self):
        return _iso(self._moment())

    # ---- 生命周期 ----

    def on_startup(self):
        """重启后不恢复需要密码的会话；同时记录审计。"""
        with self._lock:
            self._credentials = {}
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

    def _insert_session(self, user_id, moment, user_agent):
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
        return token, csrf_token, expires_at

    def configured(self):
        return bool(self.config["auth"]["url"])

    def on_config_changed(self):
        """配置热更新：认证源变化时让旧会话失效，并清空限速记录。"""
        previous = self.auth_source_id
        self.auth_source_id = _digest(
            self.config["auth"]["url"] + "|" + self.config["auth"]["credential_group"]
        )[:16]
        with self._lock:
            self._attempts = {}
        if previous != self.auth_source_id:
            self.revoke_svn_sessions("auth_source_changed")
        return previous != self.auth_source_id

    def test_auth_url(self, url):
        """管理员测试认证路径：必须可达且拒绝匿名。"""
        target = str(url or self.config["auth"]["url"] or "").strip()
        if not target:
            raise AuthError("invalid_request", "请先填写 SVN 认证路径 URL")
        import tempfile
        config_dir = tempfile.mkdtemp(prefix="md2web-svn-test-")
        try:
            readable = self.svn.anonymous_readable(target, config_dir)
        except SvnError as error:
            if error.code == "auth_failed":
                return {"requiresAuth": True, "reachable": True,
                        "message": "认证路径可达且要求登录，可以使用"}
            raise AuthError(error.code, str(error))
        finally:
            import shutil
            shutil.rmtree(config_dir, ignore_errors=True)
        if readable:
            raise AuthError(
                "anonymous_allowed",
                "该路径允许匿名访问，不能用于验证账号密码；请管理员改用强制认证路径",
            )
        return {"requiresAuth": True, "reachable": True, "message": "认证路径可用"}

    def login_admin(self, username, password, client_ip, user_agent=""):
        username = str(username or "").strip()
        if not username or password is None or password == "":
            raise AuthError("invalid_request")
        key = self._rate_key(client_ip, username)
        self._check_rate(key)
        with self._db_lock:
            row = database.find_user(self.conn, database.LOCAL_ADMIN_SOURCE, username)
        if row is None or row["role"] != "admin" or row["disabled"]:
            self._record_attempt(key)
            with self._db_lock, self.conn:
                database.audit(self.conn, "admin_login", "failed:unknown", resource=username, client_ip=client_ip)
            raise AuthError("auth_failed")
        if not passwords.verify_password(password, row["password_hash"]):
            self._record_attempt(key)
            with self._db_lock, self.conn:
                database.audit(self.conn, "admin_login", "failed:password", actor_id=row["id"], resource=username, client_ip=client_ip)
            raise AuthError("auth_failed")
        moment = self._moment()
        with self._db_lock, self.conn:
            self.conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (_iso(moment), row["id"]))
            token, csrf_token, expires_at = self._insert_session(row["id"], moment, user_agent)
            database.audit(self.conn, "admin_login", "ok", actor_id=row["id"], resource=username, client_ip=client_ip)
        return {
            "token": token,
            "csrfToken": csrf_token,
            "user": {"id": row["id"], "username": row["svn_username"],
                     "displayName": row["display_name"] or row["svn_username"], "role": "admin"},
            "expiresAt": _iso(expires_at),
        }

    def change_admin_password(self, user_id, current, new_password):
        if new_password is None or len(str(new_password)) < 5:
            raise AuthError("invalid_request", "新密码至少 5 位")
        with self._db_lock:
            row = self.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None or row["role"] != "admin":
            raise AuthError("forbidden")
        if not passwords.verify_password(current, row["password_hash"]):
            raise AuthError("auth_failed", "当前密码不正确")
        with self._db_lock, self.conn:
            database.set_admin_password(self.conn, user_id, new_password)
        return True

    def login(self, username, password, client_ip, user_agent=""):
        username = str(username or "").strip()
        if not username or password is None or password == "":
            raise AuthError("invalid_request")
        # 本机管理员账号（默认 admin）：不经过 SVN 校验，直接以管理员身份登录
        with self._db_lock:
            admin_row = database.find_user(self.conn, database.LOCAL_ADMIN_SOURCE, username)
        if admin_row is not None:
            return self.login_admin(username, password, client_ip, user_agent)
        if not self.configured():
            raise AuthError("not_configured")
        key = self._rate_key(client_ip, username)
        self._check_rate(key)
        try:
            self.svn.verify_credentials(self.config["auth"]["url"], username, password)
        except SvnError as error:
            self._record_attempt(key)
            with self._db_lock, self.conn:
                database.audit(self.conn, "login", f"failed:{error.code}", resource=username, client_ip=client_ip)
            raise AuthError(error.code, str(error))
        moment = self._moment()
        with self._db_lock, self.conn:
            row = self.conn.execute(
                "SELECT * FROM users WHERE auth_source_id = ? AND svn_username = ?",
                (self.auth_source_id, username),
            ).fetchone()
            if row is not None and row["disabled"]:
                database.audit(self.conn, "login", "failed:disabled", actor_id=row["id"], resource=username, client_ip=client_ip)
                raise AuthError("disabled")
            if row is None:
                cursor = self.conn.execute(
                    "INSERT INTO users (auth_source_id, svn_username, display_name, role, created_at, last_login_at)"
                    " VALUES (?, ?, ?, 'user', ?, ?)",
                    (self.auth_source_id, username, username, _iso(moment), _iso(moment)),
                )
                user_id = cursor.lastrowid
            else:
                user_id = row["id"]
                self.conn.execute(
                    "UPDATE users SET last_login_at = ? WHERE id = ?",
                    (_iso(moment), user_id),
                )
            token, csrf_token, expires_at = self._insert_session(user_id, moment, user_agent)
            self._store_credential_locked(username, password)
            database.audit(self.conn, "login", "ok", actor_id=user_id, resource=username, client_ip=client_ip)
            session_row = self.conn.execute(
                "SELECT id FROM sessions WHERE token_hash = ?", (_digest(token),)
            ).fetchone()
            if session_row is not None:
                with self._lock:
                    self._credentials[session_row["id"]] = {"username": username, "password": password}
        return {
            "token": token,
            "csrfToken": csrf_token,
            "user": {"id": user_id, "username": username, "displayName": username, "role": "user"},
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
        if user["auth_source_id"] != database.LOCAL_ADMIN_SOURCE and user["auth_source_id"] != self.auth_source_id:
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
                "role": user["role"] or "user",
            },
        }

    # ---- SVN 口令存储（本机密钥可逆加密，登录成功后更新，提交时复用） ----

    def sync_credential(self):
        """定时同步用的只读凭据：环境变量 sync.credential_name 的 "用户名:口令"（可选）。"""
        name = str((self.config.get("sync") or {}).get("credential_name") or "").strip()
        if not name:
            return None
        value = os.environ.get(name) or ""
        if ":" not in value:
            return None
        user, _, password = value.partition(":")
        if not user.strip() or not password:
            return None
        return (user.strip(), password)

    def sync_repositories(self, md_dir, logger=None):
        """按各仓库频率拉取远端更新（跳过有活动草稿的文档并报告冲突）。"""
        credential = self.sync_credential()
        with self._db_lock:
            return operations.sync_all(self.conn, self.svn, self.config, md_dir,
                                       credential=credential, logger=logger)

    def record_document_snapshot(self, md_dir):
        """扫描 docs/md 并记录增删改（首次为基线，不产生事件）。"""
        entries = documents.scan_md_tree(md_dir)
        with self._db_lock, self.conn:
            baseline = self.conn.execute("SELECT COUNT(*) FROM document_snapshots").fetchone()[0] == 0
            return database.record_document_changes(self.conn, entries, baseline=baseline)

    def secret_key(self):
        return (self.config.get("security") or {}).get("secretKey") or ""

    def _store_credential_locked(self, username, password):
        """调用方需持有 _db_lock：保存/更新该账号的 SVN 口令密文。"""
        username = str(username or "").strip()
        if not username or password is None or password == "":
            return False
        key = self.secret_key()
        if not key:
            return False
        try:
            secret = encrypt(key, password)
        except ValueError:
            return False
        database.save_svn_credential(self.conn, self.auth_source_id, username, secret)
        return True

    def store_credential(self, username, password):
        with self._db_lock:
            return self._store_credential_locked(username, password)

    def _user_field(self, user, key, default=None):
        """会话里的用户可能是 dict 或 sqlite3.Row，缺字段时返回默认值。"""
        try:
            value = user[key]
        except (KeyError, IndexError, TypeError):
            return default
        return default if value is None else value

    def stored_credential(self, user):
        """按用户记录读取已保存的口令；返回 (username, password) 或 None。"""
        if not user:
            return None
        username = str(self._user_field(user, "svn_username", "")
                       or self._user_field(user, "username", "")).strip()
        source = self._user_field(user, "auth_source_id", None)
        if source is None and str(self._user_field(user, "role", "user")) == "admin":
            return None  # 本机管理员必须显式提供 SVN 账号
        source = str(source or self.auth_source_id).strip()
        if not username or source == database.LOCAL_ADMIN_SOURCE:
            return None
        with self._db_lock:
            row = database.find_svn_credential(self.conn, source, username)
        if row is None:
            return None
        try:
            return username, decrypt(self.secret_key(), row["secret"])
        except (ValueError, TypeError):
            return None

    def forget_stored_credential(self, user):
        """口令失效时清理数据库中的旧密文（下次提交会重新要求登录）。"""
        if not user:
            return False
        username = str(self._user_field(user, "svn_username", "")
                       or self._user_field(user, "username", "")).strip()
        source = self._user_field(user, "auth_source_id", None)
        if source is None and str(self._user_field(user, "role", "user")) == "admin":
            return False
        source = str(source or self.auth_source_id).strip()
        if not username or source == database.LOCAL_ADMIN_SOURCE:
            return False
        with self._db_lock:
            return database.delete_svn_credential(self.conn, source, username)

    def credential_for(self, session_id):
        """当前会话的 SVN 凭据（仅内存）；会话失效后立即丢弃。"""
        with self._lock:
            credential = self._credentials.get(int(session_id))
        if credential is None:
            return None
        return credential["username"], credential["password"]

    def remember_credential(self, session_id, username, password):
        """补充/更新的 SVN 凭据：写入会话内存，并加密保存到数据库供后续提交复用。"""
        with self._lock:
            self._credentials[int(session_id)] = {"username": str(username), "password": str(password)}
        self.store_credential(username, password)
    def check_svn_credential(self, username, password):
        """校验补充的 SVN 账号口令（用于管理员提交场景）。"""
        if not self.configured():
            raise AuthError("not_configured")
        if not username or not password:
            raise AuthError("invalid_request", "请输入 SVN 账号与密码")
        key = self._rate_key("credential-check", username)
        self._check_rate(key)
        try:
            self.svn.verify_credentials(self.config["auth"]["url"], username, password)
        except SvnError as error:
            self._record_attempt(key)
            raise AuthError(error.code, str(error))
        return True

    def has_credential(self, session_id):
        with self._lock:
            return int(session_id) in self._credentials

    def forget_credential(self, session_id):
        with self._lock:
            self._credentials.pop(int(session_id), None)

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
        row = self.conn.execute(
            "SELECT id FROM sessions WHERE token_hash = ?", (token_hash,)
        ).fetchone()
        if row is not None:
            self.forget_credential(row["id"])
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
        self.forget_credential(row["id"])
        self._revoke(row["token_hash"], "logout")
        with self._db_lock, self.conn:
            database.audit(self.conn, "logout", "ok", actor_id=row["user_id"])
        return True

    def revoke_svn_sessions(self, reason="auth_source_changed"):
        """认证源变化：让所有 SVN 用户会话失效；保留本地管理员会话以便继续配置。"""
        with self._db_lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN"
                " (SELECT id FROM users WHERE role != 'admin')",
                (self._stamp(),),
            )
            database.audit(self.conn, "session_reset", f"ok:{reason}")

    def revoke_all(self, reason="admin"):
        with self._lock:
            self._credentials = {}
        with self._db_lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL",
                (self._stamp(),),
            )
            database.audit(self.conn, "session_reset", f"ok:{reason}")
