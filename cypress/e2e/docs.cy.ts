describe("문서 화면 폴더 사이드바", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("docs").should("be.visible");
  });

  it("빈 상태에서도 사이드바가 열려 있고 등록된 폴더 수를 0개로 알린다", () => {
    // 하네스는 빈 app-data로 백엔드를 띄우므로 문서 폴더가 하나도 없다.
    cy.anchor("docs.sidebar").should("have.class", "docs-sidebar");
    cy.get(".docs-sidebar-head").should("contain.text", "문서 폴더").and("contain.text", "0개");
    cy.get(".docs-sidebar").should("contain.text", "등록된 폴더 없음");
  });

  it("숨기기를 누르면 사이드바가 사라지고 같은 앵커가 복원 버튼으로 바뀐다", () => {
    cy.get('[aria-label="문서 폴더 숨기기"]').click();
    cy.get("aside.docs-sidebar").should("not.exist");
    cy.anchor("docs.sidebar")
      .should("have.attr", "aria-label", "문서 폴더 보기")
      .and("have.attr", "aria-expanded", "false");
    // 접기·펴기 조작 뒤 키보드 초점이 방금 자리를 바꾼 버튼에 남아야 한다.
    cy.focused().should("have.attr", "aria-label", "문서 폴더 보기");
  });

  it("접은 상태는 다른 화면을 다녀와도 유지된다", () => {
    cy.get('[aria-label="문서 폴더 숨기기"]').click();
    cy.get("aside.docs-sidebar").should("not.exist");
    cy.openView("sessions").should("be.visible");
    cy.anchor("nav.docs").click();
    cy.get("aside.docs-sidebar").should("not.exist");
    cy.anchor("docs.sidebar").should("have.attr", "aria-label", "문서 폴더 보기");
  });

  it("접은 상태는 새로고침 뒤에도 남고 다시 펴면 초점이 숨기기 버튼으로 돌아온다", () => {
    cy.get('[aria-label="문서 폴더 숨기기"]').click();
    cy.get("aside.docs-sidebar").should("not.exist");
    cy.reload();
    cy.openView("docs").should("be.visible");
    cy.get("aside.docs-sidebar").should("not.exist");
    cy.anchor("docs.sidebar").click();
    cy.get("aside.docs-sidebar").should("be.visible");
    cy.focused().should("have.attr", "aria-label", "문서 폴더 숨기기");
  });

  it("폴더 추가 버튼이 등록 폼을 열고 경로가 비면 등록을 막는다", () => {
    cy.get('[aria-label="문서 폴더 추가"]').click().should("have.attr", "aria-expanded", "true");
    cy.get(".root-form").within(() => {
      cy.contains("button", "폴더 등록").should("be.disabled");
      cy.get('input[placeholder="/Users/me/Documents/notes"]').type("   ");
      cy.contains("button", "폴더 등록").should("be.disabled");
      cy.get('input[placeholder="/Users/me/Documents/notes"]').clear().type("/tmp/am-qa-docs-root");
      cy.contains("button", "폴더 등록").should("not.be.disabled");
    });
    cy.get('[aria-label="문서 폴더 추가"]').click();
    cy.get(".root-form").should("not.exist");
  });
});
