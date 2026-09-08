/// <reference types="cypress" />
// QA #44 — 세션 폴더 목록(.folder-list)이 넘칠 만큼 폴더가 많을 때 아랫줄 폴더의 연필을 누르면
// 편집 행이 스크롤 영역 밖으로 자라, 안내 푸터에 가린 채로 열렸다. 편집 행은 닫혀 있던 항목보다
// 훌쩍 크므로(색상·이름·저장·상위 폴더·순서·숨김·삭제) 열릴 때 그 자리를 목록 안으로 끌어와야
// 한다. 이제 SessionsView의 편집 행 ref가 editingId가 바뀐 뒤 scrollIntoView({ block: "nearest" })를
// 부른다. 여기서는 목록을 넘치게 만든 뒤 마지막 폴더의 편집 행이 목록의 보이는 영역 안에 있는지
// 기하로 확인한다. am20260907-session-folder-tree-depth는 예전에 이 결함을 스펙 안에서 직접
// scrollIntoView로 피해 갔다.

const FOLDER_COUNT = 12;
const PREFIX = "QA44 폴더";

function addButton() {
  return cy.get('.session-folders button[aria-label="최상위 폴더 추가"]');
}

function createRoot(name: string): void {
  addButton().click();
  cy.get('.folder-create-form input[placeholder="새 폴더 이름"]').type(`${name}{enter}`);
  cy.get(".folder-entry-main strong").contains(name).should("exist");
}

describe("세션 폴더 목록 아랫줄 폴더의 편집 행은 열릴 때 목록 안으로 스크롤된다", () => {
  it("목록이 넘칠 때 마지막 폴더의 편집 행이 목록의 보이는 영역 안에 놓인다", () => {
    // 폴더 패널의 높이는 뷰포트에 묶여 있으므로(max-height: calc(100vh - 125px)) 낮은 창으로
    // 적은 폴더로도 목록을 넘치게 만든다.
    cy.viewport(1000, 520);
    cy.visitApp();
    cy.openView("sessions");
    cy.get("aside.session-folders").should("be.visible");

    for (let index = 1; index <= FOLDER_COUNT; index += 1) createRoot(`${PREFIX} ${index}`);
    const last = `${PREFIX} ${FOLDER_COUNT}`;

    // 전제: 목록이 실제로 넘친다. 그렇지 않으면 이 시나리오는 결함을 재현하지 못한다.
    cy.get(".folder-list").should(($list) => {
      expect($list[0].scrollHeight, "folder-list scrollHeight").to.be.greaterThan($list[0].clientHeight);
    });
    // 맨 위로 되돌려, 마지막 폴더가 보이는 영역 아래에 놓인 상태에서 시작한다.
    cy.get(".folder-list").scrollTo("top");

    // 연필은 호버 전용이라 force로 누른다. 결함 시나리오에서는 이 시점의 편집 행이 목록 아래로
    // 넘쳐 푸터에 가려 있었다.
    cy.get(`.session-folders button[aria-label="${last} 폴더 편집"]`).click({ force: true });
    cy.get(".folder-edit-row").should("exist");
    cy.get(".folder-edit-row input:not([type=\"color\"])").should("have.value", last);

    cy.get(".folder-edit-row").should(($row) => {
      const list = $row.closest(".folder-list")[0].getBoundingClientRect();
      const row = $row[0].getBoundingClientRect();
      expect(row.top, "edit row top inside list").to.be.at.least(list.top - 1);
      expect(row.bottom, "edit row bottom inside list").to.be.at.most(list.bottom + 1);
    });
    // 푸터와 겹치지 않는다 — 목록은 푸터 위에서 끝나므로 행의 아래끝이 푸터 위에 있어야 한다.
    cy.get(".session-folders > footer").then(($footer) => {
      const footerTop = $footer[0].getBoundingClientRect().top;
      cy.get(".folder-edit-row").should(($row) => {
        expect($row[0].getBoundingClientRect().bottom, "edit row above footer").to.be.at.most(footerTop + 1);
      });
    });
    cy.get(".folder-edit-row").should("be.visible");
    cy.screenshot("qa44-session-folder-edit-row-scrolled");
  });
});
