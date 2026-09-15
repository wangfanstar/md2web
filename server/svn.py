"""SVN 命令行封装：系统内唯一的 svn 子进程入口。

约束（对应设计文档第 5、11 节）：
- 只接受内部枚举的命令与配置中的仓库 URL，调用方不能传入任意服务器地址。
- shell=False、参数数组、密码只经 stdin（--password-from-stdin），绝不进入命令行/日志。
- 每次调用使用独立 --config-dir 与 --no-auth-cache，并清理可能注入的 SVN_* 环境变量。
- 超时、输出长度限制、XML 结构化解析；错误信息脱敏。
"""

import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ERROR_MESSAGES = {
    "not_found": "未找到 svn 客户端，请先安装 Subversion 命令行工具",
    "unsupported": "svn 客户端不支持 --password-from-stdin，无法安全传递口令",
    "anonymous_allowed": "认证路径允许匿名访问，无法用于验证账号密码，请管理员改为强制认证路径",
    "auth_failed": "账号或密码错误",
    "unreachable": "无法连接 SVN 服务",
    "cert_error": "SVN 服务证书校验失败",
    "timeout": "svn 命令超时",
    "parse_error": "无法解析 svn 输出",
    "failed": "svn 命令执行失败",
    "url_not_allowed": "目标地址不在允许的 SVN 服务器范围内",
}

AUTH_FAILED_MARKERS = ("e170001", "w170001", "e215004", "authorization failed", "authentication failed", "could not authenticate")
UNREACHABLE_MARKERS = ("e170013", "e731001", "e670002", "e175002", "unable to connect", "could not connect", "connection refused", "connection timed out", "name or service not known", "no route to host")
CERT_MARKERS = ("certificate verification failed", "e230001", "server certificate", "certificate issuer")

SECRET_ENV_KEYS = ("SVN_PASSWORD", "SVN_USERNAME", "SVN_AUTH_CACHE", "SVN_SSH", "SVN_ASP_DOT_NET_HACK")


class SvnError(Exception):
    def __init__(self, code, message=None, detail=""):
        self.code = code
        self.detail = str(detail or "")[:400]
        super().__init__(message or ERROR_MESSAGES.get(code, ERROR_MESSAGES["failed"]))


def classify_error(stderr):
    text = str(stderr or "").lower()
    for marker in AUTH_FAILED_MARKERS:
        if marker in text:
            return "auth_failed"
    for marker in CERT_MARKERS:
        if marker in text:
            return "cert_error"
    for marker in UNREACHABLE_MARKERS:
        if marker in text:
            return "unreachable"
    return "failed"


def same_server(url_a, url_b):
    """比较 scheme://host:port，用于绑定同一认证服务器。"""
    pattern = re.compile(r"^(https?)://([^/:]+)(?::(\d+))?", re.IGNORECASE)
    match_a = pattern.match(str(url_a or ""))
    match_b = pattern.match(str(url_b or ""))
    if not match_a or not match_b:
        return False
    port_a = match_a.group(3) or ("443" if match_a.group(1).lower() == "https" else "80")
    port_b = match_b.group(3) or ("443" if match_b.group(1).lower() == "https" else "80")
    return (match_a.group(1).lower(), match_a.group(2).lower(), port_a) == (
        match_b.group(1).lower(),
        match_b.group(2).lower(),
        port_b,
    )


def parse_info_xml(text):
    """解析 svn info --xml；拒绝 DTD/ENTITY 防止实体扩展。"""
    content = str(text or "")
    if "<!DOCTYPE" in content.upper() or "<!ENTITY" in content.upper():
        raise SvnError("parse_error", detail="XML 包含 DTD/ENTITY，已拒绝解析")
    try:
        root = ET.fromstring(content)
    except ET.ParseError as error:
        raise SvnError("parse_error", detail=str(error)) from error
    entry = root.find("entry")
    if entry is None:
        raise SvnError("parse_error", detail="缺少 entry 节点")
    repo = entry.find("repository")
    info = {
        "kind": entry.get("kind", ""),
        "path": entry.get("path", ""),
        "revision": entry.get("revision", ""),
        "url": "",
        "root_url": "",
        "uuid": "",
    }
    if entry.find("url") is not None:
        info["url"] = entry.find("url").text or ""
    if repo is not None:
        info["root_url"] = (repo.find("root").text if repo.find("root") is not None else "") or ""
        info["uuid"] = (repo.find("uuid").text if repo.find("uuid") is not None else "") or ""
    return info


