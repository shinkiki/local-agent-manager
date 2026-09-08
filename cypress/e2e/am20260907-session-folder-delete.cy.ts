// 세션 폴더 삭제 확인 대화(.folder-delete-confirm, role="alertdialog")의 계약을 처음 다룬다.
// 기존 스펙은 폴더 생성(AM-31)과 이름·색상·숨김 편집(am20260906-session-folder-edit)까지만 갔고,
// 삭제 경로 — 하위 폴더가 함께 지워진다는 예고 문구, 취소가 아무것도 지우지 않는다는 것,
// 지운 폴더가 선택돼 있었을 때 선택이 '전체'로 돌아간다는 것, 삭제가 새로고침을 건너 남는다는 것 —
// 은 한 번도 검증한 적이 없다.
// 관련 코드: src/components/SessionsView.tsx:1015(removeFolder), :1051(확인 대화), :1105(삭제 버튼).

function addButton() {
  return cy.get('.session-folders button[aria-label="최상위 폴더 추가"]');
}

function nameInput() {
  return cy.get('.folder-create-form input[placeholder="새 폴더 이름"]');
}

function folderCount() {
  return cy.get(".session-folders header span");
}

// 격리 백엔드가 기본 폴더를 몇 개 들고 시작하는지는 계약이 아니라서, 시작값을 재고 증감으로 본다.
let baseline = 0;

// 스펙 안에서 백엔드가 이어지므로 앞 테스트가 남긴 폴더와 이름이 겹치지 않게 한다.
let seq = 0;
let ROOT = "";
let CHILD = "";

function expectCount(delta: number) {
  return folderCount().should("have.text", String(baseline + delta));
}

function confirmDialog() {
  return cy.get('.folder-delete-confirm[role="alertdialog"]');
}

function createRoot(name: string): void {
  addButton().click();
  nameInput().type(name);
  cy.get(".folder-create-form button.primary").click();
  cy.get(".folder-entry-main strong").contains(name).should("exist");
}

// 편집 연필은 행에 마우스를 올려야 보이므로(호버 전용) force로 누른다.
function openEdit(name: string): void {
  cy.get(`.session-folders button[aria-label="${name} 폴더 편집"]`).click({ force: true });
  cy.get(".folder-edit-row").should("be.visible");
}

describe("세션 폴더 삭제 확인 대화의 예고·취소·선택 복귀와 삭제 잔존", () => {
  beforeEach(() => {
    cy.visitApp();
    seq += 1;
    ROOT = `QA 상위 ${seq}`;
    CHILD = `QA 하위 ${seq}`;
    cy.openView("sessions");
    folderCount()
      .invoke("text")
      .then((text) => {
        baseline = Number(text);
      });
  });

  it("하위 폴더가 있으면 함께 지운다고 예고하고, 취소는 폴더를 하나도 지우지 않는다", () => {
    // 1) 최상위 폴더와 그 아래 하위 폴더를 만든다.
    createRoot(ROOT);
    openEdit(ROOT);
    cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').click();
    cy.get(".folder-create-form select").should("not.have.value", "");
    nameInput().type(CHILD);
    cy.get(".folder-create-form button.primary").click();
    expectCount(2);

    // 2) 상위 폴더의 삭제 버튼을 누르면 확인 대화가 뜨고, 하위 개수와 세션 보존을 예고한다.
    openEdit(ROOT);
    cy.get('.folder-edit-actions button[title="폴더 삭제"]').click();
    confirmDialog().within(() => {
      cy.get("p")
        .should("contain.text", `'${ROOT}' 폴더를 삭제할까요?`)
        .and("contain.text", "하위 폴더 1개도 함께 삭제됩니다.")
        .and("contain.text", "세션과 원본 대화는 삭제되지 않습니다.");
    });

    // 3) 취소는 대화만 닫고 폴더 두 개를 그대로 둔다.
    confirmDialog().contains("button", "취소").click();
    cy.get(".folder-delete-confirm").should("not.exist");
    expectCount(2);
    cy.get(".folder-entry-main strong").contains(CHILD).should("exist");
  });

  it("삭제는 하위까지 지우고 선택을 전체로 되돌리며 새로고침 뒤에도 돌아오지 않는다", () => {
    createRoot(ROOT);
    openEdit(ROOT);
    cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').click();
    nameInput().type(CHILD);
    cy.get(".folder-create-form button.primary").click();
    expectCount(2);

    // 1) 하위 폴더를 선택해 둔다 — 생성 직후 자동 선택이므로 활성 표시로 확인만 한다.
    cy.get(".folder-entry.active .folder-entry-main strong").should("have.text", CHILD);
    cy.get(".folder-filter").contains("전체 세션").parent().should("not.have.class", "active");

    // 2) 선택돼 있지 않은 상위 폴더를 지운다 — 하위까지 함께 사라진다.
    openEdit(ROOT);
    cy.get('.folder-edit-actions button[title="폴더 삭제"]').click();
    confirmDialog().find("button.danger").click();
    cy.get(".folder-delete-confirm").should("not.exist");
    expectCount(0);

    // 3) 선택했던 폴더가 사라졌으므로 선택은 '전체 세션'으로 돌아간다.
    cy.get(".folder-filter.active").should("contain.text", "전체 세션");

    // 4) 새로고침해도 폴더는 돌아오지 않는다 — 삭제가 백엔드에 반영됐다.
    cy.visitApp();
    cy.openView("sessions");
    expectCount(0);
    cy.get(".folder-entry-main strong").should("not.contain.text", ROOT);
  });
  // AM-115가 다루지 않은 조건: 확인 대화가 떠 있는 동안 다른 폴더로 조작을 옮기는 경우.
  // deleteCandidate는 편집 행(editingId)과 별개의 상태라, 대화가 어느 폴더를 겨누고 있는지
  // 화면이 계속 말해 주는지 본다.
  it("삭제 확인 대화가 떠 있을 때 다른 폴더의 편집을 열어도 대화는 처음 고른 폴더를 계속 가리킨다", () => {
    createRoot(ROOT);
    createRoot(CHILD); // 형제로 하나 더 — 상하위 관계가 아니어도 되는 조건이다.
    expectCount(2);

    // 1) 첫 폴더의 삭제 확인 대화를 연다.
    openEdit(ROOT);
    cy.get('.folder-edit-actions button[title="폴더 삭제"]').click();
    confirmDialog().find("p").should("contain.text", `'${ROOT}' 폴더를 삭제할까요?`);

    // 2) 대화를 닫지 않은 채 다른 폴더의 편집 행을 연다.
    openEdit(CHILD);
    cy.get(".folder-edit-row input").first().should("exist");

    // 3) 대화는 여전히 처음 고른 폴더를 가리킨다 — 겨눈 대상이 조용히 바뀌지 않는다.
    confirmDialog().find("p").should("contain.text", `'${ROOT}' 폴더를 삭제할까요?`);

    // 4) 그대로 삭제하면 처음 고른 폴더만 사라지고 나중에 편집을 연 폴더는 남는다.
    confirmDialog().find("button.danger").click();
    cy.get(".folder-delete-confirm").should("not.exist");
    expectCount(1);
    cy.get(".folder-entry-main strong").should("not.contain.text", ROOT);
    // 나중에 편집을 연 폴더는 편집 행인 채로 남아 있다 — 삭제가 그 행을 건드리지 않았다.
    cy.get('.folder-edit-row input:not([type="color"])').should("have.value", CHILD);
  });
});
