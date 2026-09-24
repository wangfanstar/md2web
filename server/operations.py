"""提交任务：审阅清单、私有工作副本、幂等操作、状态核对与发布。

对应设计文档第 8、10、11 节：
- prepare 冻结文件清单/内容 hash/基线/提交说明，生成 operation_id；
- commit 使用发起人的会话凭据在私有工作副本中只提交确认过的文件；
- 状态机 prepared → running → svn_committed → published，异常转 failed/uncertain（不自动重试）；
- 重复提交同一 operation_id 直接返回已有结果（幂等）。
"""

import json
import os
import calendar
from datetime import datetime
import re
import shutil
import tempfile
import time
import uuid
import hashlib
from pathlib import Path

from . import database, documents
from .drafts import unified_diff as documents_diff
from .svn import SvnError
from .content_lock import serialized

ACTIVE_STATES = ("prepared", "running")
DONE_STATES = ("svn_committed", "published")


class OperationError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def _slug(value):
    return re.sub(r"[^0-9A-Za-z._-]+", "-", str(value)).strip("-") or "repo"


def _row_dict(row):
    return dict(row) if row is not None else None


def binding_for_path(config, document_path):
    """按目录段最长前缀返回仓库配置。"""
    rel = documents.normalize_md_path(document_path)
    found = None
    for binding in config.get("repositories") or []:
        mount = binding["mount"]
        if rel == mount or rel.startswith(mount + "/"):
            if found is None or len(mount) > len(found["mount"]):
                found = binding
    return found


def _ensure_local_binding(conn, binding, config):
    """登记本地模式绑定；不调用 SVN。"""
    row = _binding_row(conn, binding)
    now = database.now_iso()
    if row is None:
        with conn:
            cursor = conn.execute(
                "INSERT INTO repo_bindings (repository_id, mount_path, credential_group, config_version,"
                " source_mode, sync_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', 'idle', ?, ?)",
                (binding["id"], binding["mount"], binding["credential_group"],
                 str(config.get("path", "")), now, now),
            )
        row = conn.execute("SELECT * FROM repo_bindings WHERE id = ?", (cursor.lastrowid,)).fetchone()
    elif row["source_mode"] != "local":
        with conn:
            conn.execute("UPDATE repo_bindings SET source_mode = 'local', sync_state = 'idle', updated_at = ? WHERE id = ?",
                         (now, row["id"]))
        row = conn.execute("SELECT * FROM repo_bindings WHERE id = ?", (row["id"],)).fetchone()
    return _row_dict(row)


def _repository_root(md_dir, mount):
    parts = mount.split("/")
    if not parts or parts[0] != "md" or len(parts) == 1:
        raise OperationError(400, "仓库目录必须是 md 下的子目录：" + mount)
    return Path(md_dir).joinpath(*parts[1:])


def _repository_files(root, mount="md"):
    """扫描本地仓库目录：键统一为 md/<相对路径>（与草稿、发布查找保持一致）。"""
    files = {}
    if not root.is_dir():
        return files
    for path in sorted(root.rglob("*.md")):
        if not path.is_file() or ".svn" in path.parts:
            continue
        rel = str(mount).rstrip("/") + "/" + path.relative_to(root).as_posix()
        try:
            text = documents.read_md_text(path)
        except (OSError, UnicodeError) as error:
            raise OperationError(400, "无法读取 Markdown：%s（%s）" % (path, error))
        files[rel] = {
            "content": documents.normalize_eol(text),
            "hash": documents.text_hash(text),
            "eol": documents.detect_eol(text),
        }
    return files


def _manifest_hash(files):
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(files[path]["hash"].encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def local_import_repository(conn, config, md_dir, binding, actor_id=None, force=False):
    """把本地仓库目录导入 SQLite，供首次初始化或管理员显式导入使用。"""
    if binding.get("source_mode", "svn") != "local":
        raise OperationError(400, "只有本地模式仓库才能导入 SQLite")
    binding_row = _ensure_local_binding(conn, binding, config)
    files = _repository_files(_repository_root(md_dir, binding["mount"]), binding["mount"])
    existing = {
        row["path"]: dict(row)
        for row in conn.execute("SELECT * FROM repository_documents WHERE binding_id = ?", (binding_row["id"],))
    }
    changed = []
    for path, item in files.items():
        old = existing.get(path)
        if old is None or old["content_hash"] != item["hash"] or old["state"] != "published":
            changed.append(path)
    deleted = sorted(set(existing) - set(files))
    if (changed or deleted) and existing and not force:
        # 外部修改必须由管理员显式确认，不能被定时任务静默吸收。
        raise OperationError(409, "本地目录与 SQLite 快照不一致，请选择导入或恢复",
                             code="local_external_change", changed=changed, deleted=deleted)
    revision = int(binding_row.get("source_revision") or 0) + 1
    now = database.now_iso()
    manifest_hash = _manifest_hash(files)
    with conn:
        # 清理历史遗留的绝对路径行（旧版本写入的）
        conn.execute("DELETE FROM repository_documents WHERE binding_id = ? AND path NOT LIKE 'md/%'",
                     (binding_row["id"],))
        for path, item in files.items():
            conn.execute(
                "INSERT OR REPLACE INTO repository_documents"
                " (id, binding_id, path, content, content_hash, eol, source_revision, state, updated_at)"
                " VALUES ((SELECT id FROM repository_documents WHERE binding_id = ? AND path = ?), ?, ?, ?, ?, ?, ?, 'published', ?)",
                (binding_row["id"], path, binding_row["id"], path, item["content"], item["hash"],
                 item["eol"], revision, now),
            )
        for path in deleted:
            conn.execute("UPDATE repository_documents SET state = 'deleted', source_revision = ?, updated_at = ?"
                         " WHERE binding_id = ? AND path = ?", (revision, now, binding_row["id"], path))
        conn.execute(
            "UPDATE repo_bindings SET source_mode = 'local', source_revision = ?, source_hash = ?,"
            " sync_state = 'idle', last_success_at = ?, last_error_code = NULL, updated_at = ? WHERE id = ?",
            (revision, manifest_hash, now, now, binding_row["id"]),
        )
        database.audit(conn, "local_import", "ok", actor_id=actor_id, resource=binding["mount"])
        conn.execute(
            "INSERT INTO source_events (binding_id, mode, event_type, target_revision, actor_id, detail, created_at)"
            " VALUES (?, 'local', 'local_import', ?, ?, ?, ?)",
            (binding_row["id"], revision, actor_id, json.dumps({"changed": changed, "deleted": deleted}, ensure_ascii=False), now),
        )
    return {"mode": "local", "revision": revision, "files": len(files), "changed": changed, "deleted": deleted,
            "hash": manifest_hash}


def _local_publish(conn, md_dir, binding, binding_row, rel, content, old_hash, user_id, operation_id):
    """把内容写入本地 SQLite 主库并物化 docs/md（调用方负责权限与基线校验）。"""
    text = documents.normalize_eol(content)
    new_hash = documents.text_hash(text)
    revision = int(binding_row.get("source_revision") or 0) + 1
    now = database.now_iso()
    try:
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO repository_documents"
                " (id, binding_id, path, content, content_hash, eol, source_revision, state, updated_at)"
                " VALUES ((SELECT id FROM repository_documents WHERE binding_id = ? AND path = ?), ?, ?, ?, ?, ?, ?, 'published', ?)",
                (binding_row["id"], rel, binding_row["id"], rel, text, new_hash,
                 documents.detect_eol(text), revision, now),
            )
            rows = conn.execute("SELECT path, content_hash, state FROM repository_documents WHERE binding_id = ?",
                                (binding_row["id"],)).fetchall()
            manifest_hash = _manifest_hash({row["path"]: {"hash": row["content_hash"]}
                                             for row in rows if row["state"] != "deleted"})
            conn.execute("UPDATE repo_bindings SET source_revision = ?, source_hash = ?, last_success_at = ?,"
                         " sync_state = 'idle', last_error_code = NULL, updated_at = ? WHERE id = ?",
                         (revision, manifest_hash, now, now, binding_row["id"]))
            conn.execute("INSERT INTO source_events (binding_id, operation_id, mode, event_type, path,"
                         " before_hash, after_hash, base_revision, target_revision, actor_id, created_at)"
                         " VALUES (?, ?, 'local', 'local_publish', ?, ?, ?, ?, ?, ?, ?)",
                         (binding_row["id"], operation_id, rel, old_hash, new_hash,
                          binding_row.get("source_revision"), revision, user_id, now))
        _materialize_repository(conn, md_dir, binding_row["id"], binding["mount"])
        _set_state(conn, operation_id, "published", finished_at=database.now_iso())
    except Exception as error:
        _set_state(conn, operation_id, "failed", error_code="local_publish_failed", finished_at=database.now_iso())
        raise OperationError(500, "本地发布失败：%s" % error)
    return {"operationId": operation_id, "state": "published", "revision": revision, "path": rel,
            "hash": new_hash, "mode": "local"}


