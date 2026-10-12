#!/usr/bin/env sh
# 启动 / 停止 md2web 服务（Linux）：
#   ./start_linux.sh                 后台启动（默认），日志写入 data/serve.log
#   ./start_linux.sh --foreground    前台运行（Ctrl+C 停止）
#   ./start_linux.sh --stop          停止后台实例（按 pidfile）
#   ./start_linux.sh --restart       强制重启：先更新代码（git pull --ff-only），
#                                    再停本实例并结束占用端口的进程后重新启动
#   ./start_linux.sh --update        启动前更新代码（git pull --ff-only）
#   ./start_linux.sh --no-update     跳过代码更新（等价 MD2WEB_NO_UPDATE=1）
#   ./start_linux.sh --rebuild       强制重新构建站点（setup_docsify.py）
#   MD2WEB_GIT_PROXY=http://127.0.0.1:7890 ./start_linux.sh --restart   网络受限时走代理更新
#   MD2WEB_GIT_TIMEOUT=120           git 操作超时秒数（默认 60，避免网络黑洞卡住启动）
#   MD2WEB_UPDATE_ONLY=1 ./start_linux.sh --update   只更新代码，不启动服务
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

# 代码更新相关开关
DO_UPDATE=0    # --update：启动前更新代码
DO_REBUILD=0   # --rebuild：强制重建站点
CONFIG_FILE="config/server.local.json"
NO_UPDATE=0    # --no-update 或 MD2WEB_NO_UPDATE=1：跳过更新
WANT_UPDATE=0  # --restart 默认更新代码
case "${MD2WEB_NO_UPDATE:-0}" in
  1|yes|true|on|YES|TRUE|ON) NO_UPDATE=1 ;;
esac

# 解析脚本自身的开关（其余参数原样透传给 serve.py）
MODE="background"
expect_value=0
value_option=""
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  arg="$1"
  shift
  if [ "$expect_value" -eq 1 ]; then
    if [ "$value_option" = "--config" ]; then CONFIG_FILE="$arg"; fi
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
    --update|update) DO_UPDATE=1 ;;
    --no-update|no-update) NO_UPDATE=1 ;;
    --rebuild|rebuild) DO_REBUILD=1 ;;
    --port|--pidfile|--bind|--config|--title|--svn-command)
      set -- "$@" "$arg"
      expect_value=1
      value_option="$arg"
      ;;
    --config=*) CONFIG_FILE="${arg#--config=}"; set -- "$@" "$arg" ;;
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
  if [ -z "$port" ] && [ -f "$CONFIG_FILE" ] && [ -n "$PY" ]; then
    port="$("$PY" - "$CONFIG_FILE" <<'PYEOF' 2>/dev/null || true
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
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

# git 统一走 timeout，避免网络黑洞让启动长时间挂起（没有 timeout 时直接执行）
run_git() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${MD2WEB_GIT_TIMEOUT:-60}" git "$@"
  else
    git "$@"
  fi
}

# 认证编辑依赖缺失检测 / 安装（离线包优先、非 root 优先用户级）
has_auth_deps() {
  "$PY" -c "import flask, waitress" >/dev/null 2>&1
}

# 按「离线包优先 → 联网」与「非 root 优先用户级」顺序安装 requirements
pip_install_requirements() {
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
  [ "$installed" -eq 1 ]
}

install_auth_deps() {
  echo "[提示] 未安装认证编辑服务依赖，正在安装 ..."
  if pip_install_requirements && has_auth_deps; then
    return 0
  fi
  echo "[警告] 依赖仍不可用，将以只读预览模式启动（无法登录编辑）。" >&2
  echo "        若提示 Permission denied：请改用有写权限的账号，或加 --user / sudo，例如：" >&2
  echo "          $PY -m pip install --user --no-index --find-links server/wheels -r server/requirements.txt" >&2
  echo "        老版本 pip 先升级：$PY -m pip install --user --upgrade 'pip<22'" >&2
  return 1
}

