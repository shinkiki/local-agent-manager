// UI 언어를 영어로 바꾼 뒤 문서 화면. 문서 화면의 문구는 컴포넌트가 한국어로 직접 그리고
// 정적 UI 치환기(src/lib/i18n.tsx의 STATIC_UI_EN)가 화면에서 영어로 바꿔 주는 구조라,
// 카탈로그에 실리지 않은 문구는 영어 화면에 한국어로 남는다. 어디까지 영어로 닿는지를
// 화면에서 확인한다. 섹션 탭과 탭 목록 nav의 aria-label은 치환기가 속성까지 닿지 않아 한국어로
// 남았던 자리(QA #25)로, 이제 DocsView가 text(ko, en)으로 직접 고르므로 영어 계약값을 단언한다.
describe("영어 UI에서 문서 화면 문구", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("주 메뉴·문서 폴더 패널·파일 탭은 영어로 바뀐다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.anchor("nav.docs").should("contain.text", "Documents").and("not.contain.text", "문서");

    cy.openView("docs");
    // 카탈로그에 실린 문구(i18n.tsx:52 "문서 폴더", i18n.tsx의 "파일")는 영어로 닿는다.
    cy.anchor("docs.sidebar").should("be.visible").and("contain.text", "Document folders");
    cy.view("docs").find(".docs-section-tabs button").should("have.length", 2);
    // 파일 목록 탭이므로 복수 Files. 두 번째 탭과 nav aria-label도 한국어가 남지 않는다.
    cy.view("docs").find(".docs-section-tabs button").eq(0).should("have.text", "Files");
    cy.view("docs").find(".docs-section-tabs button").eq(1).should("have.text", "Change automation");
    cy.view("docs").find(".docs-section-tabs").should("have.attr", "aria-label", "Document menu");
    cy.view("docs").find(".docs-section-tabs").invoke("text").should("not.match", /[가-힣]/);
    cy.screenshot("docs-view-english");
  });
});
