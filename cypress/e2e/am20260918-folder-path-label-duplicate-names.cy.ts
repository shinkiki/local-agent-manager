/// <reference types="cypress" />
// 정리폴더의 '경로 문구'(folderPathLabel)가 같은 이름이 여러 단계에 있을 때 실제로 그 둘을
// 갈라 주는지 화면에서 본다. 기존 폴더 시나리오는 후보 '목록에 들어가는지'만 봤다.
//  - AM-159(am20260907-session-folder-tree-depth): 5단째 잎이 후보에서 빠지는 것.
//  - AM-332: 생성 폼의 상위 select에 들어가는 후보 범위.
//  - AM-350(am20260916-session-folder-parent-subtree-height): 하위 트리 높이가 후보를 자르는 것.
// 셋 다 후보의 '개수·유무'만 봤고, 후보를 고를 때 사용자가 읽는 '문구'가 서로 다른 폴더를
// 다른 문구로 보여 주는지는 본 적이 없다. 이름은 유일하지 않으므로, 같은 이름이 두 단계에
// 있으면 경로가 붙지 않는 순간 사용자는 select에서 어느 쪽을 고르는지 알 수 없다.
// 2026-09-18 개발선 커밋 321a2622(폴더 사슬이 어느 색인을 걷는지 질의 안으로 들임)가
// ancestorChain의 인자를 색인 Map에서 폴더 목록으로 바꿨고, folderPathLabel이 그 유일한
// 호출부다. 색인 선택이 바뀐 직후라 이 경로 문구를 대상으로 골랐다.
// 관련 코드: src/lib/sessionFolderTree.ts:202(ancestorChain)·:94(rawIndexById),
//   src/lib/sessionFolders.ts:138(folderPathLabel),
//   src/components/SessionFolderSidebar.tsx:420(FolderParentOptions)·:477(생성 폼 select)
//   ·:562(편집 행 select)·:633(폴더 행 title).

const CREATE_SELECT = ".folder-create-form select";
const EDIT_SELECT = '.folder-edit-row select[aria-label="상위 폴더"]';

/** 지금 열린 select의 항목 문구를 순서대로 읽는다. */
function optionLabels(selector: string): Cypress.Chainable<string[]> {
  return cy.get(`${selector} option`).then((options) => (
    [...options].map((option) => (option.textContent ?? "").trim())
  ));
}

let seq = 0;

describe("정리폴더 상위 선택 문구가 같은 이름의 두 폴더를 경로로 가른다", () => {
  beforeEach(() => {
    cy.visitApp();
    seq += 1;
    cy.openView("sessions");
    cy.get("aside.session-folders").should("be.visible");
  });

  it("같은 이름이 최상위와 하위에 하나씩 있으면 하위 쪽만 상위 경로가 앞에 붙는다", () => {
    const work = `QA경로 업무 ${seq}`;
    const dup = `QA경로 검토 ${seq}`;

    // 1) 최상위 '업무' 밑에 '검토'를 만들고, 같은 이름의 '검토'를 최상위에도 하나 더 만든다.
    //    폴더 이름은 유일하지 않으므로 이 상태 자체가 정상 입력이다.
    cy.createFolder(work);
    cy.openFolderEdit(work);
    cy.get('.folder-edit-actions button[title="하위 폴더 추가"]').click();
    cy.folderNameInput().type(dup);
    cy.folderSubmitButton().click();
    cy.get(".folder-entry-main strong").contains(dup).should("exist");
    cy.createFolder(dup);
    // 같은 이름의 폴더가 정말 둘 생겼다 — 이 전제가 깨지면 시나리오가 성립하지 않는다.
    cy.get(".folder-entry-main strong").filter((_, element) => (element.textContent ?? "").trim() === dup)
      .should("have.length", 2);

    // 2) 새 폴더 생성 폼의 상위 후보. 최상위 '검토'는 이름만, 하위 '검토'는 '업무 / 검토'로
    //    나와야 한다. 경로가 붙지 않으면 두 항목이 같은 문구가 되어 고를 수 없다.
    cy.folderAddButton().click();
    optionLabels(CREATE_SELECT).then((labels) => {
      const mine = labels.filter((label) => label.includes(dup) || label.includes(work));
      expect(mine, "생성 폼 후보 문구").to.include.members([work, dup, `${work} / ${dup}`]);
      expect(new Set(mine).size, "생성 폼 후보에 같은 문구가 겹치지 않는다").to.equal(mine.length);
    });
    cy.contains(".folder-create-form button", "취소").click();
    cy.get(".folder-create-form").should("not.exist");

    // 3) 편집 행의 상위 후보도 같은 문구 규칙을 쓴다. 최상위 '검토'를 편집하면 자기 자신은
    //    빠지고, 이름이 같은 하위 '검토'는 경로가 붙은 채 남아 둘을 헷갈리지 않는다.
    cy.get(`.session-folders button[aria-label="${dup} 폴더 편집"]`).last().click({ force: true });
    cy.get(EDIT_SELECT).should("exist");
    optionLabels(EDIT_SELECT).then((labels) => {
      const mine = labels.filter((label) => label.includes(dup) || label.includes(work));
      expect(mine, "편집 행 후보 문구").to.include.members([work, `${work} / ${dup}`]);
      expect(mine, "자기 자신은 후보에서 빠진다").to.not.include(dup);
      expect(new Set(mine).size, "편집 행 후보에 같은 문구가 겹치지 않는다").to.equal(mine.length);
    });
    cy.get('.folder-edit-row button[aria-label="폴더 편집 닫기"]').click();

    // 4) 폴더 행의 툴팁도 같은 경로 문구를 쓴다 — 목록에서 이름만 보이는 두 '검토'를
    //    가리켜야 어느 쪽인지 알 수 있다.
    cy.get(".folder-entry-main").filter((_, element) => (
      (element.querySelector("strong")?.textContent ?? "").trim() === dup
    )).then(($entries) => {
      const titles = [...$entries].map((element) => element.getAttribute("title") ?? "");
      expect(titles.some((title) => title.startsWith(`${work} / ${dup} ·`)), "하위 '검토' 툴팁에 상위 경로가 붙는다").to.equal(true);
      expect(titles.some((title) => title.startsWith(`${dup} ·`)), "최상위 '검토' 툴팁은 이름만이다").to.equal(true);
    });
    cy.screenshot("am20260918-folder-path-label-duplicate-names");
  });
});
