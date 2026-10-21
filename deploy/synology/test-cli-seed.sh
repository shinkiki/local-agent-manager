#!/usr/bin/env bash
# 에이전트 CLI 씨앗 심기 시험(H11). 엔트리포인트가 이미지 씨앗을 HOME 볼륨의 `~/.local`로
# 심는 세 갈래 — 빈 볼륨 첫 심기, 이미 있는 설치본 유지, AGENT_MANAGER_RESEED_CLI=1 재심기 —
# 를 실제 컨테이너와 볼륨으로 확인한다.
#
# test-privdrop.sh와 같은 방식이다. 런타임 이미지 전체를 만들지 않고, 진짜 entrypoint.sh와
# profile.d 파일, 그리고 버전만 출력하는 가짜 CLI 씨앗을 작은 이미지에 담는다. 기동 대상
# (dbus·keyring·서버)은 스텁이고, 서버 스텁이 자기가 본 PATH 탐색 결과와 파일 소유자를 출력한다.
#
# 사용: deploy/synology/test-cli-seed.sh   (docker 필요)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ctx="$(mktemp -d)"
volume="agent-manager-cli-seed-test-$$"
trap 'rm -rf "${ctx}"; docker volume rm -f "${volume}" >/dev/null 2>&1 || true' EXIT
cp "${here}/entrypoint.sh" "${here}/agent-manager-cli-path.sh" "${ctx}/"

cat > "${ctx}/Dockerfile" <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux bash && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 agent \
 && useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/bash agent
# 이미지 씨앗 모양만 흉내 낸다. npm 두 개는 패키지 폴더 + 상대 bin 링크, agy는 실행 파일 하나.
ENV AGENT_MANAGER_CLI_SEED=/opt/agent-manager/cli-seed
RUN s=/opt/agent-manager/cli-seed \
 && mkdir -p "$s/bin" "$s/lib/node_modules/@anthropic-ai/claude-code/bin" "$s/lib/node_modules/@openai/codex/bin" \
 && printf '#!/bin/sh\necho seed-claude\n' > "$s/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" \
 && printf '#!/bin/sh\necho seed-codex\n' > "$s/lib/node_modules/@openai/codex/bin/codex.js" \
 && printf '#!/bin/sh\necho seed-agy\n' > "$s/bin/agy" \
 && chmod +x "$s/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$s/lib/node_modules/@openai/codex/bin/codex.js" "$s/bin/agy" \
 && ln -s ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe "$s/bin/claude" \
 && ln -s ../lib/node_modules/@openai/codex/bin/codex.js "$s/bin/codex"
COPY agent-manager-cli-path.sh /etc/profile.d/agent-manager-cli.sh
ENV HOME=/home/agent AGENT_MANAGER_USER=agent NPM_CONFIG_PREFIX=/home/agent/.local \
    PATH=/home/agent/.local/bin:$PATH
RUN mkdir -p /data /workspace && chown 1000:1000 /workspace
RUN printf '#!/bin/sh\necho "DBUS_SESSION_BUS_ADDRESS=stub;"\necho "DBUS_SESSION_BUS_PID=1;"\n' > /usr/local/bin/dbus-launch \
 && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/gnome-keyring-daemon \
 && printf '#!/bin/sh\nf=/tmp/secret-tool-probe\ncase "$1" in\n  store) cat > "$f"; exit 0 ;;\n  lookup) cat "$f"; exit 0 ;;\n  clear) rm -f "$f"; exit 0 ;;\nesac\n' > /usr/local/bin/secret-tool \
 && printf '#!/bin/sh\nfor c in claude codex agy; do echo "FOUND $c=$(command -v $c) RUNS=$($c --version)"; done\necho "LOGIN-PATH $(sh -l -c "command -v claude")"\necho "LINK claude=$(readlink $HOME/.local/bin/claude)"\nstat -c "OWN %%u:%%g %%n" $HOME/.local/bin/claude $HOME/.local/lib/node_modules/@openai/codex $HOME/.local/bin/agy\n' > /usr/local/bin/agent-manager-server \
 && chmod +x /usr/local/bin/dbus-launch /usr/local/bin/gnome-keyring-daemon /usr/local/bin/secret-tool /usr/local/bin/agent-manager-server
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
EOF

