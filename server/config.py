"""配置加载、校验与保存：路径/URL/仓库身份都在这里被验证。

- `allow_incomplete=True` 允许首次部署时配置为空（先启动服务，再由管理员在网页设置里填写）。
- 保存使用与加载同一套校验，并原子替换配置文件。
"""

import json
import os
import re
import tempfile
from pathlib import Path

from .secrets import generate_key

DEFAULT_SESSION_HOURS = 8
DEFAULT_IDLE_MINUTES = 30
DEFAULT_SYNC_INTERVAL = 120
ALLOWED_URL_SCHEMES = ("http", "https")
URL_RE = re.compile(r"^https?://[^\s/]+/", re.IGNORECASE)
DEFAULT_AI = {
    "provider": "openai",
    "baseUrl": "",
    "model": "",
    "apiKey": "",
    "useProxy": "auto",
    "contextChars": 6000,
    "sourcePath": "",
}


class ConfigError(Exception):
    """配置错误：信息面向管理员，不得包含任何秘密。"""


def _clean_mount(value):
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        raise ConfigError("repository.mount 不能为空")
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise ConfigError(f"repository.mount 必须是 docs/ 下的相对路径: {value}")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ConfigError(f"repository.mount 不能包含 .. : {value}")
    if any(part.startswith(".") for part in parts):
        raise ConfigError(f"repository.mount 不能包含隐藏目录: {value}")
    return "/".join(parts)


def _check_url(value, label):
    text = str(value or "").strip()
    if not text:
        raise ConfigError(f"{label} 不能为空")
    if not URL_RE.match(text):
        raise ConfigError(f"{label} 必须是 http/https URL（不支持 file:// 或 svn+ssh://）: {text}")
    scheme = text.split(":", 1)[0].lower()
    if scheme not in ALLOWED_URL_SCHEMES:
        raise ConfigError(f"{label} 只支持 http/https: {text}")
    return text


def _resolve_path(base, value, label, docs_dir):
    raw = str(value or "").strip()
    if not raw:
        raise ConfigError(f"{label} 不能为空")
    path = Path(raw)
    resolved = (base / path).resolve() if not path.is_absolute() else path.resolve()
    docs = Path(docs_dir).resolve()
    if resolved == docs or docs in resolved.parents:
        raise ConfigError(f"{label} 不能放在 docs/ 内（会随站点分发）: {resolved}")
    return resolved


