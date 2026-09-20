"""SQLite 访问层：连接设置、迁移、事务辅助与备份。"""

import json
import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .passwords import hash_password

SCHEMA_VERSION = 8

# 兼容目标：RHEL7 自带 SQLite 3.7.17（Python 3.6 的 sqlite3）。
# Windows 端也必须只写这些版本能解析的对象，保证 data/ 数据库可在两个平台间直接共用。
SQLITE_COMPAT_TARGET = "3.7.17"

MODERN_SQL_PATTERNS = (
    (re.compile(r"\bWITHOUT\s+ROWID\b", re.I), "WITHOUT ROWID 表需要 SQLite 3.8.2+"),
    (re.compile(r"\)\s*STRICT\b", re.I), "STRICT 表需要 SQLite 3.37+"),
    (re.compile(r"\bGENERATED\s+ALWAYS\b", re.I), "生成列需要 SQLite 3.31+"),
    (re.compile(r"\bRETURNING\b", re.I), "RETURNING 需要 SQLite 3.35+"),
    (re.compile(r"\bOVER\s*\(", re.I), "窗口函数需要 SQLite 3.25+"),
    (re.compile(r"\bNULLS\s+(FIRST|LAST)\b", re.I), "NULLS FIRST/LAST 需要 SQLite 3.30+"),
    (re.compile(r"\bFILTER\s*\(\s*WHERE\b", re.I), "聚合 FILTER 需要 SQLite 3.30+"),
    (re.compile(r"\b(DROP|RENAME)\s+COLUMN\b", re.I), "ALTER TABLE DROP/RENAME COLUMN 需要 SQLite 3.25+/3.35+"),
    (re.compile(r"\bON\s+CONFLICT\b[^;]*\bDO\s+(UPDATE|NOTHING)\b", re.I), "UPSERT 需要 SQLite 3.24+"),
    (re.compile(r"(?m)^\s*WITH\b", re.I), "WITH 作为语句开头需要 SQLite 3.8.3+"),
    (re.compile(r"\b(IIF|FORMAT|UNIXEPOCH|TIMEDIFF)\s*\(", re.I), "该函数需要 SQLite 3.32+"),
    (re.compile(r"->>?|\bJSON_(EXTRACT|SET|INSERT|ARRAY|OBJECT|VALID|TYPE|QUOTE)\b", re.I), "JSON 功能需要 SQLite 3.38+/JSON1 扩展"),
    (re.compile(r"\b(FULL|RIGHT)\s+(OUTER\s+)?JOIN\b", re.I), "RIGHT/FULL JOIN 需要 SQLite 3.39+"),
    (re.compile(r"\bMATERIALIZED\b", re.I), "CTE MATERIALIZED 需要 SQLite 3.35+"),
    (re.compile(r"\bCREATE\s+(UNIQUE\s+)?INDEX\b[^;]*\bWHERE\b", re.I), "部分索引需要 SQLite 3.8+"),
)


def sqlite_compat_issues(sql, object_type=None):
    """返回 SQL 中 SQLite 3.7.17 不支持的问题列表（空列表表示兼容）。"""
    issues = []
    source = str(sql or "")
    for pattern, reason in MODERN_SQL_PATTERNS:
        if pattern.search(source):
            issues.append(reason)
    if object_type == "index":
        upper = source.upper()
        start = upper.find("(")
        end = upper.rfind(")")
        if start != -1 and end > start and "(" in upper[start + 1:end]:
            issues.append("表达式索引需要 SQLite 3.9+")
    return issues

SCHEMA_SQL = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    auth_source_id TEXT NOT NULL,
    svn_username TEXT NOT NULL,
    display_name TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    UNIQUE (auth_source_id, svn_username)
);

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    process_epoch TEXT NOT NULL,
    user_agent TEXT
);

CREATE TABLE repo_bindings (
    id INTEGER PRIMARY KEY,
    repository_id TEXT NOT NULL,
    mount_path TEXT NOT NULL UNIQUE,
    repository_uuid TEXT,
    root_url TEXT,
    target_url TEXT,
    credential_group TEXT NOT NULL,
    config_version TEXT NOT NULL,
    published_revision INTEGER,
    last_checked_at TEXT,
    sync_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    document_path TEXT NOT NULL,
    binding_id INTEGER REFERENCES repo_bindings (id),
    version INTEGER NOT NULL DEFAULT 0,
    base_revision_id INTEGER REFERENCES revisions (id),
    head_revision_id INTEGER REFERENCES revisions (id),
    state TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, document_path)
);

