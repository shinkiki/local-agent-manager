/// <reference types="cypress" />
// 세션 정리폴더 트리의 '접기·펴기'와 '5단계 깊이 한도'를 처음 검증한다.
// 기존 폴더 스펙은 생성(AM-31), 이름·색상·숨김 편집(am20260906-session-folder-edit),
// 삭제 확인 대화(am20260907-session-folder-delete), 형제 순서 이동
// (am20260907-session-folder-reorder)까지 다뤘고, 하위 폴더를 한 단계 만드는 것까지만 갔다.
// 아직 한 번도 본 적 없는 계약은 세 가지다.
//  1) 하위가 있는 폴더의 트위스티(.folder-twisty)가 접히면 하위 행이 목록에서 빠지고,
//     aria-expanded/title이 그 상태를 말한다.
//  2) 접힘은 백엔드가 아니라 localStorage("agent-manager.session-folders-collapsed")에
//     저장돼 새로고침을 건너 남는다 — 폴더 '선택'은 남지 않는다는 AM-31 계약과 대조된다.
//  3) 깊이 한도는 MAX_SESSION_FOLDER_DEPTH=5로, 5단째(depth 4) 폴더의 편집 행에는
//     '하위 폴더 추가' 버튼 자체가 없다.
// 관련 코드: src/components/SessionsView.tsx:1099(isCollapsed), :1126(하위 폴더 추가),
//   :1167·:1200·:1210(접힘 저장 키와 읽기·쓰기), src/lib/sessionFolders.ts:21·:145.
// 2026-09-07 회차에서 a2a1eda(정리폴더 트리 색인·순회·캐시를 sessionFolderTree로 분리)가
// 이 화면의 순회·접힘 계산을 옮겼으므로 그 영역을 우선 대상으로 골랐다.

const COLLAPSED_KEY = "agent-manager.session-folders-collapsed";

function addButton() {
  return cy.get('.session-folders button[aria-label="최상위 폴더 추가"]');
}

function nameInput() {
  return cy.get('.folder-create-form input[placeholder="새 폴더 이름"]');
}

function submitCreate() {
  return cy.get(".folder-create-form button.primary").click();
}

function folderCount() {
  return cy.get(".session-folders header span");
}

// 편집 연필은 호버 전용이라 force로 누른다.
// 편집 행은 열리면 스스로 목록 안으로 스크롤된다(QA #44, 회귀 스펙 qa44-session-folder-edit-scroll).
function openEdit(name: string): void {
  cy.get(`.session-folders button[aria-label="${name} 폴더 편집"]`).click({ force: true });
  cy.get(".folder-edit-row").should("be.visible");
}

function closeEdit(): void {
  cy.get('.folder-edit-row button[aria-label="폴더 편집 닫기"]').click();
  cy.get(".folder-edit-row").should("not.exist");
}

function entry(name: string) {
  return cy.get(".folder-entry-main strong").contains(name).closest(".folder-entry");
}

function createRoot(name: string): void {
  addButton().click();
  nameInput().type(name);
  submitCreate();
  cy.get(".folder-entry-main strong").contains(name).should("exist");
}

function createChild(parent: string, name: string): void {
  openEdit(parent);
  cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').click();
  nameInput().type(name);
  submitCreate();
  cy.get(".folder-entry-main strong").contains(name).should("exist");
}

// 격리 백엔드가 폴더를 몇 개 들고 시작하는지는 계약이 아니므로 증감으로 본다.
let baseline = 0;
let seq = 0;

function expectCount(delta: number) {
  return folderCount().should("have.text", String(baseline + delta));
}