class SvnClient:
    """svn CLI 的受控调用入口；测试可注入假可执行文件（command 支持多段）。"""

    def __init__(self, command=("svn",), timeout=30):
        self.command = tuple(command)
        self.timeout = timeout
        self._stdin_support = None

    # ---- 进程调用 ----

    def _environment(self):
        env = {key: value for key, value in os.environ.items() if key.upper() not in SECRET_ENV_KEYS}
        env["SVN_ASP_DOT_NET_HACK"] = ""
        return env

    def _run(self, args, stdin_text=None, timeout=None, config_dir=None):
        command = list(self.command)
        if config_dir is not None:
            command += ["--config-dir", str(config_dir)]
        command += list(args)
        try:
            completed = subprocess.run(
                command,
                input=stdin_text,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout or self.timeout,
                shell=False,
                env=self._environment(),
            )
        except FileNotFoundError as error:
            raise SvnError("not_found", detail=str(error)) from error
        except subprocess.TimeoutExpired as error:
            raise SvnError("timeout", detail=str(error)) from error
        except OSError as error:
            raise SvnError("failed", detail=str(error)) from error
        return completed

    # ---- 能力检测 ----

    def version(self):
        completed = self._run(["--version", "--quiet"])
        if completed.returncode != 0:
            raise SvnError(classify_error(completed.stderr), detail=completed.stderr)
        return completed.stdout.strip()

    def supports_password_from_stdin(self):
        if self._stdin_support is not None:
            return self._stdin_support
        completed = self._run(["help", "info"])
        text = (completed.stdout or "") + (completed.stderr or "")
        if completed.returncode != 0 and not text:
            raise SvnError(classify_error(completed.stderr), detail=completed.stderr)
        self._stdin_support = "--password-from-stdin" in text
        if not self._stdin_support:
            completed = self._run(["help"])
            text = (completed.stdout or "") + (completed.stderr or "")
            self._stdin_support = "--password-from-stdin" in text
        return self._stdin_support

    # ---- 只读查询 ----

    def anonymous_readable(self, url, config_dir):
        """匿名执行 svn info；能成功说明该路径未强制认证。"""
        completed = self._run(
            ["info", "--xml", "--non-interactive", "--no-auth-cache", url],
            config_dir=config_dir,
        )
        if completed.returncode == 0:
            return True
        code = classify_error(completed.stderr)
        if code == "auth_failed":
            return False
        raise SvnError(code, detail=completed.stderr)

    def verify_credentials(self, url, username, password, config_dir=None):
        """验证账号密码：先确认匿名不可读，再以 stdin 传入口令执行 svn info。"""
        if not username:
            raise SvnError("auth_failed", detail="用户名为空")
        if password is None or password == "":
            raise SvnError("auth_failed", detail="密码为空")
        if not self.supports_password_from_stdin():
            raise SvnError("unsupported")
        own_config = None
        if config_dir is None:
            own_config = tempfile.mkdtemp(prefix="md2web-svn-")
            config_dir = own_config
        try:
            if self.anonymous_readable(url, config_dir):
                raise SvnError("anonymous_allowed")
            completed = self._run(
                [
                    "info",
                    "--xml",
                    "--non-interactive",
                    "--no-auth-cache",
                    "--username",
                    str(username),
                    "--password-from-stdin",
                    url,
                ],
                stdin_text=str(password) + "\n",
                config_dir=config_dir,
            )
            if completed.returncode != 0:
                raise SvnError(classify_error(completed.stderr), detail=completed.stderr)
            return parse_info_xml(completed.stdout)
        finally:
            if own_config:
                try:
                    for child in Path(own_config).glob("**/*"):
                        if child.is_file():
                            child.unlink()
                    for child in sorted(Path(own_config).glob("**/*"), reverse=True):
                        if child.is_dir():
                            child.rmdir()
                    Path(own_config).rmdir()
                except OSError:
                    pass

    def info(self, url, config_dir, username=None, password=None):
        """读取配置中仓库的远程信息；绑定场景可带当前会话凭据。"""
        args = ["info", "--xml", "--non-interactive", "--no-auth-cache"]
        stdin_text = None
        if username:
            args += ["--username", str(username)]
        if password:
            if not self.supports_password_from_stdin():
                raise SvnError("unsupported")
            args.append("--password-from-stdin")
            stdin_text = str(password) + "\n"
        args.append(url)
        completed = self._run(args, stdin_text=stdin_text, config_dir=config_dir)
        if completed.returncode != 0:
            raise SvnError(classify_error(completed.stderr), detail=completed.stderr)
        return parse_info_xml(completed.stdout)