def local_publish_draft(conn, config, md_dir, user_id, document_path, expected_version=None):
    """把当前用户草稿发布到本地 SQLite 主库，再物化 docs/md。"""
    from . import drafts as drafts_module

    rel = documents.normalize_md_path(document_path)
    binding = binding_for_path(config, rel)
    if binding is None or binding.get("source_mode", "svn") != "local":
        raise OperationError(400, "该文档未关联本地 SQLite 仓库")
    if binding.get("read_only") or binding.get("allow_commit", True) is False:
        raise OperationError(403, "该仓库已设置为只读或关闭本地发布")
    draft = drafts_module.get_draft_row(conn, user_id, rel)
    if draft is None or draft["state"] != "active" or not draft["head_revision_id"]:
        raise OperationError(409, "没有可发布的个人草稿")
    if expected_version is not None and int(expected_version) != int(draft["version"]):
        raise OperationError(409, "草稿版本已变化，请重新发布", currentVersion=draft["version"])
    revision_row = conn.execute("SELECT * FROM revisions WHERE id = ?", (draft["head_revision_id"],)).fetchone()
    if revision_row is None:
        raise OperationError(409, "草稿版本不存在，请重新保存")
    binding_row = _ensure_local_binding(conn, binding, config)
    old = conn.execute("SELECT * FROM repository_documents WHERE binding_id = ? AND path = ?",
                       (binding_row["id"], rel)).fetchone()
    old_hash = old["content_hash"] if old is not None and old["state"] != "deleted" else None
    if revision_row["before_hash"] != old_hash:
        raise OperationError(409, "本地源已变化，请先重新加载并合并", code="local_external_change")
    content = documents.normalize_eol(revision_row["content"])
    operation_id = create_operation(conn, user_id, binding_row["id"], "local_publish", {
        "path": rel, "repositoryId": binding["id"], "contentHash": documents.text_hash(content),
        "baseHash": old_hash, "message": "local publish",
    })
    return _local_publish(conn, md_dir, binding, binding_row, rel, content, old_hash, user_id, operation_id)


def local_publish_content(conn, config, md_dir, user_id, document_path, content, base_hash=None):
    """编辑器一步保存：内容直接发布到本地 SQLite 主库并物化 docs/md（无 SVN 库）。"""
    if content is None:
        raise OperationError(400, "缺少 content")
    rel = documents.normalize_md_path(document_path)
    binding = binding_for_path(config, rel)
    if binding is None or binding.get("source_mode", "svn") != "local":
        raise OperationError(400, "该文档未关联本地 SQLite 仓库")
    if binding.get("read_only") or binding.get("allow_commit", True) is False:
        raise OperationError(403, "该仓库已设置为只读或关闭本地发布")
    binding_row = _ensure_local_binding(conn, binding, config)
    old = conn.execute("SELECT * FROM repository_documents WHERE binding_id = ? AND path = ?",
                       (binding_row["id"], rel)).fetchone()
    store_hash = old["content_hash"] if old is not None and old["state"] != "deleted" else None
    file_path = documents.resolve_md_file(md_dir, rel)
    file_hash = None
    if file_path.is_file():
        file_hash = documents.text_hash(documents.read_md_text(file_path))
    # 主库与 docs/md 里已知的内容都必须与编辑器基线一致，任一处被外部改动都拒绝
    known = [value for value in (store_hash, file_hash) if value is not None]
    if any(value != base_hash for value in known) or (not known and base_hash):
        raise OperationError(409, "本地源已变化，请先重新加载并合并", code="local_external_change",
                             currentHash=file_hash or store_hash)
    text = documents.normalize_eol(content)
    old_hash = file_hash if file_hash is not None else store_hash
    operation_id = create_operation(conn, user_id, binding_row["id"], "local_publish", {
        "path": rel, "repositoryId": binding["id"], "contentHash": documents.text_hash(text),
        "baseHash": old_hash, "message": "local publish",
    })
    return _local_publish(conn, md_dir, binding, binding_row, rel, text, old_hash, user_id, operation_id)


def publish_file(conn, md_dir, user_id, document_path, content, base_hash=None):
    """未关联仓库的文档：直接原子写回 docs/md（base_hash 冲突检测）并记审计。"""
    rel = documents.normalize_md_path(document_path)
    documents.save_md(md_dir, rel, content, base_hash=base_hash)
    text = documents.normalize_eol(content)
    with conn:
        database.audit(conn, "file_publish", "ok", actor_id=user_id, resource=rel)
    return {"state": "published", "path": rel, "hash": documents.text_hash(text), "mode": "file"}


