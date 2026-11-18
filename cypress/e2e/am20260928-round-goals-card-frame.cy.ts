/// <reference types="cypress" />
// 워크플로 → 자동화의 "회차 목표"(`RoundGoalsPanel.tsx`)는 설정 → AIA 설정으로 옮겨 간 "AIA 선제 제안"과 같은
// 화면에 서는데 틀이 달랐다. 카드 안에 서는 조각(`settings-subsection`)을 단독으로 써서
// 테두리도 표제 띠도 없이 배경 위에 떠 있었고, 비어 있음을 알리는 두 줄은 오른쪽에 붙는
// 메타 주석(`settings-storage-note`)을 쓴 탓에 상자 오른쪽 끝에 매달렸다.
//
// 여기서는 그 셋을 본다 — 카드 틀, 빈 목록 자리, 그리고 목록 밖으로 나온 추가 단추.
// 격리 백엔드는 목표가 비어 있으므로 빈 상태가 그대로 선다.
describe("워크플로 → 자동화 · 회차 목표 카드", () => {
  it("형제 카드와 같은 틀에 서고, 빈 자리 안내가 왼쪽 글머리에 맞는다", () => {
    cy.visitApp();
    cy.openAutomationTab();

    // 1) 카드 틀이다 — AIA 선제 제안 패널과 같은 클래스를 쓴다.
    cy.anchor("workflows.round-goals").as("card");
    cy.get("@card").should("have.class", "settings-card");
    cy.get("@card").find("header.plugin-page-header h2").should("contain.text", "회차 목표");

    // 2) 빈 목록은 첫 항목이 설 자리에 선다. (회차 보고 목록은 2026-09-30 부터 카드마다
    //    여는 "회차 상세" 모달로 옮겨 이 카드 아래에는 서지 않는다.)
    cy.get("@card").find(".plugin-empty-state strong").should("contain.text", "적어 둔 목표가 없습니다");
    cy.anchor("workflows.round-goals.reports").should("not.exist");

    // 3) 추가 단추는 목록 상자 안이 아니라 "새 목표" 줄에 있다. 누르면 편집기가 열린다.
    cy.get("@card").find(".plugin-list").should("not.exist");
    cy.get("@card").contains(".settings-update-body button", "목표 추가").click();
    cy.anchor("workflows.round-goals.editor").should("be.visible");

    cy.get("@card").screenshot("round-goals-card", { overwrite: true });
  });
});

export {};
