// 겹쳐 뜬 UI에서 Esc가 "맨 위 한 겹"만 닫는지 본다(src/components/Shared.tsx:310
// useEscapeToClose, src/lib/escapeLayers.ts). 스킬 휴지통은 드로워(아래 겹) 위에 확인
// 대화(위 겹)를 올리는 몇 안 되는 실제 흐름이라 겹침 순서를 화면에서 잡을 수 있다.
//
// 기존 시나리오는 모두 한 겹짜리였다 — AM-60/AM-138은 드로워·확인 대화를 각각 Esc로
// 닫는 것만, AM-163/AM-165/AM-289는 산출물 드로워 하나의 Esc만 봤다. 두 겹이 함께 떠
// 있을 때 Esc 한 번이 아래 겹까지 걷어내지 않는지, 위 겹을 닫은 뒤 스택이 제대로
// 되감겨 다음 Esc가 아래 겹을 닫는지는 확인된 적이 없다. 단위 테스트
// (src/lib/escapeLayers.test.mjs)는 스택 자료구조만 보고 실제 화면 등록/해제는 못 본다.
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const EMPTY_LIBRARY = skillLibraryFixtures("/tmp/am-esc").library([]);

const ITEMS = [
  {
    id: "t1",
    groupId: "g1",
    key: "alpha",
    kind: "directory",
    originalPath: "/tmp/am-esc/common/alpha",
    linkTarget: null,
    provider: null,
    scope: null,
    shared: true,
    deletedBy: "test",
    deletedAtMs: 1_700_000_000_000,
    contentDigest: "d1",
    fileCount: 1,
    totalBytes: 1024,
    name: "alpha",
    description: "alpha 설명",
  },
];

/** Esc는 창(window) 버블 단계에서 받으므로 본문에 던져도 맨 위 겹에 닿아야 한다. */
function pressEscape(): void {
  cy.get("body").type("{esc}");
}

function openTrashDrawer(): void {
  cy.stubInvoke("get_skill_library", EMPTY_LIBRARY);
  cy.stubInvoke("list_skill_trash", { root: "/tmp/am-esc/.trash", items: ITEMS, totalBytes: 1024 });
  openSkillLibrary();
  cy.get(".skill-library-toolbar").contains("button", "휴지통").click();
  cy.get(".drawer").should("contain.text", "스킬 휴지통");
}

describe("겹쳐 뜬 드로워와 확인 대화에서 Esc가 맨 위 한 겹만 닫는다", () => {
  beforeEach(() => {
    cy.stubInvoke("purge_skill_trash", { statusCode: 200, body: 1 }).as("purge");
  });

  it("확인 대화가 떠 있으면 Esc가 대화만 걷어내고 드로워는 남긴다", () => {
    openTrashDrawer();

    // 1) 아래 겹(드로워) 위에 위 겹(확인 대화)을 올린다. 두 겹이 동시에 떠 있다.
    cy.get(".skill-trash-row").eq(0).contains("button", "영구 삭제").click();
    cy.get(".confirm-dialog").should("be.visible");
    // 위 겹이 덮고 있어 Cypress는 아래 겹을 '보이지 않음'으로 본다. 겹침 자체가
    // 전제이므로 아래 겹은 존재로 확인한다.
    cy.get(".drawer").should("exist");

    // 2) Esc 한 번은 위 겹만 닫는다. 드로워까지 함께 닫히면 사용자는 확인을 무르려다
    //    보고 있던 목록을 잃는다.
    pressEscape();
    cy.get(".confirm-dialog").should("not.exist");
    cy.get(".drawer").should("be.visible").and("contain.text", "스킬 휴지통");

    // 3) Esc로 무른 것은 취소와 같아야 한다 — 삭제 요청이 나가면 안 된다.
    cy.get("@purge.all").should("have.length", 0);
    cy.get(".skill-trash-row").should("have.length", 1);
  });

  it("위 겹을 닫은 뒤 다음 Esc가 아래 겹을 닫고, 다시 열어도 순서가 유지된다", () => {
    openTrashDrawer();

    cy.get(".drawer").contains("button", "휴지통 비우기").click();
    cy.get(".confirm-dialog").should("contain.text", "휴지통을 비울까요?");

    // 4) 첫 Esc는 대화, 두 번째 Esc는 드로워. 한 번에 둘 다 사라지거나, 대화를 닫은 뒤
    //    드로워가 Esc를 못 받으면(스택이 되감기지 않으면) 여기서 걸린다.
    pressEscape();
    cy.get(".confirm-dialog").should("not.exist");
    pressEscape();
    cy.get(".drawer").should("not.exist");
    cy.get("@purge.all").should("have.length", 0);

    // 5) 겹을 닫을 때 스택에서 빠지지 않고 남으면, 다시 연 드로워의 Esc가 유령 겹에
    //    먹혀 듣지 않는다. 같은 흐름을 한 번 더 돌려 확인한다.
    cy.get(".skill-library-toolbar").contains("button", "휴지통").click();
    cy.get(".drawer").should("contain.text", "스킬 휴지통");
    cy.get(".skill-trash-row").eq(0).contains("button", "영구 삭제").click();
    cy.get(".confirm-dialog").should("be.visible");
    pressEscape();
    cy.get(".confirm-dialog").should("not.exist");
    cy.get(".drawer").should("be.visible");
    pressEscape();
    cy.get(".drawer").should("not.exist");

    // 6) 두 겹이 다 걷혔으면 목록 화면은 조작할 수 있는 상태로 돌아와 있다.
    cy.get(".skill-library-toolbar").contains("button", "휴지통").should("be.enabled");
    cy.get("@purge.all").should("have.length", 0);
  });

  it("겹이 하나도 없을 때의 Esc는 아무것도 닫지 않고 지나간다", () => {
    openTrashDrawer();
    pressEscape();
    cy.get(".drawer").should("not.exist");

    // 7) 남은 겹이 없는 상태의 Esc는 화면을 바꾸지 않는다. 리스너를 떼지 못해 마지막
    //    콜백이 다시 불리면 드로워가 혼자 다시 열리거나 오류로 떨어진다.
    pressEscape();
    pressEscape();
    cy.get(".drawer").should("not.exist");
    cy.get(".skill-library-list, .empty-state").should("exist");
    cy.get(".error-banner").should("not.exist");
  });
});
