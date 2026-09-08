// 스킬관리 '휴지통' 드로워(SkillTrashDrawer, src/components/SkillLibraryPanel.tsx:1952)의
// 빈 상태·행 표기·영구 삭제 확인의 두 갈래를 붙잡는다. AM-20은 지침관리 휴지통이 "나오지
// 않는" 것만 봤고, AM-40·AM-58·AM-87은 필터와 검색만 봤다. 스킬 휴지통을 실제로 연 시나리오는
// 아직 없다.
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const EMPTY_LIBRARY = skillLibraryFixtures("/tmp/am-trash").library([]);

function trashItem(overrides: Record<string, unknown>) {
  return {
    id: "t1",
    groupId: "g1",
    key: "alpha",
    kind: "directory",
    originalPath: "/tmp/am-trash/common/alpha",
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
    ...overrides,
  };
}

// 한 그룹으로 함께 지워진 두 항목(보관 원본 + Claude 개인 설치본)과, 혼자 지워진
// 프로젝트 링크 하나. 그룹 배지·링크 배지·위치 라벨 세 갈래가 모두 한 화면에 나온다.
const ITEMS = [
  trashItem({ id: "t1", groupId: "g1" }),
  trashItem({ id: "t2", groupId: "g1", provider: "claude", scope: "user", shared: false, originalPath: "/tmp/am-trash/home/.claude/skills/alpha" }),
  trashItem({
    id: "t3",
    groupId: "g2",
    key: "beta",
    kind: "link",
    provider: "codex",
    scope: "project",
    shared: false,
    originalPath: "/tmp/am-trash/repos/베타저장소/.codex/skills/beta",
    linkTarget: "/tmp/am-trash/common/beta",
    totalBytes: 2048,
  }),
];

function openTrash(items: unknown[]): void {
  cy.stubInvoke("get_skill_library", EMPTY_LIBRARY);
  cy.stubInvoke("list_skill_trash", {
    root: "/tmp/am-trash/.trash",
    items,
    totalBytes: items.length === 0 ? 0 : 3072,
  });
  openSkillLibrary();
  cy.get(".skill-library-toolbar").contains("button", "휴지통").click();
  cy.get(".drawer").should("contain.text", "스킬 휴지통");
}

