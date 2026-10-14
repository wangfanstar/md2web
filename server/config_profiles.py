"""可切换的站点配置方案：网页目录镜像、私有备份与运行配置恢复。"""
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_NAME = 'md2web_config.json'
FIELDS = ('auth', 'sync', 'repositories', 'folderGroups', 'siteBackup', 'ai', 'credentials')
# 配置页固定可选的三套配置：主配置、默认配置、备份配置
PRESETS = (
    ('md2web_config.json', '主配置'),
    ('md2web_config_default.json', '默认配置'),
    ('md2web_config_backup.json', '备份配置'),
)
PRESET_NAMES = [name for name, _ in PRESETS]
PRESET_LABELS = dict(PRESETS)


def label_for(name):
    return PRESET_LABELS.get(name, name)


def validate_name(name):
    from .config import ConfigError
    value = str(name or '')
    if len(value) > 100 or not re.match(r'^md2web_config(?:[_-][\w-]+)?\.json\Z', value):
        raise ConfigError('方案名称须为 md2web_config.json 或 md2web_config_名称.json，不能包含目录路径')
    return value


def private_dir(docs):
    return Path(docs).resolve().parent / 'data' / 'config-profiles'


def checked_file(path):
    from .config import ConfigError
    if path.is_symlink():
        raise ConfigError('配置文件不能是软链接：' + path.name)
    return path


