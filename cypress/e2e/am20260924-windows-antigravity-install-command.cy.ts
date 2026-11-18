/// <reference types="cypress" />

// Windows 호스트에서는 Antigravity 설치 스크립트를 `irm ... | iex`만 적으면 PowerShell이
// 아닌 기본 셸에서 실행될 수 있다. 명령 선택 함수의 단위 검증과 별개로, 백엔드가 준
// `AppStatus.platform`이 설정 → 연결 카드 → 드로워까지 전달되어 실행 가능한 한 줄이
// 실제 화면에 서는지를 검증한다.

function antigravityCard() {
  return cy.get(".cli-settings-provider").filter(":has(.source-antigravity)");
}

describe("Windows Antigravity CLI 설치 안내", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (request) => request.continue((response) => {
      response.body.status.platform = "windows";
      const provider = response.body.status.providers.find((entry: { provider: string }) => entry.provider === "antigravity");
      if (provider) {
        provider.cli.detected = false;
        provider.cli.path = null;
      }
    }));
    cy.visitApp();
    cy.openSettingsTab("connections");
  });

  it("연결 드로워가 PowerShell 실행기까지 포함한 공식 설치 명령을 한 줄로 보여준다", () => {
    antigravityCard().contains("button", "연결").click();

    cy.anchor("cli-connect.steps").find("li").eq(1).within(() => {
      cy.contains("strong", "CLI 설치 및 PATH 등록").should("exist");
      cy.get(".cli-guide-command")
        .should("have.text", 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"')
        .invoke("text")
        .should("not.match", /^\s*irm\s/i)
        .and("not.contain", "install.sh")
        .and("not.contain", "\n");
    });
    cy.anchor("cli-connect.steps").find("li").eq(2).find(".cli-guide-plain").should("have.text", "agy");
    cy.anchor("cli-connect.steps").find("li").eq(3).find(".cli-guide-command").should("have.text", "agy --help");
  });
});
