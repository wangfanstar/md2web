"""Private authorization policy; not part of public snapshots."""
import hashlib
import json


def normalize(raw):
    users = (raw.get('authorization') or {}).get('users', [])
    if not isinstance(users, list):
        raise ValueError('authorization.users 必须是数组')
    result, seen = [], set()
    for item in users:
        source, name = item.get('authSourceId'), item.get('username')
        role, enabled = item.get('role', 'user'), item.get('enabled', True)
        if not isinstance(source, str) or not source or not isinstance(name, str) or not name.strip():
            raise ValueError('授权必须包含认证源和用户名')
        if role not in ('user', 'admin') or not isinstance(enabled, bool):
            raise ValueError('权限必须为 user/admin，enabled 必须为布尔值')
        if (source, name) in seen:
            raise ValueError('重复的用户授权')
        if source == 'local-admin' and (role != 'admin' or not enabled):
            raise ValueError('本地恢复管理员必须保持启用和管理员权限')
        seen.add((source, name))
        result.append(dict(authSourceId=source, username=name, role=role, enabled=enabled))
    return {'users': result}


def effective(user, config):
    for item in config.get('authorization', {}).get('users', []):
        if item['authSourceId'] == user['auth_source_id'] and item['username'] == user['svn_username']:
            return item['role'], item['enabled'] and not user['disabled']
    return user['role'] or 'user', not user['disabled']


def version(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def options(raw, defaults):
    result = dict(defaults)
    for key, default in defaults.items():
        value = raw.get(key, default)
        if isinstance(default, bool):
            if not isinstance(value, bool):
                raise ValueError(key + ' 必须为布尔值')
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 1073741824:
            raise ValueError(key + ' 必须是有限的正数')
        result[key] = value
    return result

CACHE_DEFAULTS = dict(enabled=True, metadataTtlSeconds=60, maxEntries=256,
                      maxBytes=33554432, versionPollSeconds=30)
COMPARE_DEFAULTS = dict(contextLines=3, maxInteractiveBytes=5242880,
                        maxInteractiveLines=50000, workerBudgetMs=1500)
AUTH_DEFAULTS = dict(rememberSessionDays=30, rememberIdleDays=7,
                     rememberUsername=True, deviceHintDays=30)
