/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 워크플로 관리 탭의 목록·실행 폼을 보는 스펙 다섯이 같은 세 선택자를 저마다 적어 두고 있었다.
// 실행 버튼은 `.workflow-detail-actions .button`을 이름으로 찾은 뒤 접힌 아래에 있어 끌어와서
// 눌러야 하고(스펙 넷에 열한 벌), 입력칸은 `.workflow-inputs input`의 순번이며, 계약 고르기는
// `.workflow-card-main`을 이름으로 찾아 누른다. 선택자를 아는 곳을 여기 하나로 줄인다.

Cypress.Commands.add("workflowAction", (label: string) =>
  cy.contains(".workflow-detail-actions .button", label),
);

// 누르는 자리는 언제나 "끌어와서 누른다"였다. 없어야 하는 것을 보는 스펙만 `workflowAction`을
// 직접 쓴다 — 사라진 버튼은 끌어올 수 없다.
Cypress.Commands.add("clickWorkflowAction", (label: string) =>
  cy.workflowAction(label).scrollIntoView().click(),
);

Cypress.Commands.add("workflowInput", (index: number) =>
  cy.get(".workflow-inputs input").eq(index),
);

Cypress.Commands.add("workflowCard", (displayName: string) =>
  cy.contains(".workflow-card-main", displayName),
);

Cypress.Commands.add("selectWorkflow", (displayName: string) =>
  cy.workflowCard(displayName).click(),
);

// 워크플로 → 자동화 탭(애드온 화면에서 옮겨 온 회차 목표·온보딩 카드)을 여는 절차. 예전
// `openAddonsView("automation")`이 하던 자리다. 패널은 탭을 떠나도 DOM에 남으므로(입력 보존)
// 떴는지는 `be.visible`이 아니라 그려지고 있는지(offsetParent)로 본다 — 앵커가 탭 안 마지막
// 카드에 붙어 있어 스크롤 위치만으로 "clipped" 거짓이 날 수 있다(애드온 탭에서 쓰던 규칙 그대로).
Cypress.Commands.add("openAutomationTab", () => {
  cy.openView("workflows");
  cy.anchor("workflows.tab.automation").click();
  cy.anchor("workflows.tab.automation").should("have.class", "active");
  return cy.anchor("workflows.automation-content").should(($panel) => {
    expect($panel[0].offsetParent, "자동화 패널이 떠 있어야 한다").to.not.equal(null);
  });
});
