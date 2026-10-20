"""Bounded public metadata cache; permissions and private content never belong here."""
import hashlib
import json
import threading
import time
from collections import OrderedDict
from functools import lru_cache


class MetadataCache:
    def __init__(self, max_entries=256, max_bytes=33554432, ttl=60, clock=None):
        self.max_entries, self.max_bytes, self.ttl = max_entries, max_bytes, ttl
        self.clock = clock or time.monotonic
        self.items = OrderedDict()
        self.bytes = 0
        self.lock = threading.RLock()
        self.hits = self.misses = 0

    def clear(self):
        with self.lock:
            self.items.clear()
            self.bytes = 0

    def get_or_compute(self, key, compute):
        # One producer per cache instance. Never call while holding the database lock.
        with self.lock:
            item = self.items.pop(key, None)
            if item:
                self.bytes -= item[2]
                if self.clock() < item[0]:
                    self.items[key] = item
                    self.bytes += item[2]
                    self.hits += 1
                    return item[1]
            self.misses += 1
            value = compute()
            size = len(json.dumps(value, ensure_ascii=False).encode('utf-8'))
            if size <= self.max_bytes:
                self.items[key] = (self.clock() + self.ttl, value, size)
                self.bytes += size
                while self.bytes > self.max_bytes or len(self.items) > self.max_entries:
                    _, removed = self.items.popitem(last=False)
                    self.bytes -= removed[2]
            return value


@lru_cache(maxsize=512)
def _asset_digest(path, modified, size):
    with open(path, 'rb') as handle:
        return hashlib.sha1(handle.read()).hexdigest()[:10]


def static_policy(path, version=None):
    if version and path.is_file() and path.suffix.lower() in ('.js', '.css', '.woff2', '.woff'):
        info = path.stat()
        if _asset_digest(str(path), info.st_mtime_ns, info.st_size) == version:
            return 'public, max-age=31536000, immutable'
    return 'no-cache'