def read_json(path):
    from .config import ConfigError
    try:
        value = json.loads(checked_file(path).read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError('配置必须是 JSON 对象')
        return value
    except (OSError, ValueError) as error:
        raise ConfigError('无法读取配置方案 %s：%s' % (path.name, error))


def atomic_json(path, data):
    checked_file(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n',
                                         dir=str(path.parent), prefix='.' + path.name, suffix='.tmp', delete=False)
    temporary = Path(handle.name)
    try:
        with handle:
            os.chmod(str(temporary), 0o600)
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def profile_data(config):
    from .config import config_to_json
    raw = config_to_json(config)
    result = {key: raw[key] for key in FIELDS}
    result['ai'] = dict(result['ai'])
    result['schemaVersion'] = 1
    return result


def persist(config, docs, runtime_payload=None):
    """每次保存配置都同步当前方案；独立保留上一个不同版本。"""
    from .config import config_to_json
    name = validate_name(config.get('profile_name', DEFAULT_NAME))
    data = profile_data(config)
    backup = private_dir(docs) / name
    mirror = Path(docs) / 'html' / name
    writes = []
    if backup.is_file():
        previous = read_json(backup)
        if previous != data:
            writes.append((private_dir(docs) / (name + '.previous'), previous))
    writes.extend([(backup, data), (mirror, data)])
    writes.append((private_dir(docs) / 'runtime.json', {
        'configName': Path(config['path']).name, 'config': config_to_json(config)
    }))
    if runtime_payload is not None:
        writes.append((Path(config['path']), runtime_payload))
    # 先检查所有目标，普通写入失败时回滚，不能出现“保存失败但默认方案已切换”。
    originals = {}
    for path, _ in writes:
        checked_file(path)
        originals[path] = path.read_bytes() if path.exists() else None
    changed, rollback_files, keep_rollback = [], {}, set()
    try:
        # 在修改任意目标之前预留回滚副本，磁盘不足时不触碰已有配置。
        for path, value in writes:
            if originals[path] is not None:
                handle = tempfile.NamedTemporaryFile(dir=str(path.parent), prefix='.profile-rollback-', suffix='.tmp', delete=False)
                rollback_files[path] = Path(handle.name)
                with handle:
                    handle.write(originals[path])
        for path, value in writes:
            encoded = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            if originals[path] == encoded:
                continue
            atomic_json(path, value)
            changed.append(path)
    except OSError as error:
        for path in reversed(changed):
            try:
                if originals[path] is None:
                    path.unlink()
                else:
                    os.replace(str(rollback_files[path]), str(path))
            except OSError:
                if path in rollback_files:
                    keep_rollback.add(rollback_files[path])
        from .config import ConfigError
        if keep_rollback:
            raise ConfigError('保存失败且部分文件无法回滚，原配置保留在：' + '、'.join(str(p) for p in keep_rollback))
        raise ConfigError('保存配置失败，已撤回本次修改：' + str(error))
    finally:
        for path in rollback_files.values():
            if path.exists() and path not in keep_rollback:
                path.unlink()


def recover_runtime(path, docs):
    """服务配置丢失时从私有备份恢复，包含密钥；不覆盖已有配置。"""
    path = Path(path)
    backup = private_dir(docs) / 'runtime.json'
    if path.exists() or not backup.is_file():
        return False
    data = read_json(backup)
    if data.get('configName') != path.name:
        return False
    atomic_json(path, data['config'])
    return True


def read_profile(docs, name):
    from .config import ConfigError
    name = validate_name(name)
    mirror = Path(docs) / 'html' / name
    path = mirror if mirror.is_file() else private_dir(docs) / name
    data = read_json(path)
    return validate_data(data)


def validate_data(data):
    from .config import ConfigError
    if not isinstance(data, dict):
        raise ConfigError('方案必须是 JSON 对象')
    if set(data) - set(FIELDS) - {'schemaVersion'} or data.get('schemaVersion', 1) != 1:
        raise ConfigError('方案格式无效；只能包含仓库、认证、分组、同步、备份和 AI 设置，不能导入服务密钥或数据库位置')
    if set(FIELDS) - set(data):
        raise ConfigError('方案内容不完整，请从配置页「另存为新方案」创建')
    for key in FIELDS:
        if key == 'credentials' and data[key] is None:
            continue  # 升级旧方案时允许从本机加密数据库迁移。
        if not isinstance(data[key], list if key == 'repositories' else dict):
            raise ConfigError('方案字段类型错误：' + key)
    return data


def apply_data(current, docs, name, data):
    from .config import config_to_json, save_config
    data = validate_data(data)
    payload = config_to_json(current)
    for field in FIELDS:
        payload[field] = data[field]
    payload['profileName'] = validate_name(name)
    return save_config(current['path'], payload, docs, create_mounts=False)


def select(current, docs, name, create=False):
    from .config import ConfigError
    name = validate_name(name)
    if create:
        if (Path(docs) / 'html' / name).exists() or (private_dir(docs) / name).exists():
            raise ConfigError('同名方案已存在，请选择该方案或换一个名称')
        data = profile_data(current)
    else:
        data = read_profile(docs, name)
    return apply_data(current, docs, name, data)


def restore_previous(current, docs):
    name = validate_name(current.get('profile_name', DEFAULT_NAME))
    return apply_data(current, docs, name, read_json(private_dir(docs) / (name + '.previous')))


def ensure_presets(current, docs):
    """保证配置页三种可选配置都存在：主配置、默认配置、备份配置。

    缺失时用当前运行配置生成一份快照（镜像到 docs/html/ 与私有目录），
    已有文件不会被覆盖，管理员之后可分别编辑。
    """
    data = None
    for name, _ in PRESETS:
        try:
            mirror = Path(docs) / 'html' / name
            backup = private_dir(docs) / name
            if mirror.is_file() or backup.is_file():
                continue
            if data is None:
                data = profile_data(current)
            atomic_json(mirror, data)
            atomic_json(backup, data)
        except OSError:
            continue


def initialize(current, docs):
    """启动时读取默认方案；升级前的旧配置自动迁移，已有方案不会被构建覆盖。"""
    from .config import ConfigError
    name = validate_name(current.get('profile_name', DEFAULT_NAME))
    if (Path(docs) / 'html' / name).is_file() or (private_dir(docs) / name).is_file():
        try:
            result = select(current, docs, name)
        except ConfigError:
            # 手工编辑的 JSON 损坏时，用上次成功保存的私有副本启动，并保留坏文件供核对。
            backup = private_dir(docs) / name
            mirror = Path(docs) / 'html' / name
            if not backup.is_file() or not mirror.is_file():
                raise
            data = validate_data(read_json(backup))
            rejected = private_dir(docs) / (name + '.rejected')
            rejected.write_bytes(mirror.read_bytes())
            os.chmod(str(rejected), 0o600)
            result = apply_data(current, docs, name, data)
            print('[配置恢复] 已从私有备份恢复 ' + name + '；原 JSON 保留在 data/config-profiles/ 对应 .rejected 文件中。')
    else:
        persist(current, docs)
        result = current
    ensure_presets(result, docs)
    return result


def listing(current, docs):
    from .config import ConfigError
    ensure_presets(current, docs)
    names = {current.get('profile_name', DEFAULT_NAME)}
    for directory in (Path(docs) / 'html', private_dir(docs)):
        for path in directory.glob('md2web_config*.json'):
            try:
                names.add(validate_name(path.name))
            except ConfigError:
                continue
    items = []
    for name in sorted(names):
        mirror = Path(docs) / 'html' / name
        backup = private_dir(docs) / name
        file_path = mirror if mirror.is_file() else backup
        stamp = datetime.fromtimestamp(file_path.stat().st_mtime, timezone.utc).isoformat() if file_path.is_file() else None
        items.append({'name': name, 'label': label_for(name), 'updatedAt': stamp,
                      'hasPrevious': (private_dir(docs) / (name + '.previous')).is_file()})
    return {'active': current.get('profile_name', DEFAULT_NAME), 'profiles': items,
            'presets': PRESET_NAMES,
            'directory': 'docs/html/', 'backupDirectory': 'data/config-profiles/'}
