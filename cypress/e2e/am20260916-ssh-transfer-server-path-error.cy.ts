/// <reference types="cypress" />

/**
 * d0200249는 SSH 파일 전송 폴더가 로컬 PC가 아니라 접속 서버의 경로임을 라벨·도움말·
 * 검증 오류에 명시했다. AM-219는 빈 값·공백·유효한 /srv 경로의 저장 게이트와 복원을
 * 검증했지만, 사용자가 실제로 혼동하던 Windows 로컬 경로 입력과 실패 안내는 다루지 않았다.
 * 연결 서버가 키와 따로 저장되면서 이 칸은 "서버 추가" 폼에 있다.
 */
describe("SSH 전송 폴더에 Windows 로컬 경로를 넣었을 때 서버 경로 안내", () => {
  const fileBase = `am-qa-server-path-${Date.now()}`;
  const publicName = `${fileBase}.pub`;
  const serverName = `qa-server-path-${Date.now()}`;

  before(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
    cy.createSshKey(fileBase, "ssh-server-path-test");
  });

  after(() => {
    cy.deleteSshKey(publicName);
  });

  it("필드가 서버 경로임을 먼저 알리고 Windows 경로 저장 실패도 같은 기준으로 설명한다", () => {
    cy.contains(".ssh-section-head button", "서버 추가").click();
    cy.get(".ssh-server-new .ssh-server-form").as("form").should("be.visible");

    cy.get("#ssh-server-name-new").type(serverName);
    cy.get("#ssh-server-host-new").type("build.example.com");
    cy.get("#ssh-server-user-new").type("deploy");
    cy.selectSshServerKey(".ssh-server-new", publicName);
    cy.get("#ssh-server-agent-new").check();
    cy.get("#ssh-server-upload-new").check();

    cy.get("@form").contains(".form-row", "서버의 전송 폴더").should("be.visible").within(() => {
      cy.get("small")
        .should("contain.text", "접속하는 서버 안의 경로")
        .and("contain.text", "이 PC의 폴더가 아니므로")
        .and("contain.text", "Windows 경로");
    });

    cy.get("#ssh-server-upload-root-new")
      .type("C:\\releases")
      .should("have.value", "C:\\releases");
    cy.get("@form").contains(".form-actions button.primary", "추가").should("not.be.disabled").click();

    // 실패 배너는 백엔드 `validate_transfer_root`가 준 문구를 그대로 싣는다 — 사용자가
    // 위쪽 도움말을 거슬러 읽지 않고 오류 자리에서 값을 고칠 수 있어야 한다(QA #83).
    // 배너 머리말의 분류 코드는 문구로만 판정하므로(`Shared.tsx`의 `stableErrorCode`)
    // 이 문구에는 `APP_RUNTIME`이 붙는다. 사유가 닿는지가 이 스펙이 보는 것이라 코드는
    // 고정하지 않는다.
    cy.get(".error-banner").should("be.visible")
      .and("contain.text", "접속하는 서버 안의 경로")
      .and("contain.text", "이 PC의 폴더가 아니므로")
      .and("contain.text", "Windows 경로는 받지 않습니다");
    // 실패하면 폼은 입력값을 든 채 남고, 목록에 서버가 생기지 않는다.
    cy.get("#ssh-server-upload-root-new").should("have.value", "C:\\releases");
    cy.contains(".ssh-server-list .plugin-row", serverName).should("not.exist");

    cy.screenshot("am20260916-ssh-transfer-server-path-error");
    cy.get("@form").find(".form-actions").contains("button", "취소").click();
  });
});
