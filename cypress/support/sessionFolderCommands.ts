/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 세션 폴더 패널(.session-folders)의 선택자는 폴더 스펙 여섯이 저마다 addButton·nameInput·
// createRoot·openEdit·closeEdit·folderCount를 통째로 적어 두던 자리다. 같은 한국어 aria-label과
// 플레이스홀더가 여섯 곳에 흩어져, 라벨 한 글자가 바뀌면 여섯 파일을 같이 고쳐야 했다.
// 선택자를 아는 곳은 여기 하나로 둔다.
const FOLDER_EDIT_ROW = ".folder-edit-row";

Cypress.Commands.add("folderAddButton", () => cy.get('.session-folders button[aria-label="최상위 폴더 추가"]'));

Cypress.Commands.add("folderNameInput", () => cy.get('.folder-create-form input[placeholder="새 폴더 이름"]'));

Cypress.Commands.add("folderSubmitButton", () => cy.get(".folder-create-form button.primary"));

Cypress.Commands.add("folderCount", () => cy.get(".session-folders header span"));

Cypress.Commands.add("folderEntry", (name: string) =>
  cy.contains(".folder-entry .folder-entry-main strong", name).closest(".folder-entry"),
);

// 만들기는 "추가를 누르고 이름을 적고 폼을 보내고 그 행이 떴는지 본다"의 네 걸음이다. 폼을
// 보내는 방법이 스펙마다 갈려 있었으나(기본 버튼 클릭과 `{enter}`) 같은 submit이므로 버튼
// 한 갈래로 모았다. 엔터 제출 자체를 보는 스펙(am31)은 위 낱개 명령을 그대로 쓴다.
Cypress.Commands.add("createFolder", (name: string) => {
  cy.folderAddButton().click();
  cy.folderNameInput().type(name);
  cy.folderSubmitButton().click();
  return cy.folderEntry(name).should("exist");
});

// 편집 연필은 행에 마우스를 올려야 보이므로(호버 전용) force로 누른다.
Cypress.Commands.add("openFolderEdit", (name: string) => {
  cy.get(`.session-folders button[aria-label="${name} 폴더 편집"]`).click({ force: true });
  return cy.get(FOLDER_EDIT_ROW).should("be.visible");
});

Cypress.Commands.add("closeFolderEdit", () => {
  cy.get(`${FOLDER_EDIT_ROW} button[aria-label="폴더 편집 닫기"]`).click();
  return cy.get(FOLDER_EDIT_ROW).should("not.exist");
});
