/// <reference types="cypress" />
// QA #54: 설정 → 연결의 CLI 카드 상태 뱃지(src/lib/cliUpdate.ts `cliUpdateBadge`)는
// 실행 파일이 있고 최신 버전 조회가 끝나면 무조건 "최신 버전"으로 떴다. 실행 중인 CLI의
// `--version`을 읽지 못한 경우(currentVersion null · versionError)에는 비교 자체가 성립하지
// 않으므로 "실행 버전 확인 실패"로 따로 알려야 한다. 이 스펙은 get_cli_update_status 응답만
// 가로채 그 갈래를 만든다. 버튼은 누르지 않으므로 호스트 CLI에는 닿지 않는다.
const codexStatus = (overrides: Record<string, unknown>) => ({
  provider: "codex",
  displayName: "OpenAI Codex",
  executablePath: "/opt/homebrew/bin/codex",
  currentVersion: "0.146.0",
  versionError: null,
  installSource: "homebrewCask",
  packageName: "codex",
  updateMethod: "homebrewCask",
  updateSupported: true,
  unsupportedReason: null,
  updateCommandLabel: "brew upgrade --cask codex",
  manualUpdateHint: null,
  checkSupported: true,
  checkUnsupportedReason: null,
  // checked: true 로 두어 설정 화면의 자동 최신 확인이 다시 조회하지 않게 한다.
  checked: true,
  latestVersion: "0.146.0",
  checkError: null,
  updateAvailable: false,
  modelCaches: [],
  modelCacheUnsupportedReason: null,
  ...overrides,
});

function openWithStatus(overrides: Record<string, unknown>) {
  cy.stubInvoke("get_cli_update_status", { statusCode: 200, body: [codexStatus(overrides)] });
  cy.visitApp();
  cy.openSettingsTab("connections");
  cy.anchor("settings.connections").should("be.visible");
}

describe("QA #54 · CLI 실행 버전을 못 읽으면 상태 뱃지가 '최신 버전'이 아니다", () => {
  it("실행 버전 확인 실패는 '실행 버전 확인 실패' 뱃지와 오류 문구로 드러난다", () => {
    openWithStatus({ currentVersion: null, versionError: "codex --version 실행이 실패했습니다." });
    // 실행 버전을 못 읽은 공급자는 상단 알림 근거가 되어 업데이트 구획이 열린다.
    cy.get(".cli-update-panel", { timeout: 20000 }).should("have.length", 1).within(() => {
      cy.get(".cli-update-versions .health").should("have.text", "실행 버전 확인 실패").and("not.have.class", "ready");
      cy.get(".cli-update-versions > span").eq(0).find("b").should("have.text", "확인 실패");
      cy.get(".cli-update-note.error").should("contain.text", "codex --version 실행이 실패했습니다.");
    });
  });

  it("실행 버전을 읽었고 최신과 같으면 그대로 '최신 버전'이다", () => {
    // 최신 상태는 상단 알림 근거가 없어 구획이 접힌다 — 뱃지 자체가 없는 것이 기대 동작이다.
    openWithStatus({});
    cy.get(".cli-settings-provider").should("have.length.at.least", 1);
    cy.get(".cli-update-panel").should("not.exist");
    cy.get(".cli-settings-provider .health").should("not.contain.text", "실행 버전 확인 실패");
  });
});
