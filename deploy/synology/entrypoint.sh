#!/usr/bin/env bash
# Agent Manager 헤드리스 서버 기동 래퍼.
#
# 리눅스에서 자격증명 볼트는 keyring crate의 secret-service 백엔드를 쓴다. 컨테이너에는
# 데스크톱 세션이 없으므로 D-Bus 세션 버스와 gnome-keyring을 직접 띄우고 잠금을 풀어야
# 한다. 이 과정을 건너뛰면 서버는 기동되지만 공급자 계정 저장/조회가 전부 실패한다.
set -euo pipefail

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "환경변수 ${name}이(가) 필요합니다." >&2
    exit 1
  fi
}

require KEYRING_PASSWORD
require TAILSCALE_HOST
require TAILSCALE_USER

# D-Bus 세션 버스.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# 시크릿 서비스. 잠금 해제 결과로 나오는 GNOME_KEYRING_CONTROL 등을 환경에 반영한다.
mkdir -p "${HOME}/.local/share/keyrings"
while IFS= read -r assignment; do
  [ -n "${assignment}" ] && export "${assignment?}"
done < <(printf '%s' "${KEYRING_PASSWORD}" | gnome-keyring-daemon --unlock --components=secrets)

# 볼트가 실제로 열렸는지 기동 전에 확인한다. 여기서 실패하면 계정 기능이 조용히
# 죽은 채로 서버가 떠 버리므로, 늦게 알기보다 지금 멈추는 편이 낫다.
if ! secret-tool store --label=agent-manager-probe service agent-manager-probe key probe <<< "ok" 2>/dev/null; then
  echo "경고: 시크릿 서비스 확인에 실패했습니다. 공급자 계정 저장이 동작하지 않을 수 있습니다." >&2
else
  secret-tool clear service agent-manager-probe key probe 2>/dev/null || true
fi

args=(
  --port "${AGENT_MANAGER_PORT:-4178}"
  --static-dir /opt/agent-manager/dist
  --app-data-dir /data
  --tailscale-host "${TAILSCALE_HOST}"
  --tailscale-user "${TAILSCALE_USER}"
)

# 원격에서 변경 작업까지 허용할지. 기본은 읽기 전용이다.
#
# 판정 자체는 앱 데이터의 백엔드 서비스 설정(remoteWrite) 한 곳에 저장되고 설정 화면의
# 토글이 실행 중에도 바꾼다. 여기서는 컨테이너를 띄운 운영자의 선택을 그 설정에 명시적으로
# 기록하므로, 껐다 켤 때마다 이 환경변수 값으로 돌아온다. 화면에서 바꾼 값을 그대로 두려면
# 이 값을 그 값에 맞춰 두어야 한다.
if [ "${AGENT_MANAGER_REMOTE_WRITE:-false}" = "true" ]; then
  args+=(--remote-write)
else
  args+=(--no-remote-write)
fi

exec /usr/local/bin/agent-manager-server "${args[@]}"
