#!/usr/bin/env sh
# 启动 / 停止 md2web 服务（Linux）：
#   ./start_linux.sh                 后台启动（默认），日志写入 data/serve.log
#   ./start_linux.sh --foreground    前台运行（Ctrl+C 停止）
#   ./start_linux.sh --stop          停止后台实例（按 pidfile）
#   ./start_linux.sh --restart       强制重启：先停本实例，再结束占用端口的进程后重新启动
#   端口被其它进程占用时：显示占用进程信息（PID/用户/命令），
#   确认后强制结束；10 秒无操作自动强制结束；回答 n 取消启动
#   ./start_linux.sh --status        查看运行状态（pid / 进程名 / 端口）
#   ./start_linux.sh --port 8891     指定端口启动（也可直接写 ./start_linux.sh 8891）
#                                      留空时取配置 server.port，默认 8882
#   ./start_linux.sh --preview       只读预览（其它参数原样透传给 serve.py）
#   ./start_linux.sh --bind 127.0.0.1  仅本机访问（默认 0.0.0.0，局域网可访问）
#   PYTHON=python3.9 ./start_linux.sh  指定解释器
#   注意：开关要连写（`--restart`）；写成 `-- restart` 也会被识别，`--` 会被忽略
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
  echo "        建议同时修复工作区文件：sed -i 's/\r$//' start_linux.sh && chmod +x start_linux.sh" >&2
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
expect_value=0
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  arg="$1"
  shift
  if [ "$expect_value" -eq 1 ]; then
    # 上一个参数需要取值（--port/--bind 等），原样保留
    set -- "$@" "$arg"
    expect_value=0
    i=$((i + 1))
    continue
  fi
  case "$arg" in
    --) ;;  # 容忍 `./start_linux.sh -- restart` 这类多打了分隔符的写法
    --foreground|--fg|foreground|fg) MODE="foreground" ;;
    --stop|stop) MODE="stop" ;;
    --restart|restart) MODE="restart" ;;
    --status|status) MODE="status" ;;
    --port|--pidfile|--bind|--config|--title|--svn-command)
      set -- "$@" "$arg"
      expect_value=1
      ;;
    *)
      case "$arg" in
        ''|*[!0-9]*) set -- "$@" "$arg" ;;
        *) set -- "$@" --port "$arg" ;;  # 纯数字参数：当作端口号（./start_linux.sh 8891）
      esac
      ;;
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

validate_port() {
  port="$1"
  case "$port" in
    ''|*[!0-9]*)
      echo "[错误] 端口必须是数字：$port" >&2
      exit 1
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "[错误] 端口必须在 1-65535 之间：$port" >&2
    exit 1
  fi
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

human_duration() {
  # 秒 → 可读时长（1天2小时 / 3小时5分 / 12分30秒 / 45秒）
  seconds="$1"
  case "$seconds" in
    ''|*[!0-9]*) printf '%s' "?" ; return ;;
  esac
  days=$((seconds / 86400)); rest=$((seconds % 86400))
  hours=$((rest / 3600)); rest=$((rest % 3600))
  mins=$((rest / 60)); secs=$((rest % 60))
  if [ "$days" -gt 0 ]; then
    printf '%s' "${days}天${hours}小时"
  elif [ "$hours" -gt 0 ]; then
    printf '%s' "${hours}小时${mins}分"
  elif [ "$mins" -gt 0 ]; then
    printf '%s' "${mins}分${secs}秒"
  else
    printf '%s' "${secs}秒"
  fi
}

process_info() {
  # 打印进程信息：PID | 用户 | 运行时长 | 命令行（优先 /proc，回退 ps）
  pid="$1"
  user=""
  cmd=""
  etime=""
  if [ -r "/proc/$pid/status" ]; then
    uid="$(sed -n 's/^Uid:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "/proc/$pid/status" 2>/dev/null | head -n 1)"
    if [ -n "$uid" ]; then
      user="$(id -nu "$uid" 2>/dev/null || printf '%s' "$uid")"
    fi
    start_ticks="$(sed 's/^[0-9]* (.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')"
    uptime_s="$(cut -d. -f1 /proc/uptime 2>/dev/null)"
    clk="$(getconf CLK_TCK 2>/dev/null)"
    [ -n "$clk" ] || clk=100
    case "$start_ticks" in
      ''|*[!0-9]*) ;;
      *)
        case "$uptime_s" in
          ''|*[!0-9]*) ;;
          *) etime="$(human_duration "$((uptime_s - start_ticks / clk))")" ;;
        esac
        ;;
    esac
  fi
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-140)"
    case "$cmd" in *[!\ ]*) ;; *) cmd="" ;; esac
  fi
  if [ -z "$cmd" ]; then
    cmd="$(ps -o args= -p "$pid" 2>/dev/null | head -n 1 | cut -c1-140)"
  fi
  if [ -z "$user" ]; then
    user="$(ps -o user= -p "$pid" 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  fi
  [ -n "$user" ] || user="?"
  [ -n "$etime" ] || etime="?"
  [ -n "$cmd" ] || cmd="未知命令（可能需要 sudo 查看）"
  printf 'PID %s | 用户 %s | 已运行 %s | %s' "$pid" "$user" "$etime" "$cmd"
}

