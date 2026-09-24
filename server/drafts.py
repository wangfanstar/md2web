"""个人草稿与版本历史：乐观并发、不可变全文版本与统一差异。

设计要点（specs/2026-09-15-svn-auth-editing-design.md 第 8、9 节）：
- 每个用户对每篇文档只有一份当前草稿，用 version 做乐观并发控制。
- 每次保存写入不可变 revision（全文 + 前后 hash + 差异），可恢复、可比对。
- 草稿只属于当前登录取的用户；版本不符返回 409，绝不静默覆盖。
"""

import difflib

from . import database, documents

MAX_CONTENT = 2 * 1024 * 1024
HISTORY_LIMIT = 200


class DraftError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def _as_dict(row):
    return dict(row) if row is not None else None


def get_draft_row(conn, user_id, document_path):
    return conn.execute(
        "SELECT * FROM drafts WHERE user_id = ? AND document_path = ?",
        (user_id, document_path),
    ).fetchone()


def get_revision(conn, user_id, revision_id):
    row = conn.execute(
        "SELECT r.* FROM revisions r JOIN drafts d ON d.id = r.draft_id"
        " WHERE r.id = ? AND d.user_id = ?",
        (revision_id, user_id),
    ).fetchone()
    return _as_dict(row)


def published_text(md_dir, document_path):
    path = documents.resolve_md_file(md_dir, document_path)
    if not path.is_file():
        return None
    return documents.read_md_text(path)


def document_state(conn, user_id, md_dir, document_path, binding=None):
    """返回已发布内容与当前用户草稿（设计：打开编辑器时的编辑基线）。"""
    rel = documents.normalize_md_path(document_path)
    published = published_text(md_dir, rel)
    draft_row = get_draft_row(conn, user_id, rel)
    draft = None
    if draft_row is not None and draft_row["state"] == "active" and draft_row["head_revision_id"]:
        head = conn.execute(
            "SELECT * FROM revisions WHERE id = ?", (draft_row["head_revision_id"],)
        ).fetchone()
        if head is not None:
            draft = {
                "version": draft_row["version"],
                "content": head["content"],
                "hash": head["after_hash"],
                "revisionId": head["id"],
                "updatedAt": draft_row["updated_at"],
            }
    return {
        "path": rel,
        "exists": published is not None,
        "published": {
            "hash": documents.text_hash(published) if published is not None else None,
            "text": published,
        },
        "draft": draft,
        "binding": binding,
    }


def save_draft(conn, user_id, md_dir, document_path, content, expected_version=None, binding_id=None):
    """保存个人草稿：版本校验 + 不可变版本 + 审计，单事务完成。"""
    rel = documents.normalize_md_path(document_path)
    if content is None:
        raise DraftError(400, "缺少 content")
    if len(content) > MAX_CONTENT:
        raise DraftError(413, "内容超过 2 MB 限制")
    path = documents.resolve_md_file(md_dir, rel)
    base_text = documents.read_md_text(path) if path.is_file() else ""
    base_hash = documents.text_hash(base_text) if path.is_file() else None
    text = documents.normalize_eol(content)
    with conn:
        row = get_draft_row(conn, user_id, rel)
        if row is None:
            cursor = conn.execute(
                "INSERT INTO drafts (user_id, document_path, binding_id, version, state, created_at, updated_at)"
                " VALUES (?, ?, ?, 0, 'active', ?, ?)",
                (user_id, rel, binding_id, database.now_iso(), database.now_iso()),
            )
            draft_id = cursor.lastrowid
            version = 0
            parent_id = None
            base_revision_id = None
        else:
            draft_id = row["id"]
            if row["state"] != "active":
                # 已放弃/丢弃的草稿：重新开始一份新草稿（历史版本保留）
                conn.execute(
                    "UPDATE drafts SET state = 'active', version = 0, head_revision_id = NULL,"
                    " base_revision_id = NULL, updated_at = ? WHERE id = ?",
                    (database.now_iso(), draft_id),
                )
                version = 0
                parent_id = None
                base_revision_id = None
            else:
                version = int(row["version"])
                parent_id = row["head_revision_id"]
                base_revision_id = row["base_revision_id"]
        if expected_version is not None and int(expected_version) != version:
            current = conn.execute(
                "SELECT * FROM revisions WHERE id = ?", (parent_id,)
            ).fetchone() if parent_id else None
            raise DraftError(
                409,
                "草稿已被其他标签页或本人更新（当前版本 " + str(version) + "）",
                currentVersion=version,
                currentContent=current["content"] if current is not None else None,
                currentHash=current["after_hash"] if current is not None else None,
            )
        before_text = None
        if parent_id:
            parent = conn.execute("SELECT content FROM revisions WHERE id = ?", (parent_id,)).fetchone()
            before_text = parent["content"] if parent is not None else None
        if before_text is None:
            before_text = base_text
        diff = unified_diff(before_text, text, rel)
        eol = documents.detect_eol(base_text)
        cursor = conn.execute(
            "INSERT INTO revisions (draft_id, actor_id, parent_id, base_svn_revision, before_hash,"
            " after_hash, content, eol, unified_diff, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
            (
                draft_id,
                user_id,
                parent_id,
                documents.text_hash(before_text),
                documents.text_hash(text),
                text,
                eol,
                diff,
                database.now_iso(),
            ),
        )
        revision_id = cursor.lastrowid
        conn.execute(
            "UPDATE drafts SET version = ?, head_revision_id = ?, base_revision_id = COALESCE(base_revision_id, ?),"
            " updated_at = ?, state = 'active' WHERE id = ?",
            (version + 1, revision_id, revision_id, database.now_iso(), draft_id),
        )
        database.audit(conn, "draft_save", "ok", actor_id=user_id, resource=rel)
    return {
        "path": rel,
        "version": version + 1,
        "revisionId": revision_id,
        "hash": documents.text_hash(text),
        "baseHash": base_hash,
        "bytes": len(text.encode("utf-8")),
    }