describe("스킬관리 휴지통 드로워의 빈 상태와 영구 삭제 확인", () => {
  it("휴지통이 비어 있으면 안내만 내고 '휴지통 비우기'는 내주지 않는다", () => {
    openTrash([]);

    // 1) 0건은 목록이 아니라 문장으로 알린다.
    cy.get(".drawer").should("contain.text", "휴지통이 비어 있습니다.");
    cy.get(".skill-trash-row").should("not.exist");

    // 2) 집계는 0개·0KB로 나오고, 읽는 중 표시는 사라져 있다.
    cy.get(".drawer .section-title").contains("항목").parent().should("contain.text", "0개 · 0KB");
    cy.get(".drawer").should("not.contain.text", "휴지통을 읽고 있습니다");

    // 3) 지울 것이 없으므로 비우기 버튼 자체가 없다. 눌러서 확인 대화까지 가는 길이 없어야 한다.
    cy.get(".drawer").contains("button", "휴지통 비우기").should("not.exist");
  });

  it("항목이 있으면 그룹·링크·위치를 행마다 구분해 보여준다", () => {
    openTrash(ITEMS);

    cy.get(".skill-trash-row").should("have.length", 3);

    // 4) 보관 원본은 에이전트가 없으므로 '보관 원본'으로 적힌다.
    cy.get(".skill-trash-row").eq(0).should("contain.text", "보관 원본");
    // 5) 개인 설치본은 '에이전트 · 개인'.
    cy.get(".skill-trash-row").eq(1).should("contain.text", "Claude · 개인");
    // 6) 프로젝트 설치본은 원래 경로에서 저장소 이름을 뽑아 적는다.
    cy.get(".skill-trash-row").eq(2).should("contain.text", "Codex · 베타저장소");

    // 7) 같은 그룹으로 지워진 두 행에만 그룹 크기가 붙고, 혼자 지워진 행에는 붙지 않는다.
    cy.get(".skill-trash-row").eq(0).should("contain.text", "그룹 2개 항목");
    cy.get(".skill-trash-row").eq(1).should("contain.text", "그룹 2개 항목");
    cy.get(".skill-trash-row").eq(2).should("not.contain.text", "그룹");

    // 8) 링크 항목에만 '링크' 배지가 붙는다. 링크 삭제는 대상을 남기므로 복구 의미가 다르다.
    cy.get(".skill-trash-row").eq(2).find(".scope-pill").should("contain.text", "링크");
    cy.get(".skill-trash-row").eq(0).find(".scope-pill").should("not.contain.text", "링크");

    // 9) 행마다 복구·영구 삭제가 있고, 목록이 있을 때만 비우기가 나온다.
    cy.get(".skill-trash-row").eq(0).contains("button", "복구").should("be.enabled");
    cy.get(".drawer").contains("button", "휴지통 비우기").should("be.enabled");
  });

  it("영구 삭제 확인을 무르면 삭제가 나가지 않고, 승인해야만 나간다", () => {
    cy.intercept("POST", "**/api/invoke/purge_skill_trash", { statusCode: 200, body: 2 }).as("purge");
    openTrash(ITEMS);

    // 10) 한 항목의 '영구 삭제'는 곧바로 지우지 않고 확인 대화를 띄운다.
    cy.get(".skill-trash-row").eq(0).contains("button", "영구 삭제").click();
    cy.get(".confirm-dialog").should("contain.text", "'alpha' 휴지통 항목을 영구 삭제할까요?");
    cy.get(".confirm-dialog-warning").should("contain.text", "복구할 수 없습니다.");

    // 11) 취소하면 대화만 닫히고 요청은 나가지 않는다. 목록도 그대로다.
    cy.get(".modal-footer").contains("button", "취소").click();
    cy.get(".confirm-dialog").should("not.exist");
    cy.get(".skill-trash-row").should("have.length", 3);
    cy.get("@purge.all").should("have.length", 0);

    // 12) '휴지통 비우기'는 항목 하나가 아니라 전체를 묻는 다른 문구를 쓴다.
    cy.get(".drawer").contains("button", "휴지통 비우기").click();
    cy.get(".confirm-dialog").should("contain.text", "휴지통을 비울까요? 모든 항목이 영구 삭제됩니다.");

    // 13) 승인해야 요청이 한 번 나가고, 지운 개수가 안내로 남는다.
    cy.get(".modal-footer").contains("button", "영구 삭제").click();
    cy.wait("@purge").its("request.body").should("deep.equal", { id: null });
    cy.get(".skill-library-notice").should("contain.text", "휴지통에서 2개 항목을 영구 삭제했습니다.");
    cy.get("@purge.all").should("have.length", 1);
  });

  it("복구가 경로 점유로 일부만 되돌았으면 건너뛴 수까지 알린다", () => {
    cy.stubInvoke("restore_skill_trash", {
      groupId: "g1",
      results: [
        { id: "t1", key: "alpha", originalPath: "/tmp/am-trash/common/alpha", outcome: "restored", message: null },
        { id: "t2", key: "alpha", originalPath: "/tmp/am-trash/home/.claude/skills/alpha", outcome: "skipped", message: "경로가 사용 중" },
      ],
    });
    openTrash(ITEMS);

    // 14) 복구는 그룹 단위라 한 줄을 눌러도 결과가 여러 건이다. 전부 성공한 것처럼
    //     보이면 사용자가 사라진 설치본을 찾지 못한다.
    cy.get(".skill-trash-row").eq(0).contains("button", "복구").click();
    cy.get(".skill-library-notice")
      .should("contain.text", "'alpha' 복구: 1개 복원")
      .and("contain.text", "1개는 경로가 사용 중이라 건너뜀");
  });
});
