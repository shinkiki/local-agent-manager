#!/usr/bin/env bash
# L13 권한 내리기 시험. 엔트리포인트가 root로 볼륨 소유권만 맞춘 뒤 전용 사용자로
# 내려가는지를, 실제 컨테이너에서 서버가 받은 uid/gid·HOME·argv로 확인한다.
#
# 런타임 이미지 전체(Rust 릴리스 빌드)를 만들지 않는다. 런타임 단계의 사용자 생성 부분과
# 진짜 entrypoint.sh만 작은 이미지에 담고, 기동 대상(dbus·keyring·서버)은 자기가 받은
# 환경을 출력하는 스텁으로 바꾼다 — 판정은 소스 문자열이 아니라 그 출력이다.
#
# 사용: deploy/synology/test-privdrop.sh   (docker 필요)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ctx="$(mktemp -d)"
trap 'rm -rf "${ctx}"' EXIT
cp "${here}/entrypoint.sh" "${ctx}/"

cat > "${ctx}/Dockerfile" <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux bash && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 agent \
 && useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/bash agent
ENV HOME=/home/agent AGENT_MANAGER_USER=agent
# 공유 폴더가 전용 사용자 소유로 준비된 상태를 모사한다. 소유가 맞지 않는 경우는
# 아래 "쓰기 불가 경고" 사례가 따로 본다.
RUN mkdir -p /data /workspace && chown 1000:1000 /workspace
RUN printf '#!/bin/sh\necho "DBUS_SESSION_BUS_ADDRESS=stub;"\necho "DBUS_SESSION_BUS_PID=1;"\n' > /usr/local/bin/dbus-launch \
 && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/gnome-keyring-daemon \
 && printf '#!/bin/sh\n# 시크릿 서비스 흉내. store는 stdin을 파일로 받고 lookup은 그 파일을 돌려준다.\n# KEYRING_PROBE_MODE로 세 가지 고장을 만든다 — locked(store 실패), swallow(store는\n# 성공하고 값은 사라짐), hang(프롬프터 없는 컨테이너에서 멈춰 서는 경우).\n# 진짜 gnome-keyring을 넣지는 않으므로 "빈 키링 첫 기동"과 default collection 별칭 문제는\n# 이 시험의 범위 밖이고, 실기기 실측으로만 확인된다.\nf=/tmp/secret-tool-probe\ncase "$1" in\n  store)\n    [ "${KEYRING_PROBE_MODE}" = "locked" ] && exit 1\n    [ "${KEYRING_PROBE_MODE}" = "hang" ] && sleep 120\n    cat > "$f"\n    [ "${KEYRING_PROBE_MODE}" = "swallow" ] && : > "$f"\n    exit 0 ;;\n  lookup) [ -s "$f" ] || exit 1; cat "$f"; exit 0 ;;\n  clear) rm -f "$f"; exit 0 ;;\nesac\nexit 0\n' > /usr/local/bin/secret-tool \
 && printf '#!/bin/sh\necho "RUN-UID=$(id -u) RUN-GID=$(id -g) HOME=$HOME"\necho "GROUPS=$(id -G)"\necho "ARGV=$*"\necho "KEYRING_PASSWORD=${KEYRING_PASSWORD-unset}"\nstat -c "OWN %%u:%%g %%n" /data /home/agent /workspace\n' > /usr/local/bin/agent-manager-server \
 && chmod +x /usr/local/bin/dbus-launch /usr/local/bin/gnome-keyring-daemon /usr/local/bin/secret-tool /usr/local/bin/agent-manager-server
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
EOF

docker build -q -t agent-manager-privdrop-test "${ctx}" > /dev/null

run() {
  docker run --rm -e KEYRING_PASSWORD=x -e TAILSCALE_HOST=h -e TAILSCALE_USER=u "$@" \
    agent-manager-privdrop-test
}

# 실패해야 하는 경우. 출력과 종료 코드를 함께 돌려준다.
run_expecting_failure() {
  local out status
  set +e
  out="$(run "$@" 2>&1)"
  status=$?
  set -e
  printf '%s\nSTATUS=%s\n' "${out}" "${status}"
}

fail=0
expect() {
  local label="$1" needle="$2" output="$3"
  # V2/L13: grep -q가 먼저 끝나도 pipefail이 printf의 SIGPIPE를 실패로 보지 않게 한다.
  if grep -qF -- "${needle}" <<< "${output}"; then
    echo "ok   ${label}"
  else
    echo "FAIL ${label}: '${needle}' 없음"
    printf '%s\n' "${output}"
    fail=1
  fi
}