CREATE TABLE revisions (
    id INTEGER PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users (id),
    parent_id INTEGER REFERENCES revisions (id),
    base_svn_revision INTEGER,
    before_hash TEXT,
    after_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    eol TEXT NOT NULL DEFAULT '\n',
    unified_diff TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES users (id),
    binding_id INTEGER REFERENCES repo_bindings (id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    reviewed_manifest TEXT,
    message TEXT,
    svn_revision INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER REFERENCES users (id),
    action TEXT NOT NULL,
    resource TEXT,
    operation_id TEXT,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_revisions_draft ON revisions (draft_id, id);
CREATE INDEX idx_audit_created ON audit_events (created_at);
CREATE INDEX idx_operations_actor ON operations (actor_id, created_at);
"""



# v2：本地管理员账号（role/password_hash），用于网页端配置 SVN 认证路径与 AI 助手
MIGRATION_V2_SQL = """
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN password_hash TEXT;
"""

# v3：SVN 账号口令（本机密钥可逆加密），登录成功后更新，提交 SVN 时复用最新口令
MIGRATION_V3_SQL = """
CREATE TABLE IF NOT EXISTS svn_credentials (
    id INTEGER PRIMARY KEY,
    auth_source_id TEXT NOT NULL,
    svn_username TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (auth_source_id, svn_username)
);
CREATE INDEX IF NOT EXISTS idx_svn_credentials_user ON svn_credentials (auth_source_id, svn_username);
"""

LOCAL_ADMIN_SOURCE = "local-admin"
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect(path, logger=None):
    """打开数据库：外键开启、busy_timeout、行工厂。

    旧版 SQLite（< 3.8，如 RHEL7 自带 3.7.17）无法解析部分索引等对象，
    打开会报 "malformed database schema"；此时先尝试移除这类索引，
    仍失败则备份原文件并重建（本地草稿/会话会丢失）。
    """
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return open_connection(db_path)
    except sqlite3.DatabaseError as error:
        _report(logger, "[警告] 数据库无法直接打开（SQLite %s）：%s" % (sqlite3.sqlite_version, error))
    if repair_unsupported_indexes(db_path, logger):
        try:
            return open_connection(db_path)
        except sqlite3.DatabaseError as error:
            _report(logger, "[警告] 移除不支持的索引后仍无法打开：%s" % (error))
    backup = backup_unusable_database(db_path)
    _report(
        logger,
        "[警告] 原数据库已备份为 %s 并自动重建；本地草稿与会话丢失，管理员密码恢复为默认 admin/admin。" % backup,
    )
    return open_connection(db_path)


def open_connection(db_path):
    """建立连接：外键、busy_timeout、行工厂；Waitress 多线程由调用方串行化访问。"""
    conn = sqlite3.connect(str(db_path), timeout=10.0, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = DELETE")
        conn.execute("PRAGMA synchronous = FULL")
    except sqlite3.Error:
        conn.close()
        raise
    return conn


def _report(logger, message):
    if logger is not None:
        logger(message)
    else:
        print(message)


def _needs_newer_sqlite(sql):
    """判断索引定义是否使用旧版 SQLite 不支持的特性（部分索引/表达式索引）。"""
    upper = sql.upper()
    if re.search(r"\bWHERE\b", upper):
        return True
    start = upper.find("(")
    end = upper.rfind(")")
    if start != -1 and end > start:
        columns = upper[start + 1:end]
        if "(" in columns:
            return True
    return False


def repair_unsupported_indexes(db_path, logger=None):
    """从 schema 中移除本机 SQLite 无法解析的索引；返回是否修改了数据库。"""
    db_path = Path(db_path)
    try:
        conn = sqlite3.connect(str(db_path), timeout=10.0)
    except sqlite3.Error as error:
        _report(logger, "[警告] 无法打开数据库以修复索引：%s" % error)
        return False
    try:
        conn.execute("PRAGMA writable_schema = ON")
        rows = conn.execute("SELECT type, name, sql FROM sqlite_master").fetchall()
        victims = [
            row[1]
            for row in rows
            if row[0] == "index" and row[2] and _needs_newer_sqlite(str(row[2]))
        ]
        if not victims:
            return False
        backup = copy_database_file(db_path, ".repair")
        for name in victims:
            conn.execute("DELETE FROM sqlite_master WHERE type = 'index' AND name = ?", (name,))
        conn.commit()
        conn.execute("PRAGMA writable_schema = RESET")
        _report(
            logger,
            "[提示] 已移除本机 SQLite(%s) 不支持的索引：%s（原文件备份：%s）"
            % (sqlite3.sqlite_version, ", ".join(victims), backup),
        )
        return True
    except sqlite3.Error as error:
        _report(logger, "[警告] 移除不支持的索引失败：%s" % error)
        return False
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def _timestamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def copy_database_file(db_path, label):
    """复制数据库文件用于留档（修复前备份）。"""
    target = Path("%s%s-%s.bak" % (db_path, label, _timestamp()))
    try:
        shutil.copy2(str(db_path), str(target))
    except OSError as error:
        _report(None, "[警告] 备份数据库失败：%s" % error)
    return target


def backup_unusable_database(db_path):
    """把无法使用的数据库文件（含 -wal/-shm/-journal）改名留档，避免半损坏文件被再次读取。"""
    db_path = Path(db_path)
    target = Path("%s.corrupt-%s.bak" % (db_path, _timestamp()))
    for suffix in ("", "-wal", "-shm", "-journal"):
        source = Path("%s%s" % (db_path, suffix))
        if not source.exists():
            continue
        destination = Path("%s%s" % (target, suffix))
        try:
            shutil.move(str(source), str(destination))
        except OSError:
            try:
                source.unlink()
            except OSError:
                pass
    return target


def schema_version(conn):
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def migrate(conn, logger=None):
    """按 user_version 迁移；重复执行安全；完成后清理 SQLite 3.7.17 不兼容对象。"""
    version = schema_version(conn)
    if version < SCHEMA_VERSION:
        with conn:
            if version < 1:
                conn.executescript(SCHEMA_SQL)
            if version < 2:
                conn.executescript(MIGRATION_V2_SQL)
            if version < 3:
                conn.executescript(MIGRATION_V3_SQL)
            if version < 4:
                conn.executescript(MIGRATION_V4_SQL)
            if version < 5:
                conn.executescript(MIGRATION_V5_SQL)
            if version < 6:
                conn.executescript(MIGRATION_V6_SQL)
            if version < 7:
                conn.executescript(MIGRATION_V7_SQL)
            if version < 8:
                conn.executescript(MIGRATION_V8_SQL)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    sanitize_schema(conn, logger)
    return SCHEMA_VERSION


def sanitize_schema(conn, logger=None):
    """移除 SQLite 3.7.17（RHEL7）无法解析的索引/触发器/视图，返回被移除的名称列表。

    Windows 端启动时也会执行，保证本地写出的 data/ 数据库可直接拷到 RHEL7 使用。
    """
    removed = []
    try:
        rows = conn.execute(
            "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view')"
        ).fetchall()
    except sqlite3.Error as error:
        _report(logger, "[警告] 无法检查数据库对象：%s" % error)
        return removed
    for row in rows:
        object_type, name, sql = row[0], row[1], row[2] or ""
        if not sql or not sqlite_compat_issues(sql, object_type):
            continue
        quoted = name.replace('"', '""')
        try:
            with conn:
                conn.execute('DROP %s IF EXISTS "%s"' % (object_type.upper(), quoted))
        except sqlite3.Error as error:
            _report(logger, "[警告] 无法移除不兼容的 %s %s：%s" % (object_type, name, error))
            continue
        removed.append(name)
    for name in removed:
        _report(logger, "[提示] 已移除 SQLite %s 不兼容的数据库对象：%s" % (SQLITE_COMPAT_TARGET, name))
    return removed


# v4：审计事件记录来源 IP（管理员界面查看登录与使用情况）
MIGRATION_V4_SQL = """
ALTER TABLE audit_events ADD COLUMN client_ip TEXT;
"""


# v5：文档快照与增删记录（管理员界面：文档更新时间/次数、文件夹大小、增删历史）
MIGRATION_V5_SQL = """
CREATE TABLE IF NOT EXISTS document_snapshots (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_events_created ON document_events (created_at);
"""


# v6：仓库定时同步用的凭据（按仓库 id 存密文），以及网站数据备份仓库的凭据
MIGRATION_V6_SQL = """
CREATE TABLE IF NOT EXISTS repo_credentials (
    id INTEGER PRIMARY KEY,
    repository_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


# v7：仓库来源模式、本地 SQLite 正文快照和来源变更事件
MIGRATION_V7_SQL = """
ALTER TABLE repo_bindings ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'svn';
ALTER TABLE repo_bindings ADD COLUMN source_revision INTEGER;
ALTER TABLE repo_bindings ADD COLUMN source_hash TEXT;
ALTER TABLE repo_bindings ADD COLUMN pending_mode TEXT;
ALTER TABLE repo_bindings ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE repo_bindings ADD COLUMN last_success_at TEXT;
ALTER TABLE repo_bindings ADD COLUMN last_error_code TEXT;
CREATE TABLE IF NOT EXISTS repository_documents (
    id INTEGER PRIMARY KEY,
    binding_id INTEGER NOT NULL REFERENCES repo_bindings (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    eol TEXT NOT NULL DEFAULT '\\n',
    source_revision INTEGER,
    state TEXT NOT NULL DEFAULT 'published',
    updated_at TEXT NOT NULL,
    UNIQUE (binding_id, path)
);
CREATE INDEX IF NOT EXISTS idx_repository_documents_binding ON repository_documents (binding_id, path);
CREATE TABLE IF NOT EXISTS source_events (
    id INTEGER PRIMARY KEY,
    binding_id INTEGER REFERENCES repo_bindings (id) ON DELETE SET NULL,
    operation_id TEXT,
    mode TEXT NOT NULL,
    event_type TEXT NOT NULL,
    path TEXT,
    before_hash TEXT,
    after_hash TEXT,
    base_revision INTEGER,
    target_revision INTEGER,
    actor_id INTEGER REFERENCES users (id),
    detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_events_binding ON source_events (binding_id, created_at);
"""


# v8：读者反馈（登录用户提交，管理员更新进度）
MIGRATION_V8_SQL = """
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY,
    author_id INTEGER REFERENCES users (id),
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    page TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at);
"""

FEEDBACK_STATUSES = ("open", "in_progress", "resolved", "closed")
FEEDBACK_STATUS_LABELS = {
    "open": "待处理",
    "in_progress": "处理中",
    "resolved": "已解决",
    "closed": "已关闭",
}


def create_feedback(conn, author_id, author_name, title, body, page=None, now=None):
    timestamp = now or now_iso()
    with conn:
        cursor = conn.execute(
            "INSERT INTO feedback (author_id, author_name, title, body, page, status, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
            (author_id, author_name, title, body, page, timestamp, timestamp),
        )
    return cursor.lastrowid


def list_feedback(conn, limit=200, status=None):
    sql = ("SELECT id, author_id, author_name, title, body, page, status, note, created_at, updated_at"
           " FROM feedback")
    params = []
    if status in FEEDBACK_STATUSES:
        sql += " WHERE status = ?"
        params.append(status)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit))
    rows = conn.execute(sql, tuple(params)).fetchall()
    return [dict(row) for row in rows]


def get_feedback(conn, feedback_id):
    row = conn.execute("SELECT * FROM feedback WHERE id = ?", (feedback_id,)).fetchone()
    return dict(row) if row is not None else None


def update_feedback(conn, feedback_id, status=None, note=None, now=None):
    row = conn.execute("SELECT * FROM feedback WHERE id = ?", (feedback_id,)).fetchone()
    if row is None:
        return None
    timestamp = now or now_iso()
    new_status = status if status in FEEDBACK_STATUSES else row["status"]
    new_note = row["note"] if note is None else str(note)
    with conn:
        conn.execute("UPDATE feedback SET status = ?, note = ?, updated_at = ? WHERE id = ?",
                     (new_status, new_note, timestamp, feedback_id))
    return dict(conn.execute("SELECT * FROM feedback WHERE id = ?", (feedback_id,)).fetchone())


def delete_feedback(conn, feedback_id):
    """删除一条反馈；返回是否真的删除了记录（不存在返回 False）。"""
    with conn:
        cursor = conn.execute("DELETE FROM feedback WHERE id = ?", (feedback_id,))
    return cursor.rowcount > 0


def save_svn_credential(conn, auth_source_id, username, secret, now=None):
    """写入/更新 SVN 口令密文（按 认证源+用户名 唯一）；返回是否新建。"""
    timestamp = now or now_iso()
    existing = conn.execute(
        "SELECT id FROM svn_credentials WHERE auth_source_id = ? AND svn_username = ?",
        (auth_source_id, username),
    ).fetchone()
    with conn:
        if existing is None:
            conn.execute(
                "INSERT INTO svn_credentials (auth_source_id, svn_username, secret, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (auth_source_id, username, secret, timestamp, timestamp),
            )
            return True
        conn.execute(
            "UPDATE svn_credentials SET secret = ?, updated_at = ? WHERE id = ?",
            (secret, timestamp, existing["id"]),
        )
    return False


def save_repo_credential(conn, repository_id, username, secret, now=None):
    """写入/更新某个仓库的同步凭据（密文）；返回是否新建。"""
    timestamp = now or now_iso()
    existing = conn.execute("SELECT id FROM repo_credentials WHERE repository_id = ?",
                            (repository_id,)).fetchone()
    with conn:
        if existing is None:
            conn.execute(
                "INSERT INTO repo_credentials (repository_id, username, secret, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (repository_id, username, secret, timestamp, timestamp),
            )
            return True
        conn.execute(
            "UPDATE repo_credentials SET username = ?, secret = ?, updated_at = ? WHERE id = ?",
            (username, secret, timestamp, existing["id"]),
        )
    return False


def find_repo_credential(conn, repository_id):
    return conn.execute("SELECT * FROM repo_credentials WHERE repository_id = ?",
                        (repository_id,)).fetchone()


def delete_repo_credential(conn, repository_id):
    with conn:
        cursor = conn.execute("DELETE FROM repo_credentials WHERE repository_id = ?", (repository_id,))
    return cursor.rowcount > 0


def find_svn_credential(conn, auth_source_id, username):
    if not auth_source_id or not username:
        return None
    return conn.execute(
        "SELECT * FROM svn_credentials WHERE auth_source_id = ? AND svn_username = ?",
        (auth_source_id, username),
    ).fetchone()


def delete_svn_credential(conn, auth_source_id, username):
    with conn:
        cursor = conn.execute(
            "DELETE FROM svn_credentials WHERE auth_source_id = ? AND svn_username = ?",
            (auth_source_id, username),
        )
    return cursor.rowcount > 0


def login_events(conn, since, limit=200):
    """按 IP + 账号 + 结果聚合登录记录（管理员界面用）。"""
    rows = conn.execute(
        "SELECT client_ip, resource, result, COUNT(*) AS count, MAX(created_at) AS last_at"
        " FROM audit_events WHERE action IN ('login', 'admin_login') AND created_at >= ?"
        " GROUP BY client_ip, resource, result ORDER BY last_at DESC LIMIT ?",
        (since, int(limit)),
    ).fetchall()
    return [dict(row) for row in rows]


def user_activity(conn, since):
    """每个账号的使用情况：最后登录、草稿数、版本数、提交数与最近一次提交状态。"""
    rows = conn.execute(
        "SELECT u.id, u.svn_username AS username, u.role, u.disabled, u.last_login_at,"
        " (SELECT COUNT(*) FROM drafts d WHERE d.user_id = u.id) AS drafts,"
        " (SELECT COUNT(*) FROM revisions r WHERE r.actor_id = u.id) AS revisions,"
        " (SELECT COUNT(*) FROM operations o WHERE o.actor_id = u.id) AS operations,"
        " (SELECT COUNT(*) FROM operations o WHERE o.actor_id = u.id AND o.created_at >= ?) AS operations_since,"
        " (SELECT o.state FROM operations o WHERE o.actor_id = u.id ORDER BY o.created_at DESC LIMIT 1) AS last_state,"
        " (SELECT o.svn_revision FROM operations o WHERE o.actor_id = u.id AND o.svn_revision IS NOT NULL"
        "    ORDER BY o.created_at DESC LIMIT 1) AS last_revision"
        " FROM users u ORDER BY u.last_login_at IS NULL, u.last_login_at DESC, u.svn_username",
        (since,),
    ).fetchall()
    return [dict(row) for row in rows]


def recent_operations(conn, limit=30):
    rows = conn.execute(
        "SELECT o.id, o.kind, o.state, o.svn_revision, o.error_code, o.created_at, o.finished_at,"
        " o.reviewed_manifest, u.svn_username AS username, u.role"
        " FROM operations o LEFT JOIN users u ON u.id = o.actor_id"
        " ORDER BY o.created_at DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        try:
            manifest = json.loads(item.pop("reviewed_manifest") or "{}")
        except ValueError:
            manifest = {}
        item["path"] = manifest.get("path")
        item["repositoryId"] = manifest.get("repositoryId")
        result.append(item)
    return result


def active_sessions(conn, now):
    rows = conn.execute(
        "SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.user_agent,"
        " u.svn_username AS username, u.role"
        " FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.last_seen_at DESC",
        (now,),
    ).fetchall()
    return [dict(row) for row in rows]


def document_snapshot_map(conn):
    """当前记录的文档快照：{path: {"size":…, "mtime":…}}。"""
    rows = conn.execute("SELECT path, size, mtime FROM document_snapshots").fetchall()
    return {row["path"]: {"size": row["size"], "mtime": row["mtime"]} for row in rows}


def record_document_changes(conn, entries, baseline=False, now=None):
    """对比文档快照并记录 added/removed/modified；baseline=True 时只写快照不记事件。

    entries: {path: {"size": int, "mtime": int}}
    返回 {"added": [...], "removed": [...], "modified": [...]}
    """
    timestamp = now or now_iso()
    previous = document_snapshot_map(conn)
    changes = {"added": [], "removed": [], "modified": []}
    for path, info in sorted(entries.items()):
        old = previous.get(path)
        if old is None:
            changes["added"].append(path)
        elif old["size"] != info["size"] or old["mtime"] != info["mtime"]:
            changes["modified"].append(path)
    for path in sorted(previous):
        if path not in entries:
            changes["removed"].append(path)
    with conn:
        for path in changes["added"] + changes["modified"]:
            info = entries[path]
            existing = previous.get(path)
            if existing is None:
                conn.execute(
                    "INSERT INTO document_snapshots (path, size, mtime, updated_at) VALUES (?, ?, ?, ?)",
                    (path, info["size"], info["mtime"], timestamp),
                )
            else:
                conn.execute(
                    "UPDATE document_snapshots SET size = ?, mtime = ?, updated_at = ? WHERE path = ?",
                    (info["size"], info["mtime"], timestamp, path),
                )
        for path in changes["removed"]:
            conn.execute("DELETE FROM document_snapshots WHERE path = ?", (path,))
        if not baseline:
            for kind in ("added", "removed", "modified"):
                for path in changes[kind]:
                    size = entries.get(path, {}).get("size")
                    conn.execute(
                        "INSERT INTO document_events (kind, path, size, created_at) VALUES (?, ?, ?, ?)",
                        (kind, path, size, timestamp),
                    )
    if baseline:
        return {"added": [], "removed": [], "modified": []}
    return changes


def document_events(conn, limit=200):
    rows = conn.execute(
        "SELECT kind, path, size, created_at FROM document_events ORDER BY id DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    return [dict(row) for row in rows]


def document_update_counts(conn):
    """每个文档的更新次数与最近更新时间（来自已发布提交记录）。"""
    rows = conn.execute(
        "SELECT reviewed_manifest, finished_at, created_at, svn_revision FROM operations"
        " WHERE state = 'published' AND reviewed_manifest IS NOT NULL ORDER BY created_at",
    ).fetchall()
    stats = {}
    for row in rows:
        try:
            manifest = json.loads(row["reviewed_manifest"] or "{}")
        except ValueError:
            continue
        path = manifest.get("path")
        if not path:
            continue
        item = stats.setdefault(path, {"count": 0, "lastAt": None, "lastRevision": None})
        item["count"] += 1
        item["lastAt"] = row["finished_at"] or row["created_at"]
        item["lastRevision"] = row["svn_revision"]
    return stats


def audit_events(conn, limit=200):
    rows = conn.execute(
        "SELECT a.action, a.resource, a.result, a.created_at, a.client_ip, a.operation_id,"
        " u.svn_username AS username, u.role"
        " FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id"
        " ORDER BY a.id DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    return [dict(row) for row in rows]


def user_count(conn):
    row = conn.execute("SELECT COUNT(*) AS total, SUM(disabled) AS disabled FROM users").fetchone()
    return {"total": int(row["total"] or 0), "disabled": int(row["disabled"] or 0)}


def find_user(conn, auth_source_id, username):
    return conn.execute(
        "SELECT * FROM users WHERE auth_source_id = ? AND svn_username = ?",
        (auth_source_id, username),
    ).fetchone()


def ensure_admin(conn, username=DEFAULT_ADMIN_USERNAME, password=DEFAULT_ADMIN_PASSWORD):
    """首次启动创建本地管理员（默认 admin/admin），返回是否新建。"""
    if find_user(conn, LOCAL_ADMIN_SOURCE, username) is not None:
        return False
    with conn:
        conn.execute(
            "INSERT INTO users (auth_source_id, svn_username, display_name, role, password_hash,"
            " created_at, last_login_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)",
            (LOCAL_ADMIN_SOURCE, username, "管理员", hash_password(password), now_iso(), None),
        )
        audit(conn, "admin_seeded", "ok", resource=username)
    return True


def reset_admin_password(conn, username=DEFAULT_ADMIN_USERNAME, password=DEFAULT_ADMIN_PASSWORD):
    """强制把管理员密码恢复为默认值（忘记密码时使用）。返回被重置的用户名或 None。"""
    row = find_user(conn, LOCAL_ADMIN_SOURCE, username)
    if row is None:
        return None
    set_admin_password(conn, row["id"], password)
    return row["svn_username"]


def set_admin_password(conn, user_id, password):
    with conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ? AND role = 'admin'",
            (hash_password(password), user_id),
        )
        audit(conn, "admin_password_changed", "ok", actor_id=user_id)



def backup_to(conn, destination):
    """备份到目标文件：优先 sqlite3 backup API（3.7+），否则用 iterdump 兼容 3.6。"""
    dest = Path(destination)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(conn, "backup"):
        target = sqlite3.connect(str(dest))
        try:
            conn.backup(target)
        finally:
            target.close()
        return dest
    return dump_backup(conn, dest)


def dump_backup(conn, destination):
    """用 SQL 转储方式备份（Python 3.6 无 Connection.backup 时使用）。"""
    dest = Path(destination)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    target = sqlite3.connect(str(dest))
    try:
        target.executescript("\n".join(conn.iterdump()))
        target.commit()
    finally:
        target.close()
    return dest


def audit(conn, action, result, actor_id=None, resource=None, operation_id=None, client_ip=None):
    """写入审计记录；错误信息由调用方脱敏后再传入。"""
    conn.execute(
        "INSERT INTO audit_events (actor_id, action, resource, operation_id, result, created_at, client_ip)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (actor_id, action, resource, operation_id, result, now_iso(), client_ip),
    )


def folder_latest_updates(conn, limit=1000):
    """每个一级文件夹最近一次发布记录：{“md/<文件夹>”: {author, at, path}}。

    数据来自已发布的操作（SVN 提交与本地发布），供仓库配置页展示“最新更新作者/时间”。
    """
    rows = conn.execute(
        "SELECT o.reviewed_manifest, o.finished_at, o.created_at,"
        " COALESCE(NULLIF(TRIM(u.display_name), ''), u.svn_username, '') AS author"
        " FROM operations o LEFT JOIN users u ON u.id = o.actor_id"
        " WHERE o.state = 'published' AND o.reviewed_manifest IS NOT NULL"
        " ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    latest = {}
    for row in rows:
        try:
            manifest = json.loads(row["reviewed_manifest"] or "{}")
        except ValueError:
            continue
        path = str(manifest.get("path") or "")
        parts = path.split("/")
        if len(parts) < 2 or parts[0] != "md":
            continue
        key = "md/" + parts[1]
        if key in latest:
            continue
        latest[key] = {"author": row["author"] or "", "at": row["finished_at"] or row["created_at"],
                       "path": path}
    return latest
