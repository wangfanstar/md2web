"""串行化发布目录写入；独立于数据库锁，网络操作可以持有此锁。"""
from functools import wraps
from threading import RLock

LOCK = RLock()


def serialized(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with LOCK:
            return function(*args, **kwargs)
    return wrapped
