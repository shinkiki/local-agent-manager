import type { ProviderId } from "../types";

/**
 * CLI 연결 안내가 보여 주는 설치 명령.
 *
 * 프로바이더마다 OS별 설치 방법이 다르므로 한 줄로 고정하지 않고 `AppStatus.platform`
 * (`env::consts::OS`: `windows`·`macos`·`linux`)으로 고른다.
 *
 * Windows 항목은 **cmd.exe에서 그대로 실행되는 문법**이어야 한다. 설정 터미널이 Windows에서
 * `COMSPEC`(cmd.exe)로 뜨므로(`terminal.rs::resolve_setup_launch_spec`), 드로워가 안내한 명령을
 * 바로 아래 터미널에 붙여 넣을 수 있어야 안내가 성립한다. Antigravity 설치를 PowerShell 전용
 * 한 줄(`irm … | iex`)로 적어 둔 동안은 안내대로 따라 하면
 * `'irm'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다.`로
 * 반드시 실패했다.
 */
export interface CliInstallCommands {
  /** Windows가 아닌 플랫폼이 쓰는 명령. 안내할 설치 명령이 없으면 null. */
  default: string | null;
  /** cmd.exe에서 그대로 실행되는 Windows 명령. 없으면 `default`를 쓴다. */
  windows?: string;
}

/**
 * Antigravity는 공식 설치 스크립트가 Unix 계열(`install.sh`)과 Windows(`install.ps1`)로 갈린다.
 * Windows 쪽은 PowerShell 스크립트를 `powershell -Command`로 감싸 실행한다. 공식 cmd 안내
 * (`curl … -o install.cmd && install.cmd && del install.cmd`)와 달리 홈 디렉터리에 임시 파일을
 * 남기지 않고, cmd·PowerShell 5.1·PowerShell 7 어디에 붙여 넣어도 같게 동작한다. `iex`는 스크립트
 * 파일이 아니라 식을 실행하므로 실행 정책을 낮출 필요가 없어 `-ExecutionPolicy`는 붙이지 않는다.
 */
export const cliInstallCommands: Record<ProviderId, CliInstallCommands> = {
  claude: { default: "npm install -g @anthropic-ai/claude-code" },
  codex: { default: "npm install -g @openai/codex" },
  antigravity: {
    default: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    windows: 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
  },
  // 실행 하네스는 ACP를 말하는 OpenCode다. 이것과 서빙 서버(Ollama) 둘 다 있어야
  // 로컬 채팅이 돈다 — 드로어가 두 단계를 나눠 안내한다.
  local: { default: "npm install -g opencode-ai" },
};

/** 현재 호스트 플랫폼에서 안내할 설치 명령. 없으면 null. */
export function cliInstallCommand(provider: ProviderId, platform: string): string | null {
  const commands = cliInstallCommands[provider];
  if (!commands) return null;
  if (platform === "windows" && commands.windows) return commands.windows;
  return commands.default;
}