def load_config(path, docs_dir, allow_incomplete=False):
    """读取并校验配置；路径相对配置文件目录解析。"""
    config_path = Path(path)
    if not config_path.is_file():
        if allow_incomplete:
            raw = {}
        else:
            raise ConfigError(f"配置文件不存在: {config_path}")
    else:
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ConfigError(f"配置文件不是有效 JSON: {error}") from error
        if not isinstance(raw, dict):
            raise ConfigError("配置文件必须是 JSON 对象")
    base = config_path.resolve().parent

    security_raw = raw.get("security") or {}
    secret_key = str(security_raw.get("secretKey") or "").strip()
    secret_generated = False
    if not secret_key:
        secret_key = generate_key()
        secret_generated = True

    server_raw = raw.get("server") or {}
    bind = str(server_raw.get("bind") or "0.0.0.0").strip()
    if not bind:
        raise ConfigError("server.bind 不能为空")
    port = server_raw.get("port", 8882)
    if not isinstance(port, int) or not 0 <= port <= 65535:
        raise ConfigError("server.port 必须在 0-65535 之间")
    secure_cookies = bool(server_raw.get("secure_cookies", False))

    auth_raw = raw.get("auth") or {}
    auth_value = str(auth_raw.get("url") or "").strip()
    if not auth_value:
        if not allow_incomplete:
            raise ConfigError("auth.url 不能为空")
        auth_url = ""
    else:
        auth_url = _check_url(auth_value, "auth.url")
    credential_group = str(auth_raw.get("credential_group") or "default").strip() or "default"
    session_hours = auth_raw.get("session_hours", DEFAULT_SESSION_HOURS)
    idle_minutes = auth_raw.get("idle_minutes", DEFAULT_IDLE_MINUTES)
    for label, value in (("session_hours", session_hours), ("idle_minutes", idle_minutes)):
        if not isinstance(value, (int, float)) or value <= 0:
            raise ConfigError(f"auth.{label} 必须是正数")

    storage_raw = raw.get("storage") or {}
    database_raw = str(storage_raw.get("database") or "../data/md2web.sqlite3").strip()
    workspaces_raw = str(storage_raw.get("workspaces") or "../data/workspaces").strip()
    database = _resolve_path(base, database_raw, "storage.database", docs_dir)
    workspaces = _resolve_path(base, workspaces_raw, "storage.workspaces", docs_dir)

    folder_groups_raw = raw.get("folderGroups") or {}
    if not isinstance(folder_groups_raw, dict):
        raise ConfigError("folderGroups 必须是对象（md/<文件夹> → 分组名）")
    folder_groups = {}
    for key, value in folder_groups_raw.items():
        mount = str(key or "").strip().strip("/")
        group = str(value or "").strip()
        if not mount or not group:
            continue
        if not mount.startswith("md/"):
            raise ConfigError("folderGroups 的键必须是 md/ 下的文件夹：" + mount)
        folder_groups[mount] = group[:60]

    site_raw = raw.get("siteBackup") or {}
    site_interval = site_raw.get("intervalSeconds", 3600)
    if not isinstance(site_interval, (int, float)) or site_interval < 0:
        raise ConfigError("siteBackup.intervalSeconds 必须是不小于 0 的数值（0 表示不自动备份）")
    site_url = str(site_raw.get("url") or "").strip()
    if site_url:
        site_url = _check_url(site_url, "siteBackup.url")
    site_backup = {
        "enabled": bool(site_raw.get("enabled", bool(site_url))),
        "url": site_url,
        "interval_seconds": float(site_interval),
        "include": [str(item).strip().strip("/") for item in (site_raw.get("include") or ["docs"]) if str(item).strip()],
        "message": str(site_raw.get("message") or "site backup").strip()[:200],
    }

    sync_raw = raw.get("sync") or {}
    interval = sync_raw.get("interval_seconds", DEFAULT_SYNC_INTERVAL)
    if not isinstance(interval, (int, float)) or interval < 10:
        raise ConfigError("sync.interval_seconds 必须是不小于 10 的数值")

    repositories = []
    seen_ids = set()
    seen_mounts = set()
    for index, item in enumerate(raw.get("repositories") or []):
        if not isinstance(item, dict):
            raise ConfigError(f"repositories[{index}] 必须是对象")
        repo_id = str(item.get("id") or "").strip()
        if not repo_id:
            raise ConfigError(f"repositories[{index}].id 不能为空")
        if repo_id in seen_ids:
            raise ConfigError(f"仓库 id 重复: {repo_id}")
        seen_ids.add(repo_id)
        mount = _clean_mount(item.get("mount"))
        if mount in seen_mounts:
            raise ConfigError(f"repository.mount 重复: {mount}")
        seen_mounts.add(mount)
        source_mode = str(item.get("sourceMode", item.get("source_mode", "svn")) or "svn").strip().lower()
        if source_mode not in ("local", "svn"):
            raise ConfigError(f"repositories[{index}].sourceMode 必须是 local 或 svn")
        raw_url = str(item.get("url") or "").strip()
        if source_mode == "svn":
            repo_url = _check_url(raw_url, f"repositories[{index}].url")
        else:
            if raw_url:
                raise ConfigError(f"repositories[{index}] 本地模式不能配置 SVN URL，请清空 url")
            repo_url = ""
        sync_interval = item.get("syncIntervalSeconds", None)
        if sync_interval is not None:
            try:
                sync_interval = float(sync_interval)
            except (TypeError, ValueError):
                raise ConfigError(f"repositories[{index}].syncIntervalSeconds 必须是数值（秒，0 表示不自动同步）")
            if sync_interval < 0:
                raise ConfigError(f"repositories[{index}].syncIntervalSeconds 不能为负数")
        repositories.append({
            "id": repo_id,
            "mount": mount,
            "source_mode": source_mode,
            "url": repo_url,
            "credential_group": str(item.get("credential_group") or credential_group).strip() or credential_group,
            "group": str(item.get("group") or "").strip() or str(item.get("credential_group") or credential_group).strip() or "默认",
            "read_only": bool(item.get("readOnly", False)),
            "allow_commit": bool(item.get("allowCommit", True)),
            "sync_interval": sync_interval,
        })

    ai_raw = raw.get("ai") or {}
    ai = {
        "provider": str(ai_raw.get("provider") or DEFAULT_AI["provider"]).strip() or DEFAULT_AI["provider"],
        "baseUrl": str(ai_raw.get("baseUrl") or "").strip(),
        "model": str(ai_raw.get("model") or "").strip(),
        "apiKey": str(ai_raw.get("apiKey") or "").strip(),
        "useProxy": str(ai_raw.get("useProxy") or DEFAULT_AI["useProxy"]).strip() or DEFAULT_AI["useProxy"],
        "contextChars": int(ai_raw.get("contextChars") or DEFAULT_AI["contextChars"]),
        "sourcePath": str(ai_raw.get("sourcePath") or "").strip()[:500],
    }
    if ai["baseUrl"]:
        ai["baseUrl"] = _check_url(ai["baseUrl"], "ai.baseUrl")

    return {
        "path": config_path.resolve(),
        "security": {"secretKey": secret_key, "generated": secret_generated},
        "server": {"bind": bind, "port": port, "secure_cookies": secure_cookies},
        "auth": {
            "url": auth_url,
            "credential_group": credential_group,
            "session_hours": float(session_hours),
            "idle_minutes": float(idle_minutes),
        },
        "storage": {
            "database": database,
            "workspaces": workspaces,
            "database_raw": database_raw,
            "workspaces_raw": workspaces_raw,
        },
        "sync": {
            "interval_seconds": float(interval),
            "credential_source": str(sync_raw.get("credential_source") or "").strip(),
            "credential_name": str(sync_raw.get("credential_name") or "").strip(),
        },
        "repositories": repositories,
        "folder_groups": folder_groups,
        "site_backup": site_backup,
        "ai": ai,
    }


