# 시작하기

[English](getting-started.md)

내려받기부터 Agent Manager에서 첫 Claude Code·Codex 세션을 찾아 이어가기까지의 순서와, 무언가 보이지 않을 때 확인할 항목을 정리했습니다.

## 1. 설치 전에 확인할 것

| 항목 | 필요한 경우 | 참고 |
| --- | --- | --- |
| Apple Silicon(arm64) macOS 또는 Windows x64 | 앱 실행 | Intel Mac과 Linux 데스크톱용 공개 배포본은 아직 없습니다. |
| 로그인한 Claude Code CLI(`claude`)와/또는 OpenAI Codex CLI(`codex`) | 세션 이어가기, 새 채팅, 반복 요청 | 공식 안내대로 설치·로그인합니다: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex). Antigravity CLI(`agy`)도 지원합니다. |
| 디스크에 남은 기존 기록 | 지난 세션 보기 | Claude Code: `~/.claude/projects`. Codex: `~/.codex/state_5.sqlite`와 `~/.codex/sessions`. 읽기만 하고 수정하지 않습니다. |
| Ollama 등 OpenAI 호환 서버와 [OpenCode](https://opencode.ai)(`opencode`) | 로컬 LLM을 쓸 때만 | [로컬 LLM 공급자](local-llm.md)를 참고하세요. |
| 호스트와 다른 기기의 Tailscale | 원격 접속을 쓸 때만 | 선택 사항입니다. 로컬 기능은 Tailscale 없이 모두 동작합니다. |

**데이터가 어디로 가는지.** Agent Manager는 폴더·메모·반복 요청·설정 같은 자체 데이터를 내 컴퓨터에 저장하고, 공급자의 대화 기록은 읽기 전용으로 읽습니다. Claude Code·Codex·Antigravity를 오프라인으로 만들어 주지는 않습니다. 세션을 이어가거나 새 채팅을 시작하면 공식 CLI가 터미널에서와 똑같이 요청을 해당 공급자에게 보냅니다. 대화가 직접 운영하는 서버에만 머무는 것은 로컬 LLM 공급자뿐입니다.

## 2. 설치

### macOS

1. [최신 릴리스](https://github.com/shinkiki/local-agent-manager/releases/latest)에서 `Agent.Manager_<버전>_aarch64.dmg`를 내려받습니다.
2. DMG를 열고 `Agent Manager.app`을 `Applications`로 끌어 옮깁니다.
3. `Applications`에서 실행합니다.

배포본은 Apple Developer ID로 서명하고 공증합니다. 확인하려면 다음 명령을 실행합니다.

```bash
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
```

`source=Notarized Developer ID`가 출력되어야 합니다. 예전에 받은 앱이 차단된다면 서명 전의 옛 릴리스일 수 있습니다. 경고를 우회하지 말고 최신 버전을 다시 내려받으세요.

### Windows

1. [최신 릴리스](https://github.com/shinkiki/local-agent-manager/releases/latest)에서 `Agent.Manager_<버전>_x64-setup.exe`(일반 설치) 또는 `Agent.Manager_<버전>_x64_en-US.msi`(MSI 배포)를 내려받습니다.
2. PowerShell에서 파일 해시를 계산해 릴리스 페이지의 해당 파일 옆에 표시된 `sha256:` 값과 비교합니다.

   ```powershell
   Get-FileHash .\Agent.Manager_<버전>_x64-setup.exe -Algorithm SHA256
   ```

3. 설치 파일을 실행합니다.

Windows 설치 파일은 태그 소스로 GitHub Actions에서 빌드하지만 **아직 코드 서명이 없어** SmartScreen이 게시자를 알 수 없다고 표시할 수 있습니다. 해시가 같다는 것은 릴리스 페이지에 올라간 바로 그 파일이라는 뜻이며 서명을 대신하지는 않습니다. 조직 정책상 서명되지 않은 설치 파일을 쓸 수 없다면 서명된 배포본을 기다리거나 [CONTRIBUTING.md](../CONTRIBUTING.md)의 순서대로 소스에서 빌드하세요.

## 3. CLI 연결

1. 아직이라면 공식 안내대로 Claude Code나 Codex를 설치하고 터미널에서 한 번 로그인합니다.
2. Agent Manager를 열고 `설정 > CLI 설정`로 갑니다.
3. 공급자마다 CLI를 찾았는지 표시됩니다. 공급자를 열어 설치·로그인 순서를 확인한 뒤 `CLI 다시 검사`를 누릅니다.

CLI는 없지만 기록이 있으면 "채팅 기록은 있지만 CLI 실행 파일이 없습니다"라고 알려 줍니다. 이 상태에서도 세션을 읽을 수는 있고, 이어가려면 CLI가 필요합니다.

## 4. 세션 찾아서 이어가기

1. `세션`을 엽니다. 연결된 모든 공급자의 세션이 한 목록에 나옵니다.
2. 검색창에 프로젝트명이나 기억나는 문구를 입력합니다. 제목·프로젝트·세션 ID·메모·대화 내용을 함께 찾습니다. 처음 본문을 검색할 때는 기록을 색인하느라 잠시 걸릴 수 있습니다.
3. 필요하면 공급자 탭과 프로젝트 필터로 좁힙니다.
4. 세션을 눌러 도구 실행과 결과를 포함한 전체 대화를 읽습니다.
5. 세션 패널 아래 입력창에 다음 요청을 적어 보냅니다. 원래 공급자를 고른 상태라면 그 공급자의 CLI로 **같은 세션**을 이어가며, 새 대화 내용은 평소처럼 CLI가 자기 기록에 남깁니다.

**다른 공급자를 고르면.** 그 패널의 공급자 선택에는 연결된 다른 공급자도 보입니다. 다른 공급자를 골라도 세션이 옮겨지거나 변환되지 않습니다. 그 공급자에 새 세션을 만들고 최근 사용자·에이전트 대화를 맥락으로 넘기며, 원본 세션은 바꾸지 않습니다.

## 5. 다음으로 해 볼 것

- **정리**: 세션을 최대 5단계 폴더로 분류하고 즐겨찾기·표시 제목·메모를 붙입니다. 메모도 검색됩니다.
- **반복 요청**: 매시간·매일·평일·매주 또는 Cron으로 요청을 예약하고 실행마다 결과를 확인합니다. 컴퓨터가 켜져 있고 Agent Manager가 실행 중일 때만 돕니다(창을 닫아도 트레이에 남습니다). 잠자기나 종료 중 놓친 실행은 자동으로 다시 실행되지 않습니다.
- **지침과 스킬**: 여러 프로젝트의 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`와 스킬을 한곳에서 보고, 공통 원본을 골라 둔 프로젝트·공급자에 게시합니다.
- **원격 접속**: 호스트 Mac의 `설정 > 시스템 > Tailscale 서비스`를 켜면 같은 Tailnet에 로그인한 기기의 브라우저나 PWA에서 Agent Manager를 열 수 있습니다. 호스트는 켜져 있고 앱이 실행 중이어야 하며, 원격 변경 권한은 호스트 설정을 따릅니다.

## 문제 해결

### CLI가 탐지되지 않을 때

- 터미널에서 `claude --version` 또는 `codex --version`을 실행해 봅니다. 실패하면 CLI가 설치되지 않았거나 `PATH`에 없는 것이니 공식 설치 안내부터 진행합니다.
- Agent Manager는 로그인 셸의 `PATH`와 흔한 설치 위치(`~/.local/bin`, `~/.npm-global/bin`, Homebrew의 `/opt/homebrew/bin`, nvm·volta·pnpm·bun 디렉터리, Windows의 `%APPDATA%\npm` 등)를 찾습니다. 다른 곳에 설치했다면 로그인 셸 프로필이 그 디렉터리를 `PATH`에 넣는지 확인합니다.
- 설치하거나 `PATH`를 바꾼 뒤에는 `CLI 다시 검사`를 누르거나, 트레이 메뉴에서 Agent Manager를 종료했다가 다시 실행합니다.
- CLI는 찾았는데 채팅이 시작되지 않으면 터미널에서 다시 로그인합니다(예: `claude` 실행 후 `/login`, 또는 `codex login`).

### 지난 세션이 보이지 않을 때

- **Claude Code**: `~/.claude/projects/<프로젝트>/*.jsonl`에서 읽습니다. 이 폴더가 있고 파일이 들어 있는지 확인합니다.
- **Codex**: Codex 상태 DB인 `~/.codex/state_5.sqlite`에서 세션 목록을 만듭니다. `~/.codex/sessions` 아래 rollout 파일만 있다면 Codex CLI를 업데이트하고 한 번 실행해 DB가 생기게 합니다.
- **경로를 바꾼 경우**: 홈 폴더 아래 기본 위치만 읽습니다. `CLAUDE_CONFIG_DIR`이나 `CODEX_HOME`을 다른 곳으로 바꿔 쌓인 세션은 목록에 나오지 않습니다.
- **필터**: 검색창을 비우고 공급자 탭, 프로젝트 필터, 숨긴 세션 제외 여부를 확인합니다.
- **기록이 많을 때**: 첫 로드와 첫 본문 검색은 시간이 걸릴 수 있습니다. 검색창 아래 상태 문구가 사라질 때까지 기다립니다.

### 세션 이어가기가 실패할 때

- 같은 공급자의 CLI가 탐지되고 로그인되어 있는지 확인합니다(`설정 > CLI 설정`).
- 계정을 여러 개 쓴다면 그 세션을 만든 계정으로 이어갑니다. 한 계정으로 시작한 세션은 다른 계정 프로필에서 찾지 못할 수 있습니다.

### 반복 요청이 실행되지 않았을 때

- 컴퓨터가 깨어 있고 Agent Manager가 실행 중이어야 합니다(창을 닫아도 트레이에서 계속 돕니다).
- 잠자기나 종료 중 놓친 실행은 건너뛰며 나중에 다시 실행하지 않습니다.

### 원격 접속이 안 될 때

- 호스트와 다른 기기 모두 Tailscale이 실행 중이고 같은 Tailnet에 로그인되어 있어야 합니다.
- 호스트가 깨어 있고 Agent Manager가 실행 중이며, `설정 > 시스템`에서 `Tailscale 서비스`가 켜져 있어야 합니다.

## 문제 제보

- 설치·첫 사용 문제: [제보하기](https://github.com/shinkiki/local-agent-manager/issues/new?template=problem.yml)
- 아이디어와 요청: [기능 요청](https://github.com/shinkiki/local-agent-manager/issues/new?template=feature-request.yml)
- 보안 문제: 공개 이슈 대신 [보안 정책](../.github/SECURITY.md)을 따라 주세요.

화면이나 로그를 첨부하기 전에 토큰·계정 이메일·개인 경로·비공개 대화 내용을 지워 주세요.