docker build -q -t agent-manager-cli-seed-test "${ctx}" > /dev/null
docker volume create "${volume}" > /dev/null

run() {
  docker run --rm -e KEYRING_PASSWORD=x -e TAILSCALE_HOST=h -e TAILSCALE_USER=u \
    -v "${volume}:/home/agent" "$@" agent-manager-cli-seed-test 2>&1
}

fail=0
expect() {
  local label="$1" needle="$2" output="$3"
  if printf '%s' "${output}" | grep -qF -- "${needle}"; then
    echo "ok   ${label}"
  else
    echo "FAIL ${label}: '${needle}' 없음"
    printf '%s\n' "${output}"
    fail=1
  fi
}

# 1) 빈 볼륨: 세 CLI가 심기고, 서버 PATH와 로그인 셸 PATH가 모두 사용자 사본을 먼저 잡는다.
first="$(run)"
expect "첫 심기 claude" "CLI claude: 씨앗 심음(첫 심기) seed-claude" "${first}"
expect "첫 심기 codex" "CLI codex: 씨앗 심음(첫 심기) seed-codex" "${first}"
expect "첫 심기 agy" "CLI agy: 씨앗 심음(첫 심기) seed-agy" "${first}"
expect "서버 PATH가 사용자 사본" "FOUND claude=/home/agent/.local/bin/claude RUNS=seed-claude" "${first}"
expect "agy도 사용자 사본" "FOUND agy=/home/agent/.local/bin/agy RUNS=seed-agy" "${first}"
expect "로그인 셸 PATH도 사용자 사본" "LOGIN-PATH /home/agent/.local/bin/claude" "${first}"
expect "bin 링크는 상대 경로로 복사" "LINK claude=../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "${first}"
expect "심은 파일은 전용 사용자 소유" "OWN 1000:1000 /home/agent/.local/lib/node_modules/@openai/codex" "${first}"

# 2) 사용자가 앱에서 올린 것처럼 사본을 바꾼다. 다음 기동은 그 판을 유지해야 한다.
docker run --rm --user 1000:1000 -v "${volume}:/home/agent" --entrypoint sh agent-manager-cli-seed-test \
  -c 'printf "#!/bin/sh\necho user-claude\n" > /home/agent/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
kept="$(run)"
expect "설치본 유지" "CLI claude: 설치본 유지 user-claude (씨앗 seed-claude)" "${kept}"
expect "유지한 판이 실제로 돈다" "RUNS=user-claude" "${kept}"

# 3) 재심기 스위치는 사용자 판을 씨앗으로 덮는다.
reseeded="$(run -e AGENT_MANAGER_RESEED_CLI=1)"
expect "재심기 경고" "AGENT_MANAGER_RESEED_CLI=1: 세 CLI를 이미지 씨앗으로 되돌립니다" "${reseeded}"
expect "재심기 claude" "CLI claude: 씨앗 심음(재심기(AGENT_MANAGER_RESEED_CLI=1)) seed-claude" "${reseeded}"
expect "재심기 뒤 씨앗 판이 돈다" "FOUND claude=/home/agent/.local/bin/claude RUNS=seed-claude" "${reseeded}"

# 4) 반쯤 심긴 상태(bin 링크만 없음)는 다음 기동이 다시 심는다.
docker run --rm --user 1000:1000 -v "${volume}:/home/agent" --entrypoint rm agent-manager-cli-seed-test \
  /home/agent/.local/bin/codex
resumed="$(run)"
expect "bin 없으면 다시 심음" "CLI codex: 씨앗 심음(첫 심기) seed-codex" "${resumed}"
expect "임시 조각이 남지 않음" "FOUND codex=/home/agent/.local/bin/codex RUNS=seed-codex" "${resumed}"
leftover="$(docker run --rm -v "${volume}:/home/agent" --entrypoint sh agent-manager-cli-seed-test \
  -c 'echo "LEFTOVER=$(find /home/agent/.local -name ".seed-*" | wc -l)"')"
expect "임시 이름 정리" "LEFTOVER=0" "${leftover}"

if [ "${fail}" -ne 0 ]; then
  exit 1
fi
echo "모두 통과"
