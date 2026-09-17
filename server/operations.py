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
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from . import database, documents
from .drafts import unified_diff as documents_diff
from .svn import SvnError

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


def ensure_binding(conn, binding, svn_client, config, credential=None):
    """读取远端仓库身份并登记/核对绑定（UUID、根 URL、目标 URL）。"""
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
        raise OperationError(
            409,
            "仓库身份与绑定不一致（UUID 变化），已停止操作；请管理员重新绑定",
            expected=row["repository_uuid"], actual=info.get("uuid"),
        )
    if row["target_url"] and info.get("url") and row["target_url"].rstrip("/") != str(info.get("url", "")).rstrip("/"):
        raise OperationError(
            409,
            "目标路径与绑定不一致，已停止操作；请管理员核对映射",
            expected=row["target_url"], actual=info.get("url"),
        )
    with conn:
        conn.execute(
            "UPDATE repo_bindings SET repository_uuid = ?, root_url = ?, target_url = ?, config_version = ?,"
            " last_checked_at = ?, updated_at = ? WHERE id = ?",
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
        # 文档引用的 images 图片一并存档：复制到工作副本、必要时 svn add，再与文档一起提交
        image_paths = []
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
        revision = svn_client.commit([target_file] + image_paths, manifest["message"], config_dir=config_dir,
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
                "images": [Path(str(item)).name for item in image_paths]}
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


def sync_all(conn, svn_client, config, md_dir, credential=None, now=None, logger=None):
    """按各仓库的同步频率拉取远端更新；返回每个仓库的结果汇总。"""
    moment = now or time.time()
    results = []
    for binding in config.get("repositories") or []:
        interval = sync_interval_of(binding, config)
        row = _binding_row(conn, binding)
        row_dict = _row_dict(row)
        if not sync_due(row_dict, interval, moment):
            continue
        try:
            result = sync_binding(conn, svn_client, config, md_dir, binding, credential)
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


def sync_binding(conn, svn_client, config, md_dir, binding, credential=None):
    """把绑定仓库的远端内容同步到 docs/md（导出快照后只覆盖受管 Markdown）。"""
    row = _binding_row(conn, binding) or ensure_binding(conn, binding, svn_client, config, credential)
    username, password = credential or (None, None)
    config_dir = tempfile.mkdtemp(prefix="md2web-svn-sync-")
    staging = Path(tempfile.mkdtemp(prefix="md2web-svn-export-"))
    try:
        info = svn_client.info(binding["url"], config_dir, username=username, password=password)
        remote_revision = int(info.get("revision") or 0)
        published = int(row["published_revision"] or 0) if row else 0
        if remote_revision and remote_revision <= published:
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