SITE_REBUILT=0
rebuild_site() {
  if [ "$SITE_REBUILT" -eq 1 ]; then
    return 0
  fi
  if [ ! -f setup_docsify.py ]; then
    echo "[提示] 未找到 setup_docsify.py，跳过站点重建。" >&2
    return 1
  fi
  echo "[提示] 正在重建站点（$PY setup_docsify.py）..."
  if "$PY" setup_docsify.py --allow-empty --reconcile-config --config "$CONFIG_FILE"; then
    SITE_REBUILT=1
    echo "[提示] 站点重建完成。"
    return 0
  fi
  echo "[警告] 站点重建失败：继续使用现有生成物（页面可能不是最新）。" >&2
  return 1
}

# 从远端更新代码：git pull --ff-only（可用 MD2WEB_GIT_PROXY 走代理）；
# 更新到新提交后按需重建站点 / 补装依赖。返回 0=已最新或已更新，1=跳过或失败。
update_code() {
  if [ "$NO_UPDATE" -eq 1 ]; then
    echo "[提示] 已跳过代码更新（--no-update / MD2WEB_NO_UPDATE=1）。"
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "[警告] 未找到 git，跳过代码更新：继续使用当前工作区代码。" >&2
    return 1
  fi
  if [ ! -e .git ]; then
    echo "[提示] 当前目录不是 git 工作副本（无 .git），跳过代码更新。" >&2
    echo "        若为拷贝/rsync 部署，请先在部署目录同步最新文件（或改用 git clone 部署）。" >&2
    return 1
  fi
  old_head="$(git rev-parse HEAD 2>/dev/null || true)"
  # 服务运行时会自动重建 docs/（生成物会变成与服务器配置一致），这些改动会阻止快进更新：
  # 仅允许还原生成物；docs/md 和参考网页等源资料的修改/删除必须保留。
  reset_docs=0
  dirty="$(git -c core.quotepath=false status --porcelain --untracked-files=no 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    only_docs=1
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$(printf '%s' "$line" | cut -c4-)" in
        docs/index.html|docs/lib/*|docs/html/ref/index_html.html) ;;
        docs/html/images/*|docs/html/uploads/*|docs/html/ref/*) only_docs=0 ;;
        docs/html/*) ;;
        *) only_docs=0 ;;
      esac
    done <<EOF
$dirty
EOF
    if [ "$only_docs" -eq 1 ]; then
      echo "[提示] 本地改动仅涉及站点生成物，先还原生成物再更新代码 ..."
      # 保留服务器原来的目录证据，避免更新生成物后丢失“已删除的 SVN 目录”信息。
      mkdir -p data
      if [ -f docs/lib/source-folders.json ]; then
        cp docs/lib/source-folders.json data/source-folders-before-update.json
      fi
      if [ -f docs/html/search-index.json ]; then
        cp docs/html/search-index.json data/search-index-before-update.json
      fi
      reset_failed=0
      for generated_path in docs/index.html docs/lib docs/html; do
        if git ls-files --error-unmatch "$generated_path" >/dev/null 2>&1; then
          git checkout -- "$generated_path" 2>/dev/null || reset_failed=1
        fi
      done
      if [ "$reset_failed" -eq 0 ]; then
        reset_docs=1
      else
        echo "[警告] 还原 docs/ 失败，可能影响快进更新。" >&2
      fi
    else
      echo "[提示] 工作区有源资料或代码的修改/删除，保留这些改动；若快进失败请先提交或备份。" >&2
    fi
  fi
  proxy="${MD2WEB_GIT_PROXY:-}"
  pull_status=0
  if [ -n "$proxy" ]; then
    echo "[提示] 正在更新代码（git pull --ff-only，代理 $proxy）..."
    run_git -c "http.proxy=$proxy" -c "https.proxy=$proxy" pull --ff-only || pull_status=$?
  else
    echo "[提示] 正在更新代码（git pull --ff-only）..."
    run_git pull --ff-only || pull_status=$?
  fi
  if [ "$pull_status" -ne 0 ]; then
    echo "[警告] 代码更新失败：继续使用当前工作区代码（功能可能不是最新）。" >&2
    dirty="$(git status --porcelain 2>/dev/null | head -n 5 || true)"
    if [ -n "$dirty" ]; then
      echo "        工作区有未提交改动，可能阻止了快进更新：" >&2
      printf '%s\n' "$dirty" | sed 's/^/          /' >&2
      echo "        可先 git stash（或提交/丢弃改动）后重试。" >&2
    fi
    echo "        网络受限（直连 github.com 被重置）时可设置代理后重试：" >&2
    echo "          MD2WEB_GIT_PROXY=http://127.0.0.1:7890 ./start_linux.sh --restart" >&2
    echo "        或先手动执行：git pull --ff-only" >&2
    if [ "$reset_docs" -eq 1 ]; then
      echo "[提示] 已还原 docs/ 生成物，先按本机配置重建站点 ..."
      rebuild_site || true
    fi
    return 1
  fi
  new_head="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$new_head" ] || [ "$old_head" = "$new_head" ]; then
    echo "[提示] 代码已是最新（HEAD $(printf '%.7s' "$new_head")）。"
    if [ "$reset_docs" -eq 1 ]; then
      echo "[提示] 已还原 docs/ 生成物，按本机配置重建站点 ..."
      rebuild_site || true
    fi
    return 0
  fi
  echo "[提示] 代码已更新：$(printf '%.7s' "$old_head") → $(printf '%.7s' "$new_head")"
  changed="$(git diff --name-only "$old_head" "$new_head" 2>/dev/null || true)"
  # 依赖清单变化 → 重新安装（离线包优先）
  case "$changed" in
    *server/requirements.txt*)
      echo "[提示] 依赖清单已变化，正在更新认证服务依赖 ..."
      if pip_install_requirements && has_auth_deps; then
        echo "[提示] 认证服务依赖已更新。"
      else
        install_auth_deps || true
      fi
      ;;
  esac
  # 生成物已随提交同步时无需重建；前端源码/构建脚本/源文档变化但生成物没变时需要重建
  needs_rebuild=0
  case "$changed" in
    *web/*|*setup_docsify.py*|*docs/md/*) needs_rebuild=1 ;;
  esac
  case "$changed" in
    *docs/lib/*|*docs/html/*) needs_rebuild=0 ;;
  esac
  if [ "$reset_docs" -eq 1 ]; then
    needs_rebuild=1  # 还原过生成物：按本机配置重建，保证站点与服务器配置一致
  fi
  if [ "$needs_rebuild" -eq 1 ]; then
    rebuild_site || true
  else
    echo "[提示] 生成物已随代码更新，无需重建站点。"
  fi
  return 0
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
# 优先单键确认：临时关闭终端行缓冲（stty -icanon）后读一个字符，输入 y/n 无需回车，
#   10 秒无输入由终端驱动（min 0 time 100 = 10 秒）负责超时，避免 read -t 在 dash 下不可用；
# 不支持 stty/dd 时退回 coreutils timeout 或 read -t（这两种需要回车确认）。
prompt_kill_or_cancel() {
  printf '[提示] 是否强制结束以上进程以便启动？10 秒内未选择将自动强制结束 [Y/n] ' >&2
  answer=""
  status=0
  single_key=0
  saved_tty=""
  if [ -r /dev/tty ] && command -v stty >/dev/null 2>&1 && command -v dd >/dev/null 2>&1; then
    saved_tty="$(stty -g < /dev/tty 2>/dev/null)" || saved_tty=""
    if [ -n "$saved_tty" ] && stty -icanon -echo min 0 time 100 < /dev/tty 2>/dev/null; then
      answer="$(dd bs=1 count=1 2>/dev/null < /dev/tty)"
      stty "$saved_tty" < /dev/tty 2>/dev/null || true
      single_key=1
      case "$answer" in
        '') printf '\n' >&2 ;;
        *) printf '%s\n' "$answer" >&2 ;;
      esac
    fi
  fi
  if [ "$single_key" -eq 0 ]; then
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
    WANT_UPDATE=1
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

# 代码更新：--restart 默认更新；--update 显式更新；--no-update / MD2WEB_NO_UPDATE=1 跳过。
# 更新后再启动，保证重启拿到的就是仓库里的最新功能（前端生成物随提交同步）。
if [ "$WANT_UPDATE" -eq 1 ] || [ "$DO_UPDATE" -eq 1 ]; then
  update_code || true
fi
if [ "$DO_REBUILD" -eq 1 ]; then
  rebuild_site || true
fi

# MD2WEB_UPDATE_ONLY=1：只更新代码（供部署脚本/测试调用），不启动服务
if [ "$WANT_UPDATE" -eq 1 ] || [ "$DO_UPDATE" -eq 1 ]; then
  case "${MD2WEB_UPDATE_ONLY:-0}" in
    1|yes|true|on|YES|TRUE|ON)
      echo "[提示] MD2WEB_UPDATE_ONLY=1：仅更新代码，不启动服务。"
      exit 0
      ;;
  esac
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
if ! has_auth_deps; then
  install_auth_deps || true
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
probe_bind="0.0.0.0"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--bind" ]; then probe_bind="$arg"; fi
  case "$arg" in --bind=*) probe_bind="${arg#--bind=}" ;; esac
  prev="$arg"
done

# 将已解析的配置端口传给服务，依赖缺失回退只读预览时也保持同一访问地址。
set -- "$@" --port "$target_port"

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
if [ -f "$LOG_FILE" ]; then cp "$LOG_FILE" "$LOG_FILE.previous"; fi
nohup "$PY" -u serve.py "$@" >"$LOG_FILE" 2>&1 < /dev/null &
launcher_pid=$!

# 以本次进程存活且首页返回 HTTP 200 为准；首次构建允许更长初始化时间。
ready=0
waited=0
while [ "$waited" -lt 120 ]; do
  sleep 1
  waited=$((waited + 1))
  if ! is_alive "$launcher_pid"; then
    break
  fi
  pid="$(read_pid)"
  if [ -n "$pid" ] && is_alive "$pid"; then
    if "$PY" -c 'import sys; from serve import homepage_ready; sys.exit(0 if homepage_ready(sys.argv[1], int(sys.argv[2])) else 1)' "$probe_bind" "$target_port"; then
      ready=1
      break
    fi
  fi
  if [ "$waited" -eq 20 ] || [ "$waited" -eq 60 ]; then
    echo "[提示] 正在初始化，等待首页可访问；日志：$LOG_FILE"
  fi
done

pid="$(read_pid)"
if [ "$ready" -eq 1 ] && [ -n "$pid" ] && is_alive "$pid"; then
  echo "已启动（PID $pid，进程名 md2web-serve，index.html 已通过 HTTP 访问检查）"
  grep -E "认证编辑服务|预览目录|本机访问|局域网访问" "$LOG_FILE" 2>/dev/null | tail -n 4 || true
  echo "访问首页请使用上述地址（包含 :$target_port 端口）或在地址后加 /index.html。"
  echo "若本机可打开而其他电脑打不开，请检查服务器防火墙是否放行 $target_port/tcp。"
  echo "日志：$LOG_FILE"
  echo "停止：./start_linux.sh --stop    状态：./start_linux.sh --status"
  exit 0
fi

echo "[错误] 服务未能在预期时间内就绪。" >&2
if [ -n "$pid" ] && is_alive "$pid"; then
  if [ -n "$(port_holders "$target_port")" ]; then
    echo "[提示] 进程 $pid 仍在运行且端口 $target_port 已监听，但 index.html 尚未通过 HTTP 检查，请查看下面的本次启动日志。" >&2
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
