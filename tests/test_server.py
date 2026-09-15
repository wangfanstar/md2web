import importlib.util
import io
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


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server_package = __import__("server")
from server import auth as server_auth  # noqa: E402
from server import config as server_config  # noqa: E402
from server import database as server_database  # noqa: E402
from server import documents as server_documents  # noqa: E402
from server import paths as server_paths  # noqa: E402
from server import svn as server_svn  # noqa: E402

FAKE_SVN = r'''import os
import sys
import time

MODE = os.environ.get("FAKE_SVN_MODE", "ok")
args = sys.argv[1:]

INFO_XML = """<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="dir" path="auth-check" revision="42">
<url>https://svn.example.invalid/svn/accounts/auth-check</url>
<repository>
<root>https://svn.example.invalid/svn/accounts</root>
<uuid>11111111-2222-3333-4444-555555555555</uuid>
</repository>
</entry>
</info>
"""

if "--version" in args:
    print("1.14.2")
    sys.exit(0)

if "help" in args:
    if MODE == "no_stdin":
        print("  --username ARG : specify a username ARG")
    else:
        print("  --password-from-stdin : read password from stdin")
    sys.exit(0)

if "info" in args:
    if MODE == "timeout":
        time.sleep(5)
    if MODE == "unreachable":
        sys.stderr.write("svn: E170013: Unable to connect to a repository at URL\n")
        sys.exit(1)
    if MODE == "cert":
        sys.stderr.write("svn: E230001: Server SSL certificate verification failed\n")
        sys.exit(1)
    password = None
    if "--password-from-stdin" in args:
        password = sys.stdin.readline().strip()
    if MODE == "anon":
        sys.stdout.write(INFO_XML)
        sys.exit(0)
    if password == "good":
        sys.stdout.write(INFO_XML)
        sys.exit(0)
    sys.stderr.write("svn: E170001: Authentication failed\n")
    sys.exit(1)

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
            for name in ("users", "sessions", "repo_bindings", "drafts", "revisions", "operations", "audit_events"):
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

    def test_unsupported_password_from_stdin(self):
        with mock.patch.dict("os.environ", {"FAKE_SVN_MODE": "no_stdin"}):
            client = server_svn.SvnClient(command=(sys.executable, str(self.fake)), timeout=2)
            with self.assertRaises(server_svn.SvnError) as ctx:
                client.verify_credentials("https://svn.example.invalid/auth-check/", "alice", "good")
            self.assertEqual(ctx.exception.code, "unsupported")

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
        self.assertFalse(payload["features"]["editDraft"])
        self.assertEqual(payload["site"]["repositories"][0]["id"], "hardware")

    def test_anonymous_writes_are_rejected(self):
        for path in ("/__md/save", "/__md/draft", "/__svn/commit"):
            response = self.client.post(path, json={"path": "md/a.md", "content": "x"})
            self.assertEqual(response.status_code, 401, path)

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

    def test_draft_requires_csrf_then_reports_phase_two(self):
        self.login()
        response = self.client.put("/__md/draft", json={"path": "md/a.md", "content": "x"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "csrf_failed")
        csrf = self.client.get("/__auth/session").get_json()["csrfToken"]
        response = self.client.put("/__md/draft", json={"path": "md/a.md", "content": "x"},
                                   headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 501)

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
