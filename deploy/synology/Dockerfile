# Agent Manager 헤드리스 서버 컨테이너 이미지.
#
# 데스크톱(Tauri) 앱은 웹뷰가 필요해 NAS에서 돌릴 수 없다. 이 이미지는 `agent-manager-server`
# 백엔드와 정적 UI만 담고, 원격 접속은 같은 네트워크 네임스페이스에 붙는 Tailscale
# 사이드카가 담당한다. compose 파일을 함께 볼 것.
#
# 빌드는 x86_64 호스트에서 수행한다. DSM에는 Rust/Node 툴체인이 없다.

# --- 1단계: 정적 UI 번들 ---
FROM node:22-bookworm-slim AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
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
RUN cargo build --locked --release -p agent-manager-server

# --- 3단계: 런타임 ---
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

# dbus-x11 + gnome-keyring + libsecret-tools: 리눅스에서 자격증명 볼트는 keyring crate의
# secret-service를 쓴다. D-Bus 세션과 잠금 해제된 시크릿 서비스가 없으면 볼트 읽기/쓰기가
# 전부 실패한다. secret-tool은 엔트리포인트가 기동 전에 볼트를 확인하는 데 쓴다.
# procps: 관리 프로세스 신원 확인과 외부 프로세스 목록 조회가 `ps`를 부른다. 없으면
# 채팅 크래시 복구와 외부 프로세스 정리가 동작하지 않는다.
# git/ripgrep/less: 에이전트 CLI가 작업 디렉터리를 다룰 때 기대하는 기본 도구.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git less ripgrep procps \
      dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools \
      nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# 에이전트 CLI. Antigravity는 IDE 런처라 헤드리스에서 쓸 수 없어 넣지 않는다.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

COPY --from=server /build/target/release/agent-manager-server /usr/local/bin/agent-manager-server
COPY --from=ui /app/dist /opt/agent-manager/dist
COPY deploy/synology/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# /data: 앱 데이터(세션 DB, 설정, 스킬). /workspace: 에이전트가 다룰 프로젝트 볼륨.
VOLUME ["/data", "/workspace"]
ENV AGENT_MANAGER_PORT=4178
EXPOSE 4178

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