def _materialize_repository(conn, md_dir, binding_id, mount):
    """将 SQLite 主库物化为 docs/md；只删除此前已受管且标为 deleted 的文件。"""
    root = _repository_root(md_dir, mount)
    rows = conn.execute("SELECT * FROM repository_documents WHERE binding_id = ?", (binding_id,)).fetchall()
    root.mkdir(parents=True, exist_ok=True)
    for row in rows:
        target = Path(md_dir) / Path(*row["path"].split("/", 1)[1:])
        if row["state"] == "deleted":
            if target.is_file():
                target.unlink()
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", delete=False,
                                                 dir=str(target.parent), prefix="." + target.name + ".", suffix=".tmp")
        tmp_path = Path(temporary.name)
        try:
            with temporary:
                text = row["content"]
                if row["eol"] == "\r\n":
                    text = text.replace("\n", "\r\n")
                elif row["eol"] == "\r":
                    text = text.replace("\n", "\r")
                temporary.write(text)
            os.replace(tmp_path, target)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


def create_operation(conn, actor_id, binding_id, kind, manifest):
    operation_id = uuid.uuid4().hex
    with conn:
        conn.execute(
            "INSERT INTO operations (id, actor_id, binding_id, kind, state, reviewed_manifest,"
            " message, created_at) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?)",
            (operation_id, actor_id, binding_id, kind, json.dumps(manifest, ensure_ascii=False),
             manifest.get("message") or "", database.now_iso()),
        )
        database.audit(conn, "operation_prepare", "ok", actor_id=actor_id, operation_id=operation_id,
                       resource=manifest.get("path"))
    return operation_id


def get_operation(conn, operation_id, actor_id=None):
    row = conn.execute("SELECT * FROM operations WHERE id = ?", (operation_id,)).fetchone()
    if row is None:
        return None
    if actor_id is not None and row["actor_id"] != actor_id:
        return None
    return _row_dict(row)


def _set_state(conn, operation_id, state, **fields):
    assignments = ["state = ?"]
    values = [state]
    for name, value in fields.items():
        assignments.append(name + " = ?")
        values.append(value)
    values.append(operation_id)
    with conn:
        conn.execute("UPDATE operations SET " + ", ".join(assignments) + " WHERE id = ?", values)


def _binding_row(conn, binding):
    row = conn.execute("SELECT * FROM repo_bindings WHERE mount_path = ?", (binding["mount"],)).fetchone()
    if row is None:
        return None
    return _row_dict(row)


def ensure_binding(conn, binding, svn_client, config, credential=None, rebind=False):
    """读取远端仓库身份并登记/核对绑定（UUID、根 URL、目标 URL）。

    rebind=True（仅「删除重建」）时不阻止身份变化：把绑定更新为远端实际身份并重置已发布版本。
    """
    row = _binding_row(conn, binding)
    config_version = str(config.get("path", ""))
    username, password = credential or (None, None)
    config_dir = tempfile.mkdtemp(prefix="md2web-svn-bind-")
    try:
        info = svn_client.info(binding["url"], config_dir, username=username, password=password)
    except SvnError as error:
        if error.code == "auth_failed":
            raise OperationError(401, "SVN 账号或口令无效，请重新输入后再提交")
        if row is not None:
            return row
        raise OperationError(502, f"无法读取仓库信息：{error}")
    finally:
        shutil.rmtree(config_dir, ignore_errors=True)
    if row is None:
        with conn:
            cursor = conn.execute(
                "INSERT INTO repo_bindings (repository_id, mount_path, repository_uuid, root_url, target_url,"
                " credential_group, config_version, last_checked_at, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (binding["id"], binding["mount"], info.get("uuid", ""), info.get("root_url", ""),
                 info.get("url", binding["url"]), binding["credential_group"], config_version,
                 database.now_iso(), database.now_iso(), database.now_iso()),
            )
        row = _row_dict(conn.execute("SELECT * FROM repo_bindings WHERE id = ?", (cursor.lastrowid,)).fetchone())
        return row
    if row["repository_uuid"] and info.get("uuid") and row["repository_uuid"] != info["uuid"]:
        if not rebind:
            raise OperationError(
                409,
                "仓库身份与绑定不一致（UUID 变化），已停止操作；请用「删除重建」重新绑定并拉取",
                expected=row["repository_uuid"], actual=info.get("uuid"),
            )
    if row["target_url"] and info.get("url") and row["target_url"].rstrip("/") != str(info.get("url", "")).rstrip("/"):
        if not rebind:
            raise OperationError(
                409,
                "目标路径与绑定不一致，已停止操作；请管理员核对映射",
                expected=row["target_url"], actual=info.get("url"),
            )
    reset = ", published_revision = 0, sync_error = NULL" if rebind else ""
    with conn:
        conn.execute(
            "UPDATE repo_bindings SET repository_uuid = ?, root_url = ?, target_url = ?, config_version = ?"
            + reset + ", last_checked_at = ?, updated_at = ? WHERE id = ?",
            (info.get("uuid", ""), info.get("root_url", ""), info.get("url", binding["url"]),
             config_version, database.now_iso(), database.now_iso(), row["id"]),
        )
    row = _row_dict(conn.execute("SELECT * FROM repo_bindings WHERE id = ?", (row["id"],)).fetchone())
    return row


def prepare_commit(conn, user_id, config, md_dir, document_path, message, expected_version=None):
    """冻结待提交版本：只有草稿版本与基线一致时才允许准备。"""
    from . import drafts as drafts_module

    rel = documents.normalize_md_path(document_path)
    binding = None
    for repo in config.get("repositories") or []:
        mount = repo["mount"]
        if rel == mount or rel.startswith(mount + "/"):
            if binding is None or len(mount) > len(binding["mount"]):
                binding = repo
    if binding is None:
        raise OperationError(400, "该文档未关联 SVN：请先由管理员在「设置」中添加仓库映射")
    if not str(message or "").strip():
        raise OperationError(400, "请填写提交说明")
    draft_row = drafts_module.get_draft_row(conn, user_id, rel)
    if draft_row is None or draft_row["state"] != "active" or not draft_row["head_revision_id"]:
        raise OperationError(409, "没有可提交的个人草稿：请先保存草稿")
    if expected_version is not None and int(expected_version) != int(draft_row["version"]):
        raise OperationError(409, "草稿版本已变化，请重新准备提交", currentVersion=draft_row["version"])
    head = conn.execute("SELECT * FROM revisions WHERE id = ?", (draft_row["head_revision_id"],)).fetchone()
    published = drafts_module.published_text(md_dir, rel)
    if published is not None and documents.text_hash(published) == head["after_hash"]:
        raise OperationError(409, "草稿内容与已发布版本一致，无需提交")
    manifest = {
        "path": rel,
        "repositoryId": binding["id"],
        "mount": binding["mount"],
        "targetUrl": binding["url"],
        "draftRevisionId": head["id"],
        "draftVersion": draft_row["version"],
        "contentHash": head["after_hash"],
        "basePublishedHash": documents.text_hash(published) if published is not None else None,
        "message": str(message).strip()[:500],
        "images": documents.referenced_images(md_dir, rel, head["content"]),
        "attachments": documents.referenced_attachments(md_dir, rel, head["content"]),
    }
    operation_id = create_operation(conn, user_id, None, "svn_commit", manifest)
    diff = documents_diff(published or "", head["content"], rel)
    return {
        "operationId": operation_id,
        "manifest": manifest,
        "state": "prepared",
        "diff": diff,
        "published": published,
        "content": head["content"],
    }