kill_port_holder() {
  port="$1"
  announce="${2:-1}"  # 0 = 调用方已打印过占用进程信息
  pids="$(port_holders "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    if [ "$announce" = "1" ]; then
      echo "[提示] 端口 $port 被占用：$(process_info "$pid")"
    fi
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

# 启动前检查端口占用：打印占用进程信息并询问是否强制结束；
# 10 秒无操作（或非交互式启动）自动强制结束；按 n 取消启动。
confirm_port_conflict() {
  port="$1"
  pids="$(port_holders "$port")"
  [ -n "$pids" ] || return 0
  own_pid="$(read_pid)"
  foreign=""
  for pid in $pids; do
    if [ -n "$own_pid" ] && [ "$pid" = "$own_pid" ]; then
      continue
    fi
    foreign="$foreign $pid"
  done
  if [ -z "$foreign" ]; then
    echo "[提示] 端口 $port 由本项目实例（PID $own_pid）占用：serve.py 会按 pidfile 重启该实例。"
    return 0
  fi
  echo "[提示] 端口 $port 已被下列进程占用：" >&2
  for pid in $foreign; do
    echo "        $(process_info "$pid")" >&2
  done
  if [ -t 0 ] || [ -r /dev/tty ]; then
    if prompt_kill_or_cancel; then
      echo "[提示] 强制结束占用进程。" >&2
    else
      echo "" >&2
      echo "[提示] 已取消启动：请先手动结束占用进程，或用 ./start_linux.sh --restart 强制重启。" >&2
      exit 1
    fi
  else
    echo "[提示] 非交互式启动：自动强制结束占用进程。" >&2
  fi
  kill_port_holder "$port" 0 || true
}

# 交互确认：y/回车/超时（10 秒）→ 返回 0（强制结束）；n → 返回 1（取消）
# 说明：dash 等 /bin/sh 不支持 read -t，优先用 coreutils 的 timeout 读取 /dev/tty；
#       两者都不可用时才退回 read -t（不支持时按超时处理，行为仍是自动强制结束）。
prompt_kill_or_cancel() {
  printf '[提示] 是否强制结束以上进程以便启动？10 秒内未选择将自动强制结束 [Y/n] ' >&2
  answer=""
  status=0
  if command -v timeout >/dev/null 2>&1 && [ -r /dev/tty ]; then
    answer="$(timeout 10 sh -c 'IFS= read -r line && printf "%s" "$line"' < /dev/tty 2>/dev/null)" || status=$?
  elif read -t 10 answer 2>/dev/null; then
    status=0
  else
    status=124
  fi
  if [ "$status" = "124" ]; then
    echo "" >&2
    echo "[提示] 10 秒无操作，自动强制结束占用进程。" >&2
    return 0
  fi
  case "$answer" in
    n|N|no|No|NO) return 1 ;;
  esac
  return 0
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
    validate_port "$target_port"
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

# 端口已被占用（非本项目实例）时：显示进程信息并确认，10 秒无操作自动强制结束
case "$MODE" in
  background|foreground)
    target_port="$(resolve_port "$@")"
    validate_port "$target_port"
    confirm_port_conflict "$target_port"
    ;;
esac

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

if [ -z "$target_port" ]; then
  target_port="$(resolve_port "$@")"
fi

echo "[提示] 正在后台启动 md2web 服务（解释器 $PY）..."
# -u：日志不缓冲，启动横幅立即写入，便于判断就绪与排障
nohup "$PY" -u serve.py "$@" >>"$LOG_FILE" 2>&1 &
launcher_pid=$!

# 等待服务就绪（最多约 20 秒）：pidfile 进程存活且端口已监听；
# 没有 ss/lsof/fuser 时回退到日志关键字
ready=0
waited=0
while [ "$waited" -lt 20 ]; do
  sleep 1
  waited=$((waited + 1))
  pid="$(read_pid)"
  if [ -n "$pid" ] && is_alive "$pid"; then
    if [ -n "$(port_holders "$target_port")" ]; then
      ready=1
      break
    fi
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

echo "[错误] 服务未能在预期时间内就绪。" >&2
if [ -n "$pid" ] && is_alive "$pid"; then
  if [ -n "$(port_holders "$target_port")" ]; then
    echo "[提示] 进程 $pid 仍在运行且端口 $target_port 已监听：服务可能已启动，请刷新浏览器确认。" >&2
  else
    echo "[提示] 进程 $pid 仍在运行，但端口 $target_port 尚未监听：仍在初始化或绑定失败。" >&2
    echo "       $(process_info "$pid")" >&2
  fi
else
  echo "[提示] pidfile 进程未在运行（pidfile $PIDFILE${pid:+，记录的 PID $pid}）。" >&2
fi
if [ -s "$LOG_FILE" ]; then
  echo "最近日志（$LOG_FILE）：" >&2
  tail -n 20 "$LOG_FILE" >&2
else
  echo "日志为空：$LOG_FILE（进程可能未启动或尚未输出）" >&2
fi
if grep -q "已被占用" "$LOG_FILE" 2>/dev/null; then
  echo "[提示] 端口被占用：可执行 ./start_linux.sh --restart 强制结束占用进程后重启" >&2
fi
exit 1
