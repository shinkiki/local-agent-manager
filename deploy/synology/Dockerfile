# Agent Manager 헤드리스 서버 컨테이너 이미지.
#
# 데스크톱(Tauri) 앱은 웹뷰가 필요해 NAS에서 돌릴 수 없다. 이 이미지는 `agent-manager-server`
# 백엔드와 정적 UI만 담고, 원격 접속은 같은 네트워크 네임스페이스에 붙는 Tailscale
# 사이드카가 담당한다. compose 파일을 함께 볼 것.
#
# 빌드는 x86_64 호스트에서 수행한다. DSM에는 Rust/Node 툴체인이 없다. Apple Silicon에서는 compose의
# `platform: linux/amd64`가 에뮬레이션 빌드를 강제한다(Rust 릴리스 빌드라 오래 걸린다).

# --- 1단계: 정적 UI 번들 ---
FROM node:22-bookworm-slim AS ui
WORKDIR /app
COPY package.json package-lock.json ./
# Cypress는 E2E 전용이라 번들에 필요 없다. 바이너리 내려받기를 끄면 npm ci가 수백 MB를 아낀다.
ENV CYPRESS_INSTALL_BINARY=0
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
# `npm run build`가 먼저 i18n 카탈로그를 소스에서 뽑는다(`scripts/generate-ui-catalog.mjs`).
# 그 스크립트는 같은 폴더의 검사 스크립트와 기준선 JSON을 읽으므로 셋을 함께 복사한다.
COPY scripts/generate-ui-catalog.mjs scripts/check-i18n-static-ui.mjs scripts/i18n-static-ui-baseline.json ./scripts/
COPY src ./src
COPY public ./public
RUN npm run build

# --- 2단계: 서버 바이너리 ---
# 런타임과 같은 bookworm(glibc 2.36)에서 빌드해 glibc 버전 불일치를 막는다.
FROM rust:1-bookworm AS server
WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config cmake \
 && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# src-tauri는 워크스페이스 멤버라 매니페스트가 있어야 워크스페이스가 해석된다. 다만 실제
# 데스크톱 소스는 필요 없으므로 빈 타깃만 둔다. Cargo.lock 정합을 유지하려고 멤버를 지우지
# 않는다(멤버를 빼면 의존성 그래프가 달라져 --locked가 깨진다).
# [lib] 섹션이 선언돼 있어 lib.rs가 없으면 매니페스트 로드 자체가 실패한다. 둘 다 만든다.
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml
RUN mkdir -p src-tauri/src \
 && echo 'fn main() {}' > src-tauri/src/main.rs \
 && : > src-tauri/src/lib.rs
# 코어 크레이트가 컴파일 시점에 include_str!로 읽는 저장소 루트의 JSON. 없으면 컴파일이 멈춘다.
COPY src/lib/uiGuideTargets.json src/lib/markdownLinkCases.json src/lib/sessionReadSummaryCases.json ./src/lib/
RUN cargo build --locked --release -p agent-manager-server

# --- 3단계: 런타임 ---
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# L04: 로그인 셸과 에이전트 CLI가 같은 UTF-8 로케일을 상속한다. Debian의 C.UTF-8은
# 별도 locales 패키지나 locale-gen 없이 사용할 수 있다.
ENV LANG=C.UTF-8

