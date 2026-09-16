"""SQLite 访问层：连接设置、迁移、事务辅助与备份。"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .passwords import hash_password

SCHEMA_VERSION = 2

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


def connect(path):
    """打开数据库：外键开启、busy_timeout、行工厂。"""
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # Waitress 多线程处理请求：连接允许跨线程使用，由调用方（AuthService）串行化访问
    conn = sqlite3.connect(str(db_path), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA synchronous = FULL")
    return conn


def schema_version(conn):
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def migrate(conn):
    """按 user_version 迁移；重复执行安全。"""
    version = schema_version(conn)
    if version >= SCHEMA_VERSION:
        return version
    with conn:
        if version < 1:
            conn.executescript(SCHEMA_SQL)
        if version < 2:
            conn.executescript(MIGRATION_V2_SQL)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    return SCHEMA_VERSION


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
