"""本机可逆加密（仅标准库）：用于把 SVN 口令加密后随数据库保存，供后续提交复用。

实现：SHA-256 计数器模式密钥流 + HMAC-SHA256 认证标签（先加密后认证），
密钥来自 config/server.local.json 的 security.secretKey（首次运行自动生成）。
说明：这是本机可逆保护（数据库文件与配置文件都不可外泄），不等价于硬件级密钥管理；
如需更强保护，请限制服务仅在内网访问并妥善保管配置文件权限。
"""

import base64
import hashlib
import hmac
import os

PREFIX = "v1"
KEY_BYTES = 32
NONCE_BYTES = 16
TAG_BYTES = 16


def generate_key():
    """生成新的随机密钥（urlsafe base64 文本）。"""
    return base64.urlsafe_b64encode(os.urandom(KEY_BYTES)).decode("ascii")


def _key_bytes(key_text):
    try:
        key = base64.urlsafe_b64decode(str(key_text).encode("ascii"))
    except Exception:
        raise ValueError("密钥不是合法的 base64 文本")
    if len(key) < 16:
        raise ValueError("密钥长度不足（至少 16 字节）")
    return key


def _keystream(key, nonce, length):
    blocks = []
    counter = 0
    filled = 0
    while filled < length:
        blocks.append(hashlib.sha256(key + nonce + counter.to_bytes(4, "big")).digest())
        filled += 32
        counter += 1
    return b"".join(blocks)[:length]


def encrypt(key_text, plaintext):
    """加密文本，返回 v1:<base64(nonce|cipher|tag)>。"""
    key = _key_bytes(key_text)
    nonce = os.urandom(NONCE_BYTES)
    data = str(plaintext).encode("utf-8")
    stream = _keystream(key, nonce, len(data))
    cipher = bytes(byte ^ mask for byte, mask in zip(data, stream))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:TAG_BYTES]
    return "%s:%s" % (PREFIX, base64.urlsafe_b64encode(nonce + cipher + tag).decode("ascii"))


def decrypt(key_text, token):
    """解密 encrypt() 的结果；密钥不符或内容被篡改时抛 ValueError。"""
    value = str(token or "")
    prefix, _, payload = value.partition(":")
    if prefix != PREFIX or not payload:
        raise ValueError("密文格式不正确")
    key = _key_bytes(key_text)
    try:
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
    except Exception:
        raise ValueError("密文不是合法的 base64")
    if len(raw) < NONCE_BYTES + TAG_BYTES:
        raise ValueError("密文长度不足")
    nonce = raw[:NONCE_BYTES]
    cipher = raw[NONCE_BYTES:-TAG_BYTES]
    tag = raw[-TAG_BYTES:]
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:TAG_BYTES]
    if not hmac.compare_digest(tag, expected):
        raise ValueError("密钥不匹配或密文已被修改")
    stream = _keystream(key, nonce, len(cipher))
    data = bytes(byte ^ mask for byte, mask in zip(cipher, stream))
    return data.decode("utf-8")
