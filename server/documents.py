"""受管 Markdown 的读写底层：路径校验、EOL 保持、原子写入与内容 hash。

供发布服务与后续阶段（草稿、本地发布）复用；HTTP 层不得传入 force 绕过冲突检查。
"""

import base64
import difflib
import binascii
import hashlib
import io
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

MD_MAX_BODY = 8 * 1024 * 1024
IMAGE_MAX_BYTES = 8 * 1024 * 1024
IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
IMAGE_DIR_NAME = "images"
IMAGE_STEM_MAX = 60
IMAGE_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')

ATTACHMENT_DIR_NAME = "附件"
# 反馈截图与附件：站点页面在 docs/html/ 下，资产集中存放
FEEDBACK_IMAGE_REL = "html/images"
FEEDBACK_UPLOAD_REL = "html/uploads"
ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024
ATTACHMENT_NAME_MAX = 120
ATTACHMENT_UNSAFE = re.compile(r'[\\/:*?"<>|#%\[\]{}()\x00-\x1f]+')
# 可执行/可脚本化文件会被同源静态分发，禁止作为附件上传
ATTACHMENT_BLOCKED_SUFFIXES = (
    ".html", ".htm", ".xhtml", ".svg", ".js", ".mjs", ".cjs", ".css",
    ".php", ".phtml", ".asp", ".aspx", ".jsp", ".jspx", ".cgi", ".pl", ".py",
    ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".vbs", ".vbe", ".ps1", ".psm1", ".jar", ".sh",
)


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
    suffix = Path(*parts).suffix.lower()
    if not suffix:
        # docsify 路由会去掉 .md 后缀（file-router 补丁），这里按 ext 规则补回
        parts[-1] = parts[-1] + ".md"
    elif suffix != ".md":
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


def unified_text_diff(before, after, before_label="之前", after_label="之后", name=""):
    """返回两段文本的统一差异（difflib），供同步冲突与提交结果展示。"""
    lines = difflib.unified_diff(
        normalize_eol(before or "").split("\n"),
        normalize_eol(after or "").split("\n"),
        fromfile=("%s %s" % (name, before_label)).strip(),
        tofile=("%s %s" % (name, after_label)).strip(),
        lineterm="",
    )
    return "\n".join(lines)


def referenced_images(md_dir, document_path, content):
    """解析文档中引用的 images/ 图片，返回存在的相对文件名列表（如 ["images/a.png"]）。

    支持 Markdown 图片语法与 <img src>；忽略越界路径与不存在的文件。
    """
    text = str(content or "")
    names = []
    patterns = (
        re.compile(r"!\[[^\]]*\]\(\s*<?(images/[^)\s>]+)>?[^)]*\)"),
        re.compile(r"""<img[^>]+src=["'](images/[^"']+)["']""", re.I),
    )
    for pattern in patterns:
        for match in pattern.finditer(text):
            name = match.group(1).strip()
            if name not in names:
                names.append(name)
    return _existing_document_files(md_dir, document_path, names)


def referenced_attachments(md_dir, document_path, content):
    """解析文档中引用的 附件/ 文件，返回存在的相对文件名列表（如 ["附件/手册.pdf"]）。

    支持 Markdown 链接语法与 <a href>；提交时与文档一并存档。
    """
    text = str(content or "")
    names = []
    patterns = (
        re.compile(r"\[[^\]]*\]\(\s*<?(" + re.escape(ATTACHMENT_DIR_NAME) + r"/[^)\s>]+)>?[^)]*\)"),
        re.compile(r"""<a[^>]+href=["'](""" + re.escape(ATTACHMENT_DIR_NAME) + r"""/[^"']+)["']""", re.I),
    )
    for pattern in patterns:
        for match in pattern.finditer(text):
            name = match.group(1).strip()
            if name not in names:
                names.append(name)
    return _existing_document_files(md_dir, document_path, names)


def _existing_document_files(md_dir, document_path, names):
    """过滤出文档同目录下真实存在、且未越界的相对文件。"""
    doc_path = resolve_md_file(md_dir, document_path)
    doc_dir = doc_path.parent.resolve()
    found = []
    for name in names:
        if ".." in name.split("/"):
            continue
        try:
            candidate = (doc_path.parent / name).resolve()
            if candidate.is_file() and doc_dir in candidate.parents:
                found.append(name)
        except OSError:
            continue
    return found


