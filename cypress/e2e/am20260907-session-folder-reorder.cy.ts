/// <reference types="cypress" />
// 세션 폴더 편집 행(.folder-edit-row)의 형제 순서 이동(위로 이동·아래로 이동) 계약을 검증한다.
// 기존 스펙은 폴더 생성(AM-31), 편집기의 이름 경계·색상·숨김(am20260906-session-folder-edit),
// 삭제 확인 대화(AM-115/am20260907-session-folder-delete)까지만 다뤘고,
// 형제 사이에서 순서를 한 칸씩 위/아래로 바꾸는 동작(reorder_session_folder)과 양 끝에서의
// 버튼 비활성화(first disabled on 'up', last disabled on 'down'), 이동 후 목록 순서 즉각 반영 및
// 새로고침 뒤 영속성 보장은 한 번도 검증한 적이 없다.
// 관련 코드:
//   src/components/SessionsView.tsx:889 (siblingEdges 계산)
//   src/components/SessionsView.tsx:1008 (moveFolder 함수)
//   src/components/SessionsView.tsx:1092-1093 (위로/아래로 이동 버튼)
//   crates/agent-manager-core/src/session_folders.rs:187 (reorder_session_folder 백엔드 IPC)

function addButton() {
  return cy.get('.session-folders button[aria-label="최상위 폴더 추가"]');
}

function nameInput() {
  return cy.get('.folder-create-form input[placeholder="새 폴더 이름"]');
}

function createRoot(name: string): void {
  addButton().click();
  nameInput().type(name);
  cy.get(".folder-create-form button.primary").click();
  cy.get(".folder-entry-main strong").contains(name).should("exist");
}

function openEdit(name: string): void {
  cy.get(`.session-folders button[aria-label="${name} 폴더 편집"]`).click({ force: true });
  cy.get(".folder-edit-row").should("be.visible");
}

function closeEdit(): void {
  cy.get('.folder-edit-row button[aria-label="폴더 편집 닫기"]').click();
  cy.get(".folder-edit-row").should("not.exist");
}

function getFolderNames() {
  return cy.get(".folder-list .folder-entry .folder-entry-main strong").then(($el) => {
    return [...$el].map((e) => e.textContent?.trim() ?? "");
  });
}

let seq = 0;
let FOLDER_A = "";
let FOLDER_B = "";
let FOLDER_C = "";

describe("세션 폴더 편집기의 형제 순서 이동(위/아래)과 양 끝 경계 잠금", () => {
  beforeEach(() => {
    cy.visitApp();
    seq += 1;
    FOLDER_A = `QA 순서 A ${seq}`;
    FOLDER_B = `QA 순서 B ${seq}`;
    FOLDER_C = `QA 순서 C ${seq}`;
    cy.openView("sessions");
  });

  it("첫째 폴더는 위로 이동이 막히고, 마지막 폴더는 아래로 이동이 막히며, 중간 폴더는 둘 다 열려 있다", () => {
    createRoot(FOLDER_A);
    createRoot(FOLDER_B);
    createRoot(FOLDER_C);

    // 1) 첫 번째 폴더(A)의 편집 행: 위로 이동 버튼은 비활성(disabled), 아래로 이동 버튼은 활성
    openEdit(FOLDER_A);
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 위로 이동"]`).should("be.disabled");
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 아래로 이동"]`).should("not.be.disabled");
    closeEdit();

    // 2) 두 번째 폴더(B)의 편집 행: 위로 이동과 아래로 이동 둘 다 활성
    openEdit(FOLDER_B);
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_B} 폴더를 위로 이동"]`).should("not.be.disabled");
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_B} 폴더를 아래로 이동"]`).should("not.be.disabled");
    closeEdit();

    // 3) 세 번째 폴더(C)의 편집 행: 위로 이동은 활성, 아래로 이동 버튼은 비활성(disabled)
    openEdit(FOLDER_C);
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_C} 폴더를 위로 이동"]`).should("not.be.disabled");
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_C} 폴더를 아래로 이동"]`).should("be.disabled");
    closeEdit();
  });

  it("폴더를 아래로/위로 이동하면 목록 순서가 즉시 바뀌고 새로고침 뒤에도 순서가 유지된다", () => {
    createRoot(FOLDER_A);
    createRoot(FOLDER_B);
    createRoot(FOLDER_C);

    // 생성 직후 순서: A, B, C가 순서대로 나타남
    getFolderNames().then((names) => {
      const idxA = names.indexOf(FOLDER_A);
      const idxB = names.indexOf(FOLDER_B);
      const idxC = names.indexOf(FOLDER_C);
      expect(idxA).to.be.lessThan(idxB);
      expect(idxB).to.be.lessThan(idxC);
    });

    // 1) 첫 번째 폴더(A)를 편집하고 아래로 이동 클릭
    openEdit(FOLDER_A);
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 아래로 이동"]`).click();

    // 이제 A는 B 뒤로 갔으므로, [B, A, C] 순서가 되어야 하고 A의 위/아래 이동 버튼 모두 활성화됨
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 위로 이동"]`).should("not.be.disabled");
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 아래로 이동"]`).should("not.be.disabled");
    closeEdit();

    getFolderNames().then((names) => {
      const idxA = names.indexOf(FOLDER_A);
      const idxB = names.indexOf(FOLDER_B);
      const idxC = names.indexOf(FOLDER_C);
      expect(idxB).to.be.lessThan(idxA);
      expect(idxA).to.be.lessThan(idxC);
    });

    // 2) A를 다시 아래로 이동 클릭하면 [B, C, A] 순서가 됨
    openEdit(FOLDER_A);
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 아래로 이동"]`).click();
    // A는 이제 마지막이므로 아래로 이동은 비활성화되어야 함
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 아래로 이동"]`).should("be.disabled");
    cy.get(`.folder-edit-actions button[aria-label="${FOLDER_A} 폴더를 위로 이동"]`).should("not.be.disabled");
    closeEdit();

    getFolderNames().then((names) => {
      const idxA = names.indexOf(FOLDER_A);
      const idxB = names.indexOf(FOLDER_B);
      const idxC = names.indexOf(FOLDER_C);
      expect(idxB).to.be.lessThan(idxC);
      expect(idxC).to.be.lessThan(idxA);
    });

    // 3) 새로고침(visitApp) 후에도 [B, C, A] 순서가 영속적으로 유지되는지 확인
    cy.visitApp();
    cy.openView("sessions");

    getFolderNames().then((names) => {
      const idxA = names.indexOf(FOLDER_A);
      const idxB = names.indexOf(FOLDER_B);
      const idxC = names.indexOf(FOLDER_C);
      expect(idxB).to.be.lessThan(idxC);
      expect(idxC).to.be.lessThan(idxA);
    });
  });
});
