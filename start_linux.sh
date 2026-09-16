#!/usr/bin/env sh
# 启动文档站服务：
#   - 默认认证编辑服务（Python 3.6.8 用 server/requirements-py36.txt，Python 3.8+ 用 server/requirements.txt）
#   - 依赖缺失时自动降级为只读预览（无写接口）
#   - 强制只读预览：./start_linux.sh --preview
#   - 指定解释器：PYTHON=python3.9 ./start_linux.sh
set -e
cd "$(dirname "$0")"
if [ -n "$PYTHON" ]; then
  exec "$PYTHON" serve.py "$@"
fi
for candidate in python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" serve.py "$@"
  fi
done
echo "未找到 python：请安装 Python 3.6.8+（认证编辑服务需配合对应 requirements）" >&2
exit 1
