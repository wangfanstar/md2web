#!/usr/bin/env sh
# 启动 / 停止 md2web 服务（Linux）：
#   ./start_linux.sh                 后台启动（默认），日志写入 data/serve.log
#   ./start_linux.sh --foreground    前台运行（Ctrl+C 停止）
#   ./start_linux.sh --stop          停止后台实例（按 pidfile）
#   ./start_linux.sh --restart       强制重启：先停本实例，再结束占用端口的进程后重新启动
#   ./start_linux.sh --status        查看运行状态（pid / 进程名 / 端口）
#   ./start_linux.sh --preview       只读预览（其它参数原样透传给 serve.py）
#   ./start_linux.sh --bind 127.0.0.1  仅本机访问（默认 0.0.0.0，局域网可访问）
#   PYTHON=python3.9 ./start_linux.sh  指定解释器
# 若从 Windows 拷贝导致 CRLF 报 “No such file or directory”：
#   sed -i 's/\r$//' start_linux.sh && chmod +x start_linux.sh
# 或直接运行: sh start_linux.sh   /   python3 serve.py
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

# 先确定解释器（端口解析/依赖安装都要用）
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

# 解析脚本自身的开关（其余参数原样透传给 serve.py）
MODE="background"
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  arg="$1"
  shift
  case "$arg" in
    --foreground|--fg) MODE="foreground" ;;
    --stop) MODE="stop" ;;
    --restart) MODE="restart" ;;
    --status) MODE="status" ;;
    *) set -- "$@" "$arg" ;;
  esac
  i=$((i + 1))
done

# 取出 --pidfile（停止/状态用）
PIDFILE="data/serve.pid"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--pidfile" ]; then
    PIDFILE="$arg"
  fi
  case "$arg" in
    --pidfile=*) PIDFILE="${arg#--pidfile=}" ;;
  esac
  prev="$arg"
done

resolve_port() {
  # 端口优先级：--port > 配置 server.port > 8882
  port=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--port" ]; then
      port="$arg"
    fi
    case "$arg" in
      --port=*) port="${arg#--port=}" ;;
    esac
    prev="$arg"
  done
  if [ -z "$port" ] && [ -f config/server.local.json ] && [ -n "$PY" ]; then
    port="$("$PY" - <<'PYEOF' 2>/dev/null || true
import json
from pathlib import Path
path = Path("config/server.local.json")
if path.is_file():
    try:
        print(json.loads(path.read_text(encoding="utf-8")).get("server", {}).get("port", ""))
    except Exception:
        pass
PYEOF
)"
  fi
  [ -n "$port" ] || port=8882
  printf '%s' "$port"
}

port_holders() {
  port="$1"
  pids=""
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -lptnH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)"
  fi
  if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u)"
  fi
  if [ -z "$pids" ] && command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null | tr ' ' '\n' | tr -cd '0-9\n' | sed '/^$/d' | sort -u)"
  fi
  printf '%s' "$pids"
}

kill_port_holder() {
  port="$1"
  pids="$(port_holders "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    info="$(ps -o comm=,args= -p "$pid" 2>/dev/null | head -n 1 | cut -c1-120)"
    echo "[提示] 端口 $port 被进程 $pid 占用：${info:-未知进程}"
    kill "$pid" 2>/dev/null || true
  done
  waited=0
  while [ "$waited" -lt 5 ]; do
    sleep 1
    waited=$((waited + 1))
    remaining="$(port_holders "$port")"
    [ -z "$remaining" ] && break
  done
  remaining="$(port_holders "$port")"
  if [ -n "$remaining" ]; then
    echo "[提示] 进程未退出，强制结束：$remaining"
    for pid in $remaining; do
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
  fi
  remaining="$(port_holders "$port")"
  if [ -n "$remaining" ]; then
    echo "[警告] 端口 $port 仍被占用（$remaining）：可能是其他用户的进程，请用 sudo 结束，例如：" >&2
    echo "        sudo fuser -k $port/tcp   或   sudo kill -9 $remaining" >&2
    return 1
  fi
  echo "[提示] 端口 $port 已释放。"
  return 0
}

read_pid() {
  if [ -f "$PIDFILE" ]; then
    tr -cd '0-9' < "$PIDFILE"
  fi
}

is_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

