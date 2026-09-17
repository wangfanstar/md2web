import importlib.util
import io
import base64
import json
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))



def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server_package = __import__("server")
from server import auth as server_auth  # noqa: E402
from server import drafts as server_drafts  # noqa: E402
from server import operations as server_operations  # noqa: E402
from server import config as server_config  # noqa: E402
from server import database as server_database  # noqa: E402
from server import documents as server_documents  # noqa: E402
from server import paths as server_paths  # noqa: E402
from server import secrets as server_secrets  # noqa: E402
from server import svn as server_svn  # noqa: E402

FAKE_SVN = r'''import json
import os
import sys
import time
from pathlib import Path

MODE = os.environ.get("FAKE_SVN_MODE", "ok")
STATE_PATH = os.environ.get("FAKE_SVN_STATE", "")
args = sys.argv[1:]


def load_state():
    if not STATE_PATH or not Path(STATE_PATH).exists():
        return {"files": {}, "revision": 0, "log": [], "wc": {}, "uuid": "11111111-2222-3333-4444-555555555555"}
    return json.loads(Path(STATE_PATH).read_text(encoding="utf-8"))


def save_state(state):
    if STATE_PATH:
        Path(STATE_PATH).write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def credential_from_args(args):
    """支持 --password-from-stdin（新版）与 --password（旧版回退）。"""
    username = None
    password = None
    if "--username" in args:
        username = args[args.index("--username") + 1]
    if "--password-from-stdin" in args:
        password = sys.stdin.readline().strip()
    elif "--password" in args:
        password = args[args.index("--password") + 1]
    return username, password


def record_credential(args):
    """记录收到的凭据（--password-from-stdin 会读取 stdin，只读一次）并返回。"""
    username, password = credential_from_args(args)
    if username is None and password is None:
        return username, password
    state = load_state()
    state["credentials"] = {"username": username, "password": password}
    save_state(state)
    return username, password


def repo_relative(path):
    state = load_state()
    best = None
    for root, url in state.get("wc", {}).items():
        try:
            relative = str(Path(path).resolve().relative_to(Path(root).resolve()))
        except ValueError:
            continue
        if best is None or len(root) > len(best[0]):
            best = (root, relative)
    return best[1].replace("\\", "/") if best else None


INFO_XML = """<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="dir" path="auth-check" revision="{revision}">
<url>https://svn.example.invalid/svn/accounts/auth-check</url>
<repository>
<root>https://svn.example.invalid/svn/accounts</root>
<uuid>{uuid}</uuid>
</repository>
</entry>
</info>
"""


def emit_info(revision=None, uuid=None):
    state = load_state()
    sys.stdout.write(INFO_XML.format(revision=revision if revision is not None else state.get("revision", 0),
                                     uuid=uuid or state.get("uuid")))


if "--version" in args:
    print("1.14.2")
    sys.exit(0)

if "help" in args:
    if MODE == "no_stdin":
        print("  --username ARG : specify a username ARG")
    else:
        print("  --password-from-stdin : read password from stdin")
    sys.exit(0)

args = sys.argv[1:]
if args and args[0] == "--config-dir":
    args = args[2:]
command = args[0] if args else ""

if MODE == "timeout" and command == "info":
    time.sleep(10)

if MODE == "commit_timeout" and command == "commit":
    time.sleep(10)

if command == "info":
    if MODE == "unreachable":
        sys.stderr.write("svn: E170013: Unable to connect to a repository at URL\n")
        sys.exit(1)
    if MODE == "cert":
        sys.stderr.write("svn: E230001: Server SSL certificate verification failed\n")
        sys.exit(1)
    username, password = record_credential(args)
    if MODE == "anon":
        state = load_state()
        emit_info(revision=state.get("revision", 0), uuid="22222222-3333-4444-5555-666666666666")
        sys.exit(0)
    if password != "good":
        sys.stderr.write("svn: E170001: Authentication failed\n")
        sys.exit(1)
    emit_info()
    sys.exit(0)

if command == "checkout":
    url = args[1]
    target = Path(args[2])
    depth = args[args.index("--depth") + 1] if "--depth" in args else "infinity"
    state = load_state()
    state.setdefault("wc", {})[str(target)] = url
    save_state(state)
    target.mkdir(parents=True, exist_ok=True)
    if depth == "infinity":
        for relative, content in state.get("files", {}).items():
            file_path = target / relative
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")
    sys.exit(0)

if command == "update":
    target = Path(args[1])
    state = load_state()
    relative = str(target.relative_to(next(iter(state.get("wc", {})), str(target.parent)))).replace("\\", "/")
    if relative in state.get("files", {}):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(state["files"][relative], encoding="utf-8")
        print("U    " + relative)
        sys.exit(0)
    sys.stderr.write("svn: E160013: Path not found\n")
    sys.exit(1)

if command == "diff":
    relative = repo_relative(args[-1])
    target = Path(args[-1])
    state = load_state()
    remote = state.get("files", {}).get(relative)
    if remote is None:
        sys.exit(0)
    local = target.read_text(encoding="utf-8") if target.exists() else ""
    if local == remote:
        sys.exit(0)
    print("Index: " + str(relative))
    print("=" * 20)
    print("--- " + str(relative) + " (revision %s)" % state.get("revision", 0))
    print("+++ " + str(relative) + " (working copy)")
    for line in remote.splitlines():
        if line not in local.splitlines():
            print("-" + line)
    for line in local.splitlines():
        if line not in remote.splitlines():
            print("+" + line)
    sys.exit(0)

if command == "commit":
    if MODE == "auth_fail":
        sys.stderr.write("svn: E170001: Authentication failed\n")
        sys.exit(1)
    if MODE == "commit_conflict":
        sys.stderr.write("svn: E160028: File is out of date\n")
        sys.exit(1)
    record_credential(args)
    relative = repo_relative(args[1])
    state = load_state()
    state.setdefault("files", {})[relative] = Path(args[1]).read_text(encoding="utf-8")
    state["revision"] = int(state.get("revision", 0)) + 1
    state.setdefault("log", []).insert(0, {"revision": state["revision"], "author": "alice",
                                           "date": "2026-09-15T08:00:00.000000Z",
                                           "message": args[args.index("-m") + 1]})
    save_state(state)
    print("Committed revision %d." % state["revision"])
    sys.exit(0)

if command == "export":
    url = args[1]
    target = Path(args[2])
    state = load_state()
    for relative, content in state.get("files", {}).items():
        file_path = target / relative
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
    print("Exported revision %s." % state.get("revision", 0))
    sys.exit(0)

if command == "log":
    state = load_state()
    limit = 50
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    entries = state.get("log", [])[:limit]
    print('<?xml version="1.0" encoding="UTF-8"?>')
    print("<log>")
    for entry in entries:
        print('<logentry revision="%d">' % entry["revision"])
        print("<author>%s</author>" % entry["author"])
        print("<date>%s</date>" % entry["date"])
        print("<msg>%s</msg>" % entry["message"])
        print("</logentry>")
    print("</log>")
    sys.exit(0)

sys.stderr.write("svn: unknown command\n")
sys.exit(1)
'''


class ServerTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="md2web-server-"))
        self.docs = self.tmp / "docs"
        (self.docs / "md").mkdir(parents=True)
        (self.docs / "index.html").write_text("<html>ok</html>", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_config(self, overrides=None):
        data = {
            "server": {"bind": "127.0.0.1", "port": 3080},
            "auth": {
                "url": "https://svn.example.invalid/svn/accounts/auth-check/",
                "credential_group": "engineering",
                "session_hours": 8,
                "idle_minutes": 30,
            },
            "storage": {
                "database": "../data/md2web.sqlite3",
                "workspaces": "../data/workspaces",
            },
            "repositories": [
                {
                    "id": "hardware",
                    "mount": "md/硬件设计",
                    "url": "https://svn.example.invalid/svn/hardware/trunk/docs/",
                },
                {
                    "id": "verification",
                    "mount": "md/验证指南",
                    "url": "https://svn.example.invalid/svn/verification/trunk/manual/",
                },
            ],
        }
        if overrides:
            data.update(overrides)
        path = self.tmp / "config" / "server.local.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path


class ConfigTests(ServerTestBase):
    def test_load_config_resolves_storage_and_repositories(self):
        path = self.write_config()
        config = server_config.load_config(path, self.docs)
        self.assertEqual(config["server"]["bind"], "127.0.0.1")
        self.assertEqual(config["storage"]["database"], (self.tmp / "data" / "md2web.sqlite3").resolve())
        self.assertEqual(config["repositories"][0]["mount"], "md/硬件设计")
        self.assertLess(config["storage"]["workspaces"], self.docs)

    def test_storage_inside_docs_is_rejected(self):
        for database, workspaces in (
            (str(self.docs / "data" / "db.sqlite3"), "../data/ws"),
            ("../data/db.sqlite3", str(self.docs / "data" / "ws")),
        ):
            path = self.write_config({"storage": {"database": database, "workspaces": workspaces}})
            with self.assertRaises(server_config.ConfigError, msg=database):
                server_config.load_config(path, self.docs)

    def test_duplicate_mount_and_id_rejected(self):
        base = {
            "id": "hardware",
            "mount": "md/硬件设计",
            "url": "https://svn.example.invalid/svn/hardware/",
        }
        duplicate_mount = self.write_config({"repositories": [base, dict(base, id="other")]})
        with self.assertRaises(server_config.ConfigError):
            server_config.load_config(duplicate_mount, self.docs)
        duplicate_id = self.write_config({"repositories": [base, dict(base, mount="md/其它")]})
        with self.assertRaises(server_config.ConfigError):
            server_config.load_config(duplicate_id, self.docs)

    def test_mount_rejects_traversal_and_absolute(self):
        for mount in ("../md", "/md/硬件设计", "md/../硬件设计", "md/.svn", ""):
            path = self.write_config({"repositories": [{
                "id": "x", "mount": mount, "url": "https://svn.example.invalid/svn/x/",
            }]})
            with self.assertRaises(server_config.ConfigError, msg=mount):
                server_config.load_config(path, self.docs)

    def test_url_scheme_validation(self):
        for url in ("file:///srv/svn", "svn+ssh://host/repo", "", "not-a-url"):
            path = self.write_config({"repositories": [{
                "id": "x", "mount": "md/x", "url": url,
            }]})
            with self.assertRaises(server_config.ConfigError, msg=url):
                server_config.load_config(path, self.docs)

    def test_match_repository_uses_longest_segment_prefix(self):
        path = self.write_config({"repositories": [
            {"id": "root", "mount": "md/A", "url": "https://svn.example.invalid/svn/a/"},
            {"id": "nested", "mount": "md/A/B", "url": "https://svn.example.invalid/svn/b/"},
        ]})
        config = server_config.load_config(path, self.docs)
        self.assertEqual(server_config.match_repository(config, "md/A/B/c.md")["id"], "nested")
        self.assertEqual(server_config.match_repository(config, "md/A/c.md")["id"], "root")
        self.assertIsNone(server_config.match_repository(config, "md/AB/c.md"))
        self.assertIsNone(server_config.match_repository(config, "README.md"))

    def test_public_config_hides_auth_url(self):
        config = server_config.load_config(self.write_config(), self.docs)
        public = server_config.public_config(config)
        self.assertNotIn("https://svn.example.invalid/svn/accounts/auth-check/", json.dumps(public))
        self.assertEqual(public["repositories"][0]["id"], "hardware")


class DatabaseTests(ServerTestBase):
    def test_migrate_creates_tables_and_version(self):
        conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        try:
            self.assertEqual(server_database.migrate(conn), server_database.SCHEMA_VERSION)
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for name in ("users", "sessions", "repo_bindings", "drafts", "revisions", "operations",
                         "audit_events", "svn_credentials"):
                self.assertIn(name, tables)
            self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(server_database.migrate(conn), server_database.SCHEMA_VERSION)
        finally:
            conn.close()

    def test_foreign_keys_enforced(self):
        conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        try:
            server_database.migrate(conn)
            with self.assertRaises(sqlite3.IntegrityError):
                with conn:
                    conn.execute(
                        "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at,"
                        " expires_at, process_epoch) VALUES ('h', 999, 'c', 't', 't', 't', 'e')"
                    )
        finally:
            conn.close()

    def test_dump_backup_fallback(self):
        conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        try:
            server_database.migrate(conn)
            with conn:
                server_database.audit(conn, "test", "ok")
            dest = server_database.dump_backup(conn, self.tmp / "backup" / "dump.sqlite3")
            clone = sqlite3.connect(str(dest))
            try:
                count = clone.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
            finally:
                clone.close()
            self.assertEqual(count, 1)
        finally:
            conn.close()

    def test_backup_copies_database(self):
        conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        try:
            server_database.migrate(conn)
            with conn:
                server_database.audit(conn, "test", "ok")
            dest = server_database.backup_to(conn, self.tmp / "backup" / "db.sqlite3")
            clone = sqlite3.connect(str(dest))
            try:
                count = clone.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
            finally:
                clone.close()
            self.assertEqual(count, 1)
        finally:
            conn.close()

    def test_schema_sql_avoids_modern_only_features(self):
        # 旧版 SQLite（RHEL7 3.7.17）只能是基础语法；Windows 端也必须如此，保证 data/ 可直接共用
        for name in ("SCHEMA_SQL", "MIGRATION_V2_SQL", "MIGRATION_V3_SQL"):
            sql = getattr(server_database, name)
            self.assertEqual(server_database.sqlite_compat_issues(sql), [], name + " 含不兼容语法")

    def test_sqlite_compat_issues_flags_modern_constructs(self):
        issues = server_database.sqlite_compat_issues
        self.assertEqual(issues("CREATE INDEX i ON t (a, b)"), [])
        self.assertEqual(issues("SELECT * FROM t WHERE a = ?"), [])
        self.assertTrue(issues("CREATE INDEX i ON t (a) WHERE a > 0", "index"), "部分索引应被标记")
        self.assertTrue(
            issues("CREATE UNIQUE INDEX idx_users_local_admin ON users (auth_source_id) WHERE role = 'admin'", "index"),
            "旧版本创建的本地管理员部分索引应被标记",
        )
        self.assertTrue(issues("CREATE INDEX i ON t (lower(a))", "index"), "表达式索引应被标记")
        self.assertTrue(issues("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2"), "UPSERT 应被标记")
        self.assertTrue(issues("WITH x AS (SELECT 1) SELECT * FROM x"), "WITH 开头应被标记")
        self.assertTrue(issues("SELECT COUNT(*) OVER (PARTITION BY a) FROM t"), "窗口函数应被标记")
        self.assertTrue(issues("SELECT a FROM t ORDER BY a NULLS LAST"), "NULLS LAST 应被标记")
        self.assertTrue(issues("CREATE TABLE t (a, b, UNIQUE (a)) STRICT"), "STRICT 表应被标记")
        self.assertTrue(issues("CREATE TABLE t (a, b GENERATED ALWAYS AS (a + 1))"), "生成列应被标记")
        self.assertTrue(issues("SELECT json_extract(a, '$.b') FROM t"), "JSON 函数应被标记")
        self.assertTrue(issues("DELETE FROM t RETURNING id"), "RETURNING 应被标记")
        self.assertTrue(issues("ALTER TABLE t DROP COLUMN a"), "DROP COLUMN 应被标记")
        self.assertTrue(issues("SELECT * FROM a RIGHT JOIN b ON a.id = b.id"), "RIGHT JOIN 应被标记")

    def test_migrate_removes_sqlite37_incompatible_objects(self):
        path = self.tmp / "data" / "db.sqlite3"
        conn = server_database.connect(path)
        server_database.migrate(conn)
        with conn:
            conn.execute("CREATE UNIQUE INDEX idx_users_local_admin ON users (auth_source_id) WHERE role = 'admin'")
            conn.execute("CREATE INDEX idx_expression_demo ON users (lower(svn_username))")
        messages = []
        self.assertEqual(server_database.migrate(conn, logger=messages.append), server_database.SCHEMA_VERSION)
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        self.assertNotIn("idx_users_local_admin", names)
        self.assertNotIn("idx_expression_demo", names)
        self.assertTrue(any("已移除" in message for message in messages), messages)
        # 迁移后所有对象都必须是 3.7.17 可解析的
        for row in conn.execute("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view')"):
            sql = row[2] or ""
            if not sql:
                continue
            self.assertEqual(
                server_database.sqlite_compat_issues(sql, row[0]), [],
                "对象 %s 仍不兼容 SQLite 3.7.17" % row[1],
            )
        conn.close()

    def _corrupt_schema_entry(self, path, where, sql):
        conn = sqlite3.connect(str(path))
        try:
            conn.execute("PRAGMA writable_schema = ON")
            conn.execute("UPDATE sqlite_master SET sql = ? WHERE %s" % where, (sql,))
            conn.commit()
        finally:
            conn.close()

    def test_unsupported_index_is_removed_and_database_reopens(self):
        path = self.tmp / "data" / "db.sqlite3"
        conn = server_database.connect(path)
        server_database.migrate(conn)
        conn.close()
        # 模拟旧版 SQLite 记录的部分索引：本机也无法解析 -> 首次打开即失败
        self._corrupt_schema_entry(
            path,
            "type = 'index' AND name = 'idx_sessions_user'",
            "CREATE INDEX idx_sessions_user ON sessions (user_id) WHERE",  # 语法不完整：本机也无法解析 -> 走修复分支
        )
        messages = []
        conn = server_database.connect(path, logger=messages.append)
        try:
            self.assertEqual(server_database.migrate(conn), server_database.SCHEMA_VERSION)
            names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            self.assertNotIn("idx_sessions_user", names)
        finally:
            conn.close()
        self.assertTrue(list((self.tmp / "data").glob("*.repair-*.bak")), "修复前应留备份")
        self.assertTrue(any("已移除" in message for message in messages), messages)

    def test_unreadable_database_is_backed_up_and_recreated(self):
        path = self.tmp / "data" / "db.sqlite3"
        conn = server_database.connect(path)
        server_database.migrate(conn)
        conn.close()
        self._corrupt_schema_entry(
            path,
            "type = 'table' AND name = 'users'",
            "CREATE TABLE users (broken sql here",
        )
        messages = []
        conn = server_database.connect(path, logger=messages.append)
        try:
            self.assertEqual(server_database.migrate(conn), server_database.SCHEMA_VERSION)
            server_database.ensure_admin(conn)
            self.assertIsNotNone(server_database.find_user(conn, server_database.LOCAL_ADMIN_SOURCE, "admin"))
        finally:
            conn.close()
        backups = list((self.tmp / "data").glob("*.corrupt-*.bak"))
        self.assertEqual(len(backups), 1, backups)
        self.assertTrue(any("已备份" in message for message in messages), messages)


class SecretsTests(unittest.TestCase):
    """本机可逆加密：SVN 口令落库前必须可解密还原，且能发现密钥不符/篡改。"""

    def test_encrypt_decrypt_roundtrip(self):
        key = server_secrets.generate_key()
        for value in ("good", "含中文的口令-123", "a" * 300):
            token = server_secrets.encrypt(key, value)
            self.assertTrue(token.startswith("v1:"), token[:8])
            self.assertNotIn(value, token)
            self.assertEqual(server_secrets.decrypt(key, token), value)

    def test_wrong_key_or_tampered_ciphertext_is_rejected(self):
        key = server_secrets.generate_key()
        other = server_secrets.generate_key()
        token = server_secrets.encrypt(key, "good")
        with self.assertRaises(ValueError):
            server_secrets.decrypt(other, token)
        payload = token.split(":", 1)[1]
        tampered = "v1:" + payload[:-4] + ("AAAA" if not payload.endswith("AAAA") else "BBBB")
        with self.assertRaises(ValueError):
            server_secrets.decrypt(key, tampered)
        with self.assertRaises(ValueError):
            server_secrets.decrypt(key, "not-a-token")

    def test_nonce_makes_ciphertext_unique(self):
        key = server_secrets.generate_key()
        self.assertNotEqual(server_secrets.encrypt(key, "good"), server_secrets.encrypt(key, "good"))


class FakeSvn:
    def __init__(self, error=None, info=None, anonymous=False):
        self.error = error
        self.info = info or {"uuid": "u-1", "root_url": "https://svn.example.invalid/svn/accounts"}
        self.anonymous = anonymous
        self.calls = []

    def verify_credentials(self, url, username, password):
        self.calls.append((url, username, password))
        if self.error:
            raise self.error
        return dict(self.info)

    def anonymous_readable(self, url, config_dir):
        if self.error and self.error.code in ("unreachable", "timeout", "cert_error"):
            raise self.error
        return self.anonymous


class DocumentsTests(ServerTestBase):
    def test_save_and_read_roundtrip(self):
        md_dir = self.docs / "md"
        target = md_dir / "a.md"
        target.write_text("# A\n", encoding="utf-8")
        base = server_documents.text_hash("# A\n")
        result = server_documents.save_md(md_dir, "md/a.md", "# A\n\nB\n", base_hash=base)
        self.assertEqual(result["hash"], server_documents.text_hash("# A\n\nB\n"))
        meta = server_documents.read_md_meta(md_dir, "md/a.md")
        self.assertEqual(meta["hash"], result["hash"])

    def test_save_requires_matching_base_hash(self):
        md_dir = self.docs / "md"
        (md_dir / "a.md").write_text("# A\n", encoding="utf-8")
        with self.assertRaises(server_documents.MdSaveError) as ctx:
            server_documents.save_md(md_dir, "md/a.md", "# B\n", base_hash="stale")
        self.assertEqual(ctx.exception.status, 409)

    def test_save_preserves_crlf_and_rejects_bad_paths(self):
        md_dir = self.docs / "md"
        target = md_dir / "a.md"
        target.write_bytes("# A\r\n\r\nB\r\n".encode("utf-8"))
        server_documents.save_md(md_dir, "md/a.md", "# A\n\nB2\n", base_hash=server_documents.text_hash("# A\n\nB\n"))
        self.assertEqual(target.read_bytes().decode("utf-8"), "# A\r\n\r\nB2\r\n")
        for bad in ("../secret.md", "md/../a.md", "README.md", "md/a.txt", "md/.x/a.md"):
            with self.assertRaises(server_documents.MdSaveError, msg=bad):
                server_documents.normalize_md_path(bad)

    def test_save_uses_unique_temp_files(self):
        md_dir = self.docs / "md"
        (md_dir / "a.md").write_text("# A\n", encoding="utf-8")
        server_documents.save_md(md_dir, "md/a.md", "# A2\n", base_hash=server_documents.text_hash("# A\n"))
        leftovers = [path.name for path in md_dir.iterdir() if path.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])


class SvnTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.fake = self.tmp / "fake_svn.py"
        self.fake.write_text(FAKE_SVN, encoding="utf-8")
        self.client = server_svn.SvnClient(command=(sys.executable, str(self.fake)), timeout=2)

    def test_version_and_stdin_support(self):
        self.assertEqual(self.client.version(), "1.14.2")
        self.assertTrue(self.client.supports_password_from_stdin())

    def test_password_fallback_when_stdin_unsupported(self):
        # 旧版 svn（如 RHEL7 1.7/1.8）没有 --password-from-stdin：应回退到 --password 而不是报错
        state_path = self.tmp / "fallback-state.json"
        state_path.write_text(json.dumps({"files": {}, "revision": 1, "log": [], "wc": {},
                                          "uuid": "11111111-2222-3333-4444-555555555555"}), encoding="utf-8")
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "no_stdin", "FAKE_SVN_STATE": str(state_path)}):
            client = server_svn.SvnClient(command=(sys.executable, str(self.fake)), timeout=2)
            self.assertEqual(client.password_transport(), "argv")
            info = client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
            self.assertEqual(info["uuid"], "11111111-2222-3333-4444-555555555555")
        recorded = json.loads(state_path.read_text(encoding="utf-8")).get("credentials")
        self.assertEqual(recorded, {"username": "alice", "password": "good"})

    def test_verify_credentials_success(self):
        info = self.client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
        self.assertEqual(info["uuid"], "11111111-2222-3333-4444-555555555555")
        self.assertTrue(info["root_url"].startswith("https://svn.example.invalid/svn/accounts"))

    def test_verify_credentials_rejects_anonymous_path(self):
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "anon"}):
            with self.assertRaises(server_svn.SvnError) as ctx:
                self.client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
            self.assertEqual(ctx.exception.code, "anonymous_allowed")

    def test_verify_credentials_wrong_password(self):
        with self.assertRaises(server_svn.SvnError) as ctx:
            self.client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "bad")
        self.assertEqual(ctx.exception.code, "auth_failed")

    def test_error_classification(self):
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "unreachable"}):
            with self.assertRaises(server_svn.SvnError) as ctx:
                self.client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
            self.assertEqual(ctx.exception.code, "unreachable")
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "cert"}):
            with self.assertRaises(server_svn.SvnError) as ctx:
                self.client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
            self.assertEqual(ctx.exception.code, "cert_error")

    def test_missing_client_is_reported(self):
        client = server_svn.SvnClient(command=(str(self.tmp / "no-such-svn"),), timeout=2)
        with self.assertRaises(server_svn.SvnError) as ctx:
            client.version()
        self.assertEqual(ctx.exception.code, "not_found")

    def test_timeout_is_reported(self):
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "timeout"}):
            client = server_svn.SvnClient(command=(sys.executable, str(self.fake)), timeout=1)
            with self.assertRaises(server_svn.SvnError) as ctx:
                client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
            self.assertEqual(ctx.exception.code, "timeout")

    def test_password_never_reaches_argv(self):
        client = server_svn.SvnClient(command=(sys.executable, str(self.fake)), timeout=2)
        with mock.patch.object(client, "_run", wraps=client._run) as spy:
            client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
        for call in spy.call_args_list:
            args = call.args[0] if call.args else call.kwargs.get("args", [])
            self.assertNotIn("good", [str(item) for item in args])

    def test_info_parsing_rejects_entities(self):
        with self.assertRaises(server_svn.SvnError):
            server_svn.parse_info_xml("<!DOCTYPE foo [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><info/>")

    def test_same_server_comparison(self):
        self.assertTrue(server_svn.same_server("https://h.example/a/", "https://h.example:443/b/"))
        self.assertFalse(server_svn.same_server("https://h.example/a/", "https://other.example/b/"))


class AuthTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.clock = {"now": time.time()}
        self.svn = FakeSvn()
        self.auth = server_auth.AuthService(self.conn, self.svn, self.config, clock=lambda: self.clock["now"])
        self.auth.on_startup()

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def test_login_creates_user_and_hashed_session(self):
        result = self.auth.login("alice", "good", "127.0.0.1")
        self.assertEqual(result["user"]["username"], "alice")
        row = self.conn.execute("SELECT * FROM sessions").fetchone()
        self.assertNotIn(result["token"], row["token_hash"])
        self.assertEqual(len(row["token_hash"]), 64)
        session = self.auth.resolve(result["token"])
        self.assertIsNotNone(session)
        self.assertEqual(session["user"]["username"], "alice")

    def test_wrong_password_is_rejected_without_creating_user(self):
        self.svn.error = server_svn.SvnError("auth_failed")
        with self.assertRaises(server_auth.AuthError) as ctx:
            self.auth.login("alice", "bad", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 0)

    def test_login_stores_encrypted_svn_credential(self):
        self.auth.login("alice", "good", "127.0.0.1")
        row = self.conn.execute("SELECT * FROM svn_credentials").fetchone()
        self.assertIsNotNone(row, "登录成功后应保存口令")
        self.assertNotIn("good", row["secret"], "库里不能是明文")
        self.assertEqual(server_secrets.decrypt(self.auth.secret_key(), row["secret"]), "good")
        self.assertEqual(row["svn_username"], "alice")

    def test_new_password_updates_stored_credential(self):
        self.auth.login("alice", "first", "127.0.0.1")
        self.auth.login("alice", "second", "127.0.0.1")
        row = self.conn.execute("SELECT * FROM svn_credentials").fetchone()
        self.assertEqual(server_secrets.decrypt(self.auth.secret_key(), row["secret"]), "second")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM svn_credentials").fetchone()[0], 1)

    def test_failed_login_keeps_stored_credential(self):
        self.auth.login("alice", "good", "127.0.0.1")
        self.svn.error = server_svn.SvnError("auth_failed")
        with self.assertRaises(server_auth.AuthError):
            self.auth.login("alice", "wrong", "127.0.0.1")
        row = self.conn.execute("SELECT * FROM svn_credentials").fetchone()
        self.assertEqual(server_secrets.decrypt(self.auth.secret_key(), row["secret"]), "good")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)

    def test_stored_credential_roundtrip_and_forget(self):
        self.auth.login("alice", "good", "127.0.0.1")
        user = self.conn.execute("SELECT * FROM users WHERE svn_username = 'alice'").fetchone()
        self.assertEqual(self.auth.stored_credential(user), ("alice", "good"))
        self.assertTrue(self.auth.forget_stored_credential(user))
        self.assertIsNone(self.auth.stored_credential(user))
        # 管理员本机账号没有 SVN 口令
        server_database.ensure_admin(self.conn)
        admin = self.conn.execute("SELECT * FROM users WHERE role = 'admin'").fetchone()
        self.assertIsNone(self.auth.stored_credential(admin))

    def test_anonymous_auth_path_is_reported_as_service_error(self):
        self.svn.error = server_svn.SvnError("anonymous_allowed")
        with self.assertRaises(server_auth.AuthError) as ctx:
            self.auth.login("alice", "good", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 503)

    def test_rate_limit_blocks_after_max_attempts(self):
        self.svn.error = server_svn.SvnError("auth_failed")
        for _ in range(server_auth.RATE_LIMIT_MAX):
            with self.assertRaises(server_auth.AuthError):
                self.auth.login("alice", "bad", "10.0.0.9")
        with self.assertRaises(server_auth.AuthError) as ctx:
            self.auth.login("alice", "bad", "10.0.0.9")
        self.assertEqual(ctx.exception.status, 429)

    def test_session_expiry_and_idle_timeout(self):
        result = self.auth.login("alice", "good", "127.0.0.1")
        self.clock["now"] += 31 * 60
        self.assertIsNone(self.auth.resolve(result["token"]))
        result = self.auth.login("bob", "good", "127.0.0.1")
        self.clock["now"] += 9 * 3600
        self.assertIsNone(self.auth.resolve(result["token"]))

    def test_logout_revokes_session(self):
        result = self.auth.login("alice", "good", "127.0.0.1")
        self.assertTrue(self.auth.logout(result["token"]))
        self.assertIsNone(self.auth.resolve(result["token"]))

    def test_startup_revokes_previous_sessions(self):
        result = self.auth.login("alice", "good", "127.0.0.1")
        self.auth.on_startup()
        self.assertIsNone(self.auth.resolve(result["token"]))

    def test_config_source_change_revokes_sessions(self):
        result = self.auth.login("alice", "good", "127.0.0.1")
        changed = server_config.load_config(self.write_config({
            "auth": {
                "url": "https://svn.other.invalid/svn/accounts/auth-check/",
                "credential_group": "engineering",
                "session_hours": 8,
                "idle_minutes": 30,
            }
        }), self.docs)
        other = server_auth.AuthService(self.conn, self.svn, changed, clock=lambda: self.clock["now"])
        self.assertTrue(other.auth_source_changed())
        other.revoke_all("auth_source_changed")
        self.assertIsNone(other.resolve(result["token"]))

    def test_disabled_user_cannot_login_or_keep_session(self):
        result = self.auth.login("alice", "good", "127.0.0.1")
        with self.conn:
            self.conn.execute("UPDATE users SET disabled = 1")
        self.assertIsNone(self.auth.resolve(result["token"]))
        with self.assertRaises(server_auth.AuthError) as ctx:
            self.auth.login("alice", "good", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 403)

    def test_audit_events_recorded(self):
        self.auth.login("alice", "good", "127.0.0.1")
        actions = {row["action"] for row in self.conn.execute("SELECT action FROM audit_events")}
        self.assertIn("login", actions)


class AppTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.svn = FakeSvn()
        self.auth = server_auth.AuthService(self.conn, self.svn, self.config)
        self.auth.on_startup()
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def login(self):
        response = self.client.post("/__auth/login", json={"username": "alice", "password": "good"})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        return payload["csrfToken"]

    def test_anonymous_session_endpoint(self):
        response = self.client.get("/__auth/session")
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["authenticated"])
        self.assertTrue(payload["features"]["editDraft"])
        self.assertEqual(payload["site"]["repositories"][0]["id"], "hardware")

    def test_anonymous_writes_are_rejected(self):
        for path in ("/__md/save", "/__svn/commit"):
            response = self.client.post(path, json={"path": "md/a.md", "content": "x"})
            self.assertEqual(response.status_code, 401, path)
        response = self.client.put("/__md/draft", json={"path": "md/a.md", "content": "x"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.get("/__md/document?path=md/a.md").status_code, 401)
        self.assertEqual(self.client.get("/__md/history?path=md/a.md").status_code, 401)

    def test_legacy_save_requires_login_then_reports_retired(self):
        csrf = self.login()
        response = self.client.post("/__md/save", json={"path": "md/a.md", "content": "x"},
                                    headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 410)
        payload = response.get_json()
        self.assertEqual(payload["code"], "legacy_save_retired")

    def test_login_sets_cookie_and_session_endpoint_authenticates(self):
        self.login()
        payload = self.client.get("/__auth/session").get_json()
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["user"]["username"], "alice")
        self.assertTrue(payload["csrfToken"])

    def test_draft_requires_csrf_then_saves(self):
        (self.docs / "md" / "a.md").write_text("# A\n", encoding="utf-8")
        self.login()
        response = self.client.put("/__md/draft", json={"path": "md/a.md", "content": "x"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "csrf_failed")
        csrf = self.client.get("/__auth/session").get_json()["csrfToken"]
        response = self.client.put("/__md/draft", json={"path": "md/a.md", "content": "# A\n\n草稿\n"},
                                   headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["version"], 1)

    def test_logout_revokes_and_blocks_writes(self):
        csrf = self.login()
        response = self.client.post("/__auth/logout", json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.client.get("/__auth/session").get_json()["authenticated"])
        response = self.client.post("/__md/save", json={"path": "md/a.md"})
        self.assertEqual(response.status_code, 401)

    def test_login_rejects_cross_origin(self):
        response = self.client.post(
            "/__auth/login",
            json={"username": "alice", "password": "good"},
            headers={"Origin": "http://evil.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_login_requires_credentials(self):
        response = self.client.post("/__auth/login", json={"username": "alice"})
        self.assertEqual(response.status_code, 400)

    def test_static_files_served_with_whitelist(self):
        (self.docs / "md" / "a.md").write_text("# A", encoding="utf-8")
        (self.docs / ".svn").mkdir()
        (self.docs / ".svn" / "entries").write_text("svn", encoding="utf-8")
        (self.docs / "data").mkdir()
        (self.docs / "data" / "md2web.sqlite3").write_text("db", encoding="utf-8")
        (self.docs / "temp.md.tmp").write_text("tmp", encoding="utf-8")
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/md/a.md").status_code, 200)
        for blocked in ("/.svn/entries", "/data/md2web.sqlite3", "/temp.md.tmp", "/md/"):
            self.assertEqual(self.client.get(blocked).status_code, 404, blocked)
        response = self.client.get("/md/a.md")
        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")


class AdminConfigTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        server_database.ensure_admin(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.svn = FakeSvn()
        self.auth = server_auth.AuthService(self.conn, self.svn, self.config)
        self.auth.on_startup()
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def admin_login(self):
        response = self.client.post("/__auth/login", json={"username": "admin", "password": "admin", "mode": "admin"})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["csrfToken"]

    def test_schema_v2_adds_admin_columns_and_seed(self):
        columns = {row[1] for row in self.conn.execute("PRAGMA table_info(users)")}
        self.assertIn("role", columns)
        self.assertIn("password_hash", columns)
        self.assertFalse(server_database.ensure_admin(self.conn))
        row = self.conn.execute("SELECT * FROM users WHERE auth_source_id = 'local-admin'").fetchone()
        self.assertEqual(row["role"], "admin")
        self.assertTrue(row["password_hash"].startswith("pbkdf2_sha256$"))

    def test_admin_login_and_role_in_session(self):
        csrf = self.admin_login()
        self.assertTrue(csrf)
        payload = self.client.get("/__auth/session").get_json()
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["user"]["role"], "admin")

    def test_main_login_accepts_local_admin_without_svn(self):
        # 主登录框（不带 mode=admin）也应识别本机管理员，不需要 SVN 校验
        response = self.client.post("/__auth/login", json={"username": "admin", "password": "admin"})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = self.client.get("/__auth/session").get_json()
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["user"]["role"], "admin")

    def test_main_login_local_admin_wrong_password(self):
        response = self.client.post("/__auth/login", json={"username": "admin", "password": "nope"})
        self.assertEqual(response.status_code, 401)

    def test_main_login_admin_works_without_svn_configuration(self):
        empty = self.write_config({"auth": {"url": "", "credential_group": "engineering"}})
        config = server_config.load_config(empty, self.docs, allow_incomplete=True)
        service = server_auth.AuthService(self.conn, self.svn, config)
        result = service.login("admin", "admin", "127.0.0.1")
        self.assertEqual(result["user"]["role"], "admin")
        with self.assertRaises(server_auth.AuthError) as ctx:
            service.login("alice", "good", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 503)

    def test_json_configuration_is_flask_2_compatible(self):
        if hasattr(self.app, "json"):
            self.assertFalse(self.app.json.ensure_ascii)
            self.assertFalse(self.app.json.sort_keys)
        else:
            self.assertFalse(self.app.config["JSON_AS_ASCII"])
            self.assertFalse(self.app.config["JSON_SORT_KEYS"])
        self.assertEqual(self.app.config["MAX_CONTENT_LENGTH"], 2 * 1024 * 1024)

    def test_admin_login_rejects_wrong_password(self):
        response = self.client.post("/__auth/login", json={"username": "admin", "password": "nope", "mode": "admin"})
        self.assertEqual(response.status_code, 401)

    def test_svn_login_reports_missing_auth_configuration(self):
        empty = self.write_config({"auth": {"url": "", "credential_group": "engineering"}})
        config = server_config.load_config(empty, self.docs, allow_incomplete=True)
        service = server_auth.AuthService(self.conn, self.svn, config)
        with self.assertRaises(server_auth.AuthError) as ctx:
            service.login("alice", "good", "127.0.0.1")
        self.assertEqual(ctx.exception.status, 503)
        self.assertIn("尚未配置", str(ctx.exception))

    def test_config_api_requires_admin(self):
        self.assertEqual(self.client.get("/__config").status_code, 401)
        self.client.post("/__auth/login", json={"username": "alice", "password": "good"})
        response = self.client.get("/__config")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "admin_required")

    def test_config_api_roundtrip_and_hot_apply(self):
        svn_client = self.app.test_client()
        svn_client.post("/__auth/login", json={"username": "alice", "password": "good"})
        self.assertTrue(svn_client.get("/__auth/session").get_json()["authenticated"])
        csrf = self.admin_login()
        payload = self.client.get("/__config").get_json()["config"]
        self.assertEqual(payload["auth"]["url"], self.config["auth"]["url"])
        payload["auth"]["url"] = "https://svn.other.invalid/svn/accounts/auth-check/"
        payload["ai"] = {"provider": "deepseek", "baseUrl": "https://api.deepseek.com/chat/completions",
                         "model": "deepseek-chat", "apiKey": "sk-team", "useProxy": "auto", "contextChars": 5000}
        response = self.client.put("/__config", json=payload, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.config["auth"]["url"], "https://svn.other.invalid/svn/accounts/auth-check/")
        on_disk = json.loads(Path(self.config["path"]).read_text(encoding="utf-8"))
        self.assertEqual(on_disk["ai"]["model"], "deepseek-chat")
        # 认证源变化必须让 SVN 用户旧会话失效；管理员会话保留以便继续配置
        self.assertFalse(svn_client.get("/__auth/session").get_json()["authenticated"])
        session = self.client.get("/__auth/session").get_json()
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["site"]["ai"]["apiKey"], "sk-team")
        self.assertEqual(session["site"]["authConfigured"], True)

    def test_anonymous_session_hides_ai_key(self):
        csrf = self.admin_login()
        payload = self.client.get("/__config").get_json()["config"]
        payload["ai"] = {"provider": "openai", "baseUrl": "https://api.example.com/v1/chat/completions",
                         "model": "m", "apiKey": "sk-secret", "useProxy": "auto", "contextChars": 6000}
        self.client.put("/__config", json=payload, headers={"X-CSRF-Token": csrf})
        self.client.post("/__auth/logout", json={}, headers={"X-CSRF-Token": self.client.get("/__auth/session").get_json()["csrfToken"]})
        site = self.client.get("/__auth/session").get_json()["site"]
        self.assertNotIn("apiKey", site["ai"] or {})
        self.assertFalse(site["authConfigured"] is None)

    def test_config_api_rejects_invalid_payload(self):
        csrf = self.admin_login()
        payload = self.client.get("/__config").get_json()["config"]
        payload["repositories"] = [{"id": "x", "mount": "md/x", "url": "file:///etc"}]
        response = self.client.put("/__config", json=payload, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "config_invalid")

    def test_config_api_requires_csrf(self):
        self.admin_login()
        response = self.client.put("/__config", json={})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "csrf_failed")

    def test_test_auth_endpoint_accepts_protected_path(self):
        csrf = self.admin_login()
        response = self.client.post("/__config/test-auth", json={"url": "https://svn.example.invalid/auth-check/"},
                                    headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()["result"]["requiresAuth"])

    def test_test_auth_endpoint_rejects_anonymous_path(self):
        self.svn.anonymous = True
        csrf = self.admin_login()
        response = self.client.post("/__config/test-auth", json={"url": "https://svn.example.invalid/public/"},
                                    headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 503)
        self.assertIn("匿名", response.get_json()["error"])

    def test_reset_admin_password_restores_default(self):
        csrf = self.admin_login()
        self.client.post("/__admin/password", json={"current": "admin", "password": "secret1"},
                         headers={"X-CSRF-Token": csrf})
        self.assertEqual(self.client.post("/__auth/login", json={"username": "admin", "password": "admin", "mode": "admin"}).status_code, 401)
        self.assertEqual(server_database.reset_admin_password(self.conn), "admin")
        self.assertEqual(self.client.post("/__auth/login", json={"username": "admin", "password": "admin", "mode": "admin"}).status_code, 200)

    def test_reset_admin_password_missing_admin(self):
        with self.conn:
            self.conn.execute("DELETE FROM users WHERE auth_source_id = 'local-admin'")
        self.assertIsNone(server_database.reset_admin_password(self.conn))

    def test_admin_password_change(self):
        csrf = self.admin_login()
        response = self.client.post("/__admin/password", json={"current": "admin", "password": "secret1"},
                                    headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.client.post("/__auth/logout", json={}, headers={"X-CSRF-Token": csrf})
        wrong = self.client.post("/__auth/login", json={"username": "admin", "password": "admin", "mode": "admin"})
        self.assertEqual(wrong.status_code, 401)
        right = self.client.post("/__auth/login", json={"username": "admin", "password": "secret1", "mode": "admin"})
        self.assertEqual(right.status_code, 200)


class ConfigFileTests(ServerTestBase):
    def test_default_config_bootstraps_loadable_file(self):
        path = self.tmp / "config" / "server.local.json"
        self.assertFalse(path.exists())
        loaded = server_config.save_config(path, server_config.default_config(), self.docs)
        self.assertTrue(path.exists())
        self.assertEqual(loaded["auth"]["url"], "")
        self.assertEqual(loaded["repositories"], [])
        self.assertEqual(loaded["ai"]["provider"], "openai")

    def test_saved_config_roundtrip_keeps_values(self):
        path = self.tmp / "config" / "server.local.json"
        payload = server_config.default_config()
        payload["auth"]["url"] = "https://svn.example.invalid/svn/accounts/auth-check/"
        payload["repositories"] = [{"id": "hardware", "mount": "md/硬件设计",
                                    "url": "https://svn.example.invalid/svn/hardware/"}]
        loaded = server_config.save_config(path, payload, self.docs)
        again = server_config.config_to_json(loaded)
        self.assertEqual(again["repositories"][0]["mount"], "md/硬件设计")
        self.assertEqual(again["storage"]["database"], "../data/md2web.sqlite3")


class DraftTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        self.md_dir = self.docs / "md"
        (self.md_dir / "a.md").write_text("# A\n\n已发布内容\n", encoding="utf-8")
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO users (auth_source_id, svn_username, display_name, role, created_at)"
                " VALUES ('src', 'alice', 'alice', 'user', 't')"
            )
            self.alice = cursor.lastrowid
            cursor = self.conn.execute(
                "INSERT INTO users (auth_source_id, svn_username, display_name, role, created_at)"
                " VALUES ('src', 'bob', 'bob', 'user', 't')"
            )
            self.bob = cursor.lastrowid

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def test_save_draft_creates_version_and_history(self):
        first = server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\n草稿一\n", expected_version=0)
        self.assertEqual(first["version"], 1)
        self.assertIsNotNone(first["revisionId"])
        second = server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\n草稿二\n", expected_version=1)
        self.assertEqual(second["version"], 2)
        history = server_drafts.list_history(self.conn, self.alice, self.md_dir, "md/a.md")
        self.assertEqual(len(history["revisions"]), 2)
        self.assertTrue(history["revisions"][0]["isHead"])

    def test_save_draft_conflict_returns_409_with_current(self):
        server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\n草稿一\n", expected_version=0)
        with self.assertRaises(server_drafts.DraftError) as ctx:
            server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# B\n", expected_version=0)
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.extra.get("currentVersion"), 1)
        self.assertIn("草稿一", ctx.exception.extra.get("currentContent") or "")

    def test_draft_is_private_per_user(self):
        server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\nAlice 草稿\n", expected_version=0)
        bob_state = server_drafts.document_state(self.conn, self.bob, self.md_dir, "md/a.md")
        self.assertIsNone(bob_state["draft"])
        self.assertEqual(bob_state["published"]["text"].replace("\r\n", "\n"), "# A\n\n已发布内容\n")
        self.assertIsNone(server_drafts.get_revision(self.conn, self.bob, 1))
        alice_state = server_drafts.document_state(self.conn, self.alice, self.md_dir, "md/a.md")
        self.assertIn("Alice 草稿", alice_state["draft"]["content"])

    def test_published_file_not_changed_by_draft(self):
        server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\n草稿\n", expected_version=0)
        self.assertEqual((self.md_dir / "a.md").read_text(encoding="utf-8"), "# A\n\n已发布内容\n")

    def test_diff_between_published_and_draft(self):
        server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\n草稿\n", expected_version=0)
        result = server_drafts.diff_documents(self.conn, self.alice, self.md_dir, "md/a.md", "published", "draft")
        self.assertIn("-已发布内容", result["diff"])
        self.assertIn("+草稿", result["diff"])
        same = server_drafts.diff_documents(self.conn, self.alice, self.md_dir, "md/a.md", "published", "published")
        self.assertTrue(same["identical"])

    def test_discard_draft_keeps_history(self):
        server_drafts.save_draft(self.conn, self.alice, self.md_dir, "md/a.md", "# A\n\n草稿\n", expected_version=0)
        server_drafts.discard_draft(self.conn, self.alice, "md/a.md")
        state = server_drafts.document_state(self.conn, self.alice, self.md_dir, "md/a.md")
        self.assertIsNone(state["draft"])
        history = server_drafts.list_history(self.conn, self.alice, self.md_dir, "md/a.md")
        self.assertEqual(len(history["revisions"]), 1)

    def test_draft_rejects_illegal_path(self):
        for bad in ("../a.md", "README.md", "md/a.txt"):
            with self.assertRaises(server_documents.MdSaveError, msg=bad):
                server_drafts.save_draft(self.conn, self.alice, self.md_dir, bad, "x", expected_version=0)


class DraftApiTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.svn = FakeSvn()
        self.auth = server_auth.AuthService(self.conn, self.svn, self.config)
        self.auth.on_startup()
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()
        (self.docs / "md" / "a.md").write_text("# A\n\n已发布\n", encoding="utf-8")
        self.client.post("/__auth/login", json={"username": "alice", "password": "good"})
        self.csrf = self.client.get("/__auth/session").get_json()["csrfToken"]

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def test_document_endpoint_returns_published_and_draft(self):
        target = self.docs / "md" / "硬件设计"
        target.mkdir(parents=True, exist_ok=True)
        (target / "a.md").write_text("# A\n\n已发布\n", encoding="utf-8")
        path = "md/硬件设计/a.md"
        payload = self.client.get("/__md/document?path=" + path).get_json()
        self.assertTrue(payload["ok"])
        self.assertIn("已发布", payload["document"]["published"]["text"])
        self.assertIsNone(payload["document"]["draft"])
        self.assertEqual(payload["document"]["binding"]["id"], "hardware")
        self.client.put("/__md/draft", json={"path": path, "content": "# A\n\n草稿\n", "expectedVersion": 0},
                        headers={"X-CSRF-Token": self.csrf})
        payload = self.client.get("/__md/document?path=" + path).get_json()
        self.assertEqual(payload["document"]["draft"]["version"], 1)
        self.assertIn("草稿", payload["document"]["draft"]["content"])

    def test_draft_conflict_over_api(self):
        headers = {"X-CSRF-Token": self.csrf}
        self.client.put("/__md/draft", json={"path": "md/a.md", "content": "v1", "expectedVersion": 0}, headers=headers)
        response = self.client.put("/__md/draft", json={"path": "md/a.md", "content": "v2", "expectedVersion": 0}, headers=headers)
        self.assertEqual(response.status_code, 409)
        payload = response.get_json()
        self.assertEqual(payload["code"], "draft_conflict")
        self.assertEqual(payload["currentVersion"], 1)
        self.assertEqual(payload["currentContent"], "v1")

    def test_history_and_diff_over_api(self):
        headers = {"X-CSRF-Token": self.csrf}
        self.client.put("/__md/draft", json={"path": "md/a.md", "content": "# A\n\n第一版\n", "expectedVersion": 0}, headers=headers)
        self.client.put("/__md/draft", json={"path": "md/a.md", "content": "# A\n\n第二版\n", "expectedVersion": 1}, headers=headers)
        history = self.client.get("/__md/history?path=md/a.md").get_json()["history"]
        self.assertEqual(len(history["revisions"]), 2)
        diff = self.client.get("/__md/diff?path=md/a.md&from=published&to=draft").get_json()["diff"]
        self.assertIn("+第二版", diff["diff"])
        older = history["revisions"][-1]["id"]
        diff2 = self.client.get(f"/__md/diff?path=md/a.md&from={older}&to=draft").get_json()["diff"]
        self.assertIn("-第一版", diff2["diff"])
        self.assertIn("+第二版", diff2["diff"])

    def test_discard_endpoint(self):
        headers = {"X-CSRF-Token": self.csrf}
        self.client.put("/__md/draft", json={"path": "md/a.md", "content": "x", "expectedVersion": 0}, headers=headers)
        response = self.client.post("/__md/discard", json={"path": "md/a.md"}, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.client.get("/__md/document?path=md/a.md").get_json()["document"]["draft"])


class ImageUploadTests(ServerTestBase):
    """编辑器粘贴图片：写入文档同级 images/，命名 <文档名>-<序号>-<时间戳>.<扩展名>。"""

    PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE"
           "hQGAhKmMIQAAAABJRU5ErkJggg==")

    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.svn = FakeSvn()
        self.auth = server_auth.AuthService(self.conn, self.svn, self.config)
        self.auth.on_startup()
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()
        target = self.docs / "md" / "硬件设计"
        target.mkdir(parents=True, exist_ok=True)
        (target / "时钟树设计.md").write_text("# 时钟树\n", encoding="utf-8")
        self.path = "md/硬件设计/时钟树设计.md"
        self.client.post("/__auth/login", json={"username": "alice", "password": "good"})
        self.csrf = self.client.get("/__auth/session").get_json()["csrfToken"]

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def upload(self, mime="image/png", data=None, path=None, csrf=True):
        headers = {"X-CSRF-Token": self.csrf} if csrf else {}
        return self.client.post("/__md/image", headers=headers, json={
            "path": path if path is not None else self.path,
            "type": mime,
            "data": self.PNG if data is None else data,
        })

    def test_upload_writes_images_folder_with_sequence_and_timestamp(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.get_json())
        payload = response.get_json()
        self.assertEqual(payload["path"], "images/" + payload["name"])
        self.assertTrue(payload["name"].startswith("时钟树设计-1-"), payload["name"])
        self.assertTrue(payload["name"].endswith(".png"), payload["name"])
        target = self.docs / "md" / "硬件设计" / "images" / payload["name"]
        self.assertTrue(target.is_file())
        self.assertEqual(target.read_bytes(), base64.b64decode(self.PNG))
        self.assertEqual(payload["sequence"], 1)
        second = self.upload().get_json()
        self.assertTrue(second["name"].startswith("时钟树设计-2-"), second["name"])
        self.assertEqual(second["sequence"], 2)
        third = self.upload(mime="image/jpeg").get_json()
        self.assertTrue(third["name"].endswith(".jpg"), third["name"])
        self.assertEqual(third["sequence"], 3)

    def test_upload_accepts_extensionless_and_data_url(self):
        payload = self.upload(path="md/硬件设计/时钟树设计",
                              data="data:image/png;base64," + self.PNG).get_json()
        self.assertTrue(payload["name"].startswith("时钟树设计-"), payload["name"])

    def test_upload_requires_login_and_csrf(self):
        anonymous = self.app.test_client()
        response = anonymous.post("/__md/image", json={"path": self.path, "type": "image/png", "data": self.PNG})
        self.assertEqual(response.status_code, 401)
        response = self.upload(csrf=False)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "csrf_failed")

    def test_upload_rejects_unsupported_and_invalid_payloads(self):
        self.assertEqual(self.upload(mime="image/svg+xml").status_code, 415)
        self.assertEqual(self.upload(data="not-base64!!").status_code, 400)
        self.assertEqual(self.upload(data="").status_code, 400)
        self.assertEqual(self.upload(path="md/../escape.md").status_code, 400)
        self.assertEqual(self.upload(path="README.md").status_code, 400)
        self.assertEqual(self.upload(path="md/硬件设计/不存在.md").status_code, 404)
        with mock.patch.object(server_documents, "IMAGE_MAX_BYTES", 10):
            self.assertEqual(self.upload().status_code, 413)

    def test_uploaded_image_is_served_statically(self):
        name = self.upload().get_json()["name"]
        response = self.client.get("/md/硬件设计/images/" + name)
        self.assertEqual(response.status_code, 200, name)
        self.assertEqual(response.data, base64.b64decode(self.PNG))


class SvnOperationTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        server_database.ensure_admin(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        self.md_dir = self.docs / "md"
        self.mount_dir = self.md_dir / "硬件设计"
        self.mount_dir.mkdir(parents=True, exist_ok=True)
        self.published_file = self.mount_dir / "时钟树设计.md"
        self.published_file.write_text("# 时钟树设计\n\n远端基线\n", encoding="utf-8")
        self.document_path = "md/硬件设计/时钟树设计.md"
        self.state_path = self.tmp / "svn-state.json"
        self.state_path.write_text(json.dumps({
            "files": {"时钟树设计.md": "# 时钟树设计\n\n远端基线\n"},
            "revision": 3,
            "log": [{"revision": 3, "author": "bob", "date": "2026-09-14T08:00:00.000000Z", "message": "baseline"}],
            "wc": {},
            "uuid": "11111111-2222-3333-4444-555555555555",
        }, ensure_ascii=False), encoding="utf-8")
        fake = self.tmp / "fake_svn.py"
        fake.write_text(FAKE_SVN, encoding="utf-8")
        self.svn = server_svn.SvnClient(command=(sys.executable, str(fake)), timeout=5)
        self.env = mock.patch.dict("os.environ", {"FAKE_SVN_STATE": str(self.state_path)})
        self.env.start()
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO users (auth_source_id, svn_username, display_name, role, created_at)"
                " VALUES ('src', 'alice', 'alice', 'user', 't')"
            )
            self.alice = cursor.lastrowid
        self.workspaces = self.tmp / "workspaces"

    def tearDown(self):
        self.env.stop()
        self.conn.close()
        super().tearDown()

    def repo_state(self):
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def make_draft(self, content="# 时钟树设计\n\n远端基线\n\n草稿修改\n"):
        server_drafts.save_draft(self.conn, self.alice, self.md_dir, self.document_path, content, expected_version=0)
        return content

    def test_prepare_requires_binding_and_draft(self):
        with self.assertRaises(server_operations.OperationError) as ctx:
            server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir, "md/其他/x.md", "msg")
        self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(server_operations.OperationError) as ctx:
            server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir, self.document_path, "msg")
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("草稿", str(ctx.exception))

    def test_prepare_freezes_manifest_and_diff(self):
        content = self.make_draft()
        result = server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir,
                                                  self.document_path, "docs: update clock tree", expected_version=1)
        self.assertEqual(result["state"], "prepared")
        manifest = result["manifest"]
        self.assertEqual(manifest["repositoryId"], "hardware")
        self.assertEqual(manifest["mount"], "md/硬件设计")
        self.assertEqual(manifest["message"], "docs: update clock tree")
        self.assertEqual(manifest["contentHash"], server_documents.text_hash(content))
        self.assertIn("+草稿修改", result["diff"])
        row = server_operations.get_operation(self.conn, result["operationId"], self.alice)
        self.assertEqual(row["state"], "prepared")
        self.assertIsNone(server_operations.get_operation(self.conn, result["operationId"], 999))

    def test_commit_success_publishes_and_records_revision(self):
        content = self.make_draft()
        prepared = server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir,
                                                    self.document_path, "docs: update", expected_version=1)
        result = server_operations.run_commit(self.conn, self.svn, self.config, self.md_dir, self.workspaces,
                                              prepared["operationId"], self.alice, ("alice", "good"))
        self.assertEqual(result["state"], "published")
        self.assertEqual(result["svnRevision"], 4)
        self.assertEqual(self.published_file.read_text(encoding="utf-8").replace("\r\n", "\n"), content)
        self.assertEqual(self.repo_state()["revision"], 4)
        self.assertEqual(self.repo_state()["files"]["时钟树设计.md"], content)
        binding = self.conn.execute("SELECT * FROM repo_bindings WHERE mount_path = 'md/硬件设计'").fetchone()
        self.assertEqual(binding["published_revision"], 4)
        self.assertEqual(binding["repository_uuid"], "11111111-2222-3333-4444-555555555555")

    def test_commit_is_idempotent(self):
        self.make_draft()
        prepared = server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir,
                                                    self.document_path, "docs: update", expected_version=1)
        first = server_operations.run_commit(self.conn, self.svn, self.config, self.md_dir, self.workspaces,
                                             prepared["operationId"], self.alice, ("alice", "good"))
        second = server_operations.run_commit(self.conn, self.svn, self.config, self.md_dir, self.workspaces,
                                              prepared["operationId"], self.alice, ("alice", "good"))
        self.assertFalse(first.get("reused"))
        self.assertTrue(second["reused"])
        self.assertEqual(self.repo_state()["revision"], 4)

    def test_commit_without_credential_requires_auth(self):
        self.make_draft()
        prepared = server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir,
                                                    self.document_path, "docs: update", expected_version=1)
        with self.assertRaises(server_operations.OperationError) as ctx:
            server_operations.run_commit(self.conn, self.svn, self.config, self.md_dir, self.workspaces,
                                         prepared["operationId"], self.alice, None)
        self.assertEqual(ctx.exception.status, 401)
        row = server_operations.get_operation(self.conn, prepared["operationId"], self.alice)
        self.assertEqual(row["state"], "needs_auth")
        self.assertEqual(self.repo_state()["revision"], 3)

    def test_commit_conflict_marks_operation_failed(self):
        self.make_draft()
        prepared = server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir,
                                                    self.document_path, "docs: update", expected_version=1)
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "commit_conflict"}):
            with self.assertRaises(server_operations.OperationError) as ctx:
                server_operations.run_commit(self.conn, self.svn, self.config, self.md_dir, self.workspaces,
                                             prepared["operationId"], self.alice, ("alice", "good"))
        self.assertEqual(ctx.exception.status, 409)
        row = server_operations.get_operation(self.conn, prepared["operationId"], self.alice)
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["error_code"], "conflict")
        self.assertEqual(self.repo_state()["revision"], 3)

    def test_commit_timeout_is_uncertain_and_not_retried(self):
        self.make_draft()
        prepared = server_operations.prepare_commit(self.conn, self.alice, self.config, self.md_dir,
                                                    self.document_path, "docs: update", expected_version=1)
        slow = server_svn.SvnClient(command=(sys.executable, str(self.tmp / "fake_svn.py")), timeout=1)
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "commit_timeout"}):
            with self.assertRaises(server_operations.OperationError) as ctx:
                server_operations.run_commit(self.conn, slow, self.config, self.md_dir, self.workspaces,
                                             prepared["operationId"], self.alice, ("alice", "good"))
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn("不确定", str(ctx.exception))
        row = server_operations.get_operation(self.conn, prepared["operationId"], self.alice)
        self.assertEqual(row["state"], "uncertain")
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "commit_timeout"}):
            with self.assertRaises(server_operations.OperationError) as ctx:
                server_operations.run_commit(self.conn, slow, self.config, self.md_dir, self.workspaces,
                                             prepared["operationId"], self.alice, ("alice", "good"))
        self.assertEqual(ctx.exception.status, 409)

    def test_binding_uuid_mismatch_is_rejected(self):
        with self.conn:
            self.conn.execute(
                "INSERT INTO repo_bindings (repository_id, mount_path, repository_uuid, root_url, target_url,"
                " credential_group, config_version, created_at, updated_at)"
                " VALUES ('hardware', 'md/硬件设计', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',"
                " 'https://svn.example.invalid/svn/hardware', 'https://svn.example.invalid/svn/hardware/trunk/docs/',"
                " 'engineering', 'cfg', 't', 't')"
            )
        binding = server_config.match_repository(self.config, self.document_path)
        with self.assertRaises(server_operations.OperationError) as ctx:
            server_operations.ensure_binding(self.conn, binding, self.svn, self.config, ("alice", "good"))
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("UUID", str(ctx.exception))

    def test_sync_binding_exports_and_tracks_revision(self):
        binding = server_config.match_repository(self.config, self.document_path)
        first = server_operations.sync_binding(self.conn, self.svn, self.config, self.md_dir, binding,
                                               ("alice", "good"))
        self.assertTrue(first["updated"])
        self.assertEqual(first["revision"], 3)
        self.assertIn("时钟树设计.md", first["files"])
        second = server_operations.sync_binding(self.conn, self.svn, self.config, self.md_dir, binding,
                                                ("alice", "good"))
        self.assertFalse(second["updated"])
        row = self.conn.execute("SELECT * FROM repo_bindings WHERE mount_path = 'md/硬件设计'").fetchone()
        self.assertEqual(row["published_revision"], 3)


class SvnApiTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.conn = server_database.connect(self.tmp / "data" / "db.sqlite3")
        server_database.migrate(self.conn)
        server_database.ensure_admin(self.conn)
        self.config = server_config.load_config(self.write_config(), self.docs)
        (self.docs / "md" / "硬件设计").mkdir(parents=True, exist_ok=True)
        (self.docs / "md" / "硬件设计" / "时钟树设计.md").write_text("# A\n", encoding="utf-8")
        self.state_path = self.tmp / "svn-state.json"
        self.state_path.write_text(json.dumps({
            "files": {"时钟树设计.md": "# A\n"}, "revision": 5, "log": [
                {"revision": 5, "author": "alice", "date": "2026-09-15T08:00:00.000000Z", "message": "docs"}],
            "wc": {}, "uuid": "11111111-2222-3333-4444-555555555555",
        }, ensure_ascii=False), encoding="utf-8")
        fake = self.tmp / "fake_svn.py"
        fake.write_text(FAKE_SVN, encoding="utf-8")
        self.env = mock.patch.dict("os.environ", {"FAKE_SVN_STATE": str(self.state_path)})
        self.env.start()
        self.svn = server_svn.SvnClient(command=(sys.executable, str(fake)), timeout=5)
        self.auth = server_auth.AuthService(self.conn, self.svn, self.config)
        self.auth.on_startup()
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()

    def tearDown(self):
        self.env.stop()
        self.conn.close()
        super().tearDown()

    def login(self):
        response = self.client.post("/__auth/login", json={"username": "alice", "password": "good"})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return self.client.get("/__auth/session").get_json()["csrfToken"]

    def test_anonymous_svn_endpoints_are_rejected(self):
        self.assertEqual(self.client.get("/__svn/info?path=md/硬件设计/时钟树设计.md").status_code, 401)
        self.assertEqual(self.client.post("/__svn/prepare", json={"path": "md/硬件设计/时钟树设计.md"}).status_code, 401)
        self.assertEqual(self.client.post("/__svn/commit", json={}).status_code, 401)
        self.assertEqual(self.client.get("/__svn/log?path=md/硬件设计/时钟树设计.md").status_code, 401)

    def test_csrf_required_for_prepare_and_commit(self):
        self.login()
        response = self.client.post("/__svn/prepare", json={"path": "md/硬件设计/时钟树设计.md", "message": "m"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "csrf_failed")

    def test_info_endpoint_reports_binding(self):
        self.login()
        response = self.client.get("/__svn/info?path=md/硬件设计/时钟树设计.md")
        payload = response.get_json()
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["binding"]["id"], "hardware")
        self.assertEqual(payload["binding"]["targetUrl"], "https://svn.example.invalid/svn/hardware/trunk/docs/")
        self.assertEqual(payload["binding"]["repositoryUuid"], "11111111-2222-3333-4444-555555555555")
        self.assertEqual(self.client.get("/__svn/info?path=md/其他/x.md").status_code, 400)

    def test_log_endpoint_uses_session_credential(self):
        self.login()
        payload = self.client.get("/__svn/log?path=md/硬件设计/时钟树设计.md&limit=5").get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["entries"][0]["revision"], 5)
        self.assertEqual(payload["entries"][0]["message"], "docs")

    def test_commit_uses_stored_credential_without_session_memory(self):
        """模拟重启/换标签页：会话内存没有口令时，提交应使用数据库里已保存的最新口令。"""
        headers_csrf = self.login()
        headers = {"X-CSRF-Token": headers_csrf}
        stored = self.conn.execute("SELECT * FROM svn_credentials").fetchone()
        self.assertIsNotNone(stored, "登录后应已保存口令")
        self.auth._credentials = {}
        self.client.put("/__md/draft", json={"path": "md/硬件设计/时钟树设计.md", "content": "# A\n\n草稿\n",
                                             "expectedVersion": 0}, headers=headers)
        prepared = self.client.post("/__svn/prepare", json={"path": "md/硬件设计/时钟树设计.md",
                                                            "message": "docs: 存储口令提交", "expectedVersion": 1},
                                    headers=headers).get_json()
        self.assertTrue(prepared["ok"], prepared)
        committed = self.client.post("/__svn/commit", json={"operationId": prepared["operationId"]},
                                     headers=headers).get_json()
        self.assertTrue(committed["ok"], committed)
        self.assertEqual(committed["result"]["state"], "published")
        recorded = json.loads(self.state_path.read_text(encoding="utf-8")).get("credentials")
        self.assertEqual(recorded, {"username": "alice", "password": "good"})

    def test_commit_with_updated_password_uses_latest_stored(self):
        """换密码后重新登录：数据库应更新，随后提交使用新口令。"""
        self.login()
        response = self.client.post("/__auth/login", json={"username": "alice", "password": "good"})
        self.assertEqual(response.status_code, 200)
        with self.conn:
            self.conn.execute("UPDATE svn_credentials SET secret = ? WHERE svn_username = 'alice'",
                              (server_secrets.encrypt(self.auth.secret_key(), "newpass"),))
        self.auth._credentials = {}
        self.assertEqual(self.auth.stored_credential(
            self.conn.execute("SELECT * FROM users WHERE svn_username = 'alice'").fetchone()),
            ("alice", "newpass"))

    def test_commit_auth_failure_clears_stored_credential(self):
        headers_csrf = self.login()
        headers = {"X-CSRF-Token": headers_csrf}
        self.client.put("/__md/draft", json={"path": "md/硬件设计/时钟树设计.md", "content": "# A\n\n草稿\n",
                                             "expectedVersion": 0}, headers=headers)
        prepared = self.client.post("/__svn/prepare", json={"path": "md/硬件设计/时钟树设计.md",
                                                            "message": "m", "expectedVersion": 1},
                                    headers=headers).get_json()
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "auth_fail"}):
            response = self.client.post("/__svn/commit", json={"operationId": prepared["operationId"]},
                                        headers=headers)
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(self.conn.execute("SELECT * FROM svn_credentials").fetchone(),
                          "口令失效后应清理旧密文")

    def test_prepare_then_commit_via_api(self):
        headers_csrf = self.login()
        headers = {"X-CSRF-Token": headers_csrf}
        self.client.put("/__md/draft", json={"path": "md/硬件设计/时钟树设计.md", "content": "# A\n\n草稿\n",
                                             "expectedVersion": 0}, headers=headers)
        prepared = self.client.post("/__svn/prepare", json={"path": "md/硬件设计/时钟树设计.md",
                                                            "message": "docs: 草稿提交", "expectedVersion": 1},
                                    headers=headers).get_json()
        self.assertTrue(prepared["ok"], prepared)
        operation_id = prepared["operationId"]
        committed = self.client.post("/__svn/commit", json={"operationId": operation_id}, headers=headers).get_json()
        self.assertTrue(committed["ok"], committed)
        self.assertEqual(committed["result"]["state"], "published")
        self.assertEqual(committed["result"]["svnRevision"], 6)
        status = self.client.get("/__operations/" + operation_id).get_json()["operation"]
        self.assertEqual(status["state"], "published")
        self.assertEqual(status["svnRevision"], 6)


class PathsTests(unittest.TestCase):
    def test_blocked_paths(self):
        blocked = (".svn/entries", "md/.hidden/a.md", "data/db.sqlite3", "config/server.local.json",
                   "app.py", "md/x.md.tmp", "../secret.md", "")
        for value in blocked:
            self.assertTrue(server_paths.is_blocked_static_path(value), value)
        for value in ("md/a.md", "lib/ai-assistant.js", "md/硬件设计/时钟树设计.md"):
            self.assertFalse(server_paths.is_blocked_static_path(value), value)


if __name__ == "__main__":
    unittest.main()
