/// <reference types="cypress" />
// QA #40. 지침 휴지통(InstructionTrashDrawer, src/components/InstructionsView.tsx)은 같은 groupId로
// 함께 지워진 항목을 '복구' 한 번에 함께 되살린다(instruction_trash.rs 그룹 복구). 스킬 휴지통과
// 같이 (1) 그룹 항목이 2개 이상인 행에 '그룹 N개 항목' 배지를 달고, (2) 상단 안내가 복구는 그룹
// 전체를 원래 경로로 되돌린다고 말해야 한다. AM-20은 휴지통이 비었을 때 버튼이 없는 것까지만 봤다.
const MODE_KEY = "agent-manager.instruction-mode.v1";

function trashItem(overrides: Record<string, unknown>) {
  return {
    id: "i1",
    groupId: "g1",
    key: "alpha",
    kind: "directory",
    originalPath: "/tmp/am-inst/common/alpha",
    provider: null,
    scope: null,
    projectPath: null,
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

// 공통 원본 + 개인 배포 파일이 한 그룹(g1), 프로젝트 배포 파일 하나는 혼자(g2).
const ITEMS = [
  trashItem({ id: "i1", groupId: "g1" }),
  trashItem({ id: "i2", groupId: "g1", kind: "file", provider: "claude", scope: "personal", shared: false, originalPath: "/tmp/am-inst/home/.claude/CLAUDE.md" }),
  trashItem({ id: "i3", groupId: "g2", key: "beta", name: "beta", kind: "file", provider: "codex", scope: "project", projectPath: "/tmp/am-inst/repos/beta", shared: false, originalPath: "/tmp/am-inst/repos/beta/AGENTS.md", totalBytes: 2048 }),
];

function openTrash(items: unknown[]) {
  cy.stubInvoke("list_instruction_trash", { statusCode: 200, body: { root: "/tmp/am-inst/.trash", items, totalBytes: 4096 } });
  cy.visitApp();
  cy.window().its("localStorage").invoke("setItem", MODE_KEY, "manage");
  cy.openInstructionMode("manage");
  cy.get(".skill-library-toolbar-row button").contains("휴지통").click();
  return cy.get(".drawer").should("contain.text", "지침 휴지통");
}

describe("지침 휴지통의 그룹 복구 안내", () => {
  it("같은 그룹으로 지워진 두 행에만 '그룹 2개 항목' 배지가 붙는다", () => {
    openTrash(ITEMS);
    cy.get(".skill-trash-row").should("have.length", 3);
    cy.get(".skill-trash-row").eq(0).should("contain.text", "alpha").and("contain.text", "공통 원본").and("contain.text", "그룹 2개 항목");
    cy.get(".skill-trash-row").eq(1).should("contain.text", "개인 배포 파일").and("contain.text", "그룹 2개 항목");
    cy.get(".skill-trash-row").eq(2).should("contain.text", "프로젝트 배포 파일").and("not.contain.text", "그룹");
  });

  it("상단 안내가 복구는 그룹 전체를 원래 경로로 되돌린다고 알린다", () => {
    openTrash(ITEMS);
    cy.get(".drawer .prose-copy").first()
      .should("contain.text", "3개 항목")
      .and("contain.text", "그룹 전체")
      .and("contain.text", "원래 경로로 되돌리");
  });
});
