#!/usr/bin/env bash
# 키링 감시 시험. 진짜 dbus-daemon·gnome-keyring-daemon·secret-tool로, 기동 때 연 데몬이
# 죽은 뒤 D-Bus가 잠긴 데몬을 다시 띄우는 2026-10-25~27 장애를 그대로 만들고, 엔트리포인트의
# 감시가 그걸 스스로 고치는지 본다. 판정은 실제 값 조회 결과와 프로세스 상태다.
#
# 스텁으로는 이 장애를 만들 수 없다(`test-privdrop.sh`는 키링을 흉내만 낸다). 그래서 이
# 시험은 gnome-keyring이 든 환경 — 런타임 이미지나 돌고 있는 컨테이너 안 — 에서 비root로
# 돈다. 임시 HOME과 새 세션 버스를 쓰고 GNOME_KEYRING_CONTROL을 지워, 같은 컨테이너에서
# 돌고 있는 진짜 볼트 데몬에는 닿지 않는다. 약 40초 걸린다. 도구가 없으면 SKIP을 찍고 77로 끝난다.
#
# 사용: deploy/synology/test-keyring-watchdog.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
for tool in dbus-launch dbus-send gnome-keyring-daemon secret-tool pgrep; do
  command -v "${tool}" >/dev/null || { echo "SKIP ${tool} 없음 — gnome-keyring이 든 환경에서 돌리세요"; exit 77; }
done

sandbox="$(mktemp -d)"
export HOME="${sandbox}"
unset GNOME_KEYRING_CONTROL XDG_RUNTIME_DIR SSH_AUTH_SOCK DBUS_SESSION_BUS_ADDRESS
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
watchdog_log="${sandbox}/watchdog.log"

# 이 시험이 띄운 프로세스만 고른다(HOME이 sandbox인 것). 진짜 데몬을 건드리지 않게 하는 경계다.
# 패턴은 명령줄 맨 앞에 고정한다 — 감시의 `bash -c` 인자에도 데몬 명령 문자열이 들어 있다.
mine() {
  local pid
  for pid in $(pgrep -f "$1" || true); do
    if { tr '\0' '\n' < "/proc/${pid}/environ"; } 2>/dev/null | grep -qxF "HOME=${sandbox}"; then
      echo "${pid}"
    fi
  done
}
# 감시 본체만. 감시가 상태를 물을 때 잠깐 포크하는 자식 셸도 명령줄이 같으므로, 부모가 감시인
# 것은 뺀다.
watchdogs() {
  local all pid
  all=" $(mine '^bash -c .*keyring_watchdog' | tr '\n' ' ') "
  for pid in ${all}; do
    [[ "${all}" == *" $(awk '{print $4}' "/proc/${pid}/stat" 2>/dev/null) "* ]] || echo "${pid}"
  done
}

cleanup() {
  local pid
  for pid in $(mine '^bash -c .*keyring_watchdog') $(mine 'gnome-keyring-daemon'); do
    kill -CONT "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
  done
  kill "${DBUS_SESSION_BUS_PID}" 2>/dev/null || true
  rm -rf "${sandbox}"
}
trap cleanup EXIT

# shellcheck source=entrypoint.sh
source "${here}/entrypoint.sh"
set +e

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
alive() { if [ -n "$1" ] && [ -d "/proc/$1" ]; then echo yes; else echo no; fi; }
count() { local n; n="$(mine "$1" | wc -l)"; echo "${n// /}"; }
wait_readable() {
  local _
  for _ in $(seq 1 40); do
    sleep 1
    if [ "$(keyring_locked_state)" = false ] \
      && [ "$(timeout 5 secret-tool lookup service watchdog-test key k 2>/dev/null)" = v1 ]; then
      echo yes
      return
    fi
  done
  echo no
}

password="watchdog-test-$$"
mkdir -p "${HOME}/.local/share/keyrings"
while IFS= read -r assignment; do
  [ -n "${assignment}" ] && export "${assignment?}"
done < <(printf '%s' "${password}" | gnome-keyring-daemon --unlock --components=secrets)

# 엔트리포인트와 같이, 데몬이 버스에 올라오기 전에 값을 요청해 잠긴 데몬을 활성화하지 않는다.
for _ in $(seq 1 10); do
  [ "$(keyring_locked_state)" = false ] && break
  sleep 1
done
printf 'v1' | timeout 10 secret-tool store --label=watchdog-test service watchdog-test key k
check "기동 직후 키링은 열려 있다" false "$(keyring_locked_state)"
check "기동 직후 값을 읽는다" v1 "$(timeout 10 secret-tool lookup service watchdog-test key k)"

