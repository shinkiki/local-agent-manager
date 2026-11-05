#!/usr/bin/env bash
# 리눅스 OS 보안 저장소 통로(`os_keychain/secret_service.rs`) 시험. 진짜 dbus-daemon·
# gnome-keyring-daemon 위에서 코어 시험(`secret_service_phase`)을 단계별로 돌린다.
#
# 2026-10-28 NAS: 키링 데몬이 죽고 잠긴 데몬이 떠 있던 몇 초 사이 서버의 볼트 읽기가 잠금 해제
# prompt를 띄웠다. 화면 없는 곳에서 그 prompt에는 응답이 오지 않고(이 격리 환경에서 70초 동안
# `Completed` 없음), 예전 통로(`keyring` 크레이트)는 시한 없이 기다리며 Vault 잠금을 쥔 채
# 6시간 멈췄다. 새 통로는 컨테이너에서(`AGENT_MANAGER_KEYRING_NO_PROMPT=1`) prompt를 띄우지
# 않고, 잠긴 동안 감시가 다시 열기를 기다렸다가 읽고, 끝내 잠겨 있으면 15초쯤에 "잠김"으로
# 실패해야 한다. 예전 통로가 쓴 볼트를 그대로 찾고 예전 통로가 새 값을 읽는지도 본다.
#
# `test-keyring-watchdog.sh`처럼 임시 HOME과 새 세션 버스를 써서 같은 컨테이너의 진짜 볼트
# 데몬에는 닿지 않는다. 약 40초 걸린다. 도구가 없으면 SKIP을 찍고 77로 끝난다.
#
# 사용: deploy/synology/test-keyring-prompt-hang.sh <agent_manager_core 시험 바이너리>
#   바이너리는 `cargo test -p agent-manager-core --lib --no-run`이 알려 주는 경로다.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
test_bin="${1:?코어 시험 바이너리 경로가 필요합니다}"
for tool in dbus-launch dbus-send gnome-keyring-daemon secret-tool pgrep timeout; do
  command -v "${tool}" >/dev/null || { echo "SKIP ${tool} 없음 — gnome-keyring이 든 환경에서 돌리세요"; exit 77; }
done

sandbox="$(mktemp -d)"
export HOME="${sandbox}"
unset GNOME_KEYRING_CONTROL XDG_RUNTIME_DIR SSH_AUTH_SOCK DBUS_SESSION_BUS_ADDRESS DISPLAY WAYLAND_DISPLAY
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS

# 이 시험이 띄운 데몬만 고른다(HOME이 sandbox인 것).
mine() {
  local pid
  for pid in $(pgrep -f "$1" || true); do
    if { tr '\0' '\n' < "/proc/${pid}/environ"; } 2>/dev/null | grep -qxF "HOME=${sandbox}"; then
      echo "${pid}"
    fi
  done
}
cleanup() {
  local pid
  for pid in $(mine 'gnome-keyring-daemon'); do
    kill "${pid}" 2>/dev/null || true
  done
  kill "${DBUS_SESSION_BUS_PID}" 2>/dev/null || true
  rm -rf "${sandbox}"
}
trap cleanup EXIT

# 상태는 엔트리포인트 감시와 같은 함수로 묻는다. 주인을 먼저 확인하지 않고 서비스에 바로 말을
# 걸면, 데몬이 버스 이름을 잡기 전에 D-Bus가 잠긴 데몬을 깨워 시험이 시작부터 잠긴다.
# shellcheck source=entrypoint.sh
source "${here}/entrypoint.sh"
set +e
bus_call() { keyring_bus_call "$@"; }
locked_state() { keyring_locked_state; }
lock_default() {
  local path
  path="$(bus_call --dest=org.freedesktop.secrets /org/freedesktop/secrets \
    org.freedesktop.Secret.Service.ReadAlias string:default | tr -d ' ')"
  bus_call --dest=org.freedesktop.secrets /org/freedesktop/secrets \
    org.freedesktop.Secret.Service.Lock "array:objpath:${path}" >/dev/null
}
run_phase() {
  AM_KEYRING_TEST_PHASE="$1" AGENT_MANAGER_KEYRING_NO_PROMPT=1 timeout 120 "${test_bin}" \
    --ignored --exact --nocapture os_keychain::tests::secret_service_phase >"${sandbox}/$1.log" 2>&1
}

fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    echo "ok   ${label}"
  else
    echo "FAIL ${label}: '${expected}'이어야 하는데 '${actual}'"
    fail=1
  fi
}
status_of() { if run_phase "$1"; then echo pass; else echo "fail($?)"; fi; }

password="prompt-hang-test-$$"
mkdir -p "${HOME}/.local/share/keyrings"
while IFS= read -r assignment; do
  [ -n "${assignment}" ] && export "${assignment?}"
done < <(printf '%s' "${password}" | gnome-keyring-daemon --unlock --components=secrets)
# 부하가 걸린 NAS에서는 새 키링의 기본 컬렉션이 10초 넘게 걸려 생기기도 했다.
for _ in $(seq 1 30); do
  [ "$(locked_state)" = false ] && break
  sleep 1
done
check "기동 직후 키링은 열려 있다" false "$(locked_state)"
check "예전 통로(keyring)로 볼트를 쓴다" pass "$(status_of keyring-write)"
check "새 통로가 예전 통로의 값을 찾는다" pass "$(status_of read-old)"
check "새 통로로 쓰고 덮는다" pass "$(status_of write)"
check "예전 통로가 새 통로의 값을 읽는다(되돌림 호환)" pass "$(status_of keyring-read)"
printf '남의-값' | timeout 10 secret-tool store --label=foreign service am-test-foreign username foreign-user
check "target 없는 남의 항목을 찾는다" pass "$(status_of foreign-read)"

lock_default
check "키링을 잠갔다" true "$(locked_state)"
# 엔트리포인트 감시처럼 3초 뒤 데몬을 바꿔 연다. 그 사이 앱은 prompt 없이 기다려야 한다.
( sleep 3; printf '%s' "${password}" | timeout 30 gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null 2>&1 ) &
reopen_pid=$!
started=$(date +%s)
check "잠긴 동안 기다렸다가 열리면 읽는다" pass "$(status_of read-unlocked-later)"
wait "${reopen_pid}" || true
echo "     걸린 시간 $(( $(date +%s) - started ))초"
check "다시 연 키링은 열려 있다" false "$(locked_state)"

lock_default
check "키링을 다시 잠갔다" true "$(locked_state)"
started=$(date +%s)
check "끝내 잠겨 있으면 멈추지 않고 잠김으로 실패한다" pass "$(status_of read-stays-locked)"
echo "     걸린 시간 $(( $(date +%s) - started ))초"
check "앱이 키링을 대신 열지 않았다(prompt 없음)" true "$(locked_state)"

printf '%s' "${password}" | timeout 30 gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null 2>&1
for _ in $(seq 1 10); do
  [ "$(locked_state)" = false ] && break
  sleep 1
done
check "지우면 예전 통로에서도 사라진다" pass "$(status_of delete)"

if [ "${fail}" -ne 0 ]; then
  for log in "${sandbox}"/*.log; do
    echo "--- ${log##*/}"
    tail -n 30 "${log}"
  done
fi
exit "${fail}"
