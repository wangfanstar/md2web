"""Rollback selected filesystem paths if a surrounding database transaction fails."""
import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def database_transaction(conn):
    """Python 3.6 sqlite3 can leave a transaction open when COMMIT itself fails."""
    try:
        yield
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _copy(source, target):
    if source.is_symlink():
        target.symlink_to(os.readlink(str(source)), target_is_directory=source.is_dir())
    elif source.is_dir():
        shutil.copytree(str(source), str(target), symlinks=True)
    else:
        shutil.copy2(str(source), str(target))


@contextmanager
def rollback_paths(paths):
    # Keep lexical paths: writable mounts may be directory links.
    roots = []
    for raw in sorted(set(str(Path(os.path.abspath(str(p)))) for p in paths), key=len):
        path = Path(raw)
        if not any(parent == path or parent in path.parents for parent in roots):
            roots.append(path)
    backup = Path(tempfile.mkdtemp(prefix='md2web-rollback-'))
    snapshots = []
    keep_backup = False
    try:
        for index, target in enumerate(roots):
            saved = backup / str(index)
            exists = target.exists() or target.is_symlink()
            if exists:
                _copy(target, saved)
            snapshots.append((target, saved, exists))
        try:
            yield
        except Exception:
            failures = []
            for target, saved, existed in reversed(snapshots):
                try:
                    if target.is_symlink() or target.is_file():
                        target.unlink()
                    elif target.exists():
                        shutil.rmtree(str(target))
                    if existed:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        _copy(saved, target)
                except Exception as error:
                    failures.append('%s: %s' % (target, error))
            if failures:
                keep_backup = True
                from .operations import OperationError
                raise OperationError(500, '文件回滚失败，原始备份保留在 %s；%s' % (backup, '; '.join(failures)))
            raise
    finally:
        if not keep_backup:
            shutil.rmtree(str(backup), ignore_errors=True)