default_out="$(run)"
expect "기본 uid/gid는 전용 사용자" "RUN-UID=1000 RUN-GID=1000 HOME=/home/agent" "${default_out}"
# C20(2026-10-11)이 `--remote-write`/`--no-remote-write`를 없앴다. 엔트리포인트는 더 이상
# 그 플래그를 만들지 않으므로 기대치에서도 뺀다 — 남겨 두면 하네스가 항상 빨개서 아래
# 검사들이 아무것도 거르지 못한다.
expect "서버 argv 유지" "--app-data-dir /data --tailscale-host h --tailscale-user u" "${default_out}"
expect "볼륨 소유권 이전" "OWN 1000:1000 /data" "${default_out}"
# 잠금 해제가 끝난 볼트 암호가 서버 환경(→ 에이전트 CLI·터미널)으로 넘어가지 않는다.
expect "볼트 암호는 서버 환경에 남지 않는다" "KEYRING_PASSWORD=unset" "${default_out}"

# gid 100은 이미지에 이미 있는 users 그룹이다. 시놀로지 공유 폴더의 기본 gid이므로
# 중복을 거절하면 가장 흔한 배포가 뜨지 않는다.
mapped_out="$(run -e PUID=1027 -e PGID=100 2>&1)"
expect "PUID/PGID 재배치" "RUN-UID=1027 RUN-GID=100 HOME=/home/agent" "${mapped_out}"
expect "보조그룹은 지정한 gid 하나" "GROUPS=100" "${mapped_out}"
expect "재배치 후 소유권" "OWN 1027:100 /home/agent" "${mapped_out}"

# PUID=0은 거부한다. 받아 주면 setpriv 뒤에도 root라 엔트리포인트가 자기 자신을 끝없이
# 다시 실행하고, root를 피하려던 경로가 조용히 root로 돌아간다.
root_out="$(run_expecting_failure -e PUID=0)"
expect "PUID=0 거부" "PUID/PGID에 0을 쓸 수 없습니다" "${root_out}"
expect "PUID=0은 종료 코드 1" "STATUS=1" "${root_out}"

# 소유권을 못 맞추면 기동하지 않는다. 읽기 전용 마운트가 그 상황을 그대로 만든다.
ro_out="$(run_expecting_failure --tmpfs /data:ro)"
expect "소유권 실패 시 중단" "볼륨 소유권을" "${ro_out}"
expect "소유권 실패는 종료 코드 1" "STATUS=1" "${ro_out}"

# /workspace는 사용자 프로젝트라 소유권을 바꾸지 않는다. 쓸 수 없으면 경고만 하고 기동한다.
ws_out="$(run --tmpfs /workspace:ro 2>&1)"
expect "/workspace 쓰기 불가 경고" "/workspace에 1000:1000로 쓸 수 없습니다" "${ws_out}"
expect "경고 뒤에도 기동" "RUN-UID=1000" "${ws_out}"

# L02. 볼트가 열리지 않은 채로 기동하면 계정 목록은 앱 데이터에서 그대로 보이고 사용만
# 실패하므로, 경고가 아니라 종료 코드 1로 끝나야 한다. 판정은 소스 문자열이 아니라 실제
# 종료 코드와 서버 스텁이 돌지 않았다는 사실로 한다. 정상 키링에서 기동한다는 사실은
# 위 "기본 uid/gid" 검사가 이미 같은 출력으로 보고 있다.
expect_no_server() {
  local label="$1" output="$2"
  if grep -qF "RUN-UID=" <<< "${output}"; then
    echo "FAIL ${label}: 볼트 검사가 실패했는데 서버가 기동했다"
    fail=1
  else
    echo "ok   ${label}"
  fi
}

locked_out="$(run_expecting_failure -e KEYRING_PROBE_MODE=locked)"
expect "잠긴 키링이면 중단" "자격증명 볼트를 열지 못했습니다: 시크릿 서비스에 값을 저장하지 못했습니다" "${locked_out}"
expect "잠긴 키링은 KEYRING_PASSWORD를 짚는다" "KEYRING_PASSWORD가" "${locked_out}"
expect "잠긴 키링은 종료 코드 1" "STATUS=1" "${locked_out}"
expect_no_server "잠긴 키링에서는 서버를 띄우지 않는다" "${locked_out}"

# 저장은 성공으로 보고하고 값은 돌려주지 못하는 키링. 쓰기만 보던 예전 검사는 이걸 통과시켰다.
swallow_out="$(run_expecting_failure -e KEYRING_PROBE_MODE=swallow)"
expect "값을 삼키는 키링이면 중단" "시크릿 서비스에 저장한 값을 다시 읽지 못했습니다" "${swallow_out}"
expect "값을 삼키는 키링은 종료 코드 1" "STATUS=1" "${swallow_out}"
expect_no_server "값을 삼키는 키링에서는 서버를 띄우지 않는다" "${swallow_out}"

# 프롬프터가 없는 컨테이너에서 잠긴 컬렉션에 쓰면 secret-tool은 실패하지 않고 멈춰 선다.
# 상한이 없으면 "명확한 오류"가 아니라 "영원히 기동 중"이 되므로, 멈춤도 실패로 끝나야 한다.
hang_out="$(run_expecting_failure -e KEYRING_PROBE_MODE=hang)"
expect "멈춘 시크릿 서비스도 중단" "자격증명 볼트를 열지 못했습니다" "${hang_out}"
expect "멈춘 시크릿 서비스는 종료 코드 1" "STATUS=1" "${hang_out}"
expect_no_server "멈춘 시크릿 서비스에서는 서버를 띄우지 않는다" "${hang_out}"

