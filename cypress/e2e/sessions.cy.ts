describe("세션 목록 필터", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("실패, 보관함, 즐겨찾기 필터 칩이 토글된다", () => {
    cy.openView("sessions");

    // 실패 칩 검증
    cy.contains("button", "실패").as("failureChip");
    cy.get("@failureChip").should("have.attr", "aria-pressed", "false");
    cy.get("@failureChip").should("not.have.class", "active");
    
    cy.get("@failureChip").click();
    cy.get("@failureChip").should("have.attr", "aria-pressed", "true");
    cy.get("@failureChip").should("have.class", "active");

    // 보관함 칩 검증
    cy.contains("button", "보관함").as("archiveChip");
    cy.get("@archiveChip").should("have.attr", "aria-pressed", "false");
    cy.get("@archiveChip").click();
    cy.get("@archiveChip").should("have.attr", "aria-pressed", "true");

    // 즐겨찾기 칩 검증
    cy.contains("button", "즐겨찾기").as("favoriteChip");
    cy.get("@favoriteChip").should("have.attr", "aria-pressed", "false");
    cy.get("@favoriteChip").click();
    cy.get("@favoriteChip").should("have.attr", "aria-pressed", "true");
  });
});

// 위 케이스가 칩을 켜는 것까지 본다면, 여기서는 묶음 구성·해제·상태 유지를 본다.
// 격리 백엔드는 세션이 하나도 없으므로 목록 내용 대신 칩의 계약을 확인한다.
describe("세션 목록 좁히기 칩 묶음", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
  });

  const chips = () => cy.view("sessions").find('.filter-chips[role="group"]');

  it("세 칩이 한 묶음으로 그려지고 처음에는 모두 꺼져 있다", () => {
    chips().should("have.attr", "aria-label", "세션 좁히기");
    chips().find("button.filter-chip").should("have.length", 3);
    chips().find("button.filter-chip").then((list) => {
      expect([...list].map((el) => el.textContent?.trim())).to.deep.equal(["즐겨찾기", "보관함", "실패"]);
    });
    chips().find("button.filter-chip[aria-pressed='true']").should("not.exist");
  });

  it("실패 칩은 서로 독립으로 켜지고 다시 누르면 풀린다", () => {
    chips().find("button.filter-chip").eq(2).as("failures");
    cy.get("@failures").should("have.class", "danger").click();
    cy.get("@failures").should("have.attr", "aria-pressed", "true").and("have.class", "active");
    chips().find("button.filter-chip").eq(0).should("have.attr", "aria-pressed", "false");
    chips().find("button.filter-chip").eq(1).should("have.attr", "aria-pressed", "false");
    cy.get("@failures").click();
    cy.get("@failures").should("have.attr", "aria-pressed", "false").and("not.have.class", "active");
  });

  it("여러 칩을 켠 상태는 화면을 전환했다 돌아와도 유지된다", () => {
    chips().find("button.filter-chip").eq(0).click();
    chips().find("button.filter-chip").eq(2).click();
    cy.openView("dashboard").should("be.visible");
    cy.anchor("nav.sessions").click();
    chips().find("button.filter-chip").eq(0).should("have.attr", "aria-pressed", "true");
    chips().find("button.filter-chip").eq(1).should("have.attr", "aria-pressed", "false");
    chips().find("button.filter-chip").eq(2).should("have.attr", "aria-pressed", "true");
  });

  it("칩을 켠 빈 목록에서도 조건 안내 문구가 나온다", () => {
    chips().find("button.filter-chip").eq(2).click();
    cy.view("sessions").should("contain.text", "조건에 맞는 세션이 없습니다");
  });
});
