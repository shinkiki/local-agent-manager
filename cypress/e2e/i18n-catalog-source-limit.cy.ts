/**
 * UI 언어 전환은 화면에 렌더된 한국어 문구를 모아 카탈로그로 보낸다. 백엔드는 문구 하나를
 * 512**바이트**까지만 받고 제어 문자가 든 문구도 거절하는데(`translation.rs`의
 * `validate_ui_catalog`) 수집은 500**자**로 잘라, 한글 170자를 넘는 문단이 하나라도 렌더돼
 * 있으면 카탈로그 전체가 거절되고 언어 전환이 통째로 막혔다(QA #21). 워크플로 화면(페이싱
 * 스케줄 안내 문단)을 한 번 열면 재현된다. 지침 화면은 줄바꿈이 든 `text()` 키까지 등록해
 * 같은 거절을 다른 갈래로 만들었다(QA #18).
 */
describe("UI 언어 전환과 번역 카탈로그 한도", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("긴 문단이 있는 화면을 들른 뒤에도 UI 언어를 바꿀 수 있다", () => {
    cy.visitApp();
    // 워크플로 화면에는 512바이트를 훌쩍 넘는 한국어 안내 문단이 있다.
    cy.anchor("nav.workflows").click();
    cy.setLanguage("en");

    // 카탈로그가 거절되면 이 자리에 "UI 번역 카탈로그에 잘못된 문구가 있습니다"가 뜨고
    // 언어는 그대로 한국어로 남는다.
    cy.get(".translation-language-error").should("not.exist");
    cy.anchor("nav.workflows").should("contain.text", "Workflows");
  });

  it("지침·워크플로 화면을 차례로 들른 뒤에도 영어로 바꾸고 한국어로 되돌릴 수 있다 (QA #18)", () => {
    cy.visitApp();
    // 지침 화면의 두 모드는 줄바꿈이 든 text() 키와 긴 안내 문단을 등록한다.
    cy.openInstructionMode("info");
    cy.openInstructionMode("manage");
    // 워크플로 화면은 페이싱 안내 문단(512바이트 초과)을 등록한다.
    cy.openView("workflows");

    cy.setLanguage("en");
    cy.get(".translation-language-error").should("not.exist");
    cy.anchor("nav.instructions").should("contain.text", "Instructions");
    cy.anchor("nav.workflows").should("contain.text", "Workflows");

    // 되돌리기도 같은 카탈로그를 보내므로 같은 거절 경로를 지난다.
    cy.setLanguage("ko");
    cy.get(".translation-language-error").should("not.exist");
    cy.anchor("nav.instructions").should("contain.text", "지침");
    cy.anchor("nav.workflows").should("contain.text", "워크플로");
  });
});
