// 문서 화면의 "변경 자동화" 섹션. 격리 하네스는 빈 app-data라 등록된 문서 폴더가 하나도
// 없다. 이때 트리거 등록 폼이 입력칸 대신 폴더부터 등록하라는 안내로 바뀌고, 등록된
// 트리거 목록은 0개 빈 상태로 서며, 섹션 탭 선택이 화면을 다녀오거나 새로고침한 뒤에
// 어디까지 남는지(화면 전환에는 남고 새로고침에는 사라진다)를 화면에서 확인한다.
const tabs = () => cy.view("docs").find(".docs-section-tabs button");

describe("문서 변경 자동화 섹션 빈 상태", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("docs").should("be.visible");
  });

  it("감시할 폴더가 없으면 트리거 폼이 입력칸 대신 폴더 등록 안내로 바뀐다", () => {
    tabs().eq(1).click();
    cy.view("docs").find(".document-automation-panel").should("be.visible");
    cy.get(".document-trigger-form").should("contain.text", "문서 트리거 등록");
    cy.get(".document-trigger-form .tree-empty").should(
      "contain.text",
      "감시할 문서 폴더가 없습니다",
    );
    // 안내가 선 동안에는 저장 대상이 없으므로 입력 격자 자체가 서지 않는다.
    cy.get(".document-trigger-grid").should("not.exist");
    cy.get(".document-trigger-form-actions").should("not.exist");
  });

  it("등록된 트리거 목록은 0개 빈 상태로 선다", () => {
    tabs().eq(1).click();
    cy.get(".document-trigger-list header").should("contain.text", "등록된 트리거").and("contain.text", "0개");
    cy.get(".document-trigger-list .tree-empty").should("contain.text", "등록된 트리거가 없습니다.");
    cy.screenshot("docs-automation-empty");
  });

  it("파일 탭으로 돌아가면 자동화 패널이 사라지고 활성 표시가 옮겨간다", () => {
    tabs().eq(1).click();
    tabs().eq(1).should("have.class", "active");
    tabs().eq(0).should("not.have.class", "active");
    tabs().eq(0).click();
    cy.get(".document-automation-panel").should("not.exist");
    tabs().eq(0).should("have.class", "active");
  });

  it("선택한 섹션 탭은 다른 화면을 다녀오면 남고 새로고침하면 파일로 돌아간다", () => {
    tabs().eq(1).click();
    cy.get(".document-automation-panel").should("be.visible");
    // 화면은 감춰질 뿐 다시 만들어지지 않으므로 섹션 선택이 그대로 남는다.
    cy.revisitView("docs");
    tabs().eq(1).should("have.class", "active");
    cy.get(".document-automation-panel").should("be.visible");

    // 반면 섹션 선택은 저장되지 않는 화면 안 상태라 새로고침에는 남지 않는다.
    cy.reload();
    cy.openView("docs").should("be.visible");
    tabs().eq(0).should("have.class", "active");
    cy.get(".document-automation-panel").should("not.exist");
  });
});