# dbus-x11 + gnome-keyring + libsecret-tools: 리눅스에서 자격증명 볼트는 keyring crate의
# secret-service를 쓴다. D-Bus 세션과 잠금 해제된 시크릿 서비스가 없으면 볼트 읽기/쓰기가
# 전부 실패한다. secret-tool은 엔트리포인트가 기동 전에 볼트를 확인하는 데 쓴다.
# procps: 관리 프로세스 신원 확인과 외부 프로세스 목록 조회가 `ps`를 부른다. 없으면
# 채팅 크래시 복구와 외부 프로세스 정리가 동작하지 않는다.
# git/ripgrep/less: 에이전트 CLI가 작업 디렉터리를 다룰 때 기대하는 기본 도구.
# python3: 스킬이 들고 오는 집계·변환 스크립트가 쓴다(예: 잡코리아 공고 수집의
# score_jobs.py). 없으면 `python3: not found`로 회차가 통째로 멈추고, 실행 중인
# 컨테이너에 apt로 넣어 봐야 컨테이너를 다시 만들 때마다 사라진다. 표준 라이브러리만
# 쓰므로 인터프리터만 있으면 된다.
# util-linux(setpriv) + passwd(useradd·usermod·groupmod): L13의 권한 내리기가 쓴다.
# bookworm-slim에 이미 들어 있지만 명시해 두어야 베이스가 더 슬림해져도 엔트리포인트가
# 조용히 깨지지 않는다.
# python3-venv: 시스템 스킬(ssh-endpoints·chat-secrets)의 `python3 -I` 한 줄 스크립트에 더해, 스킬이 가상환경을
# 만들 수 있게 한다(python3 자체는 위 줄, 사용자 요청 2026-10-11).
# openssh-client: SSH 애드온이 키 생성(ssh-keygen)·접속(ssh)·전송(scp)에 부른다. 없으면 원격 화면의
# "새 SSH 키"가 "ssh-keygen 실행 파일을 찾지 못해"로 끝난다(2026-10-11 NAS 실측).
# xvfb·xauth와 GTK/NSS/ALSA 런타임: Cypress 애드온이 띄우는 Electron 브라우저의 요구 사항이다.
# 없으면 Cypress 자체 점검이 `missing the dependency: Xvfb`로 끝나 테스트가 시작조차 못 한다
# (2026-10-10 NAS 실측). fonts-noto-cjk는 한국어 사이트 스크린샷이 네모로 깨지지 않게 한다.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git less ripgrep procps util-linux passwd python3 \
      dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools \
      xvfb xauth libgtk-3-0 libgbm1 libnotify4 libnss3 libxss1 libasound2 libxtst6 \
      fonts-liberation fonts-noto-cjk \
      openssh-client python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Node 22. bookworm의 apt nodejs는 18이라 Claude CLI(>=22)가 돌지 않으므로 UI 단계의
# 공식 Node 바이너리를 그대로 가져온다. npm/npx는 그 안의 스크립트를 가리키는 링크다.
COPY --from=ui /usr/local/bin/node /usr/local/bin/node
COPY --from=ui /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# 에이전트 CLI 셋. 전부 PATH(/usr/local/bin)에 둔다 — 헤드리스 서버는 설정 터미널이 없어
# 나중에 설치할 길이 없고, 백엔드는 PATH와 ~/.local/bin에서만 실행 파일을 찾는다.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force
# Antigravity CLI(`agy`)는 npm이 아니라 공식 부트스트랩 스크립트가 플랫폼별 네이티브 빌드를 받는다
# (linux_amd64 지원). 버전 고정 옵션이 없어 빌드 시점의 최신이 들어가며, 어떤 버전인지 빌드 로그에
# 남긴다. 실행 중 자동 업데이트는 백엔드가 막는다(antigravity_usage.rs).
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
 && /usr/local/bin/agy --version

COPY --from=server /build/target/release/agent-manager-server /usr/local/bin/agent-manager-server
COPY --from=ui /app/dist /opt/agent-manager/dist
COPY deploy/synology/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# L13: 서버·키링·에이전트 CLI는 전용 비root 사용자로 돈다. Claude CLI는 uid 0에서
# `--dangerously-skip-permissions`를 거부해 전체 접근 채팅이 exit 1로 끝나기 때문이다
# (compose의 `IS_SANDBOX=1` 우회를 이걸로 걷어낸다). HOME은 `/root`가 아니라 compose가
# 볼륨으로 받치는 `/home/agent`다 — 볼트(`.local/share/keyrings`)와 공급자 홈이 거기 있다.
# uid/gid는 이미지에 1000으로 굳히고, NAS 공유 폴더 소유자에 맞추는 일은 엔트리포인트가
# 기동 시점의 PUID/PGID 하나로만 한다 — 같은 값을 빌드와 기동 두 곳에서 받으면 어느 쪽이
# 이겼는지가 보이지 않는다.
RUN groupadd -g 1000 agent \
 && useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/bash agent
# 전역 node_modules는 root 소유라 비root가 자동 업데이트를 할 수 없다. CLI 버전은
# 이미지(CLAUDE_CODE_VERSION)가 정하므로 자동 업데이트를 꺼 매 턴 실패 경고를 없앤다.
ENV HOME=/home/agent AGENT_MANAGER_USER=agent DISABLE_AUTOUPDATER=1

# /data: 앱 데이터(세션 DB, 설정, 스킬). /workspace: 에이전트가 다룰 프로젝트 볼륨.
VOLUME ["/data", "/workspace"]
ENV AGENT_MANAGER_PORT=4178
EXPOSE 4178

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
