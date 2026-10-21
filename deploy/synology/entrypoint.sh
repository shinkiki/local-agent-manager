#!/usr/bin/env bash
# Agent Manager 헤드리스 서버 기동 래퍼.
#
# 리눅스에서 자격증명 볼트는 keyring crate의 secret-service 백엔드를 쓴다. 컨테이너에는
# 데스크톱 세션이 없으므로 D-Bus 세션 버스와 gnome-keyring을 직접 띄우고 잠금을 풀어야
# 한다. 이 과정을 건너뛰면 서버는 기동되지만 공급자 계정 저장/조회가 전부 실패한다.
#
# L13: 컨테이너는 root로 들어오지만 서버·키링·CLI는 root로 돌지 않는다. Claude CLI가 uid 0
# 에서 `--dangerously-skip-permissions`를 거부해 전체 접근 채팅이 exit 1로 끝나기 때문이다.
# root로 하는 일은 볼륨 소유권을 맞추는 것뿐이고, 그다음 `setpriv`로 권한을 내려 자기
# 자신을 다시 실행한다. 아래 볼트·서버 기동은 전부 전용 사용자로 돈다.
set -euo pipefail

AGENT_USER="${AGENT_MANAGER_USER:-agent}"

drop_privileges() {
  local uid gid
  uid="${PUID:-$(id -u "${AGENT_USER}")}"
  gid="${PGID:-$(id -g "${AGENT_USER}")}"

  # L13: 두 값을 계정 변경보다 먼저 검사한다. 숫자가 아닌 값은 도구마다 사용자 이름이나
  # 부호로 다르게 해석하므로 십진수만 받고, 00 같은 0의 다른 표기도 거절한다.
  if [[ ! "${uid}" =~ ^[0-9]+$ || ! "${gid}" =~ ^[0-9]+$ ]]; then
    echo "PUID/PGID는 십진수 숫자로만 적어야 합니다." >&2
    exit 1
  fi

  # uid/gid 0은 받지 않는다. 받아 주면 setpriv 뒤에도 여전히 root라 이 함수가 자기 자신을
  # 끝없이 다시 실행하고(restart: unless-stopped와 합쳐지면 chown -R이 반복된다), 무엇보다
  # root를 피하려고 만든 경로가 조용히 root로 돌아간다.
  if [[ "${uid}" =~ ^0+$ || "${gid}" =~ ^0+$ ]]; then
    echo "PUID/PGID에 0을 쓸 수 없습니다(root로는 에이전트 CLI가 돌지 않습니다)." >&2
    exit 1
  fi

  # 공유 폴더 소유자에 맞춰 기동 시점에 uid/gid를 바꾼다. 시놀로지 공유 폴더는 보통
  # gid 100(users)이고 그 그룹은 이미지에 이미 있으므로 중복을 허용(-o)해야 한다. 대신
  # 아래 setpriv가 보조그룹을 --init-groups로 조회하지 않고 이 gid 하나만 준다 — 중복
  # uid/gid에서 남의 계정 보조그룹을 물려받는 경로를 그래서 닫는다.
  if [ "${gid}" != "$(id -g "${AGENT_USER}")" ]; then
    groupmod -o -g "${gid}" "${AGENT_USER}"
  fi
  if [ "${uid}" != "$(id -u "${AGENT_USER}")" ]; then
    usermod -o -u "${uid}" "${AGENT_USER}"
  fi

  local home
  home="$(getent passwd "${AGENT_USER}" | cut -d: -f6)"

  # /data와 HOME은 이 앱이 소유한 볼륨이라 재귀로 맞춘다. 실패를 삼키지 않는다 — 여기서
  # 넘어가면 권한을 내린 뒤 볼트와 앱 데이터를 못 읽어, 서버는 떴는데 계정 기능만 죽는
  # 바로 그 상태가 된다.
  if ! chown -R "${uid}:${gid}" "${home}" /data; then
    echo "볼륨 소유권을 ${uid}:${gid}로 맞추지 못했습니다. .env의 PUID/PGID를 공유 폴더 소유자에 맞추세요." >&2
    exit 1
  fi
  # /workspace는 사용자 프로젝트다. 소유권을 바꾸지 않고 쓸 수 있는지만 확인한다.
  if ! setpriv --reuid "${uid}" --regid "${gid}" --clear-groups test -w /workspace; then
    echo "경고: /workspace에 ${uid}:${gid}로 쓸 수 없습니다. PUID/PGID를 공유 폴더 소유자에 맞추세요." >&2
  fi

  export HOME="${home}" AGENT_MANAGER_PRIVDROPPED=1
  exec setpriv --reuid "${uid}" --regid "${gid}" --groups "${gid}" --inh-caps=-all \
    "$0" "$@"
}

