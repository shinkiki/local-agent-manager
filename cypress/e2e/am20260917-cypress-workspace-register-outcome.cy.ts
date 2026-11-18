// 애드온 → Cypress의 작업공간 추가 폼에서 "등록" 버튼을 실제로 누른 뒤의 두 갈래를 본다.
// AM-28은 등록을 누르지 않고 필수값 경계와 취소 후 잔존만 봤다. 여기서는 백엔드 응답을 스텁해
// 파일시스템을 건드리지 않고 실패·성공 두 갈래를 확인한다.
//  - 실패: 오류 안내가 서고 폼이 열린 채 초안 세 칸이 남아 경로만 고쳐 다시 시도할 수 있다.
//  - 성공: 폼이 닫히고 등록 알림이 서며, 다시 열면 세 칸이 비어 있다(reset 계약).
// 폼이 열릴 때 이름 칸으로 초점이 가는 계약도 함께 본다.
import { cypressWorkspace, stubCypressRegistry } from "../support/cypressWorkspaceFixtures";

describe("Cypress 작업공간 등록의 실패·성공 갈래와 폼 초기화", () => {
  const NAME = "QA 등록 결과 확인";
  const PATH = "/tmp/am-qa-register-outcome";
  const MODULE = "/tmp/am-qa-register-module";
  const FAILURE = "폴더를 찾을 수 없습니다: /tmp/am-qa-register-outcome";

  const openForm = () => {
    cy.contains(".settings-subsection header button", "작업공간 추가").click();
    cy.get(".cypress-form").should("be.visible");
  };

  const submitButton = () => cy.get(".cypress-form .cypress-form-actions button.primary");

  const fillDraft = () => {
    cy.get("#cypress-new-name").clear().type(NAME);
    cy.get("#cypress-new-path").clear().type(PATH);
    cy.get("#cypress-new-module").clear().type(MODULE);
  };

  beforeEach(() => {
    // 등록 전 목록은 비어 있다. 성공 응답은 스텁이 새 등록부로 답하므로 여기서는 빈 목록만 둔다.
    stubCypressRegistry([]);
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openAddonsView("cypress");
  });

  it("폼을 열면 이름 칸으로 초점이 간다", () => {
    openForm();
    cy.get("#cypress-new-name").should("have.focus");
  });

  it("등록이 실패하면 오류가 서고 폼과 초안 세 칸이 그대로 남는다", () => {
    cy.stubInvoke("add_cypress_workspace", { statusCode: 500, body: { error: FAILURE } }).as("addFail");
    openForm();
    fillDraft();
    submitButton().click();
    cy.wait("@addFail");

    cy.get(".cypress-banner").should("contain.text", FAILURE);
    // 폼이 닫히면 사용자가 세 칸을 다시 적어야 한다. 실패에서는 닫히지 않아야 한다.
    cy.get(".cypress-form").should("be.visible");
    cy.get("#cypress-new-name").should("have.value", NAME);
    cy.get("#cypress-new-path").should("have.value", PATH);
    cy.get("#cypress-new-module").should("have.value", MODULE);
    // 목록은 그대로 비어 있고 등록 버튼도 다시 누를 수 있다.
    cy.get(".cypress-panel").should("contain.text", "등록된 작업공간이 없습니다.");
    submitButton().should("not.be.disabled");
  });

  it("실패 뒤 다시 눌러 성공하면 폼이 닫히고 알림이 서며 초안이 비워진다", () => {
    cy.stubInvoke("add_cypress_workspace", { statusCode: 500, body: { error: FAILURE } }).as("addFail");
    openForm();
    fillDraft();
    submitButton().click();
    cy.wait("@addFail");
    cy.get(".cypress-banner").should("contain.text", FAILURE);

    // 두 번째 시도는 성공 응답으로 바꾼다. moduleReady를 참으로 둬 등록 뒤 자동 설치로 이어지지 않게 한다.
    const added = cypressWorkspace({ id: "ws-register-outcome", name: NAME, path: PATH, moduleDir: MODULE });
    cy.stubInvoke("add_cypress_workspace", { statusCode: 200, body: { enabled: true, workspaces: [added] } }).as("addOk");
    submitButton().click();
    cy.wait("@addOk");

    cy.get(".cypress-form").should("not.exist");
    cy.get(".cypress-notice").should("contain.text", `'${NAME}' 작업공간을 등록했습니다.`);
    // 실패 때 섰던 오류 안내는 다음 시도 시작에서 걷힌다.
    cy.get(".cypress-banner").should("not.exist");
    cy.get(".cypress-panel").should("contain.text", NAME);

    // reset은 폼을 닫으면서 초안도 비운다 — 취소로 닫았을 때(AM-28)와 다른 지점이다.
    openForm();
    cy.get("#cypress-new-name").should("have.value", "");
    cy.get("#cypress-new-path").should("have.value", "");
    cy.get("#cypress-new-module").should("have.value", "");
  });
});
