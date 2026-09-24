"""按仓库保存可恢复的文档删除记录。"""
import json
import shutil
import time
import uuid
from pathlib import Path

from . import documents, operations

NAME = "回收站"
META = "meta.json"


def root_for(md_dir, mount):
    root = Path(md_dir).resolve()
    parts = str(mount or "md").split("/")
    if parts and parts[0] == "md":
        root = root.joinpath(*parts[1:])
    return root / NAME


def _entry_path(root, entry_id):
    value = str(entry_id or "").strip()
    if not value or "/" in value or "\\" in value or value in (".", ".."):
        raise operations.OperationError(400, "回收站条目标识不合法")
    path = Path(root) / value
    if not path.is_dir():
        raise operations.OperationError(404, "回收站条目不存在")
    return path


def _read_meta(path):
    try:
        return json.loads((path / META).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise operations.OperationError(409, "回收站条目元数据损坏，无法操作")


def list_entries(md_dir, mount):
    root = root_for(md_dir, mount)
    if not root.is_dir():
        return []
    result = []
    for path in sorted(root.iterdir(), key=lambda item: item.name, reverse=True):
        if not path.is_dir() or path.name.startswith(".") or not (path / META).is_file():
            continue
        meta = _read_meta(path)
        meta["id"] = path.name
        meta.pop("trash", None)
        result.append(meta)
    return result


def _asset_paths(md_dir, document_path, content):
    paths = []
    for relative in documents.referenced_images(md_dir, document_path, content) + \
            documents.referenced_attachments(md_dir, document_path, content):
        absolute = documents.resolve_md_file(md_dir, document_path).parent / Path(*relative.split("/"))
        if absolute.is_file() and absolute not in paths:
            paths.append(absolute)
    return paths


def move_to_trash(md_dir, relative, mount):
    target = operations._managed_path(md_dir, relative)
    if not target.exists() or target.name == NAME or str(relative).rstrip("/").endswith("/" + NAME):
        raise operations.OperationError(404, "目标不存在或不能删除回收站")
    if target.resolve() == Path(md_dir).resolve():
        raise operations.OperationError(400, "不能删除 docs/md 根目录")
    root = root_for(md_dir, mount)
    root.mkdir(parents=True, exist_ok=True)
    entry_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    entry = root / entry_id
    payload = entry / "payload"
    payload.mkdir(parents=True)
    original = str(relative).replace("\\", "/")
    is_document = target.is_file()
    assets = []
    if is_document:
        content = documents.read_md_text(target)
        for asset in _asset_paths(md_dir, original, content):
            try:
                asset_rel = asset.relative_to(Path(md_dir).resolve()).as_posix()
            except ValueError:
                continue
            asset_target = payload / "assets" / asset_rel
            asset_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(asset), str(asset_target))
            assets.append(asset_rel)
    payload_target = payload / "document" if is_document else payload / "folder"
    payload_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(payload_target))
    meta = {"id": entry_id, "path": original, "mount": mount, "kind": "document" if is_document else "folder",
            "name": target.name, "deletedAt": int(time.time()), "assets": assets, "trash": str(entry)}
    (entry / META).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def restore(md_dir, mount, entry_id):
    root = root_for(md_dir, mount)
    entry = _entry_path(root, entry_id)
    meta = _read_meta(entry)
    target = operations._managed_path(md_dir, meta["path"])
    if target.exists():
        raise operations.OperationError(409, "原位置已有同名文件或文件夹，请先处理后恢复")
    payload = entry / "payload" / ("document" if meta.get("kind") == "document" else "folder")
    if not payload.exists():
        raise operations.OperationError(409, "回收站内容缺失，无法恢复")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(payload), str(target))
    for asset_rel in meta.get("assets") or []:
        saved = entry / "payload" / "assets" / asset_rel
        destination = Path(md_dir).resolve() / asset_rel
        if saved.exists() and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(saved), str(destination))
    shutil.rmtree(str(entry), ignore_errors=True)
    return meta


def empty(md_dir, mount, entry_id=None):
    root = root_for(md_dir, mount)
    if not root.is_dir():
        return 0
    targets = [_entry_path(root, entry_id)] if entry_id else [item for item in root.iterdir() if item.is_dir()]
    count = 0
    for item in targets:
        shutil.rmtree(str(item), ignore_errors=False)
        count += 1
    try:
        root.rmdir()
    except OSError:
        pass
    return count
