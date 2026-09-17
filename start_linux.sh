#!/usr/bin/env sh
# 启动文档站服务：
#   - 默认认证编辑服务（Python 3.6.8+ 同一套依赖：server/requirements.txt）
#   - 依赖缺失时自动降级为只读预览（无写接口）
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

if [ -n "$PYTHON" ]; then
  exec "$PYTHON" serve.py "$@"
fi
for candidate in python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" serve.py "$@"
  fi
done
echo "未找到 python：请安装 Python 3.6.8+" >&2
exit 1
