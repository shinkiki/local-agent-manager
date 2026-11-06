# Agent Manager

**English** · [한국어](#한국어)

**Find a past Claude Code or Codex session by project or keyword, read what happened, and continue it — from one desktop app on macOS and Windows.**

Agent Manager is for developers who already use Claude Code or OpenAI Codex and lose track of sessions spread across projects and terminals. Google Antigravity and self-hosted local LLMs are supported as well.

![Sessions from several providers in one list, with folders and filters](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-sessions.png)

<!-- Replace this screenshot with the 30–45 s "search → read → continue" demo once it is recorded. -->

## Download

Get the files from the [latest release](https://github.com/shinkiki/local-agent-manager/releases/latest).

| Platform | File | Signing |
| --- | --- | --- |
| macOS, Apple Silicon (arm64) | `Agent.Manager_<version>_aarch64.dmg` | Signed with an Apple Developer ID and notarized |
| Windows x64 | `Agent.Manager_<version>_x64-setup.exe` or `Agent.Manager_<version>_x64_en-US.msi` | **Not code-signed yet** — read [Windows](#windows) before installing |

There are no public builds for Intel Macs or Linux desktops yet.

## What you need

- **Claude Code** (`claude`) or **OpenAI Codex** (`codex`) installed and signed in with your own account. The Antigravity CLI (`agy`) works too.
- Reading and searching past sessions uses the history those CLIs already keep on your disk. Continuing a session or starting a new one runs that provider's official CLI, so the CLI has to be installed and signed in.
- Agent Manager does not make Claude or Codex work offline. What you send still goes to that provider through its CLI, exactly as it does in a terminal. The app's own data — folders, notes, schedules, settings — stays on your computer.
- For a local LLM only: an OpenAI-compatible server such as Ollama, plus [OpenCode](https://opencode.ai) (`opencode`) as the run harness. See [Local LLM provider](docs/local-llm.md) (Korean).

## Quick start: find a session and continue it

1. Install the app ([macOS](#macos) · [Windows](#windows)) and launch it. The first launch can take a few seconds while local history loads.
2. Open `Settings > CLI settings` and check that Claude Code or Codex is detected. If it is not, see [Troubleshooting](docs/getting-started.md#troubleshooting).
3. Open `Sessions` and type a project name or a phrase you remember into the search box. It matches titles, projects, session IDs, your notes, and the conversation text.
4. Click a result to read the full transcript, including tool calls.
5. Type your next message in the box at the bottom of the session panel. With the original provider selected, it continues **the same session** through that provider's CLI.

> Choosing a *different* provider in that panel does not move or convert the session. It starts a new session with that provider and hands off the recent messages as context; the original session is left unchanged.

A longer walkthrough with troubleshooting is in [Getting started](docs/getting-started.md).

## Highlights

- **One session list across providers**: Search, filter, sort into folders, star, and annotate Claude Code, Codex, Antigravity, and local LLM sessions, then reopen any of them to keep working.
- **Instructions and skills across projects**: See each project's `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` and its skills in one place. Keep a shared source, publish it to the projects and providers you choose, and see what is out of sync.
- **Recurring requests**: Schedule a prompt hourly, daily, on weekdays, weekly, or with Cron, and review each run's result. Runs happen only while the computer is on and the app is running.

## All features

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
- **Projects**: View the files of a registered project and check git status, diffs, and history, or stage, commit, switch branches, stash, rebase, pull, and push from the app. Irreversible commands are not offered.
- **Storage and settings**: See how much space each provider's conversation sources and Agent Manager's supplemental data use. Configure CLI and account connections, language and theme, chat display, launch at login, and remote access.
- **Local LLM**: Register your own OpenAI-compatible server (Ollama and the like) as a fourth provider. There is no account login and no usage quota, and conversations go only to the server you run. See [Local LLM provider](docs/local-llm.md) for details.
- **Use from other devices**: If needed, check sessions and continue permitted work from a browser or PWA on the same Tailnet through Tailscale.

## Screenshots

All screenshots use demo data in dark mode — no real accounts or projects.

<details>
<summary><b>More screenshots (34)</b></summary>

### Dashboard and chat

**Dashboard: sessions, tokens, connected CLIs and per-account burn rate**

![Dashboard: sessions, tokens, connected CLIs and per-account burn rate](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-dashboard.png)

**Recent sessions, recurring schedules, top projects and model mix**

![Recent sessions, recurring schedules, top projects and model mix](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-dashboard-activity.png)

**Live chat with grouped tool calls and test output**

![Live chat with grouped tool calls and test output](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-chat.png)

**Permission request card before a git push**

![Permission request card before a git push](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-chat-approval.png)

**Plan-mode review card with run options**

![Plan-mode review card with run options](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-chat-plan.png)

**AIA system agent answering a usage and schedule question**

![AIA system agent answering a usage and schedule question](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-aia.png)

**Notification center: approvals, completions, failures, pacing tips**

![Notification center: approvals, completions, failures, pacing tips](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-notifications.png)

### Sessions

**Unified session catalog across all providers, with folders**

![Unified session catalog across all providers, with folders](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-sessions.png)

**Session drawer with the full conversation and tool calls**

![Session drawer with the full conversation and tool calls](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-session-transcript.png)

### Projects

**Project file browser with rendered README preview**

![Project file browser with rendered README preview](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-projects-files.png)

**Git tab: staged/changed/untracked files and commit graph**

![Git tab: staged/changed/untracked files and commit graph](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-projects-git.png)

**Staged diff viewer**

![Staged diff viewer](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-projects-git-diff.png)

**Branches, remotes, worktrees and expanded commit files**

![Branches, remotes, worktrees and expanded commit files](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-projects-git-history.png)

### Automation

**Recurring requests with next run and recent results**

![Recurring requests with next run and recent results](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-schedules.png)

**Schedule editor: prompt, account, execution mode and approvals**

![Schedule editor: prompt, account, execution mode and approvals](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-schedule-editor.png)

**Registered workflow contracts and run settings**

![Registered workflow contracts and run settings](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-workflows.png)

**Workflow pacing: account pool and usage budget**

![Workflow pacing: account pool and usage budget](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-pacing.png)

**Paced rounds with per-account cost per run**

![Paced rounds with per-account cost per run](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-pacing-rounds.png)

### Library

**Skill library with per-agent install state**

![Skill library with per-agent install state](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-skills.png)

**Skill drawer: OS compatibility and per-location deployment**

![Skill drawer: OS compatibility and per-location deployment](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-skills-detail.png)

**Instruction deployment matrix by project and agent**

![Instruction deployment matrix by project and agent](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-instructions.png)

**Deployed CLAUDE.md / AGENTS.md / GEMINI.md browser**

![Deployed CLAUDE.md / AGENTS.md / GEMINI.md browser](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-instructions-info.png)

**Docs viewer rendering Markdown and Mermaid**

![Docs viewer rendering Markdown and Mermaid](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-docs.png)

**Claude sub-agent definitions with tools and models**

![Claude sub-agent definitions with tools and models](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-agents.png)

**Antigravity artifacts grouped by conversation**

![Antigravity artifacts grouped by conversation](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-artifacts.png)

**Storage overview: provider sources vs app-owned data**

![Storage overview: provider sources vs app-owned data](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-storage.png)

**Saved and per-chat secrets, values never shown**

![Saved and per-chat secrets, values never shown](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-storage-secrets.png)

### Add-ons and settings

**External MCP plugins (Notion, GitHub, Google) with tool permissions**

![External MCP plugins (Notion, GitHub, Google) with tool permissions](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-addons-plugins.png)

**SSH keys with agent-enabled endpoints**

![SSH keys with agent-enabled endpoints](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-addons-ssh.png)

**Database connections with read-only / approval write modes**

![Database connections with read-only / approval write modes](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-addons-db.png)

**Cypress automation workspaces and spec editor**

![Cypress automation workspaces and spec editor](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-addons-cypress.png)

**Multiple accounts per provider with live usage windows**

![Multiple accounts per provider with live usage windows](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-settings-accounts.png)

**Local LLM (Ollama) connections with reachability checks**

![Local LLM (Ollama) connections with reachability checks](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-settings-local-llm.png)

**Backend service: Tailscale remote access, remote editing, sleep prevention**

![Backend service: Tailscale remote access, remote editing, sleep prevention](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.1/am-031-en-settings-backend.png)

</details>

## Installation

### macOS

1. Download the latest `aarch64.dmg` from the [latest release](https://github.com/shinkiki/local-agent-manager/releases/latest).
2. Open the DMG and move `Agent Manager.app` into the `Applications` folder.
3. Launch Agent Manager.

Builds are signed with an Apple Developer ID and notarized, so they open without any Gatekeeper workaround. To check it yourself, confirm that the following command prints `source=Notarized Developer ID`.

```bash
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
```

Older releases published before signing was introduced are not signed. If an app you downloaded earlier is blocked, download the latest version again instead of bypassing the warning.

### Windows

1. Download the latest `x64-setup.exe` (regular install) or `x64_en-US.msi` (MSI-based deployment) from the [latest release](https://github.com/shinkiki/local-agent-manager/releases/latest).
2. Check the file before running it. In PowerShell, run `Get-FileHash .\<file name> -Algorithm SHA256` and compare the result with the `sha256:` value shown next to that file on the release page.
3. Run the installer.

The Windows installers are built by GitHub Actions from the tagged source, but they are **not code-signed yet**, so Windows SmartScreen may say the publisher is unknown. A matching hash only shows that the file is the one published on the release page; it is not a substitute for a code signature. If your organization does not allow unsigned installers, wait for a signed build or build from source ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Good to know

- Closing the window keeps the app in the system tray, where it continues to handle recurring requests and notifications. To quit completely, choose `Quit` from the tray menu.
- A chat's permission scope can be `Read only`, `Workspace write`, or `Full access`. `Full access` can reach files outside the working path and run system commands, so use it only when needed.
- When approving a plan made in `Read only`, choosing `Run this plan and allow all except decisions` means that run asks only about plan changes and questions and approves every other permission request automatically. Limits you set on external plugin tools still apply.
- Recurring requests run while the computer is on and Agent Manager is running. Runs missed during sleep or shutdown are not run again automatically.
- Agent Manager never modifies a provider's source conversation data directly. New conversations and session resumes go through each provider's official CLI. The local LLM has no CLI of its own, so it runs through an ACP harness (`opencode acp`), and the only keys the app writes in that configuration file are the two listed in the [documentation](docs/local-llm.md).

## Remote access

If you need remote access, turn it on in `Settings > System > Tailscale service` on the host Mac. It can then be used from a browser or PWA on devices signed in to the same Tailnet, and remote write permission follows the host app's settings. The host has to stay on with Agent Manager running.

All local features of the desktop app work without Tailscale.

## FAQ

**Does it move my Claude Code conversation into Codex?**
No. Each session stays with the provider that created it. Continuing with another provider starts a new session there and passes the recent messages along as context.

**Does it change the providers' history files?**
No. Agent Manager reads them read-only. New turns are written by the provider's own CLI, the same way they would be in a terminal.

**Do I need a separate API key?**
Not for Claude Code, Codex, or Antigravity. The app runs the official CLI, which uses the login you already set up for it.

**Does it work offline?**
Only with a local LLM. With Claude Code, Codex, or Antigravity, your prompts go to that provider as usual.

**Intel Mac or Linux?**
No public builds yet.

## Feedback

Reports from first-time users help the most. If you got stuck anywhere between download and continuing your first session, please [open an install or first-use report](https://github.com/shinkiki/local-agent-manager/issues/new?template=problem.yml). After a week of use, the [first-week feedback form](https://github.com/shinkiki/local-agent-manager/issues/new?template=first-week-feedback.yml) asks three short questions. Remove tokens, personal paths, and private conversation text from anything you attach.

## Support and policies

- Bug reports and change proposals: [CONTRIBUTING.md](CONTRIBUTING.md)
- Private reporting of security issues: [Security policy](.github/SECURITY.md)
- License: your choice of [MIT](LICENSE-MIT) or [Apache License 2.0](LICENSE-APACHE).
- Dependency copyright notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

Claude, Claude Code, OpenAI, Codex, Google, Antigravity, Tailscale, and related names may be trademarks of their respective owners. This project is not officially endorsed by or affiliated with those companies.

---

## 한국어

[English](#agent-manager) · **한국어**

**Claude Code·Codex에 흩어진 대화와 작업을 프로젝트명이나 키워드로 찾아 내용을 확인하고, 그 자리에서 이어서 작업하는 데스크톱 앱입니다(macOS·Windows).**

Claude Code나 OpenAI Codex를 이미 쓰면서 여러 프로젝트와 터미널에 흩어진 세션을 다시 찾기 어려웠던 개발자를 위한 앱입니다. Google Antigravity와 직접 띄운 로컬 LLM도 지원합니다.

![여러 공급자의 세션을 한 목록에서 폴더·필터로 정리](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-sessions.png)

<!-- "검색 → 확인 → 이어가기" 30~45초 데모를 촬영하면 이 화면을 교체합니다. -->

### 내려받기

[최신 릴리스](https://github.com/shinkiki/local-agent-manager/releases/latest)에서 내려받습니다.

| 환경 | 파일 | 서명 |
| --- | --- | --- |
| macOS, Apple Silicon(arm64) | `Agent.Manager_<버전>_aarch64.dmg` | Apple Developer ID 서명·공증 |
| Windows x64 | `Agent.Manager_<버전>_x64-setup.exe` 또는 `Agent.Manager_<버전>_x64_en-US.msi` | **아직 코드 서명 없음** — 설치 전에 [Windows](#windows-1) 안내를 확인하세요 |

Intel Mac과 Linux 데스크톱용 공개 배포본은 아직 없습니다.

### 필요한 것

- 본인 계정으로 설치·로그인한 **Claude Code**(`claude`) 또는 **OpenAI Codex**(`codex`) CLI. Antigravity CLI(`agy`)도 쓸 수 있습니다.
- 지난 세션을 읽고 검색하는 일은 각 CLI가 디스크에 남긴 기록만 읽습니다. 세션을 이어가거나 새로 시작할 때는 해당 공급자의 공식 CLI를 실행하므로 CLI가 설치·로그인되어 있어야 합니다.
- Agent Manager를 쓴다고 Claude·Codex가 오프라인으로 동작하지는 않습니다. 보내는 요청은 터미널에서 쓸 때와 똑같이 CLI를 거쳐 해당 공급자에게 전달됩니다. 폴더·메모·반복 요청·설정 같은 앱 자체 데이터는 내 컴퓨터에 저장됩니다.
- 로컬 LLM만 쓸 때: Ollama 같은 OpenAI 호환 서버와 실행 하네스인 [OpenCode](https://opencode.ai)(`opencode`)가 필요합니다. [로컬 LLM 공급자](docs/local-llm.md)를 참고하세요.

### 빠른 시작: 세션 찾아서 이어가기

1. 앱을 설치하고([macOS](#macos-1) · [Windows](#windows-1)) 실행합니다. 처음 실행할 때는 로컬 대화 내역을 불러오느라 몇 초가 걸릴 수 있습니다.
2. `설정 > CLI 설정`에서 Claude Code나 Codex가 탐지됐는지 확인합니다. 보이지 않으면 [문제 해결](docs/getting-started.ko.md#문제-해결)을 보세요.
3. `세션`을 열고 검색창에 프로젝트명이나 기억나는 문구를 입력합니다. 제목·프로젝트·세션 ID·메모·대화 내용을 함께 찾습니다.
4. 결과를 눌러 도구 실행 기록을 포함한 전체 대화를 확인합니다.
5. 세션 패널 아래 입력창에 다음 요청을 적습니다. 원래 공급자를 고른 상태라면 그 공급자의 CLI로 **같은 세션**을 이어갑니다.

> 그 패널에서 *다른* 공급자를 고르면 세션이 옮겨지거나 변환되지 않습니다. 해당 공급자에 새 세션을 만들고 최근 대화를 맥락으로 넘기며, 원본 세션은 그대로 둡니다.

자세한 순서와 문제 해결은 [시작하기](docs/getting-started.ko.md)에 있습니다.

### 대표 기능

- **여러 공급자의 세션을 한 목록에서**: Claude Code·Codex·Antigravity·로컬 LLM 세션을 검색·필터링하고 폴더·즐겨찾기·메모로 정리한 뒤 다시 열어 이어서 작업합니다.
- **여러 프로젝트의 지침과 스킬 관리**: 프로젝트별 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`와 스킬을 한곳에서 보고, 공통 원본을 골라 둔 프로젝트·공급자에 게시한 뒤 어긋난 곳을 확인합니다.
- **반복 요청**: 매시간·매일·평일·매주 또는 Cron으로 요청을 예약하고 실행마다 결과를 확인합니다. 컴퓨터가 켜져 있고 앱이 실행 중일 때만 동작합니다.

### 전체 기능

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
- **프로젝트**: 등록한 프로젝트의 파일을 보고 git 상태·diff·이력 확인, 스테이징·커밋·브랜치·stash·rebase·pull·push를 앱에서 수행합니다. 되돌릴 수 없는 명령은 제공하지 않습니다.
- **로컬 LLM**: 직접 띄운 OpenAI 호환 서버(Ollama 등)를 등록해 네 번째 공급자로 씁니다. 계정 로그인도 사용량 할당량도 없고 대화 내용은 직접 운영하는 서버로만 갑니다. 자세한 내용은 [로컬 LLM 공급자](docs/local-llm.md)를 참고하세요.
- **다른 기기에서 사용**: 필요하면 Tailscale을 통해 같은 Tailnet의 브라우저나 PWA에서 세션을 확인하고 허용된 작업을 이어갑니다.

### 화면

모든 화면은 다크 모드의 데모 데이터로 촬영했습니다. 실제 계정이나 프로젝트가 아닙니다.

<details>
<summary><b>화면 더 보기 (34장)</b></summary>

#### 대시보드와 채팅

**네 공급자의 연결 상태, 계정별 소진율, 세션·토큰·용량을 한 화면에서**

![네 공급자의 연결 상태, 계정별 소진율, 세션·토큰·용량을 한 화면에서](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-dashboard.png)

**최근 세션, 반복 일정, 상위 프로젝트와 모델 분포**

![최근 세션, 반복 일정, 상위 프로젝트와 모델 분포](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-dashboard-activity.png)

**앱 안에서 에이전트와 대화 — 도구 실행 결과와 마크다운 답변**

![앱 안에서 에이전트와 대화 — 도구 실행 결과와 마크다운 답변](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-chat.png)

**위험한 명령은 실행 전에 승인 카드로 확인**

![위험한 명령은 실행 전에 승인 카드로 확인](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-chat-approval.png)

**계획 모드: 실행 전에 계획을 검토하고 실행 방식 선택**

![계획 모드: 실행 전에 계획을 검토하고 실행 방식 선택](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-chat-plan.png)

**AIA 도우미에게 사용량과 일정을 물어보기**

![AIA 도우미에게 사용량과 일정을 물어보기](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-aia.png)

**완료·승인 대기·실패·페이싱 제안을 한 곳에서 보는 알림 센터**

![완료·승인 대기·실패·페이싱 제안을 한 곳에서 보는 알림 센터](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-notifications.png)

#### 세션

**네 공급자의 세션을 한 목록에서 — 폴더·즐겨찾기·필터로 정리**

![네 공급자의 세션을 한 목록에서 — 폴더·즐겨찾기·필터로 정리](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-sessions.png)

**세션 상세에서 대화와 도구 실행 기록을 그대로 다시 읽기**

![세션 상세에서 대화와 도구 실행 기록을 그대로 다시 읽기](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-session-transcript.png)

#### 프로젝트

**저장소 트리를 펼치고 README를 읽기 전용으로 미리 보기**

![저장소 트리를 펼치고 README를 읽기 전용으로 미리 보기](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-projects-files.png)

**브랜치 앞섬·뒤처짐, 스테이지·변경·추적 안 된 파일과 커밋 이력을 한 화면에서**

![브랜치 앞섬·뒤처짐, 스테이지·변경·추적 안 된 파일과 커밋 이력을 한 화면에서](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-projects-git.png)

**변경 파일을 누르면 diff 모달로 패치를 확인**

![변경 파일을 누르면 diff 모달로 패치를 확인](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-projects-git-diff.png)

**커밋을 펼쳐 바뀐 파일과 브랜치·원격 브랜치를 확인**

![커밋을 펼쳐 바뀐 파일과 브랜치·원격 브랜치를 확인](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-projects-git-history.png)

#### 자동화

**반복 요청 — 공급자별 일정, 다음 실행, 실행 중 상태와 이전 실행 기록**

![반복 요청 — 공급자별 일정, 다음 실행, 실행 중 상태와 이전 실행 기록](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-schedules.png)

**반복 요청 편집기 — 요청 본문·작업 경로·권한·승인 처리**

![반복 요청 편집기 — 요청 본문·작업 경로·권한·승인 처리](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-schedule-editor.png)

**등록된 워크플로 계약 목록과 페이싱 회차 계약의 상세·실행 설정**

![등록된 워크플로 계약 목록과 페이싱 회차 계약의 상세·실행 설정](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-workflows.png)

**워크플로 페이싱 — 계정 풀 소진율과 창 초기화까지 남은 시간**

![워크플로 페이싱 — 계정 풀 소진율과 창 초기화까지 남은 시간](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-pacing.png)

**페이싱 회차 카드 — 다음 실행 계정·추론 수준, 완료조건, 계정별 회당 소비**

![페이싱 회차 카드 — 다음 실행 계정·추론 수준, 완료조건, 계정별 회당 소비](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-pacing-rounds.png)

#### 라이브러리

**공통 스킬을 Claude·Codex·Antigravity·Ollama의 개인·프로젝트 위치에 배포**

![공통 스킬을 Claude·Codex·Antigravity·Ollama의 개인·프로젝트 위치에 배포](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-skills.png)

**스킬 상세 — 위치별·에이전트별 사용 설정**

![스킬 상세 — 위치별·에이전트별 사용 설정](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-skills-detail.png)

**팀 공통 규칙의 프로젝트별 CLAUDE.md·AGENTS.md·GEMINI.md 배포 현황**

![팀 공통 규칙의 프로젝트별 CLAUDE.md·AGENTS.md·GEMINI.md 배포 현황](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-instructions.png)

**프로젝트별 지침 파일 트리와 연결 문서, 본문 미리보기**

![프로젝트별 지침 파일 트리와 연결 문서, 본문 미리보기](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-instructions-info.png)

**등록 폴더 트리와 Mermaid 다이어그램이 그려진 문서 미리보기**

![등록 폴더 트리와 Mermaid 다이어그램이 그려진 문서 미리보기](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-docs.png)

**Claude 에이전트 정의 — 모델·도구·정의 파일**

![Claude 에이전트 정의 — 모델·도구·정의 파일](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-agents.png)

**Antigravity 대화의 작업 목록·구현 계획·워크스루**

![Antigravity 대화의 작업 목록·구현 계획·워크스루](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-artifacts.png)

**공급자 대화 원본과 Agent Manager 보완 저장소 사용량**

![공급자 대화 원본과 Agent Manager 보완 저장소 사용량](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-storage.png)

**저장된 비밀값과 대화별 임시 비밀값 (값은 가려짐)**

![저장된 비밀값과 대화별 임시 비밀값 (값은 가려짐)](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-storage-secrets.png)

#### 애드온과 설정

**Notion·GitHub·Google Drive·Calendar·Figma를 채팅 도구로 연결하고 도구마다 권한 지정**

![Notion·GitHub·Google Drive·Calendar·Figma를 채팅 도구로 연결하고 도구마다 권한 지정](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-addons-plugins.png)

**SSH 키마다 연결 서버와 에이전트 사용·파일 전송·출력 표시 지정**

![SSH 키마다 연결 서버와 에이전트 사용·파일 전송·출력 표시 지정](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-addons-ssh.png)

**PostgreSQL·MySQL·SQLite 연결을 환경 라벨과 쓰기 모드별로 등록**

![PostgreSQL·MySQL·SQLite 연결을 환경 라벨과 쓰기 모드별로 등록](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-addons-db.png)

**Cypress 작업공간의 설정과 스펙 파일을 앱 안에서 편집**

![Cypress 작업공간의 설정과 스펙 파일을 앱 안에서 편집](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-addons-cypress.png)

**공급자별 CLI 연결과 여러 계정의 5시간·7일 사용량 관리**

![공급자별 CLI 연결과 여러 계정의 5시간·7일 사용량 관리](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-settings-accounts.png)

**이 기기와 Tailscale 너머의 Ollama 서버를 여러 개 등록하고 점검**

![이 기기와 Tailscale 너머의 Ollama 서버를 여러 개 등록하고 점검](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-settings-local-llm.png)

**Tailscale 서비스와 로그인 설정(ID/비밀번호·OTP, 접근 채널별)으로 휴대폰에서 원격 사용**

![Tailscale 서비스와 로그인 설정으로 휴대폰에서 원격 사용](https://github.com/shinkiki/local-agent-manager/releases/download/v0.3.0/am-030-settings-backend.png)

</details>

### 설치

#### macOS

1. [최신 릴리스](https://github.com/shinkiki/local-agent-manager/releases/latest)에서 `aarch64.dmg` 파일을 내려받습니다.
2. DMG를 열고 `Agent Manager.app`을 `Applications` 폴더로 옮깁니다.
3. Agent Manager를 실행합니다.

배포본은 Apple Developer ID로 서명하고 공증합니다. 별도의 Gatekeeper 예외 조작 없이 바로 실행됩니다. 직접 확인하려면 다음 명령이 `source=Notarized Developer ID`를 출력하는지 보면 됩니다.

```bash
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
```

서명을 적용하기 전에 올라간 예전 릴리스는 서명되어 있지 않습니다. 예전에 받은 앱이 차단된다면 경고를 우회하지 말고 최신 버전을 다시 내려받으세요.

#### Windows

1. [최신 릴리스](https://github.com/shinkiki/local-agent-manager/releases/latest)에서 `x64-setup.exe`(일반 설치) 또는 `x64_en-US.msi`(MSI 기반 배포)를 내려받습니다.
2. 실행하기 전에 파일을 확인합니다. PowerShell에서 `Get-FileHash .\<파일 이름> -Algorithm SHA256`을 실행해 릴리스 페이지의 해당 파일 옆에 표시된 `sha256:` 값과 같은지 비교합니다.
3. 설치 파일을 실행합니다.

Windows 설치 파일은 태그 소스로 GitHub Actions에서 빌드하지만 **아직 코드 서명이 없어** SmartScreen이 게시자를 알 수 없다고 표시할 수 있습니다. 해시가 같다는 것은 릴리스 페이지에 올라간 그 파일이라는 뜻일 뿐 코드 서명을 대신하지는 않습니다. 조직 정책상 서명되지 않은 설치 파일을 쓸 수 없다면 서명된 배포본을 기다리거나 소스에서 직접 빌드하세요([CONTRIBUTING.md](CONTRIBUTING.md)).

### 알아두기

- 창을 닫으면 앱은 시스템 트레이에 남아 반복 요청과 알림을 계속 처리합니다. 완전히 종료하려면 트레이 메뉴에서 `종료`를 선택하세요.
- 채팅의 권한 범위는 `읽기 전용`, `작업공간 쓰기`, `전체 접근` 중에서 선택할 수 있습니다. `전체 접근`은 작업 경로 밖의 파일과 시스템 명령에 접근할 수 있으므로 필요한 경우에만 사용하세요.
- `읽기 전용`으로 세운 계획을 승인할 때 `계획대로 실행 + 전체 허용(정책 제외)`을 고르면, 그 실행에서는 계획 변경과 질문만 확인을 받고 나머지 권한 요청은 자동 승인됩니다. 외부 플러그인 도구에 정해 둔 제한은 그대로 적용됩니다.
- 반복 요청은 컴퓨터가 켜져 있고 Agent Manager가 실행 중일 때 동작합니다. 잠자기나 종료 중 놓친 실행은 자동으로 다시 실행되지 않습니다.
- Agent Manager는 공급자의 원본 대화 데이터를 직접 수정하지 않습니다. 새 대화와 세션 재개는 각 공급자의 공식 CLI를 통해 처리합니다. 로컬 LLM은 자체 CLI가 없어 ACP 하네스(`opencode acp`)를 거치며, 이때 앱이 쓰는 설정 파일의 키는 [문서](docs/local-llm.md)에 적힌 두 개뿐입니다.

### 원격 접속

원격 접속이 필요하면 호스트 Mac의 `설정 > 시스템 > Tailscale 서비스`에서 기능을 켭니다. 같은 Tailnet에 로그인한 기기의 브라우저 또는 PWA에서 사용할 수 있으며, 원격 변경 권한은 호스트 앱의 설정을 따릅니다. 호스트는 켜져 있고 Agent Manager가 실행 중이어야 합니다.

Tailscale을 사용하지 않아도 데스크톱 앱의 로컬 기능은 정상적으로 사용할 수 있습니다.

### 자주 묻는 질문

**Claude Code 대화를 Codex로 옮겨 주나요?**
아닙니다. 세션은 만든 공급자에 그대로 남습니다. 다른 공급자로 이어가면 그 공급자에 새 세션을 만들고 최근 대화를 맥락으로 넘깁니다.

**공급자의 대화 기록 파일을 바꾸나요?**
아닙니다. 읽기 전용으로 읽습니다. 새 대화 내용은 터미널에서 쓸 때처럼 공급자의 CLI가 직접 기록합니다.

**API 키가 따로 필요한가요?**
Claude Code·Codex·Antigravity는 필요 없습니다. 앱은 공식 CLI를 실행하고, CLI는 이미 해 둔 로그인을 그대로 씁니다.

**오프라인으로 동작하나요?**
로컬 LLM을 쓸 때만 그렇습니다. Claude Code·Codex·Antigravity를 쓰면 요청은 평소처럼 해당 공급자에게 전달됩니다.

**Intel Mac이나 Linux에서 쓸 수 있나요?**
아직 공개 배포본이 없습니다.

### 피드백

처음 써 본 분의 이야기가 가장 큰 도움이 됩니다. 내려받기부터 첫 세션을 이어가기까지 어디서든 막혔다면 [설치·첫 사용 문제 제보](https://github.com/shinkiki/local-agent-manager/issues/new?template=problem.yml)를 남겨 주세요. 일주일쯤 써 본 뒤에는 [첫 주 사용 후기](https://github.com/shinkiki/local-agent-manager/issues/new?template=first-week-feedback.yml)에서 짧은 질문 세 개에 답해 주시면 됩니다. 첨부하는 화면이나 로그에서 토큰·개인 경로·비공개 대화 내용은 지워 주세요.

### 지원 및 정책

- 문제 제보와 변경 제안: [CONTRIBUTING.md](CONTRIBUTING.md)
- 보안 문제 비공개 제보: [보안 정책](.github/SECURITY.md)
- 라이선스: [MIT](LICENSE-MIT) 또는 [Apache License 2.0](LICENSE-APACHE) 중 선택하여 사용할 수 있습니다.
- 의존성 저작권 고지: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

Claude, Claude Code, OpenAI, Codex, Google, Antigravity, Tailscale 및 관련 명칭은 각 소유자의 상표일 수 있습니다. 이 프로젝트는 해당 회사가 공식적으로 보증하거나 제휴한 제품이 아닙니다.