# L10: 사이드카의 데이터패스 모드 값은 여기서 받아 **검사만** 한다. 이 컨테이너는 그 값을
# 쓰지 않는다 — 쓰는 쪽은 같은 netns를 지는 tailscale 사이드카이고, 그 이미지는 우리 것이
# 아니라 거기에 검사를 넣을 수 없다. compose의 `${VAR:?}`류는 미설정만 잡지 값의 집합을
# 보지 못하므로, 집행할 수 있는 자리가 여기뿐이다.
#
# 이 배포가 허용하는 값은 실측된 `true`/`false` 두 가지뿐이다. 사이드카의 containerboot는
# Go `strconv.ParseBool`을 쓰므로 `1`·`True`·`0` 같은 값도 해석하기는 한다. 그래도 받지
# 않는 이유는 두 가지다. 첫째, `yes`처럼 **파싱에 실패하는** 값은 containerboot의 기본값인
# 사용자 공간 모드로 떨어지는데, 커널 모드를 쓰려던 사람은 그 전환을 어디에서도 통보받지
# 못한다(사이드카는 그것을 오류로 보고하지 않는다). 둘째, 두 글자만 허용하면 그 경계가
# 눈에 보여서 오타와 의도를 로그 한 줄로 가를 수 있다.
#
# 멈추는 판단은 볼트 검사(L02)와 같다 — 조용히 다른 구성으로 도는 것보다 종료 코드 1로
# 로그에 원인을 남기는 쪽이 낫다. 비워 두는 것은 정상이다(compose가 `false`를 넣는다).
# 값은 trim하지 않는다. `TS_USERSPACE=false `(뒤 공백)는 사이드카 쪽에서도 파싱에 실패하는
# 값이라, 여기서 다듬어 통과시키면 두 컨테이너가 서로 다른 모드로 갈린다.
#
# 검사는 권한 내리기보다 **앞**에 둔다. 뒤에 두면 오타 한 줄이 재시작마다 root 패스의
# `chown -R /data`를 다시 돌린다. 문자열 비교뿐이라 root/비root 어느 패스에서도 결과가 같다.
if [ -n "${TS_USERSPACE:-}" ] && [ "${TS_USERSPACE}" != "true" ] && [ "${TS_USERSPACE}" != "false" ]; then
  echo "TS_USERSPACE 값 '${TS_USERSPACE}'은(는) 이 배포가 받지 않습니다. true 또는 false만 적으세요." >&2
  echo "사이드카가 해석하지 못하는 값은 조용히 사용자 공간 모드로 떨어지고, 해석하는 값이라도 이 배포는 실측된 둘만 받습니다. 커널 모드를 쓰려던 설정이 다른 데이터패스로 도는 것을 여기서 막습니다." >&2
  sleep 10
  exit 1
fi

# AGENT_MANAGER_PRIVDROPPED는 이 스크립트가 자기 재실행을 알아보는 내부 표시다. compose나
# .env에 적지 말 것 — 적으면 권한 내리기를 통째로 건너뛰고 root로 돌게 된다.
if [ "$(id -u)" = "0" ] && [ -z "${AGENT_MANAGER_PRIVDROPPED:-}" ]; then
  drop_privileges "$@"
fi

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

# 에이전트 CLI 씨앗 심기. 이미지는 CLI를 씨앗 prefix(`AGENT_MANAGER_CLI_SEED`)에만 담고, 실제로
# 실행되는 사본은 HOME 볼륨의 `~/.local`에 둔다 — 앱의 업데이트 버튼이 비root로 그 사본을 올리고,
# 볼륨이라 컨테이너를 다시 만들어도 올린 버전이 남는다(Dockerfile의 씨앗 주석).
#
# 권한을 내린 **뒤**에 돈다. root로 볼륨에 파일을 만들면 다음 업데이트가 소유권에 막힌다.
#
# CLI마다 `~/.local/bin/<cli>`가 없을 때만 심는다. 있으면 사용자가 앱에서 올린 버전이므로
# 이미지 씨앗이 더 새 것이어도 덮지 않는다 — 버전을 비교해 자동으로 고르면 사람이 올린 판이
# 재생성 한 번에 조용히 바뀐다. 씨앗으로 되돌리는 길은 `AGENT_MANAGER_RESEED_CLI=1` 하나다.
#
# bin 항목을 맨 마지막에 놓는다. bin이 있다는 것이 "심기 끝"의 표시라, 중간에 멈춰도 다음
# 기동이 처음부터 다시 심는다. 각 조각은 임시 이름으로 복사한 뒤 `mv`로 바꿔 넣는다.
#
# 심기 실패는 기동을 멈추지 않는다. 볼트와 달리 서버는 CLI 없이도 뜨고, 앱의 CLI 화면이
# "탐지되지 않음"으로 원인을 보인다. 대신 로그에 남긴다.
seed_cli_dir="${AGENT_MANAGER_CLI_SEED:-/opt/agent-manager/cli-seed}"
user_prefix="${HOME}/.local"