def ensure_secret_key(config, docs_dir):
    """把新生成的 security.secretKey 写回配置文件（失败时仅警告，密钥仍在内存中）。"""
    if not config.get("security", {}).get("generated"):
        return config
    try:
        saved = save_config(config["path"], config_to_json(config), docs_dir)
        saved["security"]["generated"] = False
        return saved
    except Exception as error:  # 配置只读等情况：本次运行仍可用，重启会重新生成
        print("[警告] 无法写入 security.secretKey（%s）；SVN 口令将在重启后需要重新登录" % error)
        config["security"]["generated"] = False
        return config


def config_to_json(config):
    """把已加载配置还原成文件结构（含 security，供写回磁盘；API 层返回前需剥离）。"""
    data = {
        "server": dict(config["server"]),
        "auth": {
            "url": config["auth"]["url"],
            "credential_group": config["auth"]["credential_group"],
            "session_hours": config["auth"]["session_hours"],
            "idle_minutes": config["auth"]["idle_minutes"],
        },
        "storage": {
            "database": config["storage"].get("database_raw", "../data/md2web.sqlite3"),
            "workspaces": config["storage"].get("workspaces_raw", "../data/workspaces"),
        },
        "sync": dict(config["sync"]),
        "folderGroups": dict(config.get("folder_groups") or {}),
        "siteBackup": {
            "enabled": bool(config.get("site_backup", {}).get("enabled")),
            "url": config.get("site_backup", {}).get("url", ""),
            "intervalSeconds": config.get("site_backup", {}).get("interval_seconds", 3600),
            "include": list(config.get("site_backup", {}).get("include", ["docs"])),
            "message": config.get("site_backup", {}).get("message", "site backup"),
        },
        "repositories": [
            {"id": repo["id"], "mount": repo["mount"], "sourceMode": repo.get("source_mode", "svn"),
             "url": repo["url"],
             "credential_group": repo["credential_group"], "group": repo.get("group") or "默认",
             "readOnly": bool(repo.get("read_only")), "allowCommit": bool(repo.get("allow_commit", True)),
             "syncIntervalSeconds": repo.get("sync_interval")}
            for repo in config["repositories"]
        ],
        "ai": dict(config["ai"]),
    }
    if config.get("security", {}).get("secretKey"):
        data["security"] = {"secretKey": config["security"]["secretKey"]}
    return data