# L10. 사이드카 데이터패스 모드 값. 이 컨테이너는 값을 쓰지 않고 검사만 하므로, 판정은
# "해석 가능한 값에서는 평소대로 기동하고, 그 밖의 값에서는 서버가 아예 돌지 않는다"로
# 한다 — 엔트리포인트 안의 문자열이 아니라 실제 종료 코드와 서버 스텁의 유무로 본다.
userspace_true_out="$(run -e TS_USERSPACE=true 2>&1)"
expect "TS_USERSPACE=true면 그대로 기동" "RUN-UID=1000" "${userspace_true_out}"
userspace_false_out="$(run -e TS_USERSPACE=false 2>&1)"
expect "TS_USERSPACE=false면 그대로 기동" "RUN-UID=1000" "${userspace_false_out}"
# 빈 값은 변수를 주지 않은 것과 같게 본다(기본 run()은 변수 자체를 주지 않는 다른 경로다).
userspace_empty_out="$(run -e TS_USERSPACE= 2>&1)"
expect "TS_USERSPACE 빈 값은 통과" "RUN-UID=1000" "${userspace_empty_out}"

# `yes`는 containerboot의 ParseBool이 해석하지 못해 사용자 공간 모드로 떨어지는 값이다.
userspace_typo_out="$(run_expecting_failure -e TS_USERSPACE=yes)"
expect "TS_USERSPACE 오타 거부" "TS_USERSPACE 값 'yes'은(는) 이 배포가 받지 않습니다" "${userspace_typo_out}"
expect "오타는 데이터패스가 바뀐다는 사실을 짚는다" "조용히 사용자 공간 모드로 떨어지고" "${userspace_typo_out}"
expect "TS_USERSPACE 오타는 종료 코드 1" "STATUS=1" "${userspace_typo_out}"
expect_no_server "TS_USERSPACE 오타에서는 서버를 띄우지 않는다" "${userspace_typo_out}"

# `1`·`True`는 사이드카가 정상 해석하는 값이다. 그래도 이 배포는 받지 않는다 — 허용 집합을
# 두 글자로 고정해야 로그 한 줄로 오타와 의도를 가를 수 있다. 메시지가 "해석 못 하는 값"이
# 아니라 "이 배포가 받지 않는 값"이라고 말하는 이유가 이 두 사례다.
for v in 1 True; do
  out="$(run_expecting_failure -e "TS_USERSPACE=${v}")"
  expect "TS_USERSPACE=${v}도 거부" "TS_USERSPACE 값 '${v}'은(는) 이 배포가 받지 않습니다" "${out}"
  expect_no_server "TS_USERSPACE=${v}에서는 서버를 띄우지 않는다" "${out}"
done

# 두 서비스가 같은 값을 보는지. 이번 변경의 계약은 "앱이 검사하는 값 = 사이드카가 쓰는 값"
# 이므로, 한쪽 식만 고치는 편집이 아무 시험도 깨지 않으면 L10이 닫은 실패 종류가 돌아온다.
# -F로 고정 문자열 비교를 강제한다. 정규식으로 두면 `${…}`의 중괄호 해석이 grep 구현마다
# 달라 같은 파일에서 2와 0이 모두 나온다(실측).
compose_refs="$(grep -cF 'TS_USERSPACE: ${TS_USERSPACE:-true}' "${here}/docker-compose.yml" || true)"
if [ "${compose_refs}" = "2" ]; then
  echo "ok   compose의 두 서비스가 같은 TS_USERSPACE 식을 쓴다"
else
  echo "FAIL compose의 두 서비스가 같은 TS_USERSPACE 식을 쓴다: 같은 식이 ${compose_refs}회(2회여야 한다)"
  fail=1
fi

# 기본값은 사용자 공간 모드다(L21). `.env`를 쓰지 않는 새 설치가 보는 값은 compose의
# `:-` 기본값이고, `.env.example`을 복사해 쓰는 설치가 보는 값은 그 파일의 한 줄이다.
# 둘이 갈라지면 같은 README를 따라 세운 두 설치가 서로 다른 데이터패스로 뜨므로, 한쪽만
# 고치는 편집이 여기서 걸리게 둘 다 값으로 고정한다.
env_example_default="$(grep -E '^TS_USERSPACE=' "${here}/.env.example" | head -1 | cut -d= -f2)"
if [ "${env_example_default}" = "true" ]; then
  echo "ok   .env.example의 TS_USERSPACE 기본값이 사용자 공간 모드다"
else
  echo "FAIL .env.example의 TS_USERSPACE 기본값이 사용자 공간 모드다: '${env_example_default}'"
  fail=1
fi

exit "${fail}"
