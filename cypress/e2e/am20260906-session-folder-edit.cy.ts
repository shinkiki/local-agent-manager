// 세션 폴더 연필 편집기(이름·색상·숨김)를 본다. AM-31은 '최상위 폴더 추가' 폼의 이름 경계만
// 봤고, 같은 경계를 편집기가 어떻게 다루는지(생성 폼은 버튼을 막고, 편집기는 무엇을 하는지),
// 저장한 이름·색이 목록과 새로고침을 건너 남는지, 숨김 토글이 목록 표시에 반영되는지는 처음이다.
const FOLDER_NAME = "QA 폴더 편집";
const RENAMED = "QA 폴더 편집 완료";

function addButton() {
  return cy.get('.session-folders button[aria-label="최상위 폴더 추가"]');
}

function editRow() {
  return cy.get(".folder-edit-row");
}

// 연필 버튼은 항목에 마우스를 올려야 드러나므로, 실제 조작과 같게 hover 뒤에 누른다.
function openEditor(name: string) {
  folderEntry(name).trigger("mouseover");
  cy.get(`.session-folders button[aria-label="${name} 폴더 편집"]`).click({ force: true });
  return editRow().should("be.visible");
}

function folderEntry(name: string) {
  return cy.contains(".folder-entry .folder-entry-main strong", name).closest(".folder-entry");
}

describe("세션 폴더 편집기의 이름 경계·색상 저장·숨김 토글", () => {
  it("빈 이름이면 저장 버튼이 비활성이 되고, 저장한 이름·색상과 숨김은 새로고침을 건너 남는다", () => {
    cy.visitApp();
    cy.openView("sessions");

    // 1) 사전 흐름 — 임시 HOME이라 폴더가 0건이므로 편집 대상을 하나 만든다(AM-31 계약).
    cy.get(".session-folders header span").should("have.text", "0");
    addButton().click();
    cy.get('.folder-create-form input[placeholder="새 폴더 이름"]').type(`${FOLDER_NAME}{enter}`);
    cy.get(".session-folders header span").should("have.text", "1");

    // 2) 연필을 누르면 편집기가 현재 이름·색상을 담은 채 열린다.
    openEditor(FOLDER_NAME);
    editRow().find('input:not([type="color"])').should("have.value", FOLDER_NAME);
    editRow().find('input[type="color"]').should("have.attr", "value").and("match", /^#[0-9a-f]{6}$/i);

    // 3) 이름을 공백만 남기면 편집기의 저장 버튼도 생성 폼과 같은 계약으로 비활성이 된다(QA #26).
    //    예전에는 눌리는 채로 남아 조용히 무시돼 저장이 먹히지 않는 것처럼 보였다.
    editRow().find('input:not([type="color"])').clear().type("   ");
    editRow().find('button[aria-label="이름·색상 저장"]').should("be.disabled");
    // Enter로도 저장되지 않는다 — 편집기는 열린 채 남고 오류 안내는 필요 없다.
    editRow().find('input:not([type="color"])').type("{enter}");
    editRow().should("be.visible");
    cy.get(".folder-error").should("not.exist");
    // 글자를 다시 넣으면 저장 버튼이 되살아난다.
    editRow().find('input:not([type="color"])').type("x");
    editRow().find('button[aria-label="이름·색상 저장"]').should("not.be.disabled");

    // 닫고 보면 이름은 그대로다 — 빈 이름이 저장된 것이 아니라 조작 자체가 막혔다.
    editRow().find('button[aria-label="폴더 편집 닫기"]').click();
    folderEntry(FOLDER_NAME).should("exist");

    // 4) 이름과 색상을 함께 바꿔 저장하면 편집기가 닫히고 목록에 곧바로 반영된다.
    openEditor(FOLDER_NAME);
    editRow().find('input:not([type="color"])').clear().type(RENAMED);
    // 색상 입력은 OS 색 선택기라 타이핑할 수 없다. React가 값 변화를 놓치지 않도록 네이티브
    // value setter로 넣고 input 이벤트를 올린다(jQuery val()만으로는 React가 무시한다).
    editRow().find('input[type="color"]').then(($input) => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setValue?.call($input[0], "#3366ff");
      $input[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    editRow().find('input[type="color"]').should("have.value", "#3366ff");
    editRow().find('button[aria-label="이름·색상 저장"]').click();
    editRow().should("not.exist");
    folderEntry(RENAMED).find(".folder-symbol").should("have.attr", "style").and("contain", "#3366ff");

    // 5) 숨김 토글은 폴더를 지우지 않고 목록 항목에 숨김 표시만 남긴다.
    openEditor(RENAMED);
    editRow().find(`button[aria-label="${RENAMED} 폴더 숨김"]`).click();
    editRow().find(`button[aria-label="${RENAMED} 폴더 표시"]`).should("have.attr", "aria-pressed", "true");
    editRow().find('button[aria-label="폴더 편집 닫기"]').click();
    folderEntry(RENAMED).should("have.class", "hidden-folder");
    cy.get(".session-folders header span").should("have.text", "1");

    // 6) 이름·색상·숨김은 백엔드(app-data)에 남는 값이라 새로고침을 건너 복원된다.
    cy.reload();
    cy.openView("sessions");
    folderEntry(RENAMED).should("have.class", "hidden-folder");
    folderEntry(RENAMED).find(".folder-symbol").should("have.attr", "style").and("contain", "#3366ff");
    cy.screenshot("session-folder-edit-after-reload");
  });
});
