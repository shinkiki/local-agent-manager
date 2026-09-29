import assert from "node:assert/strict";
import test from "node:test";
import { cliInstallCommand, cliInstallCommands } from "./cliInstallCommand.ts";

test("Antigravity 설치 명령은 플랫폼마다 갈린다", () => {
  assert.equal(
    cliInstallCommand("antigravity", "macos"),
    "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  );
  assert.equal(cliInstallCommand("antigravity", "linux"), cliInstallCommand("antigravity", "macos"));
  assert.notEqual(cliInstallCommand("antigravity", "windows"), cliInstallCommand("antigravity", "macos"));
});

// 설정 터미널은 Windows에서 cmd.exe로 뜬다. 안내 명령이 PowerShell 전용 문법이면 안내대로
// 따라 한 사용자가 `'irm'은(는) 내부 또는 외부 명령…`을 받는다.
test("Windows 명령은 cmd.exe에서 실행할 수 있는 형태여야 한다", () => {
  for (const [provider, commands] of Object.entries(cliInstallCommands)) {
    const command = cliInstallCommand(provider, "windows");
    if (command === null) continue;
    assert.doesNotMatch(
      command,
      /^\s*(irm|iwr|iex|Invoke-RestMethod|Invoke-WebRequest|Invoke-Expression)\b/,
      `${provider}: cmd에 없는 PowerShell 별칭으로 시작하면 안 된다`,
    );
    assert.ok(!command.includes("\n"), `${provider}: 한 줄이어야 붙여 넣을 수 있다`);
    assert.ok(commands.default !== null, `${provider}: 다른 플랫폼 안내도 있어야 한다`);
  }
});

test("Windows 전용 명령이 없는 프로바이더는 공통 명령을 그대로 쓴다", () => {
  assert.equal(cliInstallCommand("claude", "windows"), cliInstallCommand("claude", "macos"));
  assert.equal(cliInstallCommand("codex", "windows"), "npm install -g @openai/codex");
});