case "$MODE" in
  restart)
    # 先按 pidfile 停本实例（若在运行）
    pid="$(read_pid)"
    if [ -n "$pid" ] && is_alive "$pid"; then
      echo "[提示] 停止旧实例（PID $pid）..."
      kill "$pid" 2>/dev/null || true
      waited=0
      while is_alive "$pid" && [ "$waited" -lt 10 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      if is_alive "$pid"; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PIDFILE"
    # 释放端口（可能是未记录 pidfile 的旧实例）
    target_port="$(resolve_port "$@")"
    echo "[提示] 检查端口 $target_port 占用情况..."
    kill_port_holder "$target_port" || true
    MODE="background"
    ;;
  stop)
    pid="$(read_pid)"
    if [ -z "$pid" ]; then
      echo "[提示] 未找到 pidfile（$PIDFILE）：服务可能未在运行。"
      exit 0
    fi
    if ! is_alive "$pid"; then
      echo "[提示] 进程 $pid 已不存在，清理 pidfile。"
      rm -f "$PIDFILE"
      exit 0
    fi
    echo "[提示] 正在停止 md2web 服务（PID $pid）..."
    kill "$pid" 2>/dev/null || true
    waited=0
    while is_alive "$pid" && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if is_alive "$pid"; then
      echo "[警告] 进程未退出，强制结束。"
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
    echo "已停止。"
    exit 0
    ;;
  status)
    pid="$(read_pid)"
    if [ -n "$pid" ] && is_alive "$pid"; then
      echo "运行中：PID $pid（pidfile $PIDFILE）"
    else
      echo "未运行（pidfile $PIDFILE${pid:+，记录的 PID $pid 已不存在}）"
    fi
    echo "进程列表（按名字匹配 md2web）："
    ps -o pid,ppid,stat,etime,comm,args -C md2web-serve 2>/dev/null \
      || ps -ef | grep '[m]d2web' \
      || true
    exit 0
    ;;
esac

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

# 默认监听所有网卡（局域网可访问）；仅本机使用请在命令行加 --bind 127.0.0.1
has_bind=0
for arg in "$@"; do
  case "$arg" in
    --bind|--bind=*) has_bind=1 ;;
  esac
done
if [ "$has_bind" -eq 0 ]; then
  set -- "$@" --bind 0.0.0.0
fi

if [ "$MODE" = "foreground" ]; then
  exec "$PY" serve.py "$@"
fi

# 后台启动：日志写入 data/serve.log，PID 由 serve.py 写入 pidfile
LOG_DIR="$(dirname "$PIDFILE")"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/serve.log"
has_no_browser=0
for arg in "$@"; do
  case "$arg" in
    --no-browser) has_no_browser=1 ;;
  esac
done
if [ "$has_no_browser" -eq 0 ]; then
  set -- "$@" --no-browser
fi

echo "[提示] 正在后台启动 md2web 服务（解释器 $PY）..."
nohup "$PY" serve.py "$@" >>"$LOG_FILE" 2>&1 &
launcher_pid=$!

# 等待服务就绪（最多约 15 秒）
ready=0
waited=0
while [ "$waited" -lt 15 ]; do
  sleep 1
  waited=$((waited + 1))
  pid="$(read_pid)"
  if [ -n "$pid" ] && is_alive "$pid"; then
    if grep -q "认证编辑服务" "$LOG_FILE" 2>/dev/null || grep -q "预览目录" "$LOG_FILE" 2>/dev/null; then
      ready=1
      break
    fi
  fi
  if ! is_alive "$launcher_pid"; then
    break
  fi
done

pid="$(read_pid)"
if [ "$ready" -eq 1 ] && [ -n "$pid" ] && is_alive "$pid"; then
  echo "已启动（PID $pid，进程名 md2web-serve）"
  grep -E "认证编辑服务|预览目录|本机访问|局域网访问" "$LOG_FILE" 2>/dev/null | tail -n 4 || true
  echo "日志：$LOG_FILE"
  echo "停止：./start_linux.sh --stop    状态：./start_linux.sh --status"
  exit 0
fi

echo "[错误] 服务未能在预期时间内就绪，最近日志：" >&2
tail -n 20 "$LOG_FILE" 2>/dev/null || true
if grep -q "已被占用" "$LOG_FILE" 2>/dev/null; then
  echo "[提示] 端口被占用：可执行 ./start_linux.sh --restart 强制结束占用进程后重启" >&2
fi
exit 1
