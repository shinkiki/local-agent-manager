#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
USER_HOME="${HOME:?HOME is required}"
APP_DATA_DIR="$USER_HOME/Library/Application Support/com.shinc.agentmanager"
SETTINGS_FILE="$APP_DATA_DIR/backend-service-settings.json"
STATIC_DIR="$REPO_ROOT/dist"
BACKEND_BIN="$REPO_ROOT/target/debug/agent-manager-server"
BACKEND_OUT="${TMPDIR:-/tmp}/agent-manager-dev-backend.out.log"
BACKEND_ERR="${TMPDIR:-/tmp}/agent-manager-dev-backend.err.log"
REMOTE_WRITE=false
FRONTEND_PORT=1420
LAUNCH_LABEL="com.shinc.agentmanager.remote-write"
BACKEND_PID=""
FRONTEND_PID=""

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/restart-dev.sh [--remote-write]

Builds the current frontend and debug backend, safely stops existing Agent
Manager frontend/backend processes, then starts one standalone backend and the
Tauri development frontend. Ctrl+C stops both processes.

  --remote-write  Require the current Tailscale identity and Serve target, and
                  expose the backend with remote write access.
EOF
}

case "${1:-}" in
  "") ;;
  --remote-write) REMOTE_WRITE=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; fail "지원하지 않는 인자입니다: $1" ;;
esac
[ "$#" -le 1 ] || fail "인자는 --remote-write 하나만 사용할 수 있습니다."

for executable in jq lsof curl ps pgrep; do
  command -v "$executable" >/dev/null 2>&1 || fail "$executable 명령이 필요합니다."
done

read_port() {
  if [ ! -f "$SETTINGS_FILE" ]; then
    printf '%s\n' "54178"
    return
  fi
  jq -er '.port | select(type == "number" and floor == . and . >= 1024 and . <= 65535)' \
    "$SETTINGS_FILE" 2>/dev/null \
    || fail "백엔드 서비스 포트 설정이 올바르지 않습니다: $SETTINGS_FILE"
}

PORT="$(read_port)"
EXPECTED_PROTOCOL="$(sed -n 's/^const EXPECTED_BACKEND_PROTOCOL_VERSION = \([0-9][0-9]*\);$/\1/p' "$REPO_ROOT/src/lib/ipc.ts")"
[ -n "$EXPECTED_PROTOCOL" ] || fail "프런트엔드 API 프로토콜 버전을 확인하지 못했습니다."

listener_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

process_executable() {
  lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'
}

redacted_command() {
  process_command "$1" | sed -E 's/(--tailscale-user )[[:graph:]]+/\1[redacted]/g'
}

assert_known_backend() {
  local pid executable command
  pid="$1"
  executable="$(process_executable "$pid")"
  command="$(process_command "$pid")"
  case "$executable" in
    "$REPO_ROOT/target/debug/agent-manager-server"|"$REPO_ROOT/target/release/agent-manager-server")
      return 0
      ;;
    "$REPO_ROOT/target/debug/agent-manager-tauri"|"$REPO_ROOT/target/release/agent-manager-tauri"|"/Applications/Agent Manager.app/Contents/MacOS/agent-manager-tauri")
      [[ "$command" == *" --backend"* ]] && return 0
      ;;
  esac
  fail "포트 $PORT의 PID $pid가 허용된 Agent Manager 백엔드가 아닙니다: $(redacted_command "$pid")"
}

assert_known_frontend() {
  local pid executable cwd command
  pid="$1"
  executable="$(process_executable "$pid")"
  cwd="$(process_cwd "$pid")"
  command="$(process_command "$pid")"
  case "$executable" in
    "$REPO_ROOT/target/debug/agent-manager-tauri"|"$REPO_ROOT/target/release/agent-manager-tauri"|"/Applications/Agent Manager.app/Contents/MacOS/agent-manager-tauri")
      return 0
      ;;
  esac
  if [ "$cwd" = "$REPO_ROOT" ] && [[ "$command" == *"vite"* || "$command" == *"tauri-cli.mjs"* || "$command" == *"@tauri-apps/cli/tauri.js"* ]]; then
    return 0
  fi
  fail "PID $pid가 이 저장소의 Agent Manager 개발 프런트엔드가 아닙니다: $(redacted_command "$pid")"
}

