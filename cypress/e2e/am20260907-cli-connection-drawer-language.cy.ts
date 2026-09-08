/// <reference types="cypress" />
// 설정 → 연결의 CLI 카드가 여는 CLI 연결 드로워(src/components/CliConnectionDrawer.tsx)는
// 문구가 한국어 리터럴로 박혀 있어 영어 UI에서 카탈로그가 덮은 제목·다시 검사 버튼만
// 번역되고 요약·4단계 안내·채팅 이동 버튼·재시작 안내는 한국어로 남았다(QA #38).
// 조치 뒤에는 드로워 안의 모든 문구가 text(ko, en)로 번역되고, 공용 Drawer의 닫기 아이콘도
// text()를 타며, 주요 지점에 data-ui-anchor가 붙는다. 이 스펙은 그 계약을 문구 단위로 붙잡는다.
// 격리 백엔드의 CLI 탐지는 임시 HOME이 아니라 PATH를 타므로 요약은 탐지 여부에 따라 두 갈래
// 가운데 하나다. 버튼은 문구가 아니라 카드 안의 위치로 잡는다.
// UI 언어는 백엔드에 남아 뒤따르는 스펙으로 새므로 끝에서 한국어로 되돌린다.
describe("설정 · 연결 · CLI 연결 드로워의 언어 전환", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("영어 UI에서 드로워의 제목·요약·단계 안내·버튼·닫기 이름이 모두 영어로 나오고 앵커가 붙는다 (QA #38)", () => {
    cy.visitApp();
    cy.setLanguage("en");

    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").within(() => {
      cy.contains("CLI settings").should("be.visible");
      cy.get(".cli-settings-provider-states button.button").first().click();
    });

    cy.get('[role="dialog"]').should("have.length", 1);
    cy.get('[role="dialog"]').within(() => {
      // 드로워 본문은 스크롤 영역이라 아래쪽 버튼·안내는 뷰포트 밖일 수 있다.
      // 여기서 보는 것은 배치가 아니라 문구이므로 존재 여부로만 확인한다.
      cy.contains("CLI connection").should("be.visible");
      cy.contains("button", "Check CLI again").should("exist");

      // 요약은 탐지 여부에 따라 두 갈래지만 어느 쪽이든 영어다.
      cy.anchor("cli-connect.summary").find("strong").invoke("text")
        .should("match", /^(CLI found|Chat history exists, but the CLI executable is missing)$/);
      cy.anchor("cli-connect.status").invoke("text").should("match", /^(Detected|Connection required)$/);
      cy.anchor("cli-connect.steps").within(() => {
        cy.contains("Install the CLI and add it to PATH").should("exist");
        cy.contains("Account login").should("exist");
        cy.contains("Verify the connection").should("exist");
        cy.contains("Existing chats detected").should("not.exist").then(() => {
          // 1단계 제목은 기록 탐지 여부에 따라 두 갈래지만 어느 쪽이든 영어다.
          cy.get("li").first().find("strong").invoke("text").should("match", /^(Existing chats detected|No existing chats)$/);
        });
      });
      cy.anchor("cli-connect.recheck").should("have.text", "Check CLI again");
      cy.contains("If the CLI is still not detected after installing").should("exist");

      // 옛 한국어 문구는 하나도 남지 않는다.
      cy.contains("CLI를 찾았습니다").should("not.exist");
      cy.contains("CLI 설치 및 PATH 등록").should("not.exist");
      cy.contains("계정 로그인").should("not.exist");
      cy.contains("연결 확인").should("not.exist");
      cy.contains("button", "채팅으로 이동").should("not.exist");
      cy.contains("설치 후에도 탐지되지 않으면").should("not.exist");
      // 공용 Drawer의 닫기 아이콘도 text()를 탄다.
      cy.get('button[aria-label="닫기"]').should("not.exist");
      cy.get('.drawer-header-actions button[aria-label="Close"]').should("exist");
    });

    // 드로워 안의 문구 전체에 한글이 남지 않는다(명령어·경로만 남는 자리다).
    cy.get('[role="dialog"]').invoke("text").should("not.match", /[가-힣]/);

    // Esc로 닫히고 설정 화면은 영어 그대로 남는다.
    cy.get("body").type("{esc}");
    cy.get('[role="dialog"]').should("not.exist");
    cy.anchor("settings.connections").contains("CLI settings").should("exist");
  });

  it("한국어 UI에서는 같은 자리가 한국어로 나오고 닫기 이름도 한국어다", () => {
    cy.restoreLanguage();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").find(".cli-settings-provider-states button.button").first().click();
    cy.get('[role="dialog"]').within(() => {
      cy.anchor("cli-connect.summary").find("strong").invoke("text")
        .should("match", /^(CLI를 찾았습니다|채팅 기록은 있지만 CLI 실행 파일이 없습니다)$/);
      cy.anchor("cli-connect.steps").should("contain.text", "CLI 설치 및 PATH 등록");
      cy.anchor("cli-connect.recheck").should("have.text", "CLI 다시 검사");
      cy.get('.drawer-header-actions button[aria-label="닫기"]').should("exist");
    });
    cy.get("body").type("{esc}");
  });
});
