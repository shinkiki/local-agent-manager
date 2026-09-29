#!/bin/bash
# 튜닝 회차가 쓰는 개발 백엔드를 띄운다.
#
# 운영 앱을 멈추지 않는다. 같은 앱 데이터 폴더에는 백엔드가 둘 뜰 수 없으므로
# (BackendOwnershipLease) 씨앗만 복사한 별도 폴더를 만들고 다른 포트로 띄운다.
# 복사하는 것은 작은 JSON 몇 개뿐이다. 플러그인 비밀값은 앱 데이터가 아니라 OS 자격
# 증명 저장소에 플러그인 id로 들어 있어 복사본에서도 그대로 읽힌다.
#
# 사용:
#   bash dev-backend.sh <저장소> [포트] [운영앱데이터]   — 띄운다
#   bash dev-backend.sh stop <저장소> [포트]             — 내린다
#
# 내리는 것을 스크립트가 맡는 이유: PID 파일에 적히는 값은 이 셸이 보는 pid 라, 다른
# 셸에서 `kill` 하면 듣지 않는 일이 있다(Git Bash). 무인 회차는 반드시 내려야 하므로
# 그 절차를 사람 손에 맡기지 않는다.
set -euo pipefail

MODE=start
if [ "${1:-}" = "stop" ]; then MODE=stop; shift; fi

REPO=${1:?저장소 경로가 필요합니다}
PORT=${2:-54180}
APP_DATA=${3:-}

if [ -z "$APP_DATA" ]; then
  case "$(uname -s)" in
    Darwin) APP_DATA="$HOME/Library/Application Support/com.shinc.agentmanager" ;;
    MINGW*|MSYS*|CYGWIN*) APP_DATA="${APPDATA:-$HOME/AppData/Roaming}/com.shinc.agentmanager" ;;
    *) APP_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/com.shinc.agentmanager" ;;
  esac
fi

[ -d "$REPO" ] || { echo "ERROR: 저장소가 없습니다: $REPO" >&2; exit 1; }
[ -d "$APP_DATA" ] || { echo "ERROR: 앱 데이터를 찾지 못했습니다: $APP_DATA" >&2; exit 1; }

DEV_DATA="$REPO/.tuning/app-data"
PID_FILE="$REPO/.tuning/backend-$PORT.pid"
LOG_OUT="$REPO/.tuning/backend-$PORT.out.log"
LOG_ERR="$REPO/.tuning/backend-$PORT.err.log"

# 그 포트의 백엔드를 내린다. `kill` 이 듣지 않는 환경을 위해 Windows 쪽 손잡이도 같이 쥔다.
stop_backend() {
  local pid=""
  [ -f "$PID_FILE" ] && pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  if command -v taskkill >/dev/null 2>&1; then
    # ps -W 의 넷째 칸이 Windows pid 다. 우리 저장소의 실행파일만 고른다.
    # `|| true` 가 없으면 이미 죽어 grep 이 빈손일 때 pipefail 이 함수를 통째로 중단시킨다
    # — 실제로 그렇게 조용히 1 로 끝나 "내려감"도 못 적었다.
    local win
    win=$(ps -W 2>/dev/null | grep -F "$REPO/target/debug/agent-manager-server" | awk '{print $4}' || true)
    for w in $win; do taskkill //PID "$w" //F >/dev/null 2>&1 || true; done
  fi
  rm -f "$PID_FILE"
  for _ in $(seq 1 20); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/access" >/dev/null 2>&1 || {
      echo "개발 백엔드 내려감: 127.0.0.1:$PORT"
      return 0
    }
    sleep 0.5
  done
  echo "ERROR: 127.0.0.1:$PORT 가 아직 응답합니다." >&2
  return 1
}

if [ "$MODE" = "stop" ]; then
  stop_backend
  exit $?
fi

# 그 포트에 이미 무언가 응답하면 우리 것이 아닐 수 있다. 죽이지 않고 멈추는다.
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/access" >/dev/null 2>&1; then
  echo "ERROR: 127.0.0.1:$PORT 에 이미 무언가 응답합니다. 다른 포트를 쓰세요." >&2
  exit 1
fi

echo "프런트엔드와 디버그 백엔드를 빌드합니다."
( cd "$REPO" && npm run build >/dev/null && cargo build -p agent-manager-server )

BIN="$REPO/target/debug/agent-manager-server"
[ -f "$BIN" ] || BIN="$BIN.exe"
[ -f "$BIN" ] || { echo "ERROR: 백엔드 실행파일이 없습니다: $BIN" >&2; exit 1; }

# 씨앗을 새로 만든다. 지난 회차가 남긴 상태가 이번 측정에 섞이지 않게 통째로 갈아 끼운다.
mkdir -p "$REPO/.tuning"
rm -rf "$DEV_DATA"
mkdir -p "$DEV_DATA"
for f in external-plugins.json local-llm-connection-v1.json manager-state.json \
         backend-service-settings.json power-settings.json chat-settings-schema-v1.json; do
  [ -f "$APP_DATA/$f" ] && cp "$APP_DATA/$f" "$DEV_DATA/"
done

: > "$LOG_OUT"
: > "$LOG_ERR"
"$BIN" --port "$PORT" --static-dir "$REPO/dist" --app-data-dir "$DEV_DATA" >"$LOG_OUT" 2>"$LOG_ERR" &
PID=$!
echo "$PID" > "$PID_FILE"

for _ in $(seq 1 80); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/access" 2>/dev/null | grep -q '"writable":true'; then
    echo "개발 백엔드 준비됨: http://127.0.0.1:$PORT (pid=$PID)"
    echo "  앱 데이터: $DEV_DATA"
    echo "  로그: $LOG_OUT / $LOG_ERR"
    echo "  내릴 때: bash scripts/dev-backend.sh stop '$REPO' $PORT"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done

echo "ERROR: 개발 백엔드가 제한 시간 안에 준비되지 않았습니다." >&2
sed -n '1,40p' "$LOG_ERR" >&2 || true
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1