@serialized
def run_commit(conn, svn_client, config, md_dir, workspace_root, operation_id, user_id, credential):
    """执行提交：幂等、私有工作副本、实际 diff 核对、发布到 docs/md。"""
    operation = get_operation(conn, operation_id, user_id)
    if operation is None:
        raise OperationError(404, "操作不存在或无权访问")
    if operation["state"] in DONE_STATES:
        return {"operationId": operation_id, "state": operation["state"],
                "svnRevision": operation["svn_revision"], "reused": True}
    retryable = tuple(ACTIVE_STATES) + ("needs_auth",)
    if operation["state"] not in retryable:
        raise OperationError(409, "操作状态为 " + str(operation["state"]) + "，不能继续执行")
    manifest = json.loads(operation["reviewed_manifest"] or "{}")
    rel = manifest["path"]
    binding = None
    for repo in config.get("repositories") or []:
        if repo["id"] == manifest.get("repositoryId"):
            binding = repo
    if binding is None:
        raise OperationError(409, "仓库映射已变更，请重新准备提交")

    _set_state(conn, operation_id, "running")
    username, password = credential or (None, None)
    if not username or not password:
        _set_state(conn, operation_id, "needs_auth", error_code="needs_auth")
        raise OperationError(401, "会话凭据不可用：请重新登录后再提交")

    try:
        binding_row = ensure_binding(conn, binding, svn_client, config, credential)
        mount_relative = rel[len(binding["mount"]):].lstrip("/")
        if not mount_relative:
            raise OperationError(400, "提交路径必须是挂载目录下的文档")
        work_dir = Path(workspace_root) / _slug(binding["id"]) / operation_id
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)
        work_dir.mkdir(parents=True, exist_ok=True)
        config_dir = str(work_dir / "svn-config")
        Path(config_dir).mkdir(parents=True, exist_ok=True)
        svn_client.checkout(binding["url"], work_dir / "wc", depth="empty",
                            config_dir=config_dir, username=username, password=password)
        target_file = work_dir / "wc" / Path(*mount_relative.split("/"))
        target_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            svn_client.update(target_file, depth="infinity", config_dir=config_dir,
                              username=username, password=password)
        except SvnError as error:
            if error.code not in ("not_found_remote",):
                raise
        existing = documents.read_md_text(target_file) if target_file.is_file() else ""
        eol = documents.detect_eol(existing)
        content = documents.normalize_eol(operation_content(conn, manifest))
        if eol != "\n":
            content = content.replace("\n", eol)
        target_file.parent.mkdir(parents=True, exist_ok=True)
        with open(target_file, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        diff = svn_client.diff(target_file, config_dir=config_dir, username=username, password=password)
        if not str(diff or "").strip():
            raise OperationError(409, "远端内容与草稿一致，无需提交")
        # 文档引用的 images 图片与 附件/ 文件一并存档：复制到工作副本、必要时 svn add，再与文档一起提交
        image_paths = []
        attachment_paths = []
        for name in manifest.get("images") or []:
            source = documents.resolve_md_file(md_dir, rel).parent / name
            target = target_file.parent / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_file():
                shutil.copyfile(str(source), str(target))
                image_paths.append(target)
                try:
                    svn_client.add(target, config_dir=config_dir, username=username, password=password)
                except SvnError as error:
                    if error.code not in ("conflict", "failed", "parse_error"):
                        raise
        for name in manifest.get("attachments") or []:
            source = documents.resolve_md_file(md_dir, rel).parent / name
            target = target_file.parent / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_file():
                shutil.copyfile(str(source), str(target))
                attachment_paths.append(target)
                try:
                    svn_client.add(target, config_dir=config_dir, username=username, password=password)
                except SvnError as error:
                    if error.code not in ("conflict", "failed", "parse_error"):
                        raise
        revision = svn_client.commit([target_file] + image_paths + attachment_paths, manifest["message"],
                                     config_dir=config_dir,
                                     username=username, password=password)
        if revision is None:
            raise OperationError(502, "提交未返回 revision，结果需人工核对")
        _set_state(conn, operation_id, "svn_committed", svn_revision=revision,
                   finished_at=database.now_iso(), error_code=None)
        publish_committed(conn, md_dir, rel, content, revision, binding_row["id"])
        _set_state(conn, operation_id, "published")
        shutil.rmtree(work_dir, ignore_errors=True)
        return {"operationId": operation_id, "state": "published", "svnRevision": revision,
                "path": rel, "message": manifest["message"],
                "images": [Path(str(item)).name for item in image_paths],
                "attachments": [Path(str(item)).relative_to(target_file.parent).as_posix()
                                for item in attachment_paths]}
    except OperationError:
        raise
    except SvnError as error:
        if error.code == "auth_failed":
            _set_state(conn, operation_id, "needs_auth", error_code="auth_failed")
            raise OperationError(401, "SVN 账号或口令无效，请重新输入后再提交")
        uncertain = error.code in ("timeout", "unreachable", "failed")
        _set_state(conn, operation_id, "uncertain" if uncertain else "failed",
                   error_code=error.code, finished_at=database.now_iso())
        if uncertain:
            raise OperationError(502, f"提交结果不确定（{error.code}）：请核对 SVN 日志后再决定，系统不会自动重试")
        raise OperationError(409 if error.code in ("conflict", "not_found_remote") else 502, str(error))


def operation_content(conn, manifest):
    row = conn.execute("SELECT content FROM revisions WHERE id = ?", (manifest["draftRevisionId"],)).fetchone()
    if row is None:
        raise OperationError(409, "草稿版本已被清理，请重新准备提交")
    return row["content"]


def publish_committed(conn, md_dir, rel, content, revision, binding_id):
    """把已提交内容写入 docs/md（带基线 hash 前置检查），并记录 published_revision。"""
    path = documents.resolve_md_file(md_dir, rel)
    current = documents.read_md_text(path) if path.is_file() else ""
    eol = documents.detect_eol(current)
    text = documents.normalize_eol(content)
    if eol != "\n":
        text = text.replace("\n", eol)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="", delete=False,
        dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp",
    )
    tmp_path = Path(handle.name)
    try:
        with handle:
            handle.write(text)
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    with conn:
        conn.execute(
            "UPDATE repo_bindings SET published_revision = CASE"
            " WHEN published_revision IS NULL OR published_revision < ? THEN ? ELSE published_revision END,"
            " last_checked_at = ?, sync_error = NULL, updated_at = ? WHERE id = ?",
            (revision, revision, database.now_iso(), database.now_iso(), binding_id),
        )
        database.audit(conn, "operation_publish", "ok", operation_id=None, resource=rel)
    return path


def active_draft_paths(conn):
    """存在活动草稿的文档路径集合（同步时跳过，避免覆盖正在编辑的内容）。"""
    rows = conn.execute("SELECT DISTINCT document_path FROM drafts WHERE state = 'active'").fetchall()
    return {row[0] for row in rows}