describe("세션 정리폴더 트리의 접기·펴기 잔존과 5단계 깊이 한도", () => {
  beforeEach(() => {
    cy.visitApp();
    seq += 1;
    cy.openView("sessions");
    folderCount()
      .invoke("text")
      .then((text) => {
        baseline = Number(text);
      });
  });

  it("트위스티로 접으면 하위 행이 목록에서 빠지고 aria-expanded가 뒤집힌다", () => {
    const root = `QA 트리 상위 ${seq}`;
    const child = `QA 트리 하위 ${seq}`;
    createRoot(root);
    createChild(root, child);
    expectCount(2);

    // 하위가 붙은 뒤에는 상위에 트위스티 버튼이 생기고 펴진 상태로 시작한다.
    entry(root)
      .find("button.folder-twisty")
      .should("have.attr", "aria-expanded", "true")
      .and("have.attr", "title", "하위 폴더 접기");
    // 하위 행은 한 단 들여쓰여 있다.
    entry(child).should("have.attr", "style").and("contain", "--folder-depth: 1");

    // 접으면 하위 행이 목록에서 빠지고, 버튼 안내가 개수와 함께 '펼치기'로 바뀐다.
    entry(root).find("button.folder-twisty").click();
    cy.get(".folder-entry-main strong").contains(child).should("not.exist");
    entry(root)
      .find("button.folder-twisty")
      .should("have.attr", "aria-expanded", "false")
      .and("have.attr", "title", "하위 폴더 1개 펼치기");
    // 접힘은 표시일 뿐이라 폴더 개수는 그대로다.
    expectCount(2);

    // 다시 누르면 그대로 돌아온다.
    entry(root).find("button.folder-twisty").click();
    cy.get(".folder-entry-main strong").contains(child).should("exist");
  });

  it("접힘은 localStorage에 남아 새로고침을 건너지만, 폴더 선택은 전체로 돌아간다", () => {
    const root = `QA 접힘 상위 ${seq}`;
    const child = `QA 접힘 하위 ${seq}`;
    createRoot(root);
    createChild(root, child);

    entry(root).find("button.folder-twisty").click();
    cy.get(".folder-entry-main strong").contains(child).should("not.exist");
    // 저장 위치는 백엔드가 아니라 브라우저 저장소다.
    cy.window().then((win) => {
      const stored = win.localStorage.getItem(COLLAPSED_KEY);
      expect(stored, "접힘 저장값").to.be.a("string");
      expect(JSON.parse(stored as string)).to.have.length(1);
    });

    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openView("sessions");

    // 접힘은 남는다.
    cy.get(".folder-entry-main strong").contains(root).should("exist");
    cy.get(".folder-entry-main strong").contains(child).should("not.exist");
    entry(root).find("button.folder-twisty").should("have.attr", "aria-expanded", "false");
    // 선택은 저장 계약이 없어 '전체 세션'으로 돌아간다(AM-31과 같은 계약).
    cy.get(".folder-filter.active").should("contain.text", "전체 세션");
  });

  it("5단째 폴더의 편집 행에는 '하위 폴더 추가' 버튼이 없다", () => {
    const names = [1, 2, 3, 4, 5].map((level) => `QA 단계${level} ${seq}`);
    createRoot(names[0]);
    for (let level = 1; level < names.length; level += 1) {
      createChild(names[level - 1], names[level]);
    }
    expectCount(5);
    entry(names[4]).should("have.attr", "style").and("contain", "--folder-depth: 4");

    // 4단째까지는 하위를 더 붙일 수 있다(depth 3 + 2 <= 5).
    openEdit(names[3]);
    cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').should("exist");
    closeEdit();

    // 5단째에서는 버튼 자체가 사라진다 — 비활성 버튼이 아니라 미표시가 계약이다.
    openEdit(names[4]);
    cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').should("not.exist");
    // 다른 편집 수단은 그대로 남아 있어야 한다.
    cy.get('.folder-edit-actions button[title="폴더 삭제"]').should("exist");
    // 상위 폴더 선택 목록에도 5단째는 나오지 않는다(더 내릴 자리가 없다).
    cy.get('.folder-edit-row select[aria-label="상위 폴더"] option').then((options) => {
      const labels = [...options].map((option) => option.textContent ?? "");
      expect(labels.join("\n")).not.to.contain(names[4]);
    });
  });
});
