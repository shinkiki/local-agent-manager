// AM-31 (임시 스펙): 세션 폴더 사이드바의 '최상위 폴더 추가' 폼이 이름 경계(빈 값·공백만)에서
// 저장을 막는지, 취소·재개방이 입력값을 어떻게 다루는지(AM-28의 Cypress 등록 폼과 대조),
// Enter 키로도 생성되는지, 생성 직후 그 폴더가 자동 선택돼 접힘 복원 버튼 라벨
// (collapsedFolderLabel)까지 따라가는지, 그리고 폴더는 백엔드에 남지만 폴더 선택은 저장 계약이
// 없어 새로고침 뒤 '전체'로 돌아가는지.
// 기존 AM-16(보류)은 접기·펴기 상태만, AM-1·AM-14·AM-21은 칩·추가 필터만 다뤘고 폴더 생성은 처음이다.

function openSessions(): void {
  cy.openView("sessions");
}

function addButton() {
  return cy.get('.session-folders button[aria-label="최상위 폴더 추가"]');
}

function nameInput() {
  return cy.get('.folder-create-form input[placeholder="새 폴더 이름"]');
}

function submitButton() {
  return cy.get(".folder-create-form button.primary");
}

describe("세션 폴더 생성 폼의 이름 경계·취소 계약과 생성 후 선택·잔존", () => {
  it("빈 이름·공백만으로는 추가할 수 없고, 취소는 폴더를 만들지 않으며 재개방은 입력값을 지운다", () => {
    cy.visitApp();
    openSessions();

    // 1) 임시 HOME이라 폴더는 0건이고 생성 폼은 닫혀 있다.
    cy.get(".session-folders header span").should("have.text", "0");
    cy.get(".folder-create-form").should("not.exist");
    addButton().should("have.attr", "aria-expanded", "false");

    // 2) 폼을 열면 aria-expanded가 뒤집히고, 빈 이름에서는 '추가'가 막혀 있다.
    addButton().click().should("have.attr", "aria-expanded", "true");
    cy.get(".folder-create-form").should("be.visible");
    submitButton().should("be.disabled");

    // 3) 공백만 넣어도 trim 경계에 걸려 계속 막혀 있다.
    nameInput().type("   ");
    submitButton().should("be.disabled");

    // 4) 공백이 아닌 글자가 들어가야 활성된다.
    nameInput().clear().type("QA 임시 폴더");
    submitButton().should("not.be.disabled");

    // 5) 취소는 폴더를 만들지 않고 폼만 닫는다.
    cy.get(".folder-create-form button").contains("취소").click();
    cy.get(".folder-create-form").should("not.exist");
    addButton().should("have.attr", "aria-expanded", "false");
    cy.get(".session-folders header span").should("have.text", "0");

    // 6) 다시 열면 이름이 비어 있다 — 재개방이 startCreating을 거쳐 name을 지우기 때문이고,
    //    입력값이 남던 Cypress 등록 폼(AM-28)과 정반대 계약이다.
    addButton().click();
    nameInput().should("have.value", "");
  });

  it("Enter로 만든 폴더가 자동 선택돼 접힘 라벨에 반영되고, 새로고침 뒤 폴더는 남고 선택은 전체로 돌아간다", () => {
    cy.visitApp();
    openSessions();

    // 1) Enter 키로도 생성된다(onKeyDown 계약).
    addButton().click();
    nameInput().type("QA 폴더 A{enter}");

    // 2) 폼이 닫히고 목록에 한 건이 생기며, 만든 폴더가 곧바로 선택된다.
    cy.get(".folder-create-form").should("not.exist");
    cy.get(".session-folders header span").should("have.text", "1");
    cy.get(".folder-entry.active .folder-entry-main strong").should("have.text", "QA 폴더 A");

    // 3) 사이드바를 접으면 복원 버튼 라벨이 '폴더'가 아니라 현재 선택 폴더 이름을 담는다.
    cy.get('.session-folders button[aria-label="세션 폴더 숨기기"]').click();
    cy.anchor("sessions.folders")
      .should("have.attr", "aria-expanded", "false")
      .and("have.attr", "aria-label", "세션 폴더 보기 · 현재 QA 폴더 A");

    // 4) 다시 펴면 사이드바가 돌아오고 선택도 유지된다.
    cy.anchor("sessions.folders").click();
    cy.get(".folder-entry.active .folder-entry-main strong").should("have.text", "QA 폴더 A");

    // 5) 새로고침 — 폴더는 백엔드(app-data)에 남지만, 폴더 선택은 저장 계약이 없어 전체로 돌아간다.
    cy.reload();
    openSessions();
    cy.get(".session-folders header span").should("have.text", "1");
    cy.get(".folder-entry-main strong").should("have.text", "QA 폴더 A");
    cy.get(".folder-entry.active").should("not.exist");

    // 6) 그래서 접힘 복원 버튼 라벨도 기본값 '폴더'로 돌아온다.
    cy.get('.session-folders button[aria-label="세션 폴더 숨기기"]').click();
    cy.anchor("sessions.folders").should("have.attr", "aria-label", "세션 폴더 보기 · 현재 폴더");
  });
});