def sync_interval_of(binding, config):
    """仓库的自动同步间隔（秒）：仓库自身配置优先，其次全局 sync.interval_seconds，0 表示不自动同步。"""
    interval = binding.get("sync_interval")
    if interval is None:
        interval = (config.get("sync") or {}).get("interval_seconds", 120)
    try:
        return float(interval)
    except (TypeError, ValueError):
        return 0.0


def sync_due(row, interval_seconds, now=None):
    """判断仓库是否到期需要同步（基于 repo_bindings.last_checked_at）。"""
    if interval_seconds is None or float(interval_seconds) <= 0:
        return False
    last = (row or {}).get("last_checked_at") if row else None
    if not last:
        return True
    moment = now or time.time()
    try:
        checked = _parse_iso(str(last))
    except ValueError:
        return True
    return (moment - checked) >= float(interval_seconds)


def _parse_iso(value):
    """解析 YYYY-mm-ddTHH:MM:SSZ（保持 Python 3.6 兼容，不用 fromisoformat）。"""
    text = str(value or "").strip().replace("Z", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return calendar.timegm(time.strptime(text, fmt))
        except ValueError:
            continue
    raise ValueError("时间格式不正确: " + value)


def sync_all(conn, svn_client, config, md_dir, credential=None, now=None, logger=None,
             credential_of=None):
    """按各仓库的同步频率拉取远端更新；返回每个仓库的结果汇总。"""
    moment = now or time.time()
    results = []
    for binding in config.get("repositories") or []:
        if binding.get("source_mode", "svn") == "local":
            continue
        interval = sync_interval_of(binding, config)
        row = _binding_row(conn, binding)
        row_dict = _row_dict(row)
        if not sync_due(row_dict, interval, moment):
            continue
        per_repo = credential
        if credential_of is not None:
            try:
                found = credential_of(binding)
            except Exception:
                found = None
            if found:
                per_repo = found
        try:
            result = sync_binding(conn, svn_client, config, md_dir, binding, per_repo)
            result["binding"] = binding["mount"]
            results.append(result)
            if logger is not None and (result.get("updated") or result.get("conflicts")):
                logger("已同步 %s：r%s（%d 个文件，冲突 %d）"
                       % (binding["mount"], result.get("revision"), len(result.get("files") or []),
                          len(result.get("conflicts") or [])))
        except OperationError as error:
            results.append({"binding": binding["mount"], "error": str(error), "status": error.status})
            if logger is not None:
                logger("同步 %s 失败：%s" % (binding["mount"], error))
    return results


def remote_revision(conn, svn_client, config, binding, credential=None):
    """查询仓库当前远端版本（用于同步状态展示）。"""
    username, password = credential or (None, None)
    config_dir = tempfile.mkdtemp(prefix="md2web-svn-info-")
    try:
        info = svn_client.info(binding["url"], config_dir, username=username, password=password)
        return int(info.get("revision") or 0)
    except SvnError as error:
        raise OperationError(502, f"查询远端版本失败：{error}")
    finally:
        shutil.rmtree(config_dir, ignore_errors=True)


def remote_diff(conn, svn_client, config, md_dir, binding, document_path, credential=None):
    """返回远端最新内容与本地文件的统一差异（用于合并前的对比）。"""
    username, password = credential or (None, None)
    row = _binding_row(conn, binding)
    published = int(row["published_revision"] or 0) if row else 0
    mount = binding["mount"]
    relative = str(document_path)[len(mount):].lstrip("/")
    url = binding["url"].rstrip("/") + "/" + relative
    config_dir = tempfile.mkdtemp(prefix="md2web-svn-diff-")
    try:
        info = svn_client.info(binding["url"], config_dir, username=username, password=password)
        remote_revision = int(info.get("revision") or 0)
        remote_text = svn_client.cat(url, revision=remote_revision, config_dir=config_dir,
                                     username=username, password=password)
    except SvnError as error:
        raise OperationError(502, f"读取远端内容失败：{error}")
    finally:
        shutil.rmtree(config_dir, ignore_errors=True)
    local_path = documents.resolve_md_file(md_dir, document_path)
    local_text = documents.read_md_text(local_path) if local_path.is_file() else ""
    return {
        "diff": documents.unified_text_diff(local_text, remote_text, "本地", "远端 r%d" % remote_revision,
                                            name=document_path),
        "remoteRevision": remote_revision,
        "publishedRevision": published,
        "path": document_path,
    }


def _managed_path(md_dir, relative, expect_md=False):
    """把 md/<相对路径> 解析为受管路径；越界/非法抛 OperationError。"""
    value = str(relative or "").strip().replace("\\", "/").strip("/")
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if not parts or parts[0] != "md":
        raise OperationError(400, "仅支持 docs/md 下的路径")
    if any(part == ".." or part.startswith(".") for part in parts):
        raise OperationError(400, "路径不合法")
    root = Path(md_dir).resolve()
    target = (root.parent / Path(*parts)).resolve()
    if target != root and root not in target.parents:
        raise OperationError(400, "路径越界")
    if expect_md and target.suffix.lower() != ".md":
        raise OperationError(400, "文档必须是 .md 文件")
    return target


def _safe_name(name):
    value = str(name or "").strip().replace("\\", "/").strip("/")
    if not value or "/" in value or value in (".", "..") or value.startswith("."):
        raise OperationError(400, "名称不合法")
    for char in "\\:*?\"<>|":
        if char in value:
            raise OperationError(400, "名称不能包含 \\ : * ? \" < > | 等字符")
    return value


def list_md_folders(md_dir, repos=None):
    """列出 docs/md 下所有文件夹（含文档数与已配置的仓库信息），供仓库配置页使用。"""
    root = Path(md_dir).resolve()
    if not root.is_dir():
        return []
    folders = []
    for path in sorted(root.iterdir()):
        if not path.is_dir() or path.name.startswith(".") or path.name == "回收站":
            continue
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        mount = "md/" + relative
        documents = 0
        for child in path.iterdir():
            if child.is_file() and child.suffix.lower() == ".md" and not child.name.startswith("."):
                documents += 1
        repo = None
        for item in repos or []:
            if item.get("mount") == mount:
                repo = item
                break
        folders.append({
            "path": mount,
            "name": path.name,
            "documents": documents,
            "repo": {
                "id": repo["id"],
                "url": repo["url"],
                "group": repo.get("group") or "默认",
                "readOnly": bool(repo.get("read_only")),
                "allowCommit": bool(repo.get("allow_commit", True)),
                "syncIntervalSeconds": repo.get("sync_interval"),
            } if repo else None,
        })
    return folders


def folder_listing(md_dir, relative, recursive=False):
    """列出某个文件夹下的文档与子文件夹（公开信息：名称/大小/修改时间）。"""
    target = _managed_path(md_dir, relative)
    if not target.is_dir():
        raise OperationError(404, "文件夹不存在")
    root = Path(md_dir).resolve()
    documents = []
    folders = []
    for entry in sorted(target.iterdir(), key=lambda item: item.name):
        if entry.name.startswith(".") or entry.name == "回收站":
            continue
        if entry.is_dir():
            folders.append({"name": entry.name,
                            "path": "md/" + entry.resolve().relative_to(root).as_posix()})
        elif entry.suffix.lower() == ".md":
            stat = entry.stat()
            documents.append({
                "name": entry.name,
                "path": "md/" + entry.resolve().relative_to(root).as_posix(),
                "size": int(stat.st_size),
                "mtime": int(stat.st_mtime),
            })
    if recursive:
        for child in folders[:]:
            nested = folder_listing(md_dir, child["path"], recursive=True)
            documents.extend(nested["documents"])
    return {
        "path": "md/" + target.resolve().relative_to(root).as_posix(),
        "name": target.name,
        "documents": documents,
        "folders": folders,
        "totalBytes": sum(item["size"] for item in documents),
    }


def create_entry(md_dir, parent, kind, name):
    """在指定文件夹下新建文档或子文件夹。"""
    directory = _managed_path(md_dir, parent)
    if not directory.is_dir():
        raise OperationError(404, "文件夹不存在")
    safe = _safe_name(name)
    root = Path(md_dir).resolve()
    if kind == "folder":
        target = directory / safe
        if target.exists():
            raise OperationError(409, "同名文件夹已存在")
        target.mkdir(parents=True)
        return {"path": "md/" + target.resolve().relative_to(root).as_posix(), "kind": "folder"}
    if kind != "document":
        raise OperationError(400, "kind 只能是 document 或 folder")
    filename = safe if safe.lower().endswith(".md") else safe + ".md"
    target = directory / filename
    if target.exists():
        raise OperationError(409, "同名文档已存在")
    target.write_text("# " + Path(filename).stem + "\n\n", encoding="utf-8")
    return {"path": "md/" + target.resolve().relative_to(root).as_posix(), "kind": "document"}


def rename_entry(md_dir, relative, name):
    """重命名文档或文件夹（保持同目录）。"""
    target = _managed_path(md_dir, relative)
    if not target.exists():
        raise OperationError(404, "目标不存在")
    safe = _safe_name(name)
    if target.is_dir():
        new_name = safe
    else:
        new_name = safe if safe.lower().endswith(".md") else safe + ".md"
    new_path = target.parent / new_name
    if new_path.exists():
        raise OperationError(409, "同名目标已存在")
    target.rename(new_path)
    return {"path": "md/" + new_path.resolve().relative_to(Path(md_dir).resolve()).as_posix(),
            "oldPath": str(relative)}


def delete_entry(md_dir, relative, trash_root):
    """删除文档或文件夹：移动到 data/trash/<时间戳>/ 下（可找回）。"""
    target = _managed_path(md_dir, relative)
    if not target.exists():
        raise OperationError(404, "目标不存在")
    root = Path(md_dir).resolve()
    if target.resolve() == root:
        raise OperationError(400, "不能删除 docs/md 根目录")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    trash = Path(trash_root) / stamp / target.name
    trash.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(trash))
    return {"path": str(relative), "trash": str(trash)}