def unified_diff(before, after, name):
    lines = difflib.unified_diff(
        str(before or "").split("\n"),
        str(after or "").split("\n"),
        fromfile=name + " (之前)",
        tofile=name + " (之后)",
        lineterm="",
    )
    return "\n".join(lines)


def diff_documents(conn, user_id, md_dir, document_path, from_ref, to_ref):
    """比较任意两个版本：published / draft / <revisionId>。"""
    rel = documents.normalize_md_path(document_path)

    def resolve(ref):
        ref = str(ref or "").strip()
        if ref in ("published", "", "base"):
            text = published_text(md_dir, rel)
            if text is None:
                raise DraftError(404, "已发布文档不存在")
            return "已发布版本", text
        if ref == "draft":
            row = get_draft_row(conn, user_id, rel)
            if row is None or not row["head_revision_id"]:
                raise DraftError(404, "没有个人草稿")
            head = conn.execute("SELECT * FROM revisions WHERE id = ?", (row["head_revision_id"],)).fetchone()
            return "草稿 v" + str(row["version"]), head["content"]
        revision = get_revision(conn, user_id, int(ref))
        if revision is None:
            raise DraftError(404, "版本不存在或无权访问")
        return "版本 #" + str(revision["id"]), revision["content"]

    from_label, from_text = resolve(from_ref)
    to_label, to_text = resolve(to_ref)
    return {
        "path": rel,
        "from": {"ref": str(from_ref), "label": from_label, "hash": documents.text_hash(from_text)},
        "to": {"ref": str(to_ref), "label": to_label, "hash": documents.text_hash(to_text)},
        "diff": unified_diff(from_text, to_text, rel),
        "identical": documents.text_hash(from_text) == documents.text_hash(to_text),
    }


def list_history(conn, user_id, md_dir, document_path, limit=HISTORY_LIMIT):
    rel = documents.normalize_md_path(document_path)
    rows = conn.execute(
        "SELECT r.id, r.after_hash, r.before_hash, r.created_at, LENGTH(r.content) AS size, r.base_svn_revision,"
        " d.version, d.updated_at"
        " FROM revisions r JOIN drafts d ON d.id = r.draft_id"
        " WHERE d.user_id = ? AND d.document_path = ? ORDER BY r.id DESC LIMIT ?",
        (user_id, rel, int(limit)),
    ).fetchall()
    published = published_text(md_dir, rel)
    return {
        "path": rel,
        "publishedHash": documents.text_hash(published) if published is not None else None,
        "revisions": [
            {
                "id": row["id"],
                "hash": row["after_hash"],
                "beforeHash": row["before_hash"],
                "createdAt": row["created_at"],
                "size": row["size"],
                "baseRevision": row["base_svn_revision"],
                "draftVersion": row["version"],
                "updatedAt": row["updated_at"],
                "isHead": index == 0,
            }
            for index, row in enumerate(rows)
        ],
    }


def discard_draft(conn, user_id, document_path):
    """丢弃当前草稿（保留历史版本记录，供审计）。"""
    rel = documents.normalize_md_path(document_path)
    with conn:
        row = get_draft_row(conn, user_id, rel)
        if row is None:
            raise DraftError(404, "没有个人草稿")
        conn.execute(
            "UPDATE drafts SET state = 'discarded', updated_at = ? WHERE id = ?",
            (database.now_iso(), row["id"]),
        )
        database.audit(conn, "draft_discard", "ok", actor_id=user_id, resource=rel)
    return {"path": rel, "discarded": True}


def list_active_drafts(conn, user_id):
    """当前用户未提交的本地暂存（活动草稿），用于离开页面时的提醒。"""
    rows = conn.execute(
        "SELECT document_path, version, updated_at FROM drafts"
        " WHERE user_id = ? AND state = 'active' AND head_revision_id IS NOT NULL"
        " ORDER BY updated_at DESC",
        (user_id,),
    ).fetchall()
    return {"drafts": [
        {"path": row["document_path"], "version": row["version"], "updatedAt": row["updated_at"]}
        for row in rows
    ]}