if [ "${HOME}" != "/home/agent" ]; then
  # 이미지의 NPM_CONFIG_PREFIX·PATH는 `/home/agent/.local`로 고정이다. HOME이 다르면 앱이 올린
  # CLI가 이 스크립트가 심은 곳과 다른 데 깔린다.
  echo "경고: HOME이 ${HOME}입니다. 이미지의 CLI 경로(/home/agent/.local)와 달라 앱 업데이트가 다른 위치에 설치될 수 있습니다." >&2
fi

cli_version() {
  local out
  out="$(timeout 15 "$1" --version 2>/dev/null | head -n 1)" || true
  printf '%s' "${out:-버전 확인 실패}"
}

# 원본을 임시 이름으로 복사한 뒤 대상과 바꾼다. 디렉터리든 링크든 파일이든 `cp -a`로 그대로 옮긴다.
replace_from_seed() {
  local src="$1" dest="$2" tmp
  tmp="$(dirname "${dest}")/.seed-$(basename "${dest}").$$"
  rm -rf "${tmp}"
  cp -a "${src}" "${tmp}" || { rm -rf "${tmp}"; return 1; }
  rm -rf "${dest}"
  mv "${tmp}" "${dest}"
}

# 인자: CLI 이름, npm 패키지(없으면 빈 문자열 — 단일 실행 파일).
seed_cli() {
  local cli="$1" package="$2" bin="${user_prefix}/bin/$1" reason
  if [ ! -e "${seed_cli_dir}/bin/${cli}" ]; then
    echo "CLI 씨앗 ${cli}: 이미지에 씨앗이 없어 건너뜁니다." >&2
    return 0
  fi
  if [ "${AGENT_MANAGER_RESEED_CLI:-}" = "1" ]; then
    reason="재심기(AGENT_MANAGER_RESEED_CLI=1)"
  elif [ -e "${bin}" ] || [ -L "${bin}" ]; then
    echo "CLI ${cli}: 설치본 유지 $(cli_version "${bin}") (씨앗 $(cli_version "${seed_cli_dir}/bin/${cli}"))"
    return 0
  else
    reason="첫 심기"
  fi

  mkdir -p "${user_prefix}/bin" || return 1
  if [ -n "${package}" ]; then
    mkdir -p "$(dirname "${user_prefix}/lib/node_modules/${package}")" || return 1
    replace_from_seed "${seed_cli_dir}/lib/node_modules/${package}" \
      "${user_prefix}/lib/node_modules/${package}" || return 1
  fi
  replace_from_seed "${seed_cli_dir}/bin/${cli}" "${bin}" || return 1
  echo "CLI ${cli}: 씨앗 심음(${reason}) $(cli_version "${bin}")"
}

if [ "${AGENT_MANAGER_RESEED_CLI:-}" = "1" ]; then
  echo "AGENT_MANAGER_RESEED_CLI=1: 세 CLI를 이미지 씨앗으로 되돌립니다. 되돌린 뒤에는 이 값을 지우세요 — 남겨 두면 기동할 때마다 앱에서 올린 버전을 덮습니다." >&2
fi
for entry in "claude @anthropic-ai/claude-code" "codex @openai/codex" "agy "; do
  read -r seed_name seed_package <<< "${entry}"
  if ! seed_cli "${seed_name}" "${seed_package:-}"; then
    echo "경고: CLI ${seed_name}을(를) ${user_prefix}에 심지 못했습니다. 디스크 공간과 ${HOME} 소유권을 확인하세요." >&2
  fi
done

# D-Bus 세션 버스.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# 시크릿 서비스. 잠금 해제 결과로 나오는 GNOME_KEYRING_CONTROL 등을 환경에 반영한다.
mkdir -p "${HOME}/.local/share/keyrings"
while IFS= read -r assignment; do
  [ -n "${assignment}" ] && export "${assignment?}"
done < <(printf '%s' "${KEYRING_PASSWORD}" | gnome-keyring-daemon --unlock --components=secrets)
# 볼트 암호는 위 잠금 해제에만 쓴다. 지우지 않으면 서버를 거쳐 에이전트 CLI·터미널·회차가
# 모두 물려받아, 에이전트가 `env` 한 번으로 암호를 읽고 세션 기록에 평문으로 남길 수 있다
# (키링 파일 사본만 있으면 어디서든 열린다). 서버는 이 값을 읽지 않고, 아래 실패 안내는
# 값이 아니라 변수 이름만 쓴다. `docker inspect`에 남는 컨테이너 설정은 이 줄로 지울 수 없다.
unset KEYRING_PASSWORD

