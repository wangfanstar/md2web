"""静态分发的路径白名单：不依赖 Flask，预览服务与认证服务共用。"""

BLOCKED_SEGMENTS = {".svn", ".git", ".hg", ".md2web", "data", "config", "server", "tests", "specs", "__pycache__"}
BLOCKED_SUFFIXES = (".tmp", ".part", ".sqlite", ".sqlite3", ".db", ".py", ".pyc", ".pem", ".key")


def is_blocked_static_path(value):
    """判断相对路径是否禁止静态分发（点目录、.svn、临时/数据库/配置/源码文件）。"""
    rel = str(value or "").replace("\\", "/").lstrip("/")
    if not rel:
        return True
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if not parts:
        return True
    lowered = [part.lower() for part in parts]
    if lowered[0] == 'code' or lowered[:2] == ['docs', 'code']:
        return True
    if any(part.startswith(".") for part in parts):
        return True
    if any(part.lower() in BLOCKED_SEGMENTS for part in parts):
        return True
    if ".." in parts:
        return True
    if parts[-1].lower().startswith('md2web_config') and parts[-1].lower().endswith('.json'):
        return True
    return rel.lower().endswith(BLOCKED_SUFFIXES)
