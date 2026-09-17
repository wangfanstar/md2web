#!/usr/bin/env sh
# 启动文档站服务：
#   - 默认认证编辑服务（Python 3.6.8+ 同一套依赖：server/requirements.txt）
#   - 缺少依赖时优先用离线包安装（server/wheels，Linux x86_64 + cp36），失败再联网安装
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

# 认证编辑依赖：缺失时优先离线 wheels，其次联网安装
if ! "$PY" -c "import flask, waitress" >/dev/null 2>&1; then
  echo "[提示] 未安装认证编辑服务依赖，尝试安装 ..."
  installed=1
  if [ -d server/wheels ]; then
    echo "       使用离线包: server/wheels（--no-index --find-links）"
    "$PY" -m pip install --no-index --find-links server/wheels -r server/requirements.txt || installed=0
  fi
  if [ "$installed" -ne 1 ]; then
    echo "       离线包安装失败，尝试联网安装 ..."
    "$PY" -m pip install --user -r server/requirements.txt || "$PY" -m pip install -r server/requirements.txt || true
  fi
  if ! "$PY" -c "import flask, waitress" >/dev/null 2>&1; then
    echo "[警告] 依赖仍不可用，将以只读预览模式启动（无法登录编辑）。" >&2
    echo "        手动安装: $PY -m pip install --no-index --find-links server/wheels -r server/requirements.txt" >&2
  fi
fi

exec "$PY" serve.py "$@"