# L02: 볼트가 실제로 열렸는지 기동 전에 확인하고, 열리지 않았으면 **멈춘다.**
#
# 경고만 하고 기동하면 가장 나쁜 모양이 된다. 계정 목록과 사용량은 앱 데이터
# (`provider-accounts-v1.json`)에 남아 있어 화면에는 계정이 그대로 보이는데, 그 계정을
# 쓰는 순간마다 볼트 읽기가 실패한다. 화면 어디에도 원인이 `KEYRING_PASSWORD`라고 적히지
# 않으므로 운영자는 공급자 장애로 오해한다. 기동이 종료 코드 1로 끝나면 적어도 원인이
# 컨테이너 로그 첫 줄에 남는다.
#
# 쓰기만 해 보지 않고 넣고-읽고-대조한다. 잠긴 컬렉션은 저장을 성공으로 보고하고도 값을
# 돌려주지 못할 수 있고, 그 경우가 바로 이 검사가 잡으려는 상태다.
#
# 두 호출 모두 `timeout`으로 상한을 건다. 잠긴 컬렉션에 쓰기가 들어가면 gnome-keyring은
# `org.freedesktop.Secret.Prompt`를 올리는데 컨테이너에는 그 프롬프터가 없다 —
# `secret-tool`은 실패하는 대신 그대로 멈춰 선다. 상한이 없으면 "명확한 오류로 끝난다"가
# 아니라 "영원히 기동 중"이 되고, 그건 경고만 찍던 예전보다 알아채기 어렵다.
#
# 프로브 주소에도 pid를 넣는다. 같은 키링 볼륨을 쓰는 컨테이너가 겹쳐 뜨면 고정 주소로는
# 서로의 값을 읽어 거짓 실패를 내고 뒤이은 clear가 상대 항목을 지운다.
keyring_probe_value="agent-manager-keyring-probe-$$"
keyring_probe_key="probe-$$"
keyring_probe_failure=""
keyring_probe_detail=""
if ! keyring_probe_detail="$(printf '%s' "${keyring_probe_value}" \
  | timeout 10 secret-tool store --label=agent-manager-probe \
      service agent-manager-probe key "${keyring_probe_key}" 2>&1)"; then
  keyring_probe_failure="시크릿 서비스에 값을 저장하지 못했습니다"
elif [ "$(timeout 10 secret-tool lookup service agent-manager-probe key "${keyring_probe_key}" 2>/dev/null)" \
       != "${keyring_probe_value}" ]; then
  keyring_probe_failure="시크릿 서비스에 저장한 값을 다시 읽지 못했습니다"
fi
timeout 10 secret-tool clear service agent-manager-probe key "${keyring_probe_key}" 2>/dev/null || true

if [ -n "${keyring_probe_failure}" ]; then
  # secret-tool의 stderr에는 비밀값이 실리지 않고 실패 사유만 나온다(G4 유지). 그걸 버리면
  # "저장 실패"와 "default collection 없음"과 "D-Bus 미연결"을 구분할 수 없다.
  echo "자격증명 볼트를 열지 못했습니다: ${keyring_probe_failure}. ${keyring_probe_detail}" >&2
  echo "KEYRING_PASSWORD가 ${HOME}/.local/share/keyrings의 기존 키링 암호와 같은지 확인하세요. 암호를 바꿨다면 예전 암호로 되돌려야 하고, 키링을 새로 만들면 저장된 공급자 계정 자격증명은 모두 사라집니다." >&2
  # compose의 restart 정책이 이 실패를 초당 수 회 되풀이하면 같은 메시지가 로그를 덮고
  # root의 `chown -R /data`가 매 회차 다시 돈다. 멈추는 판단은 그대로 두고 간격만 벌린다.
  sleep 10
  exit 1
fi

args=(
  --port "${AGENT_MANAGER_PORT:-4178}"
  --static-dir /opt/agent-manager/dist
  --app-data-dir /data
  --tailscale-host "${TAILSCALE_HOST}"
  --tailscale-user "${TAILSCALE_USER}"
)

# (C20) 원격 권한은 기동 인자가 아니다 — 설정 → 시스템 → 로그인 설정이 정하고, 로그인한
# 뒤에는 원격도 데스크톱과 같은 권한이다. 비밀번호·OTP를 잃었으면 컨테이너 안에서
# `agent-manager-server --app-data-dir /data --reset-login`으로 초기화한다.

exec /usr/local/bin/agent-manager-server "${args[@]}"