def site_backup_due(last_run, interval_seconds, now=None):
    """网站数据备份是否到期（interval 为 0 表示不自动备份）。"""
    if not interval_seconds or float(interval_seconds) <= 0:
        return False
    if not last_run:
        return True
    return (now or time.time()) - float(last_run) >= float(interval_seconds)


def backup_site(conn, svn_client, config, root, credential=None, message=None, now=None):
    """把网站数据（默认 docs/）合入到配置的 SVN 库：检出工作副本 → 复制 → svn add → 提交。"""
    settings = config.get("site_backup") or {}
    url = str(settings.get("url") or "").strip()
    if not url:
        raise OperationError(400, "未配置网站数据仓库地址（siteBackup.url）")
    username, password = credential or (None, None)
    includes = settings.get("include") or ["docs"]
    work_root = Path(config["storage"]["workspaces"]).parent / "site-wc"
    work_root.mkdir(parents=True, exist_ok=True)
    config_dir = str(work_root / "svn-config")
    Path(config_dir).mkdir(parents=True, exist_ok=True)
    try:
        if not (work_root / ".svn").exists():
            svn_client.checkout(url, work_root, depth="empty", config_dir=config_dir,
                                username=username, password=password)
        copied = []
        for item in includes:
            source = Path(root) / item
            if not source.exists():
                continue
            target = work_root / item
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink()
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            copied.append(item)
        svn_client.add(work_root, config_dir=config_dir, username=username, password=password)
        status = svn_client.status(work_root, config_dir=config_dir, username=username, password=password)
        if not str(status or "").strip():
            return {"updated": False, "revision": None, "files": copied,
                    "message": "没有需要提交的变更"}
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        text = "%s %s" % (message or settings.get("message") or "site backup", stamp)
        revision = svn_client.commit(work_root, text, config_dir=config_dir,
                                     username=username, password=password)
        return {"updated": True, "revision": revision, "files": copied}
    except SvnError as error:
        if error.code == "auth_failed":
            raise OperationError(401, "网站数据仓库认证失败，请检查同步用户名与密码")
        raise OperationError(502, "网站数据备份失败：%s" % error)


