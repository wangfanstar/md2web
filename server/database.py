"""SQLite 访问层：连接设置、迁移、事务辅助与备份。"""

import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .passwords import hash_password

SCHEMA_VERSION = 2

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


def audit(conn, action, result, actor_id=None, resource=None, operation_id=None):
    """写入审计记录；错误信息由调用方脱敏后再传入。"""
    conn.execute(
        "INSERT INTO audit_events (actor_id, action, resource, operation_id, result, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (actor_id, action, resource, operation_id, result, now_iso()),
    )