stop_pid() {
  local pid label attempt
  pid="$1"
  label="$2"
  kill -0 "$pid" 2>/dev/null || return 0
  echo "$label 정상 종료 요청: PID $pid"
  kill -TERM "$pid"
  for attempt in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  echo "$label 강제 종료: PID $pid"
  kill -KILL "$pid"
  for attempt in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  fail "$label PID $pid가 종료되지 않았습니다."
}

frontend_candidate_pids() {
  {
    lsof -nP -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -t 2>/dev/null || true
    pgrep -f 'target/debug/agent-manager-tauri' 2>/dev/null || true
    pgrep -f '/Applications/Agent Manager.app/Contents/MacOS/agent-manager-tauri' 2>/dev/null || true
    pgrep -f 'scripts/tauri-cli.mjs dev' 2>/dev/null || true
    pgrep -f '@tauri-apps/cli/tauri.js dev' 2>/dev/null || true
  } | awk -v self="$$" -v parent="$PPID" '$1 != self && $1 != parent' | sort -un
}

stop_existing_frontend() {
  local pid
  for pid in $(frontend_candidate_pids); do
    kill -0 "$pid" 2>/dev/null || continue
    assert_known_frontend "$pid"
    stop_pid "$pid" "기존 프런트엔드"
  done
}

stop_existing_backend() {
  local pids count pid
  /bin/launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
  pids="$(listener_pids)"
  [ -n "$pids" ] || return 0
  count="$(printf '%s\n' "$pids" | wc -l | tr -d ' ')"
  [ "$count" = "1" ] || fail "포트 $PORT 리스너가 $count개라 자동 종료하지 않습니다."
  pid="$pids"
  assert_known_backend "$pid"
  stop_pid "$pid" "기존 백엔드"
  [ -z "$(listener_pids)" ] || fail "포트 $PORT의 기존 리스너가 남아 있습니다."
}

tailscale_executable() {
  if [ -x "/usr/local/bin/tailscale" ]; then
    printf '%s\n' "/usr/local/bin/tailscale"
  elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
    printf '%s\n' "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  else
    fail "Tailscale CLI를 찾을 수 없습니다."
  fi
}

load_tailscale_identity() {
  local status backend_state serve_status serve_key expected_proxy
  TAILSCALE_BIN="$(tailscale_executable)"
  status="$("$TAILSCALE_BIN" status --json 2>&1)"
  printf '%s' "$status" | jq -e . >/dev/null 2>&1 || fail "Tailscale 상태 JSON을 읽지 못했습니다."
  backend_state="$(printf '%s' "$status" | jq -er '.BackendState')"
  [ "$backend_state" = "Running" ] || fail "Tailscale 상태가 Running이 아닙니다: $backend_state"
  TAILNET_HOST="$(printf '%s' "$status" | jq -er '.Self.DNSName | rtrimstr(".")')"
  TAILNET_LOGIN="$(printf '%s' "$status" | jq -er '.Self.UserID as $id | .User[($id | tostring)].LoginName')"
  case "$TAILNET_HOST" in
    *.ts.net) ;;
    *) fail "올바른 Tailnet 호스트를 확인하지 못했습니다." ;;
  esac
  [ -n "$TAILNET_LOGIN" ] || fail "Tailnet 로그인 사용자를 확인하지 못했습니다."
  serve_status="$("$TAILSCALE_BIN" serve status --json 2>/dev/null || printf '{}')"
  serve_key="$TAILNET_HOST:443"
  expected_proxy="http://127.0.0.1:$PORT"
  printf '%s' "$serve_status" | jq -e --arg key "$serve_key" --arg proxy "$expected_proxy" \
    '.Web[$key].Handlers["/"].Proxy == $proxy' >/dev/null 2>&1 \
    || fail "Tailscale Serve가 $expected_proxy 를 가리키지 않습니다. 설정을 자동 변경하지 않습니다."
}

local_access_json() {
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/access"
}

