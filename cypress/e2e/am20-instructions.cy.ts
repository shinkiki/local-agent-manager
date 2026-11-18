// AM-20 (임시 스펙): 보관 지침이 0건인 지침관리 모드에서 툴바가 무엇을 막고 왜 막았는지
// 알려 주는지, 휴지통 버튼이 아예 나오지 않는지, 고른 모드가 화면 전환·새로고침을 건너 남는지.
const MODE_KEY = "agent-manager.instruction-mode.v1";

describe("지침 화면 빈 라이브러리 툴바 계약과 모드 잔존", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.instructions").should("be.visible");
  });

  it("0건 지침관리 툴바가 막힌 이유를 설명하고 휴지통은 나오지 않는다", () => {
    // 1) 기본 모드는 지침정보다.
    cy.openView("instructions");
    cy.get('.skill-mode-tabs[role="group"][aria-label="지침 화면 모드"]').as("modes");
    cy.get("@modes").find("button").eq(0).should("have.attr", "aria-pressed", "true").and("contain.text", "지침정보");

    // 2) 지침관리로 전환한다.
    cy.openInstructionMode("manage");

    // 3) 보관 지침 요약이 0개이고 공통 원본 루트를 함께 알린다.
    cy.get(".skill-library-summary strong").should("have.text", "보관 지침");
    cy.get(".skill-library-summary small").invoke("text").should("match", /^0개 · \S+/);

    // 4) 빈 상태가 다음에 무엇을 하라고 알려 준다.
    cy.get(".instructions-view .empty-state strong").should("have.text", "보관된 지침이 없습니다");
    cy.get(".instructions-view .empty-state p")
      .should("contain.text", "새 지침")
      .and("contain.text", "지침 가져오기");

    // 5) 가져올 것이 없으면 '지침 가져오기'가 막히고 title이 이유를 말한다. 개수 배지는 없다.
    cy.get(".skill-library-toolbar-row button").contains("지침 가져오기").as("import");
    cy.get("@import").should("be.disabled")
      .and("have.attr", "title", "등록 프로젝트와 개인 설정에 아직 보관하지 않은 지침 파일이 없습니다");
    cy.get("@import").find("small").should("not.exist");

    // 6) 만들기는 0건이어도 열려 있어야 한다(빈 상태 안내가 가리키는 유일한 출구).
    cy.get(".skill-library-toolbar-row button").contains("새 지침").should("not.be.disabled");

    // 7) 휴지통이 비어 있으면 버튼 자체가 없다.
    cy.get(".skill-library-toolbar-row button").contains("휴지통").should("not.exist");

    // 8) 시스템 에이전트가 없으면 일괄 마이그레이션도 막히고 그 이유를 말한다.
    cy.get(".skill-mode-toolbar .skill-transfer-buttons button").contains("일괄 마이그레이션")
      .should("be.disabled")
      .and("have.attr", "title", "연결된 시스템 에이전트를 설정하세요");
  });

  it("고른 지침관리 모드가 화면 전환과 새로고침을 건너 남는다", () => {
    cy.openInstructionMode("manage");
    cy.window().its("localStorage").invoke("getItem", MODE_KEY).should("eq", "manage");

    // 9) 다른 화면을 다녀와도 유지된다.
    cy.revisitView("instructions");
    cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(1)
      .should("have.attr", "aria-pressed", "true");

    // 10) 새로고침 뒤에도 저장값에서 복원된다.
    cy.visitApp();
    cy.openView("instructions");
    cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(1)
      .should("have.attr", "aria-pressed", "true");
    cy.get(".skill-library-summary small").invoke("text").should("match", /^0개 · \S+/);
  });
});