def save_config(path, payload, docs_dir):
    """校验并原子写入配置文件，返回加载后的配置。

    载荷里没有 security.secretKey 时保留磁盘上的原值（网页端不应接触该密钥）。
    """
    if not isinstance(payload, dict):
        raise ConfigError("配置必须是 JSON 对象")
    payload = json.loads(json.dumps(payload))
    secret = str(((payload.get("security") or {}).get("secretKey")) or "").strip()
    if not secret:
        existing = ""
        existing_path = Path(path)
        if existing_path.is_file():
            try:
                raw_existing = json.loads(existing_path.read_text(encoding="utf-8"))
                existing = str(((raw_existing.get("security") or {}).get("secretKey")) or "").strip()
            except (json.JSONDecodeError, OSError):
                existing = ""
        payload["security"] = {"secretKey": existing or generate_key()}
    config_path = Path(path)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", delete=False,
        dir=str(config_path.parent), prefix="." + config_path.name + ".", suffix=".tmp",
    )
    tmp_path = Path(handle.name)
    try:
        with handle:
            handle.write(text)
        loaded = load_config(tmp_path, docs_dir, allow_incomplete=True)
        os.replace(tmp_path, config_path)
    except Exception:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise
    loaded["path"] = config_path.resolve()
    return loaded


def default_config():
    """首次启动时写入的默认配置（SVN 地址留空，待管理员在网页设置中填写）。"""
    return {
        "security": {"secretKey": generate_key()},
        "server": {"bind": "0.0.0.0", "port": 8882, "secure_cookies": False},
        "auth": {
            "url": "",
            "credential_group": "default",
            "session_hours": DEFAULT_SESSION_HOURS,
            "idle_minutes": DEFAULT_IDLE_MINUTES,
        },
        "storage": {"database": "../data/md2web.sqlite3", "workspaces": "../data/workspaces"},
        "sync": {"interval_seconds": DEFAULT_SYNC_INTERVAL, "credential_source": "", "credential_name": ""},
        "folderGroups": {},
        "siteBackup": {"enabled": False, "url": "", "intervalSeconds": 3600, "include": ["docs"],
                       "message": "site backup"},
        "repositories": [],
        "ai": dict(DEFAULT_AI),
    }


def match_repository(config, document_path):
    """按目录段最长前缀匹配仓库；'md/A' 不匹配 'md/AB'。"""
    rel = str(document_path or "").strip().replace("\\", "/").lstrip("/")
    best = None
    best_length = -1
    for repo in config.get("repositories") or []:
        mount = repo["mount"]
        if rel == mount or rel.startswith(mount + "/"):
            if len(mount) > best_length:
                best = repo
                best_length = len(mount)
    return best


def public_config(config):
    """给未登录前端的配置视图：不含认证地址、AI Key 与任何凭据。"""
    ai = config.get("ai") or {}
    return {
        "repositories": [
            {"id": repo["id"], "mount": repo["mount"], "sourceMode": repo.get("source_mode", "svn"),
             "url": repo["url"],
             "group": repo.get("group") or "默认", "readOnly": bool(repo.get("read_only")),
             "allowCommit": bool(repo.get("allow_commit", True)),
             "syncIntervalSeconds": repo.get("sync_interval")}
            for repo in config.get("repositories") or []
        ],
        "sessionHours": config["auth"]["session_hours"],
        "idleMinutes": config["auth"]["idle_minutes"],
        "authConfigured": bool(config["auth"]["url"]),
        "ai": {"provider": ai.get("provider", ""), "baseUrl": ai.get("baseUrl", ""),
               "model": ai.get("model", ""), "useProxy": ai.get("useProxy", "auto"),
               "contextChars": ai.get("contextChars", 6000), "sourcePath": ai.get("sourcePath", "")},
    }


def authenticated_config(config):
    """给已登录用户的配置视图：包含 AI 默认值（含 Key，供共享 AI 助手使用）。"""
    data = public_config(config)
    data["ai"]["apiKey"] = (config.get("ai") or {}).get("apiKey", "")
    return data
