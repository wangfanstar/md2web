#!/usr/bin/env sh
# 启动文档站服务：
#   - 默认认证编辑服务（Python 3.6.8+ 同一套依赖：server/requirements.txt）
#   - 缺少依赖时自动安装：非 root 优先 --user（避免系统目录权限不足），优先离线包 server/wheels
#   - 仍失败则降级为只读预览（无写接口）
#   - 强制只读预览：./start_linux.sh --preview
#   - 指定解释器：PYTHON=python3.9 ./start_linux.sh
#   - 若从 Windows 拷贝导致 CRLF 报 “No such file or directory”：
#       sed -i 's/\r$//' start_linux.sh && chmod +x start_linux.sh
#     或直接运行: sh start_linux.sh   /   python3 serve.py
set -e
cd "$(dirname "$0")"

# CRLF 自愈：本文件若含 \r（Windows 拷贝），去 CR 后重新执行自身
if grep -q "$(printf '\r')" "$0" 2>/dev/null; then
  normalized="$(mktemp 2>/dev/null || echo /tmp/md2web-start.$$)"
  tr -d '\r' < "$0" > "$normalized"
  chmod +x "$normalized" 2>/dev/null || true
  echo "[提示] 检测到脚本含 CRLF（可能从 Windows 拷贝），已自动转换后继续执行。" >&2
  exec "$normalized" "$@"
fi

# 选择一个可用的解释器（优先较新版本）
PY=""
if [ -n "$PYTHON" ]; then
  PY="$PYTHON"
else
  for candidate in python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "未找到 python：请安装 Python 3.6.8+" >&2
  exit 1
fi

# 认证编辑依赖：缺失时自动安装
if ! "$PY" -c "import flask, waitress" >/dev/null 2>&1; then
  echo "[提示] 未安装认证编辑服务依赖，正在安装 ..."
  # 非 root 时优先用户级安装（RHEL/CentOS 系统目录通常不可写）
  if [ "$(id -u 2>/dev/null || echo 0)" -eq 0 ]; then
    first_flags=""
    second_flags="--user"
  else
    first_flags="--user"
    second_flags=""
  fi
  installed=0
  if [ -d server/wheels ]; then
    for flags in "$first_flags" "$second_flags"; do
      # shellcheck disable=SC2086
      if "$PY" -m pip install $flags --no-index --find-links server/wheels -r server/requirements.txt; then
        installed=1
        break
      fi
    done
  fi
  if [ "$installed" -ne 1 ]; then
    for flags in "$first_flags" "$second_flags"; do
      # shellcheck disable=SC2086
      if "$PY" -m pip install $flags -r server/requirements.txt; then
        installed=1
        break
      fi
    done
  fi
  if ! "$PY" -c "import flask, waitress" >/dev/null 2>&1; then
    echo "[警告] 依赖仍不可用，将以只读预览模式启动（无法登录编辑）。" >&2
    echo "        若提示 Permission denied：请改用有写权限的账号，或加 --user / sudo，例如：" >&2
    echo "          $PY -m pip install --user --no-index --find-links server/wheels -r server/requirements.txt" >&2
    echo "        老版本 pip 先升级：$PY -m pip install --user --upgrade 'pip<22'" >&2
  fi
fi

exec "$PY" serve.py "$@"