wait_for_backend() {
  local attempt access expected_store_id
  for attempt in $(seq 1 80); do
    access="$(local_access_json 2>/dev/null || true)"
    if [ -n "$access" ] && printf '%s' "$access" | jq -e \
      --argjson protocol "$EXPECTED_PROTOCOL" \
      '.protocolVersion == $protocol and .writable == true' >/dev/null 2>&1; then
      expected_store_id="$(jq -er '.storeId' "$SETTINGS_FILE")"
      printf '%s' "$access" | jq -e --arg store_id "$expected_store_id" \
        '.storeId == $store_id' >/dev/null 2>&1 \
        || fail "새 백엔드의 storeId가 저장된 설정과 일치하지 않습니다."
      return 0
    fi
    kill -0 "$BACKEND_PID" 2>/dev/null || break
    sleep 0.25
  done
  echo "Backend stdout:" >&2
  sed -n '1,120p' "$BACKEND_OUT" >&2 2>/dev/null || true
  echo "Backend stderr:" >&2
  sed -n '1,120p' "$BACKEND_ERR" >&2 2>/dev/null || true
  fail "새 백엔드가 제한 시간 안에 정상화되지 않았습니다."
}

verify_remote_write() {
  local access
  access="$(curl -fsS --max-time 15 "https://$TAILNET_HOST/api/access")"
  printf '%s' "$access" | jq -e \
    --argjson protocol "$EXPECTED_PROTOCOL" \
    '.protocolVersion == $protocol and .mode == "tailscale" and .remote == true and .writable == true' \
    >/dev/null \
    || fail "Tailnet 백엔드가 remote-write 상태가 아닙니다."
}

wait_for_frontend() {
  local attempt
  for attempt in $(seq 1 120); do
    curl -fsS --max-time 1 "http://localhost:$FRONTEND_PORT" >/dev/null 2>&1 && return 0
    kill -0 "$FRONTEND_PID" 2>/dev/null || fail "Tauri 개발 프런트엔드가 시작 중 종료되었습니다."
    sleep 0.25
  done
  fail "Tauri 개발 프런트엔드가 제한 시간 안에 시작되지 않았습니다."
}

cleanup() {
  local status
  status=$?
  trap - EXIT INT TERM
  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill -TERM "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
echo "최신 프런트엔드와 개발 백엔드를 빌드합니다."
npm run build
cargo build -p agent-manager-server

if [ "$REMOTE_WRITE" = true ]; then
  load_tailscale_identity
fi

echo "기존 Agent Manager 개발 프런트엔드와 포트 $PORT 백엔드를 종료합니다."
stop_existing_frontend
stop_existing_backend

: > "$BACKEND_OUT"
: > "$BACKEND_ERR"
backend_args=(
  --port "$PORT"
  --static-dir "$STATIC_DIR"
  --app-data-dir "$APP_DATA_DIR"
)
if [ "$REMOTE_WRITE" = true ]; then
  backend_args+=(
    --tailscale-host "$TAILNET_HOST"
    --tailscale-user "$TAILNET_LOGIN"
    --remote-write
  )
fi

"$BACKEND_BIN" "${backend_args[@]}" >"$BACKEND_OUT" 2>"$BACKEND_ERR" &
BACKEND_PID=$!
wait_for_backend
if [ "$REMOTE_WRITE" = true ]; then
  verify_remote_write
fi

node "$REPO_ROOT/scripts/tauri-cli.mjs" dev &
FRONTEND_PID=$!
wait_for_frontend

echo "Agent Manager 개발 환경이 시작되었습니다."
echo "  backend pid=$BACKEND_PID port=$PORT protocol=$EXPECTED_PROTOCOL"
echo "  frontend pid=$FRONTEND_PID url=http://localhost:$FRONTEND_PORT"
if [ "$REMOTE_WRITE" = true ]; then
  echo "  Tailnet remote-write 검증 완료"
fi
echo "Ctrl+C를 누르면 프런트엔드와 백엔드를 함께 종료합니다."

set +e
wait "$FRONTEND_PID"
frontend_status=$?
set -e
FRONTEND_PID=""
exit "$frontend_status"