# 엔트리포인트와 같은 모양으로 띄운다: 볼트 암호가 든 환경으로 exec된 셸이 암호를 셸 변수로
# 옮기고 unset한 뒤 감시를 띄운다. 그 셸의 환경 블록에는 암호가 그대로 있으므로, 포크만 하는
# 구현이면 감시의 /proc/<pid>/environ에 암호가 보인다.
env KEYRING_PASSWORD="${password}" KEYRING_WATCHDOG_INTERVAL=1 bash -c '
  source "$1"
  keyring_password="${KEYRING_PASSWORD}"
  unset KEYRING_PASSWORD
  start_keyring_watchdog "${keyring_password}"
' _ "${here}/entrypoint.sh" 2>>"${watchdog_log}"
sleep 1
watchdog_pid="$(watchdogs | head -n 1)"
check "감시가 하나 떠 있다" 1 "$(watchdogs | wc -l | tr -d ' ')"
if [ -z "${watchdog_pid}" ]; then
  echo "FAIL 감시가 없어 나머지를 건너뜁니다"
  exit 1
fi
check "감시 환경에 볼트 암호가 없다" 0 \
  "$(tr '\0' '\n' < "/proc/${watchdog_pid}/environ" | grep -cF "${password}")"
check "감시 인자에 볼트 암호가 없다" 0 \
  "$(tr '\0' '\n' < "/proc/${watchdog_pid}/cmdline" | grep -cF "${password}")"

# 멀쩡한 데몬은 갈지 않는다.
first_daemon="$(mine '^gnome-keyring-daemon --unlock' | head -n 1)"
sleep 4
check "열린 데몬은 그대로 둔다" yes "$(alive "${first_daemon}")"
check "열린 동안 감시는 아무것도 하지 않는다" 0 "$(grep -c . "${watchdog_log}")"

# 멈춘 데몬(주인은 있는데 답이 없음)은 갈지 않는다 — `--replace`도 그 제어 소켓에서 멈춘다.
kill -STOP "${first_daemon}"
sleep 14
check "멈춘 데몬은 교체하지 않는다" 0 "$(count '^gnome-keyring-daemon --replace')"
check "멈춘 데몬은 한 번만 기록한다" 1 "$(grep -c '답하지 않습니다' "${watchdog_log}")"
kill -CONT "${first_daemon}"
check "깨어난 데몬으로 다시 읽는다" yes "$(wait_readable)"

# 장애 재현: 기동 때 연 데몬을 SIGTRAP으로 죽이고, 서버의 요청처럼 값을 읽어 D-Bus가 잠긴
# 데몬을 띄우게 한다. 감시가 그 사이에 끼면 `absent` 경로로 새므로 그동안 감시를 멈춰 둔다.
kill -STOP "${watchdog_pid}"
kill -TRAP "${first_daemon}"
( timeout 8 secret-tool lookup service watchdog-test key k >/dev/null 2>&1 & )
locked=no
for _ in $(seq 1 20); do
  sleep 0.5
  if [ "$(keyring_locked_state)" = true ]; then locked=yes; break; fi
done
check "죽은 뒤 D-Bus가 잠긴 데몬을 띄운다(장애 재현)" yes "${locked}"
check "잠긴 활성화 데몬이 떠 있다" 1 "$(count '^/usr/bin/gnome-keyring-daemon --start --foreground')"
kill -CONT "${watchdog_pid}"
check "데몬이 죽어도 감시가 다시 연다" yes "$(wait_readable)"
check "감시가 잠김(true)을 보고 교체했다" 1 "$(grep -c '상태 true' "${watchdog_log}")"
check "새 데몬은 감시가 띄운 --replace --unlock 하나다" 1 "$(count '^gnome-keyring-daemon --replace --unlock')"
daemon_pid="$(mine '^gnome-keyring-daemon --replace --unlock' | head -n 1)"
if [ -z "${daemon_pid}" ]; then
  echo "FAIL 교체된 데몬이 없어 나머지를 건너뜁니다"
  exit 1
fi
check "새 데몬 환경에 볼트 암호가 없다" 0 \
  "$(tr '\0' '\n' < "/proc/${daemon_pid}/environ" | grep -cF "${password}")"

# 한 번 더: 감시가 한 번 고치고 멈추지 않는지.
kill -TRAP "${daemon_pid}"
sleep 0.5
check "두 번째 데몬이 실제로 죽었다" no "$(alive "${daemon_pid}")"
check "두 번째 사망도 다시 연다" yes "$(wait_readable)"
check "감시는 그대로 살아 있다" yes "$(alive "${watchdog_pid}")"

echo "--- 감시 기록"
cat "${watchdog_log}"
exit "${fail}"
