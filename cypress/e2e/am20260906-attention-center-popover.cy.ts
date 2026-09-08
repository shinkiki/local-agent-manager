/**
 * 상단바 알림 센터(`topbar.attention`)의 팝오버 열고닫기 계약.
 *
 * f45798d에서 알림을 묶어 보이도록 바뀌었지만 이 버튼과 팝오버를 잡는 스펙이 아직
 * 하나도 없었다. 격리 백엔드에는 알림이 없으므로 여기서는 묶음이 아니라 빈 상태와
 * 열고닫기 경로 — 토글, 바깥 누름, Esc, 다국어 문구 — 를 붙잡는다.
 */
describe("알림 센터 팝오버", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("topbar.attention").should("be.visible");
  });

  it("알림이 없으면 뱃지 없이 빈 상태를 보이고, 다시 누르면 닫힌다", () => {
    cy.anchor("topbar.attention").should("have.attr", "aria-expanded", "false");
    // 알림이 하나도 없으면 개수 뱃지(span)를 그리지 않는다.
    cy.anchor("topbar.attention").find("span").should("not.exist");
    cy.get(".attention-popover").should("not.exist");

    cy.anchor("topbar.attention").click();
    cy.anchor("topbar.attention").should("have.attr", "aria-expanded", "true");
    cy.get(".attention-popover").should("be.visible");
    cy.get(".attention-popover .attention-heading-text").should("contain.text", "알림").and("contain.text", "새 확인사항");
    cy.get(".attention-empty").should("contain.text", "새 알림이 없습니다.");
    // 빈 목록에서는 "모두 읽음"·"읽음 전체삭제"를 내보내지 않는다.
    cy.get(".attention-header-actions button").should("not.exist");

    cy.anchor("topbar.attention").click();
    cy.get(".attention-popover").should("not.exist");
    cy.anchor("topbar.attention").should("have.attr", "aria-expanded", "false");
  });

  it("팝오버 바깥을 누르거나 Esc를 치면 닫힌다", () => {
    cy.anchor("topbar.attention").click();
    cy.get(".attention-popover").should("be.visible");
    // 바깥 누름은 pointerdown으로만 듣는다.
    cy.anchor("nav.sessions").trigger("pointerdown");
    cy.get(".attention-popover").should("not.exist");

    cy.anchor("topbar.attention").click();
    cy.get(".attention-popover").should("be.visible");
    cy.get("body").type("{esc}");
    cy.get(".attention-popover").should("not.exist");
  });

  it("팝오버 안을 눌러도 닫히지 않는다", () => {
    cy.anchor("topbar.attention").click();
    cy.get(".attention-popover header").trigger("pointerdown");
    cy.get(".attention-popover").should("be.visible");
  });

  it("영어로 바꾸면 버튼 레이블과 빈 상태 문구가 함께 영어로 바뀐다", () => {
    cy.setLanguage("en");
    cy.anchor("topbar.attention").should("have.attr", "aria-label", "0 notifications");
    cy.anchor("topbar.attention").click();
    cy.get(".attention-popover").should("have.attr", "aria-label", "Agent notifications");
    cy.get(".attention-popover .attention-heading-text").should("contain.text", "Notifications").and("contain.text", "Nothing new");
    cy.get(".attention-empty").should("contain.text", "No new notifications.");
    cy.restoreLanguage();
  });
});
