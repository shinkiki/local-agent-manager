# Agent Manager

**English** · [한국어](#한국어)

A desktop app that manages the local conversations and work of Claude Code, OpenAI Codex, Google Antigravity, and your own self-hosted local LLM in one place.

## Features

- **Dashboard**: Check the connection status and account usage of Claude Code, Codex, Antigravity, and the local LLM, and see sessions, tokens, disk usage, weekly trends, recent sessions, and recurring schedules at a glance.
- **Chat**: Start new work by choosing the provider, account, model, working folder, and permission scope. Follow answers, tool runs, file changes, and approval requests in real time, and stop or reconnect a run.
- **Session explorer**: Search and filter local conversations across providers and read full transcripts. Reopen an existing session with the official CLI to continue the work.
- **Session organization**: Sort sessions into a folder tree up to five levels deep and move them by drag and drop. Use the pencil on a folder row to change its name, color, parent, and order among siblings, or to delete it. Favorites, hiding, display titles, notes, and linking one session to several folders are also supported.
- **Recurring requests**: Schedule work with hourly, daily, weekday, and weekly presets or Cron. Manage new or continued conversations, the resume-failure policy, and the run history per task.
- **Notifications and approvals**: See pending approvals, completed or failed work, and session switches in one place and jump straight to the related chat or session. Codex tool-run requests can be allowed or denied on screen as well.
- **AIA assistant**: Ask about the app's state and get guidance and review suggestions for settings, skills, and agent instructions. Changes show their content and required permissions before they run.
- **Documents**: Register local Markdown folders, browse them as a tree, and search, create, read, edit, and download files. You are warned about conflicts when a file changes outside the app while you edit it.
- **Instructions and skills**: Browse a project's `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` and personal and project skills in one place. Create or import a shared source, publish it to target projects and providers, and check its sync status.
- **Agents and artifacts**: Browse Claude agent definitions and system prompts, and Antigravity task lists, implementation plans, and walkthroughs.
- **Projects (in development)**: View the files of a registered project and check git status, diffs, and history, or stage, commit, switch branches, stash, rebase, pull, and push from the app. Irreversible commands are not offered. This feature is still in development, so its screens and behavior may change.
- **Storage and settings**: See how much space each provider's conversation sources and Agent Manager's supplemental data use. Configure CLI and account connections, language and theme, chat display, launch at login, and remote access.
- **Local LLM**: Register your own OpenAI-compatible server (Ollama and the like) as a fourth provider. There is no account login and no usage quota, and conversations never leave the host. See [Local LLM provider](docs/local-llm.md) for details.
- **Use from other devices**: If needed, check sessions and continue permitted work from a browser or PWA on the same Tailnet through Tailscale.

## Installation

Public builds currently support macOS Apple Silicon (arm64) and Windows x64.

### macOS

1. Download the latest `aarch64.dmg` from [GitHub Releases](https://github.com/shinkiki/local-agent-manager/releases).
2. Open the DMG and move `Agent Manager.app` into the `Applications` folder.
3. Launch Agent Manager.

Builds are signed with an Apple Developer ID and notarized, so they run without any Gatekeeper workaround. To check it yourself, confirm that the following command prints `source=Notarized Developer ID`.

```bash
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
```

Older releases published before signing was introduced are not signed. If an app you downloaded earlier is blocked, download the latest version from Releases again.

### Windows

1. Download the latest `x64-setup.exe` or `x64_en-US.msi` from [GitHub Releases](https://github.com/shinkiki/local-agent-manager/releases).
2. Run `x64-setup.exe` for a regular install, or `x64_en-US.msi` if you need MSI-based deployment.
3. If a publisher signature warning appears, compare the downloaded file with the checksum on the release page before continuing the installation.

## Getting started

1. Install and log in to the Claude Code, Codex, or Antigravity CLI you want to use. If you only use a local LLM, register the server address and model in `Settings > Local LLM` instead.
2. Launch Agent Manager and check the result in `Settings > CLI connection status`.
3. If a CLI is not detected, follow the install or login guidance and choose `Check CLI again`.
4. Start new work in `Chat`, or open an existing conversation in `Sessions` to continue it.

The first launch may take a few seconds, depending on how much local conversation history has to be loaded.

## Good to know

- Closing the window keeps the app in the system tray, where it continues to handle recurring requests and notifications. To quit completely, choose `Quit` from the tray menu.
- A chat's permission scope can be `Read only`, `Workspace write`, or `Full access`. `Full access` can reach files outside the working path and run system commands, so use it only when needed.
- When approving a plan made in `Read only`, choosing `Run this plan and allow all except decisions` means that run asks only about plan changes and questions and approves every other permission request automatically. Limits you set on external plugin tools still apply.
- Recurring requests run while the computer is on and Agent Manager is running. Runs missed during sleep or shutdown are not run again automatically.
- Agent Manager never modifies a provider's source conversation data directly. New conversations and session resumes go through each provider's official CLI. The local LLM has no CLI of its own, so it runs through an ACP harness (`opencode acp`), and the only keys the app writes in that configuration file are the two listed in the [documentation](docs/local-llm.md).

## Remote access

If you need remote access, turn it on in `Settings > Backend service > Tailscale service` on the host Mac. It can then be used from a browser or PWA on devices signed in to the same Tailnet, and remote write permission follows the host app's settings.

All local features of the desktop app work without Tailscale.

## Support and policies

- Bug reports and change proposals: [CONTRIBUTING.md](CONTRIBUTING.md)
- Private reporting of security issues: [Security policy](.github/SECURITY.md)
- License: your choice of [MIT](LICENSE-MIT) or [Apache License 2.0](LICENSE-APACHE).
- Dependency copyright notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

Claude, Claude Code, OpenAI, Codex, Google, Antigravity, Tailscale, and related names may be trademarks of their respective owners. This project is not officially endorsed by or affiliated with those companies.

---

## 한국어

[English](#agent-manager) · **한국어**

Claude Code, OpenAI Codex, Google Antigravity와 직접 띄운 로컬 LLM의 로컬 대화와 작업을 한곳에서 관리하는 데스크톱 앱입니다.

### 주요 기능

- **대시보드**: Claude Code, Codex, Antigravity, 로컬 LLM의 연결 상태와 계정 사용량을 확인하고 세션·토큰·디스크 사용량, 주간 추이, 최근 세션과 반복 일정을 한눈에 살펴봅니다.
- **채팅**: 공급자, 계정, 모델, 작업 폴더와 권한 범위를 선택해 새 작업을 시작합니다. 답변, 도구 실행, 파일 변경과 승인 요청을 실시간으로 확인하고 실행을 중단하거나 다시 연결할 수 있습니다.
- **세션 탐색**: 여러 공급자의 로컬 대화를 통합 검색·필터링하고 전체 대화 내용을 읽습니다. 기존 세션은 공식 CLI로 다시 열어 이어서 작업할 수 있습니다.
- **세션 정리**: 세션을 최대 5단계 폴더 트리로 분류하고 드래그 앤 드롭으로 옮깁니다. 폴더 행의 연필에서 이름·색상·상위 폴더와 같은 단계 안의 순서를 바꾸고 삭제합니다. 즐겨찾기, 숨김, 표시 제목, 메모와 다중 폴더 연결도 지원합니다.
- **반복 요청**: 매시간·매일·평일·매주 프리셋 또는 Cron으로 작업을 예약합니다. 새 대화와 기존 대화 이어가기, 재개 실패 정책, 실행 이력을 작업별로 관리할 수 있습니다.
- **알림과 승인**: 승인 대기, 작업 완료·실패, 세션 전환 알림을 한곳에서 확인하고 관련 채팅이나 세션으로 바로 이동합니다. Codex의 도구 실행 요청도 화면에서 허용하거나 거절할 수 있습니다.
- **AIA 도우미**: 앱 상태를 질문하고 설정, 스킬, 에이전트 지침 관리에 필요한 안내와 검토 제안을 받습니다. 변경 작업은 실행 전에 내용과 권한을 확인할 수 있습니다.
- **문서**: 로컬 Markdown 폴더를 등록해 트리로 탐색하고 파일을 검색·생성·읽기·편집·다운로드합니다. 편집 중 외부에서 파일이 바뀌면 충돌을 알려 줍니다.
- **지침과 스킬**: 프로젝트의 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`와 개인·프로젝트 스킬을 한곳에서 탐색합니다. 공통 원본을 만들거나 가져와 대상 프로젝트와 공급자에 게시하고 동기화 상태를 확인할 수 있습니다.
- **에이전트와 아티팩트**: Claude 에이전트 정의와 시스템 프롬프트, Antigravity의 작업 목록·구현 계획·워크스루를 찾아보고 내용을 확인합니다.
- **저장소와 설정**: 공급자별 대화 원본과 Agent Manager 보완 데이터의 사용량을 확인합니다. CLI·계정 연결, 언어와 테마, 채팅 표시 방식, 자동 실행과 원격 접속도 설정할 수 있습니다.
- **프로젝트 (개발 중)**: 등록한 프로젝트의 파일을 보고 git 상태·diff·이력 확인, 스테이징·커밋·브랜치·stash·rebase·pull·push를 앱에서 수행합니다. 되돌릴 수 없는 명령은 제공하지 않습니다. 아직 개발 중이라 화면과 동작이 바뀔 수 있습니다.
- **로컬 LLM**: 직접 띄운 OpenAI 호환 서버(Ollama 등)를 등록해 네 번째 공급자로 씁니다. 계정 로그인도 사용량 할당량도 없고 대화 내용이 호스트를 떠나지 않습니다. 자세한 내용은 [로컬 LLM 공급자](docs/local-llm.md)를 참고하세요.
- **다른 기기에서 사용**: 필요하면 Tailscale을 통해 같은 Tailnet의 브라우저나 PWA에서 세션을 확인하고 허용된 작업을 이어갑니다.

### 설치

현재 공개 배포본은 macOS Apple Silicon(arm64)과 Windows x64를 지원합니다.

#### macOS

1. [GitHub Releases](https://github.com/shinkiki/local-agent-manager/releases)에서 최신 `aarch64.dmg` 파일을 내려받습니다.
2. DMG를 열고 `Agent Manager.app`을 `Applications` 폴더로 옮깁니다.
3. Agent Manager를 실행합니다.

배포본은 Apple Developer ID로 서명하고 공증합니다. 별도의 Gatekeeper 예외 조작 없이 바로 실행됩니다. 직접 확인하려면 다음 명령이 `source=Notarized Developer ID`를 출력하는지 보면 됩니다.

```bash
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
```

서명을 적용하기 전에 올라간 예전 릴리스는 서명되어 있지 않습니다. 예전에 받은 앱이 차단된다면 Releases에서 최신 버전을 다시 내려받으세요.

#### Windows

1. [GitHub Releases](https://github.com/shinkiki/local-agent-manager/releases)에서 최신 `x64-setup.exe` 또는 `x64_en-US.msi` 파일을 내려받습니다.
2. 일반 설치는 `x64-setup.exe`, MSI 기반 배포가 필요하면 `x64_en-US.msi`를 실행합니다.
3. 게시자 서명 경고가 표시되면 릴리즈 페이지의 체크섬과 내려받은 파일을 먼저 비교한 뒤 설치를 계속합니다.

### 처음 사용하기

1. 사용할 Claude Code, Codex 또는 Antigravity CLI를 설치하고 로그인합니다. 로컬 LLM만 쓸 경우에는 대신 `설정 > 로컬 LLM`에서 서버 주소와 모델을 등록합니다.
2. Agent Manager를 실행한 뒤 `설정 > CLI 연결 상태`에서 연결 결과를 확인합니다.
3. CLI가 보이지 않으면 설치 또는 로그인 안내를 진행하고 `CLI 다시 검사`를 선택합니다.
4. `채팅`에서 새 작업을 시작하거나 `세션`에서 기존 대화를 열어 이어서 작업합니다.

처음 실행할 때는 로컬 대화 내역을 불러오느라 데이터 양에 따라 몇 초가 걸릴 수 있습니다.

### 알아두기

- 창을 닫으면 앱은 시스템 트레이에 남아 반복 요청과 알림을 계속 처리합니다. 완전히 종료하려면 트레이 메뉴에서 `종료`를 선택하세요.
- 채팅의 권한 범위는 `읽기 전용`, `작업공간 쓰기`, `전체 접근` 중에서 선택할 수 있습니다. `전체 접근`은 작업 경로 밖의 파일과 시스템 명령에 접근할 수 있으므로 필요한 경우에만 사용하세요.
- `읽기 전용`으로 세운 계획을 승인할 때 `계획대로 실행 + 전체 허용(정책 제외)`을 고르면, 그 실행에서는 계획 변경과 질문만 확인을 받고 나머지 권한 요청은 자동 승인됩니다. 외부 플러그인 도구에 정해 둔 제한은 그대로 적용됩니다.
- 반복 요청은 컴퓨터가 켜져 있고 Agent Manager가 실행 중일 때 동작합니다. 잠자기나 종료 중 놓친 실행은 자동으로 다시 실행되지 않습니다.
- Agent Manager는 공급자의 원본 대화 데이터를 직접 수정하지 않습니다. 새 대화와 세션 재개는 각 공급자의 공식 CLI를 통해 처리합니다. 로컬 LLM은 자체 CLI가 없어 ACP 하네스(`opencode acp`)를 거치며, 이때 앱이 쓰는 설정 파일의 키는 [문서](docs/local-llm.md)에 적힌 두 개뿐입니다.

### 원격 접속

원격 접속이 필요하면 호스트 Mac의 `설정 > 백엔드 서비스 > Tailscale 서비스`에서 기능을 켭니다. 같은 Tailnet에 로그인한 기기의 브라우저 또는 PWA에서 사용할 수 있으며, 원격 변경 권한은 호스트 앱의 설정을 따릅니다.

Tailscale을 사용하지 않아도 데스크톱 앱의 로컬 기능은 정상적으로 사용할 수 있습니다.

### 지원 및 정책

- 문제 제보와 변경 제안: [CONTRIBUTING.md](CONTRIBUTING.md)
- 보안 문제 비공개 제보: [보안 정책](.github/SECURITY.md)
- 라이선스: [MIT](LICENSE-MIT) 또는 [Apache License 2.0](LICENSE-APACHE) 중 선택하여 사용할 수 있습니다.
- 의존성 저작권 고지: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

Claude, Claude Code, OpenAI, Codex, Google, Antigravity, Tailscale 및 관련 명칭은 각 소유자의 상표일 수 있습니다. 이 프로젝트는 해당 회사가 공식적으로 보증하거나 제휴한 제품이 아닙니다.