def scan_md_tree(md_dir):
    """扫描 docs/md 下的 Markdown：返回 {"md/<相对路径>": {"size": int, "mtime": int}}。"""
    root = Path(md_dir)
    entries = {}
    if not root.is_dir():
        return entries
    for path in sorted(root.rglob("*.md")):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        entries["md/" + path.relative_to(root).as_posix()] = {
            "size": int(stat.st_size),
            "mtime": int(stat.st_mtime),
        }
    return entries


def image_stem(text):
    """把文档名整理成安全的文件名前缀（保留中文，非法字符换成 -）。"""
    value = IMAGE_UNSAFE.sub("-", str(text or "")).strip(" .-")
    value = re.sub(r"-{2,}", "-", value)
    if len(value) > IMAGE_STEM_MAX:
        value = value[:IMAGE_STEM_MAX].rstrip(" .-")
    return value or "document"


def image_extension(mime_type):
    """返回受支持的图片扩展名；不支持时抛 MdSaveError(415)。"""
    extension = IMAGE_TYPES.get(str(mime_type or "").strip().lower())
    if not extension:
        raise MdSaveError(415, "仅支持 PNG/JPEG/GIF/WebP 图片（不支持 SVG 等格式）")
    return extension


def decode_image_data(data):
    """严格解码 base64 图片数据；空内容抛 400，超限抛 413。"""
    value = str(data or "").strip()
    if not value:
        raise MdSaveError(400, "缺少图片数据 data（base64）")
    if value.startswith("data:") and "," in value:
        value = value.split(",", 1)[1]
    try:
        blob = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise MdSaveError(400, "图片数据不是合法的 base64")
    if not blob:
        raise MdSaveError(400, "图片内容为空")
    if len(blob) > IMAGE_MAX_BYTES:
        raise MdSaveError(413, "图片过大（上限 %d MB）" % (IMAGE_MAX_BYTES // (1024 * 1024)))
    return blob


def document_folder(md_dir, raw):
    """返回 (文档路径, 文档所在目录)：附件等资源与文档同级存放。"""
    path = resolve_md_file(md_dir, raw)
    if not path.is_file():
        raise MdSaveError(404, "源文件不存在：" + normalize_md_path(raw))
    return path, path.parent


def document_image_dir(md_dir, raw):
    """返回 (文档路径, 图片目录)：图片目录为文档同级的 images/。"""
    path, folder = document_folder(md_dir, raw)
    return path, folder / IMAGE_DIR_NAME


def next_image_sequence(directory, stem):
    """扫描同目录图片，返回该文档可用的下一个序号（命名形如 文档名-20260917-113045-1.png）。"""
    pattern = re.compile(r"^" + re.escape(stem) + r"-\d{8}-\d{6}-(\d+)\.")
    highest = 0
    if directory.is_dir():
        for entry in sorted(directory.iterdir()):
            if not entry.is_file():
                continue
            match = pattern.match(entry.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return highest + 1


def _write_blob(directory, name, blob):
    """把二进制内容原子写入目录（唯一临时文件 + 替换），返回目标路径。"""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    handle = tempfile.NamedTemporaryFile(
        mode="wb", delete=False, dir=str(directory), prefix="." + name + ".", suffix=".tmp",
    )
    tmp_path = Path(handle.name)
    try:
        with handle:
            handle.write(blob)
        os.replace(tmp_path, target)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return target


def save_feedback_image(docs_dir, mime_type, data, now=None):
    """反馈截图/图片：写入 docs/html/images/，命名 fb-<时间戳>-<序号>.<扩展名>。"""
    extension = image_extension(mime_type)
    blob = decode_image_data(data)
    directory = Path(docs_dir) / FEEDBACK_IMAGE_REL
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    sequence = next_image_sequence(directory, "fb")
    name = "fb-%s-%d%s" % (stamp, sequence, extension)
    _write_blob(directory, name, blob)
    return {"path": FEEDBACK_IMAGE_REL + "/" + name, "name": name, "bytes": len(blob)}


def save_feedback_attachment(docs_dir, name, data):
    """反馈附件：写入 docs/html/uploads/，沿用原文件名（重名自动加序号）。"""
    blob = decode_attachment_data(data)
    filename = attachment_filename(name)
    directory = Path(docs_dir) / FEEDBACK_UPLOAD_REL
    final_name = next_attachment_name(directory, filename)
    _write_blob(directory, final_name, blob)
    return {"path": FEEDBACK_UPLOAD_REL + "/" + final_name, "name": final_name, "bytes": len(blob)}


def save_document_image(md_dir, raw, mime_type, data, now=None):
    """把粘贴的图片写入文档同级 images/，返回相对路径（供 Markdown 引用）。

    命名规则：<文档名>-<时间戳>-<序号>.<扩展名>，例如 时钟树设计-20260917-113045-1.png
    """
    extension = image_extension(mime_type)
    blob = decode_image_data(data)
    path, directory = document_image_dir(md_dir, raw)
    stem = image_stem(path.stem)
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise MdSaveError(400, "无法创建图片目录：%s" % error)
    sequence = next_image_sequence(directory, stem)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    name = "%s-%s-%d%s" % (stem, stamp, sequence, extension)
    target = directory / name
    handle = tempfile.NamedTemporaryFile(
        mode="wb", delete=False, dir=str(directory), prefix="." + name + ".", suffix=".tmp",
    )
    tmp_path = Path(handle.name)
    try:
        with handle:
            handle.write(blob)
        os.replace(tmp_path, target)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    relative = IMAGE_DIR_NAME + "/" + name
    return {
        "path": relative,
        "name": name,
        "sequence": sequence,
        "bytes": len(blob),
        "document": normalize_md_path(raw),
    }


def attachment_filename(raw):
    """整理附件文件名：保留原文件名（含中文），去掉路径与链接敏感字符。"""
    value = str(raw or "").strip().replace("\\", "/")
    value = value.rsplit("/", 1)[-1]
    value = ATTACHMENT_UNSAFE.sub("-", value)
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    value = re.sub(r"-+\.", ".", value).strip(" .-")
    if len(value) > ATTACHMENT_NAME_MAX:
        stem, dot, extension = value.rpartition(".")
        if dot and 0 < len(extension) <= 12:
            value = stem[:ATTACHMENT_NAME_MAX - len(extension) - 1].rstrip(" .-") + "." + extension
        else:
            value = value[:ATTACHMENT_NAME_MAX].rstrip(" .-")
    if not value:
        raise MdSaveError(400, "缺少附件文件名 name")
    if Path(value).suffix.lower() in ATTACHMENT_BLOCKED_SUFFIXES:
        raise MdSaveError(415, "出于安全考虑，不支持上传该类型的附件（可执行/脚本/网页文件）")
    return value


def next_attachment_name(directory, name):
    """同名附件自动追加 -2、-3 序号，避免覆盖已有文件。"""
    if not (directory / name).exists():
        return name
    stem = Path(name).stem
    suffix = Path(name).suffix
    index = 2
    while True:
        candidate = "%s-%d%s" % (stem, index, suffix)
        if not (directory / candidate).exists():
            return candidate
        index += 1


def decode_attachment_data(data):
    """严格解码 base64 附件数据；空内容抛 400，超限抛 413。"""
    value = str(data or "").strip()
    if not value:
        raise MdSaveError(400, "缺少附件数据 data（base64）")
    if value.startswith("data:") and "," in value:
        value = value.split(",", 1)[1]
    try:
        blob = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise MdSaveError(400, "附件数据不是合法的 base64")
    if not blob:
        raise MdSaveError(400, "附件内容为空")
    if len(blob) > ATTACHMENT_MAX_BYTES:
        raise MdSaveError(413, "附件过大（上限 %d MB）" % (ATTACHMENT_MAX_BYTES // (1024 * 1024)))
    return blob


def save_document_attachment(md_dir, raw, name, data, now=None):
    """把附件写入文档同级 附件/，返回相对路径（供 Markdown 链接引用）。

    命名规则：沿用原文件名（清理链接敏感字符），同名自动追加 -2、-3 序号。
    """
    blob = decode_attachment_data(data)
    filename = attachment_filename(name)
    path, folder = document_folder(md_dir, raw)
    directory = folder / ATTACHMENT_DIR_NAME
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise MdSaveError(400, "无法创建附件目录：%s" % error)
    final_name = next_attachment_name(directory, filename)
    target = directory / final_name
    handle = tempfile.NamedTemporaryFile(
        mode="wb", delete=False, dir=str(directory), prefix="." + final_name + ".", suffix=".tmp",
    )
    tmp_path = Path(handle.name)
    try:
        with handle:
            handle.write(blob)
        os.replace(tmp_path, target)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return {
        "path": ATTACHMENT_DIR_NAME + "/" + final_name,
        "name": final_name,
        "bytes": len(blob),
        "document": normalize_md_path(raw),
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
