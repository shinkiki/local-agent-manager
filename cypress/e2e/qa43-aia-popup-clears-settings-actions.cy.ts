/// <reference types="cypress" />
// AIA는 본문 크기를 바꾸지 않는 오버레이다. 닫으면 가려진 설정을 그대로 조작할 수 있다.
function runtime() {
  return cy.get('[data-ui-anchor="settings.system-agent-runtime"]');
}

function decision(label: string) {
  return runtime().find('[role="group"][aria-label="판단 처리"]').contains("button", label);
}

function actions() {
  return runtime().find(".system-agent-runtime-actions");
}

const DECISIONS = ["사용자에게 확인", "추천안 자동 선택"] as const;

describe("AIA 팝업이 열린 설정 화면의 실행설정 버튼", () => {
  // 격리 백엔드는 스펙 사이에 살아 있으므로, 여기서 고른 시스템 에이전트를 그대로 두면 뒤따르는
  // 모든 스펙이 AIA 팝업(우측 고정)과 실제 CLI 오류 카드 위에서 돌게 된다. 끝에서 '선택 안 함'으로 되돌린다.
  after(() => {
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.system-agent").find('[role="radio"]').first().click();
    cy.anchor("settings.system-agent").find('[role="radio"]').first().should("have.attr", "aria-checked", "true");
  });

  it("팝업이 본문을 밀지 않고 닫은 뒤 설정을 조작할 수 있다", () => {
    cy.visitApp();
    cy.openSettingsTab("connections");

    cy.anchor("settings.system-agent").scrollIntoView();
    cy.anchor("settings.system-agent").find('[role="radio"]:not([disabled])').not(":first")
      .should("have.length.at.least", 1)
      .first()
      .click();

    // 시스템 에이전트를 고르면 팝업이 열리고 셸에 aia-open이 붙는다.
    cy.get(".aia-chat-popup.open").should("be.visible");
    cy.get(".manager-shell").should("have.class", "aia-open");
    // 설정 스냅샷이 도착해 초안이 저장본과 같아질 틈(runtime-save 스펙과 같은 사유).
    cy.wait(3000);

    runtime().scrollIntoView().should("be.visible");
    actions().scrollIntoView();

    cy.get(".view-content").then(($view) => {
      const before = $view[0].getBoundingClientRect();
      const padding = getComputedStyle($view[0]).paddingRight;
      cy.get('.aia-chat-popup button[title="AIA 닫기"]').click();
      cy.get(".view-content").should(($closed) => {
        const after = $closed[0].getBoundingClientRect();
        expect(after.width).to.equal(before.width);
        expect(after.x).to.equal(before.x);
        expect(getComputedStyle($closed[0]).paddingRight).to.equal(padding);
      });
    });

    // 2) 버튼 중앙을 덮는 요소가 없어 force 없이 눌린다 — 값을 바꿔 열고 '변경 취소'로 되돌린다.
    runtime().find('[role="group"][aria-label="판단 처리"] button[aria-pressed="true"]').invoke("text")
      .then((label) => {
        const current = DECISIONS.find((option) => label.startsWith(option));
        expect(current, "눌려 있는 판단 처리").to.be.ok;
        const other = DECISIONS.find((option) => option !== current) as string;
        decision(other).click();
        decision(other).should("have.attr", "aria-pressed", "true");
        runtime().contains("button", "변경 취소").should("not.be.disabled").click();
        decision(current as string).should("have.attr", "aria-pressed", "true");
        runtime().contains("button", "변경 취소").should("be.disabled");
        runtime().contains("button", "실행설정 저장").should("be.disabled");
      });
    cy.screenshot("qa43-popup-clears-actions");
  });
});
