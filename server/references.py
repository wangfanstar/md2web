"""参考文献目录的安全文件操作（PDF、Word、Excel、PPT）。"""
import hashlib
import json
import re
import shutil
import time
import zipfile
from pathlib import Path

KINDS = {"pdf": (".pdf",), "word": (".doc", ".docx"), "excel": (".xls", ".xlsx"), "ppt": (".ppt", ".pptx")}
OFFICE_META_TAGS = {"word": "Pages", "excel": "Worksheets", "ppt": "Slides"}


class ReferenceError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def root_for(docs_dir, kind):
    if kind not in KINDS:
        raise ReferenceError(400, "资料类型不支持")
    root = (Path(docs_dir) / kind).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def safe_path(docs_dir, kind, rel=""):
    root = root_for(docs_dir, kind)
    rel = str(rel or "").replace("\\", "/").strip("/")
    path = (root / rel).resolve()
    if path != root and root not in path.parents:
        raise ReferenceError(400, "路径越界")
    return root, path, rel


def check_name(name):
    name = str(name or "").strip()
    if not name or name in (".", "..") or any(c in name for c in "\\/:*?\"<>|"):
        raise ReferenceError(400, "名称不合法")
    return name


def file_metadata(path, kind):
    """读取可可靠获得的页数/工作表数/幻灯片数；旧二进制格式返回未知。"""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        try:
            data = path.read_bytes()
            return len(re.findall(rb"/Type\s*/Page(?:\s|/|>)", data)), "页"
        except OSError:
            return None, "页"
    if suffix not in (".docx", ".xlsx", ".pptx"):
        return None, {"word": "页", "excel": "工作表", "ppt": "幻灯片"}.get(kind, "页")
    tag = OFFICE_META_TAGS[kind]
    try:
        with zipfile.ZipFile(str(path)) as archive:
            text = archive.read("docProps/app.xml").decode("utf-8", "ignore")
        match = re.search(r"<(?:[A-Za-z0-9_.-]+:)?%s>\s*(\d+)\s*</" % tag, text)
        return (int(match.group(1)) if match else None), {"word": "页", "excel": "工作表", "ppt": "幻灯片"}[kind]
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return None, {"word": "页", "excel": "工作表", "ppt": "幻灯片"}[kind]


def item_info(path, root, kind, item_kind="file"):
    stat = path.stat()
    pages, page_unit = file_metadata(path, kind) if item_kind == "file" else (None, "")
    return {"name": path.name, "path": path.relative_to(root).as_posix(), "kind": item_kind,
            "size": stat.st_size, "mtime": int(stat.st_mtime), "ext": path.suffix.lower(),
            "pages": pages, "pageUnit": page_unit}


def tree(docs_dir, kind):
    root = root_for(docs_dir, kind)
    result = []
    for path in sorted(root.rglob("*"), key=lambda p: str(p).lower()):
        if path.is_dir() and path.name != "回收站":
            result.append(path.relative_to(root).as_posix())
    return result


def listing(docs_dir, kind, rel=""):
    root, folder, rel = safe_path(docs_dir, kind, rel)
    if not folder.exists():
        raise ReferenceError(404, "文件夹不存在")
    rows = []
    for path in sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if path.name == "回收站" or path.name.startswith("."):
            continue
        rows.append(item_info(path, root, kind, "folder" if path.is_dir() else "file"))
    return {"kind": kind, "path": rel, "items": rows}


def search(docs_dir, query, kind="all"):
    """按文件名搜索参考文献，支持全部资料类型或指定类型。"""
    text = str(query or "").strip().casefold()
    if not text:
        return []
    kinds = tuple(KINDS.keys()) if kind in ("", "all", None) else (kind,)
    results = []
    for current_kind in kinds:
        root = root_for(docs_dir, current_kind)
        for path in root.rglob("*"):
            if not path.is_file() or path.name.startswith(".") or "回收站" in path.parts:
                continue
            if text not in path.name.casefold():
                continue
            item = item_info(path, root, current_kind)
            item["kind"] = current_kind
            results.append(item)
    kind_order = {name: index for index, name in enumerate(KINDS.keys())}
    return sorted(results, key=lambda item: (kind_order.get(item["kind"], 99), item["name"].casefold(), item["path"].casefold()))


def mkdir(docs_dir, kind, parent, name):
    root, folder, _ = safe_path(docs_dir, kind, parent)
    target = folder / check_name(name)
    if target.exists():
        raise ReferenceError(409, "目标已存在")
    target.mkdir(parents=False)
    return target.relative_to(root).as_posix()


def rename(docs_dir, kind, rel, name):
    root, source, _ = safe_path(docs_dir, kind, rel)
    if not source.exists():
        raise ReferenceError(404, "文件不存在")
    target = source.parent / check_name(name)
    if target.exists():
        raise ReferenceError(409, "目标已存在")
    source.rename(target)
    return target.relative_to(root).as_posix()


def move(docs_dir, kind, rel, parent):
    root, source, _ = safe_path(docs_dir, kind, rel)
    _, folder, _ = safe_path(docs_dir, kind, parent)
    if not source.exists() or not folder.is_dir():
        raise ReferenceError(404, "来源或目标文件夹不存在")
    if source.is_dir() and (folder == source or source in folder.parents):
        raise ReferenceError(400, "不能移动到自身或子文件夹")
    target = folder / source.name
    if target.exists():
        raise ReferenceError(409, "目标已存在")
    source.rename(target)
    return target.relative_to(root).as_posix()


def trash_root(docs_dir, kind):
    path = Path(docs_dir) / "reference-trash" / kind
    path.mkdir(parents=True, exist_ok=True)
    return path


def delete(docs_dir, kind, rel):
    root, source, _ = safe_path(docs_dir, kind, rel)
    if not source.exists():
        raise ReferenceError(404, "文件不存在")
    entry = hashlib.sha1((str(source) + str(time.time())).encode("utf-8")).hexdigest()[:20]
    dest = trash_root(docs_dir, kind) / entry
    dest.mkdir(parents=True)
    shutil.move(str(source), str(dest / source.name))
    (dest / "meta.json").write_text(json.dumps({"id": entry, "path": rel,
        "name": source.name, "kind": "folder" if source.is_dir() else "file",
        "deletedAt": int(time.time())}, ensure_ascii=False), encoding="utf-8")
    return {"id": entry, "path": rel}


def trash_listing(docs_dir, kind):
    root = trash_root(docs_dir, kind); result = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        meta = entry / "meta.json"
        if meta.is_file():
            try: result.append(json.loads(meta.read_text(encoding="utf-8")))
            except (ValueError, OSError): pass
    return result


def restore(docs_dir, kind, entry_id):
    root = trash_root(docs_dir, kind); entry = root / str(entry_id); meta = entry / "meta.json"
    if not meta.is_file(): raise ReferenceError(404, "回收站条目不存在")
    data = json.loads(meta.read_text(encoding="utf-8")); _, target, _ = safe_path(docs_dir, kind, data["path"])
    if target.exists(): raise ReferenceError(409, "原位置已存在文件")
    target.parent.mkdir(parents=True, exist_ok=True); payload = next(p for p in entry.iterdir() if p.name != "meta.json")
    shutil.move(str(payload), str(target)); shutil.rmtree(str(entry)); return data["path"]


def purge(docs_dir, kind, entry_id=None):
    root = trash_root(docs_dir, kind); entries = [root / str(entry_id)] if entry_id else list(root.iterdir()); count = 0
    for entry in entries:
        if entry.is_dir(): shutil.rmtree(str(entry)); count += 1
    return count