def repo_health(conn, svn_client, config, md_dir, binding, credential=None):
    """检查仓库健康：配置、本地目录、远端连通与认证、仓库身份（UUID）、本地内容。

    返回 {status, level, detail, hints, indexPage, localPath, revision, syncError}
    level: ok / warn / error
    """
    mount = binding["mount"]
    url = str(binding.get("url") or "").strip()
    sub = mount[3:] if mount.startswith("md/") else mount
    local_path = Path(md_dir) / Path(*[part for part in sub.split("/") if part])
    index_page = "index_%s.html" % _slug(binding["id"])
    row = _binding_row(conn, binding)
    sync_error = row["sync_error"] if row is not None else None
    revision = int(row["published_revision"] or 0) if row is not None else 0
    result = {
        "id": binding["id"],
        "mount": mount,
        "url": url,
        "indexPage": index_page,
        "localPath": str(local_path),
        "revision": revision,
        "syncError": sync_error,
        "status": "正常",
        "level": "ok",
        "detail": "",
        "hints": [],
    }
    if not url:
        result.update(status="未配置 SVN 地址", level="error",
                      detail="该文件夹还没有填写 SVN 地址，无法同步或提交",
                      hints=["在配置页填写 SVN 地址并保存", "保存后可点「创建并拉取」下载内容"])
        return result
    if not local_path.exists():
        result.update(status="目录不存在", level="error",
                      detail="本地目录 %s 不存在，尚未从 SVN 拉取内容" % mount,
                      hints=["点「创建并拉取」创建目录并下载 SVN 内容"])
        return result
    username, password = credential or (None, None)
    config_dir = tempfile.mkdtemp(prefix="md2web-health-")
    try:
        try:
            info_fn = getattr(svn_client, "info", None)
            if not callable(info_fn):
                result.update(status="无法检查远端", level="warn",
                              detail="当前 SVN 客户端不支持 info 查询",
                              hints=["在服务器上确认 svn 命令行可用"])
                return result
            info = info_fn(url, config_dir, username=username, password=password)
            result["revision"] = int(info.get("revision") or result["revision"])
        except SvnError as error:
            mapping = {
                "auth_failed": ("认证失败", "SVN 账号或口令无效", ["设置该仓库的同步凭据（用户名/密码）", "确认 SVN 路径是否需要认证"]),
                "unreachable": ("无法连接", "无法访问 SVN 服务器（网络或地址问题）", ["检查服务器地址与网络", "确认 VPN/防火墙"]),
                "cert_error": ("证书错误", "SVN 服务器证书校验失败", ["在服务器上信任该证书或改用 https 正确证书"]),
                "not_found_remote": ("路径不存在", "SVN 路径不存在或没有权限", ["确认仓库地址是否正确"]),
                "not_found": ("SVN 客户端不可用", "服务器上未找到 svn 命令行（未安装或不在 PATH）",
                              ["安装 Subversion 命令行工具", "或在启动 serve.py 时用 --svn-command 指定 svn 路径"]),
            }
            status, detail, hints = mapping.get(error.code, ("远端异常", str(error), ["检查 SVN 服务器状态与地址"]))
            result.update(status=status, level="error", detail=detail, hints=hints)
            return result
        except Exception as error:  # 其它异常（如客户端不可用）不阻塞检查
            result.update(status="远端异常", level="error", detail=str(error),
                          hints=["检查 SVN 客户端与服务器状态"])
            return result
    finally:
        shutil.rmtree(config_dir, ignore_errors=True)

    bound_uuid = row["repository_uuid"] if row is not None else ""
    if bound_uuid and info.get("uuid") and bound_uuid != info.get("uuid"):
        result.update(status="仓库身份变化", level="error",
                      detail="远端 SVN 库的 UUID 与本地绑定不一致（库被替换或重建过），已停止后续同步",
                      hints=["确认 SVN 地址无误；如确已换库，点「删除重建」重新绑定并拉取",
                             "如地址写错，先在配置页改正地址并保存"])
        return result
    if sync_error and sync_error not in ("conflicts",):
        result.update(status="同步异常", level="warn",
                      detail="上次同步失败：%s" % sync_error,
                      hints=["点「修复」重试同步", "若持续失败可「删除重建」"])
        return result
    if sync_error == "conflicts":
        result.update(status="存在冲突", level="warn",
                      detail="有文档正在编辑（草稿），同步时已跳过，未覆盖本地文件",
                      hints=["在编辑器中查看「远端差异」并合并后提交"])
    # 本地内容丢失检查：曾同步过（published_revision > 0）但本地已无 Markdown 文件
    if revision > 0 and not any(local_path.rglob("*.md")):
        result.update(status="本地内容缺失", level="warn",
                      detail="该仓库曾在 r%s 同步过内容，但本地目录现在没有任何 Markdown 文件" % revision,
                      hints=["点「修复」重新拉取远端内容", "远端如果没有文档，可忽略此提示"])
    if result["level"] == "ok" and not result["detail"]:
        result["detail"] = "远端可访问，本地目录存在（r%s）" % result["revision"]
    return result


def site_workcopy_path(config):
    return Path(config["storage"]["workspaces"]).parent / "site-wc"


def site_workcopy_health(svn_client, config):
    """检查网站数据备份的工作副本状态；未配置备份地址时返回 None。"""
    if not (config.get("site_backup") or {}).get("url"):
        return None
    work_root = site_workcopy_path(config)
    result = {
        "id": "site-backup",
        "mount": "site-backup",
        "url": (config.get("site_backup") or {}).get("url", ""),
        "indexPage": "",
        "localPath": str(work_root),
        "revision": 0,
        "syncError": None,
        "status": "正常",
        "level": "ok",
        "detail": "",
        "hints": [],
    }
    if not (work_root / ".svn").exists():
        result.update(status="尚未检出", level="warn",
                      detail="网站备份工作副本还不存在，首次备份时会自动检出",
                      hints=["点「立即备份」或等待定时备份"])
        return result
    status_fn = getattr(svn_client, "status", None)
    if not callable(status_fn):
        result.update(status="无法检查", level="warn",
                      detail="当前 SVN 客户端不支持状态检查", hints=[])
        return result
    try:
        status_fn(work_root, config_dir=None)
    except SvnError as error:
        if error.code == "not_found":
            result.update(status="SVN 客户端不可用", level="error",
                          detail="服务器上未找到 svn 命令行（未安装或不在 PATH）",
                          hints=["安装 Subversion 命令行工具", "或在启动 serve.py 时用 --svn-command 指定 svn 路径"])
        else:
            result.update(status="工作副本损坏", level="error",
                          detail="网站备份工作副本异常：%s" % error,
                          hints=["点「修复」执行 svn cleanup（修不好会自动移入 data/trash）",
                                 "仍失败可用「删除重建」重新检出并备份"])
    else:
        result["detail"] = "工作副本可用，可正常备份"
    return result


def _discard_site_workcopy(config, problem=None):
    """把网站备份工作副本移入 data/trash（下次备份自动重新检出）。"""
    work_root = site_workcopy_path(config)
    broken = Path(config["storage"]["database"]).parent / "trash" / (
        datetime.now().strftime("%Y%m%d-%H%M%S") + "-site-wc")
    try:
        broken.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(work_root), str(broken))
    except OSError as move_error:
        return ["移动网站备份工作副本失败：%s" % move_error]
    note = "已把网站备份工作副本移动到 %s（下次备份自动重新检出）" % broken
    if problem:
        note = "svn cleanup 未能修复（%s）；%s" % (problem, note)
    return [note]


def repair_site_workcopy(svn_client, config):
    """清理网站备份工作副本；清理后仍不可用则移入 data/trash。返回处理说明列表。"""
    if not (config.get("site_backup") or {}).get("url"):
        return ["未配置网站数据备份地址，无需修复"]
    work_root = site_workcopy_path(config)
    if not (work_root / ".svn").exists():
        return ["网站备份工作副本不存在，无需修复"]
    problem = None
    try:
        svn_client.cleanup(work_root)
        status_fn = getattr(svn_client, "status", None)
        if callable(status_fn):
            status_fn(work_root, config_dir=None)
    except SvnError as error:
        if error.code == "not_found":
            return ["未找到 svn 命令行，无法执行 cleanup；请安装 Subversion 或在启动时用 --svn-command 指定路径"]
        problem = error
    if problem is None:
        return ["网站备份工作副本已执行 svn cleanup 且状态正常"]
    return _discard_site_workcopy(config, problem)


def recreate_site_workcopy(conn, svn_client, config, root, credential=None, message=None):
    """删除重建网站备份工作副本：移入 data/trash 后立即重新检出并备份。"""
    notes = []
    if site_workcopy_path(config).exists():
        notes += _discard_site_workcopy(config)
    result = backup_site(conn, svn_client, config, root, credential, message=message)
    notes.append("已重新检出并备份（r%s，%s）" % (result.get("revision"),
                                            "、".join(result.get("files") or []) or "无变更"))
    return {"notes": notes, "result": result}


