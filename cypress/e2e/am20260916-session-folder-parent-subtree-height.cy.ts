/// <reference types="cypress" />
// 세션 정리폴더 '편집 행'의 상위 폴더 후보가 '옮길 폴더의 하위 트리 높이'까지 셈에 넣는지 본다.
// 기존 폴더 시나리오는 후보 목록을 두 번 건드렸지만 둘 다 높이 0인 잎만 봤다.
//  - AM-159(am20260907-session-folder-tree-depth): 5단째 '잎'이 후보에서 빠지는 것까지.
//  - AM-332(생성 폼의 상위 select): 새로 만드는 폴더는 늘 잎이라 높이가 0이다.
// 아직 본 적 없는 계약은 "하위 트리를 달고 있는 폴더는 같은 후보라도 더 일찍 막힌다"이다.
// folderParentOptions는 자기 하위 트리(순환)를 뺀 뒤 fitsUnderParent(후보 단계, 내 높이)로
// 한 번 더 거른다 — `parentDepth + subtreeHeight + 2 <= 5`(src/lib/sessionFolders.ts:38·:151).
// 그래서 높이 2짜리 폴더에게 3단째(depth 2) 후보는 6이 되어 사라지지만, 같은 후보가 잎에게는
// 4로 남는다. 이 차이를 한 화면에서 나란히 본다.
// 2026-09-16 개발선 커밋 decd2dcb(하위 트리 접어 올리기를 foldUpward 한 연산으로 모음)가
// subtreeHeights 순회를 옮겼고, 그 높이를 읽는 유일한 화면 경로가 이 select라 대상으로 골랐다.
// 관련 코드: src/lib/sessionFolderTree.ts:139(foldUpward)·:224(subtreeHeight)·:244,
//   src/lib/sessionFolders.ts:38(fitsUnderParent)·:147(folderParentOptions),
//   src/components/SessionsView.tsx:1418(editingParentOptions)·:1677(상위 폴더 select).

const PARENT_SELECT = '.folder-edit-row select[aria-label="상위 폴더"]';

function createChild(parent: string, name: string): void {
  cy.openFolderEdit(parent);
  cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').click();
  cy.folderNameInput().type(name);
  cy.folderSubmitButton().click();
  cy.get(".folder-entry-main strong").contains(name).should("exist");
}

/** 지금 열린 편집 행의 상위 후보 라벨을 한 덩어리로 읽는다. 라벨은 경로가 붙은 이름이다. */
function parentOptionLabels(): Cypress.Chainable<string> {
  return cy.get(`${PARENT_SELECT} option`).then((options) => (
    [...options].map((option) => option.textContent ?? "").join("\n")
  ));
}

function expectDepth(name: string, depth: number): void {
  cy.folderEntry(name).should("have.attr", "style").and("contain", `--folder-depth: ${depth}`);
}

let seq = 0;

describe("세션 정리폴더 상위 후보가 옮길 폴더의 하위 트리 높이를 반영한다", () => {
  beforeEach(() => {
    cy.visitApp();
    seq += 1;
    cy.openView("sessions");
  });

  it("높이 2짜리 폴더에게는 3단째 후보가 사라지고, 같은 후보가 잎에게는 남는다", () => {
    // 옮길 쪽: 3단 사슬(높이 2). 받을 쪽: 3단 사슬(후보 단계 0·1·2).
    const moving = [1, 2, 3].map((level) => `QA 높이${level} ${seq}`);
    const host = [1, 2, 3].map((level) => `QA 자리${level} ${seq}`);
    cy.createFolder(moving[0]);
    createChild(moving[0], moving[1]);
    createChild(moving[1], moving[2]);
    cy.createFolder(host[0]);
    createChild(host[0], host[1]);
    createChild(host[1], host[2]);

    // 1) 높이 2인 뿌리를 편집한다. 자기 자신과 하위 트리는 순환이라 후보에서 빠지고,
    //    받을 쪽은 0+2+2=4, 1+2+2=5까지만 남고 2+2+2=6인 3단째가 사라진다.
    cy.openFolderEdit(moving[0]);
    parentOptionLabels().then((labels) => {
      expect(labels, "자기 자신과 하위 트리는 순환이라 후보가 아니다").not.to.contain(moving[0]);
      expect(labels).not.to.contain(moving[1]);
      expect(labels).not.to.contain(moving[2]);
      expect(labels, "0+2+2=4").to.contain(host[0]);
      expect(labels, "1+2+2=5").to.contain(host[1]);
      expect(labels, "2+2+2=6이라 한도를 넘는다").not.to.contain(host[2]);
    });
    cy.closeFolderEdit();

    // 2) 같은 사슬의 잎(높이 0)에서는 방금 사라졌던 3단째 후보가 그대로 보인다 —
    //    후보를 가른 것이 '후보의 단계'가 아니라 '옮길 폴더의 높이'였음을 여기서 가른다.
    cy.openFolderEdit(moving[2]);
    parentOptionLabels().then((labels) => {
      expect(labels, "2+0+2=4라 같은 후보가 잎에게는 남는다").to.contain(host[2]);
      expect(labels, "잎 자신만 빠진다").not.to.contain(moving[2]);
      expect(labels, "자기 조상은 후보로 남는다").to.contain(moving[0]);
    });
    cy.closeFolderEdit();
  });

  it("후보로 남은 2단째로 옮기면 하위 트리째 따라 내려가 마지막 단이 5단째가 된다", () => {
    const moving = [1, 2, 3].map((level) => `QA 이동${level} ${seq}`);
    const host = [1, 2].map((level) => `QA 대상${level} ${seq}`);
    cy.createFolder(moving[0]);
    createChild(moving[0], moving[1]);
    createChild(moving[1], moving[2]);
    cy.createFolder(host[0]);
    createChild(host[0], host[1]);
    expectDepth(moving[0], 0);
    expectDepth(moving[2], 2);

    // 후보로 남아 있는 2단째(depth 1)를 골라 저장한다.
    cy.openFolderEdit(moving[0]);
    cy.get(PARENT_SELECT).select(`${host[0]} / ${host[1]}`);
    cy.get('.folder-edit-row button[aria-label="이름·색상 저장"]').click();
    cy.get(".folder-edit-row").should("not.exist");

    // 하위 트리가 통째로 두 단 내려간다. 마지막 단은 depth 4 — 1부터 세면 한도인 5단째다.
    expectDepth(moving[0], 2);
    expectDepth(moving[1], 3);
    expectDepth(moving[2], 4);

    // 한도에 닿았으므로 그 잎에는 '하위 폴더 추가'가 없고, 후보 목록에도 자리가 남지 않는다.
    cy.openFolderEdit(moving[2]);
    cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').should("not.exist");
    parentOptionLabels().then((labels) => {
      expect(labels, "한도에 닿은 자신은 후보가 아니다").not.to.contain(moving[2]);
      expect(labels, "한 단 위는 여전히 자기 조상이라 후보다").to.contain(moving[1]);
    });
    cy.closeFolderEdit();
  });
});
