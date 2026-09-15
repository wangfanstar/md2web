"""本地管理员口令的哈希与校验（PBKDF2-HMAC-SHA256）。"""

import base64
import hashlib
import hmac
import os

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 200_000


def hash_password(password, iterations=ITERATIONS):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, int(iterations))
    return "{algorithm}${iterations}${salt}${digest}".format(
        algorithm=ALGORITHM,
        iterations=int(iterations),
        salt=base64.b64encode(salt).decode("ascii"),
        digest=base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password, stored):
    try:
        algorithm, iterations, salt_b64, digest_b64 = str(stored or "").split("$")
    except ValueError:
        return False
    if algorithm != ALGORITHM:
        return False
    try:
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)
