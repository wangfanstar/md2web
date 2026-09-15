"""受管 Markdown 的读写底层：路径校验、EOL 保持、原子写入与内容 hash。

供发布服务与后续阶段（草稿、本地发布）复用；HTTP 层不得传入 force 绕过冲突检查。
"""

import hashlib
import io
import os
import tempfile
from pathlib import Path

MD_MAX_BODY = 8 * 1024 * 1024


class MdSaveError(Exception):
    """源文档读写失败：status 为建议的 HTTP 状态码。"""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def normalize_md_path(raw):
    """规范化 md/<相对路径>.md；非法路径抛 MdSaveError(400)。"""
    value = str(raw or "").strip().replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    value = value.lstrip("/")
    if not value:
        raise MdSaveError(400, "缺少 path 参数")
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if not parts or parts[0] != "md":
        raise MdSaveError(400, "仅允许编辑 docs/md 下的 Markdown 源文档")
    if any(part == ".." for part in parts):
        raise MdSaveError(400, "path 不能包含 ..")
    if any(part.startswith(".") for part in parts):
        raise MdSaveError(400, "path 不能包含隐藏目录")
    if Path(*parts).suffix.lower() != ".md":
        raise MdSaveError(400, "仅支持 .md 文件")
    return "/".join(parts)


def resolve_md_file(md_dir, raw):
    rel = normalize_md_path(raw)
    root = Path(md_dir).resolve()
    candidate = (root / rel.split("/", 1)[1]).resolve()
    if candidate != root and root not in candidate.parents:
        raise MdSaveError(400, "path 越界，超出 docs/md 目录")
    return candidate


def normalize_eol(text):
    return str(text).replace("\r\n", "\n").replace("\r", "\n")


def text_hash(text):
    return hashlib.sha256(normalize_eol(text).encode("utf-8")).hexdigest()


def detect_eol(text, default="\n"):
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    if crlf and crlf >= lf:
        return "\r\n"
    if lf:
        return "\n"
    return default


def read_md_text(path):
    with io.open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def read_md_meta(md_dir, raw):
    path = resolve_md_file(md_dir, raw)
    if not path.is_file():
        return {"path": normalize_md_path(raw), "exists": False, "mtime": None, "hash": None}
    text = read_md_text(path)
    return {
        "path": normalize_md_path(raw),
        "exists": True,
        "mtime": int(path.stat().st_mtime),
        "hash": text_hash(text),
    }


def save_md(md_dir, raw, content, base_hash=None, force=False):
    """写回源文档：EOL 与现有文件一致、唯一临时文件 + 原子替换、冲突检测。

    仅服务端内部调用可以传 force=True；HTTP 请求不得透传该参数。
    """
    path = resolve_md_file(md_dir, raw)
    rel = normalize_md_path(raw)
    if not path.is_file():
        raise MdSaveError(404, "源文件不存在：" + rel)
    if content is None:
        raise MdSaveError(400, "缺少 content")
    existing = read_md_text(path)
    current_hash = text_hash(existing)
    if not force and base_hash != current_hash:
        raise MdSaveError(
            409,
            "文件已被外部修改，请重新加载后再保存",
            currentHash=current_hash,
            current=existing,
        )
    eol = detect_eol(existing)
    text = normalize_eol(content)
    if eol != "\n":
        text = text.replace("\n", eol)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="",
        delete=False,
        dir=str(path.parent),
        prefix="." + path.name + ".",
        suffix=".tmp",
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
    return {
        "path": rel,
        "hash": text_hash(content),
        "mtime": int(path.stat().st_mtime),
        "bytes": path.stat().st_size,
    }
