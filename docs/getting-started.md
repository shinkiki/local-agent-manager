# Getting started

[한국어](getting-started.ko.md)

This guide takes you from download to continuing your first Claude Code or Codex session in Agent Manager, and lists what to check when something does not show up.

## 1. Before you install

| Item | Needed for | Notes |
| --- | --- | --- |
| macOS on Apple Silicon (arm64), or Windows x64 | Running the app | No public builds for Intel Macs or Linux desktops yet. |
| Claude Code CLI (`claude`) and/or OpenAI Codex CLI (`codex`), signed in | Continuing sessions, starting new chats, recurring requests | Install and sign in with the official instructions: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex). The Antigravity CLI (`agy`) is also supported. |
| Existing history on disk | Seeing past sessions | Claude Code: `~/.claude/projects`. Codex: `~/.codex/state_5.sqlite` plus `~/.codex/sessions`. These are only read, never modified. |
| Ollama or another OpenAI-compatible server, plus [OpenCode](https://opencode.ai) (`opencode`) | Local LLM only | See [Local LLM provider](local-llm.md) (Korean). |
| Tailscale on the host and the other device | Remote access only | Optional. Every local feature works without it. |

**Where your data goes.** Agent Manager keeps its own data (folders, notes, schedules, settings) on your computer and reads provider history read-only. It does not make Claude Code, Codex, or Antigravity work offline: when you continue or start a chat, the official CLI sends your prompt to that provider just as it does in a terminal. Only the local LLM provider keeps conversations on servers you run.

## 2. Install

### macOS

1. Download `Agent.Manager_<version>_aarch64.dmg` from the [latest release](https://github.com/shinkiki/local-agent-manager/releases/latest).
2. Open the DMG and drag `Agent Manager.app` into `Applications`.
3. Launch it from `Applications`.

The build is signed with an Apple Developer ID and notarized. To confirm, run:

```bash
spctl --assess --type exec --verbose=4 "/Applications/Agent Manager.app"
```

It should print `source=Notarized Developer ID`. If macOS blocks an app you downloaded a while ago, it may be an older unsigned release — download the latest one rather than overriding the warning.

### Windows

1. Download `Agent.Manager_<version>_x64-setup.exe` (regular install) or `Agent.Manager_<version>_x64_en-US.msi` (MSI deployment) from the [latest release](https://github.com/shinkiki/local-agent-manager/releases/latest).
2. In PowerShell, compute the file's hash and compare it with the `sha256:` value shown next to the file on the release page:

   ```powershell
   Get-FileHash .\Agent.Manager_<version>_x64-setup.exe -Algorithm SHA256
   ```

3. Run the installer.

The Windows installers are built by GitHub Actions from the tagged source but are **not code-signed yet**, so SmartScreen may report an unknown publisher. A matching hash confirms that you have the exact file published on the release page; it does not replace a signature. If your organization's policy does not allow unsigned installers, wait for a signed build or build from source with the steps in [CONTRIBUTING.md](../CONTRIBUTING.md).

## 3. Connect your CLI

1. If you have not yet, install Claude Code or Codex and sign in once from a terminal using the official instructions.
2. Open Agent Manager and go to `Settings > CLI settings`.
3. Each provider shows whether its CLI was found. Open a provider to see install and sign-in steps, then choose `Check CLI again`.

If the CLI is missing but history exists, the app says so ("Chat history exists, but the CLI executable is missing"). You can still read those sessions; you need the CLI to continue them.

## 4. Find a session and continue it

1. Open `Sessions`. Sessions from every connected provider appear in one list.
2. Type a project name or a phrase you remember into the search box. It matches titles, projects, session IDs, your notes, and the conversation text. Text search may take a moment the first time while history is indexed.
3. Narrow the list with the provider tabs and project filter if needed.
4. Click a session to read the whole conversation, including tool calls and their results.
5. Type your next message in the box at the bottom of the session panel and send it. With the original provider selected, Agent Manager continues **the same session** through that provider's CLI, and the CLI writes the new turns to its own history as usual.

**About other providers.** The provider selector in that panel also lists other connected providers. Picking one does not move or convert the session: it creates a new session with that provider and hands off the recent user and agent messages as context. The original session is not modified.

## 5. Optional next steps

- **Organize**: Sort sessions into folders (up to five levels), star them, give them display titles, and add notes. Notes are searchable.
- **Recurring requests**: Schedule a prompt hourly, daily, on weekdays, weekly, or with Cron, and check each run's result. Runs happen only while the computer is on and Agent Manager is running (closing the window keeps it in the tray). Runs missed during sleep or shutdown are not run again automatically.
- **Instructions and skills**: Review `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and skills across your projects, and publish a shared source to the projects and providers you choose.
- **Remote access**: On the host Mac, turn on `Settings > System > Tailscale service`. Devices signed in to the same Tailnet can then open Agent Manager in a browser or as a PWA. The host must stay on with the app running, and remote write permission follows the host's settings.

## Troubleshooting

### The CLI is not detected

- In a terminal, run `claude --version` or `codex --version`. If that fails, the CLI is not installed or not on your `PATH`; follow the official install steps first.
- Agent Manager looks in your login shell's `PATH` and in common install locations (for example `~/.local/bin`, `~/.npm-global/bin`, Homebrew's `/opt/homebrew/bin`, nvm/volta/pnpm/bun directories, and `%APPDATA%\npm` on Windows). If you installed the CLI somewhere else, make sure your login shell's profile adds that directory to `PATH`.
- After installing or changing `PATH`, choose `Check CLI again`, or quit Agent Manager from the tray menu and start it again.
- If the CLI is found but chats do not start, sign in again from a terminal (for example, run `claude` and use `/login`, or `codex login`).

### My past sessions do not appear

- **Claude Code**: sessions are read from `~/.claude/projects/<project>/*.jsonl`. Check that this folder exists and contains files.
- **Codex**: sessions are listed from Codex's state database, `~/.codex/state_5.sqlite`. If you only have rollout files under `~/.codex/sessions`, update the Codex CLI and open it once so it creates the database.
- **Custom locations**: history is read from the default locations under your home folder. Sessions written to a custom `CLAUDE_CONFIG_DIR` or `CODEX_HOME` are not listed.
- **Filters**: clear the search box and check the provider tab, project filter, and whether hidden sessions are excluded.
- **Large histories**: the first load and the first text search can take a while. Wait for the status line under the search box to finish.

### Continuing a session fails

- Check that the same provider's CLI is detected and signed in (`Settings > CLI settings`).
- If you use several accounts, continue with the account that created the session. A session started with one account may not be found under another account's profile.

### Recurring requests did not run

- The computer must be awake and Agent Manager must be running (it keeps running in the tray when you close the window).
- Runs missed during sleep or shutdown are skipped, not replayed.

### Remote access does not connect

- Tailscale must be running and signed in to the same Tailnet on both the host and the other device.
- The host must be awake with Agent Manager running, and `Tailscale service` must be on in `Settings > System`.

## Report a problem

- Install or first-use problems: [open a report](https://github.com/shinkiki/local-agent-manager/issues/new?template=problem.yml)
- Ideas and requests: [open a feature request](https://github.com/shinkiki/local-agent-manager/issues/new?template=feature-request.yml)
- Security issues: please follow the [security policy](../.github/SECURITY.md) instead of opening a public issue.

Before attaching screenshots or logs, remove tokens, account emails, personal paths, and private conversation text.