def repair_repo(conn, svn_client, config, md_dir, binding, credential=None):
    """修复：网站备份工作副本 cleanup（修不好就移入回收站）+ 强制重新拉取该仓库内容。"""
    notes = repair_site_workcopy(svn_client, config)
    result = provision_repository(conn, svn_client, config, md_dir, binding, credential, force=True)
    notes.append("已重新拉取 %s（r%s，覆盖 %d 个文件）" % (binding["mount"], result.get("revision"),
                                                    len(result.get("files") or [])))
    return {"notes": notes, "result": result}


def recreate_repo(conn, svn_client, config, md_dir, binding, credential=None):
    """删除重建：本地目录移入 data/trash，重新绑定仓库身份后强制重新拉取。"""
    mount = binding["mount"]
    sub = mount[3:] if mount.startswith("md/") else mount
    local_path = Path(md_dir) / Path(*[part for part in sub.split("/") if part])
    trash = Path(config["storage"]["database"]).parent / "trash" / (
        datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + binding["id"])
    before = _binding_row(conn, binding)
    notes = []
    if local_path.exists():
        trash.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(local_path), str(trash))
        notes.append("本地目录已移动到 %s" % trash)
    else:
        notes.append("本地目录不存在，直接重新拉取")
    result = provision_repository(conn, svn_client, config, md_dir, binding, credential,
                                  force=True, rebind=True)
    after = _binding_row(conn, binding)
    if (before is not None and after is not None
            and before["repository_uuid"] != after["repository_uuid"]):
        notes.append("仓库身份已重新绑定（UUID %s → %s）" % (before["repository_uuid"] or "无",
                                                        after["repository_uuid"] or "无"))
    notes.append("已重新拉取 %s（r%s，%d 个文件）" % (mount, result.get("revision"),
                                                len(result.get("files") or [])))
    return {"notes": notes, "result": result, "trash": str(trash)}


def provision_repository(conn, svn_client, config, md_dir, binding, credential=None, force=False,
                         rebind=False):
    """创建 docs/md 下的仓库目录（不存在时）并从 SVN 拉取内容，供配置页「创建并拉取」。

    force=True（修复/删除重建）时忽略「远端版本未变化就不拉取」的短路，强制重新导出；
    rebind=True（仅删除重建）时允许仓库 UUID/地址变化并更新绑定。
    """
    mount = binding["mount"]
    parts = mount.split("/")
    if len(parts) < 2 or parts[0] != "md":
        raise OperationError(400, "仓库目录必须是 md 下的子目录：" + mount)
    target = Path(md_dir) / Path(*parts[1:])
    created = not target.exists()
    target.mkdir(parents=True, exist_ok=True)
    ensure_binding(conn, binding, svn_client, config, credential, rebind=rebind)
    result = sync_binding(conn, svn_client, config, md_dir, binding, credential, force=force)
    return {
        "mount": mount,
        "path": str(target),
        "created": created,
        "revision": result.get("revision"),
        "files": result.get("files") or [],
        "conflicts": result.get("conflicts") or [],
    }


@serialized
def sync_binding(conn, svn_client, config, md_dir, binding, credential=None, force=False):
    """把绑定仓库的远端内容同步到 docs/md（导出快照后只覆盖受管 Markdown）。

    force=True 时即使远端版本 ≤ 已发布版本也重新导出（修复/删除重建场景）。
    """
    from .entries import pending
    if pending(conn, binding['mount']):
        raise OperationError(409, '仓库有待核对的文档操作，请先检查 SVN 日志和本地文件')
    row = _binding_row(conn, binding) or ensure_binding(conn, binding, svn_client, config, credential)
    username, password = credential or (None, None)
    config_dir = tempfile.mkdtemp(prefix="md2web-svn-sync-")
    staging = Path(tempfile.mkdtemp(prefix="md2web-svn-export-"))
    try:
        info = svn_client.info(binding["url"], config_dir, username=username, password=password)
        remote_revision = int(info.get("revision") or 0)
        published = int(row["published_revision"] or 0) if row else 0
        if remote_revision and remote_revision <= published and not force and (not row or row["sync_error"] != "conflicts"):
            # 远端版本未变时仍检查活动草稿；上次同步留下的冲突必须持续到草稿解决。
            draft_paths = active_draft_paths(conn)
            pending_conflicts = [path for path in draft_paths
                                 if path == binding["mount"] or path.startswith(binding["mount"] + "/")]
            if pending_conflicts:
                with conn:
                    conn.execute("UPDATE repo_bindings SET last_checked_at = ?, sync_error = 'conflicts' WHERE id = ?",
                                 (database.now_iso(), row["id"]))
                return {"updated": False, "revision": remote_revision, "files": [],
                        "conflicts": sorted(pending_conflicts)}
            if row:
                with conn:
                    conn.execute("UPDATE repo_bindings SET last_checked_at = ?, sync_error = NULL WHERE id = ?",
                                 (database.now_iso(), row["id"]))
            return {"updated": False, "revision": remote_revision, "files": [], "conflicts": []}
        svn_client.export(binding["url"], staging, revision=remote_revision, force=True,
                          config_dir=config_dir, username=username, password=password)
        mount_dir = Path(md_dir) / Path(*binding["mount"].split("/")[1:])
        draft_paths = active_draft_paths(conn)
        files = []
        conflicts = []
        for source in sorted(staging.rglob("*.md")):
            relative = source.relative_to(staging)
            target = mount_dir / relative
            document_path = binding["mount"] + "/" + str(relative).replace("\\", "/")
            if document_path in draft_paths:
                # 有人正在编辑（存在活动草稿）：不覆盖本地文件，提示合并
                conflicts.append(document_path)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            text = source.read_text(encoding="utf-8")
            handle = tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="", delete=False,
                dir=str(target.parent), prefix="." + target.name + ".", suffix=".tmp",
            )
            tmp_path = Path(handle.name)
            try:
                with handle:
                    handle.write(text)
                os.replace(tmp_path, target)
            finally:
                if tmp_path.exists():
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass
            files.append(str(relative).replace("\\", "/"))
        with conn:
            conn.execute(
                "UPDATE repo_bindings SET published_revision = ?, last_checked_at = ?,"
                " sync_error = ?, updated_at = ? WHERE id = ?",
                (remote_revision, database.now_iso(), "conflicts" if conflicts else None,
                 database.now_iso(), row["id"]),
            )
            database.audit(conn, "operation_sync", "ok", resource=binding["mount"])
        return {"updated": True, "revision": remote_revision, "files": files, "conflicts": conflicts}
    except SvnError as error:
        if row:
            with conn:
                conn.execute("UPDATE repo_bindings SET sync_error = ?, last_checked_at = ? WHERE id = ?",
                             (error.code, database.now_iso(), row["id"]))
        raise OperationError(502, f"同步失败（{error.code}）：保留现有站点内容")
    finally:
        shutil.rmtree(config_dir, ignore_errors=True)
        shutil.rmtree(staging, ignore_errors=True)
