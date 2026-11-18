// 선택 지침 카드 머리의 여섯 단계 탭이 다는 표시(3단계 흐림·4단계 주의점)가 배포 상태를
// 그대로 따라가는지 본다. 표시는 instructionProcessSteps의 순수 판정이고
// (src/components/InstructionsView.tsx:828), 그 인자 둘은 useDeploymentGroups가 모은
// presentDeployments·divergentDeployments에서 나온다(InstructionsView.tsx:753, 1184).
// 핵심은 "읽을 수 있는 배포"의 경계다 — present여도 message가 붙은 배포는 갈래 넷 어디에도
// 들어가지 않으므로(InstructionsView.tsx:759) 3단계는 계속 흐려야 하고, 3단계 본문도
// "확인할 내용이 없습니다"로 남아야 한다.
function deployment(overrides: Record<string, unknown>) {
  return {
    provider: "claude",
    scope: "project",
    projectPath: "/Users/qa/alpha-ledger",
    filePath: "/Users/qa/alpha-ledger/CLAUDE.md",
    present: true,
    managed: true,
    contentDigest: "d1",
    sourceDigest: "d1",
    divergent: false,
    linkedFiles: [],
    ...overrides,
  };
}

function entry(key: string, name: string, deployments: unknown[]) {
  return {
    key,
    name,
    description: `${name} 설명`,
    directory: `/Users/qa/.agents/instructions/${key}`,
    sourceDigest: "d1",
    providers: ["claude"],
    platforms: [],
    currentPlatformSupported: true,
    currentPlatformVariant: null,
    autoSync: false,
    linkedFiles: [],
    deployments,
  };
}

// 배포가 하나도 없는 지침, 파일은 놓였지만 읽기 오류가 붙은 지침, 외부 수정이 선 지침 셋.
const EMPTY = entry("empty-guide", "배포 없는 지침", []);
const ERRORED = entry("errored-guide", "읽기 오류 지침", [
  deployment({ message: "권한이 없어 읽지 못했습니다", contentDigest: null }),
]);
const DIVERGENT = entry("divergent-guide", "외부 수정 지침", [
  deployment({ divergent: true, contentDigest: "d2" }),
]);

const LIBRARY = {
  schemaVersion: 1,
  commonRoot: "/Users/qa/.agents/instructions",
  commonRootPresent: true,
  currentPlatform: "macos",
  projects: ["/Users/qa/alpha-ledger"],
  entries: [EMPTY, ERRORED, DIVERGENT],
  deployments: [],
  issues: [],
};

function tab(no: number) {
  return cy.get('.instruction-tabs [role="tab"]').eq(no - 1);
}

function openManage(name: string) {
  cy.get(".skill-library-row").contains(name).click();
  return cy.get(".instruction-manage-card").should("be.visible");
}

describe("지침 단계 탭 표시", () => {
  beforeEach(() => {
    cy.stubInvoke("get_project_instruction_library", (req) => {
      req.reply({ statusCode: 200, body: LIBRARY });
    });
    cy.visitApp();
    cy.openInstructionMode("manage");
  });

  it("배포가 없으면 3단계는 흐리고 4단계에 주의점이 없으며, 3단계 본문도 확인할 것이 없다고 알린다", () => {
    openManage("배포 없는 지침");

    tab(3).should("have.class", "muted");
    tab(3).find(".instruction-tab-dot").should("not.exist");
    tab(4).should("not.have.class", "attention");
    tab(4).find(".instruction-tab-dot").should("not.exist");
    // 1단계는 현재 OS를 지원하므로 주의점이 서지 않는다 — 흐림·주의점이 서로 섞이지 않는지 함께 본다.
    tab(1).should("not.have.class", "attention");

    tab(3).click();
    cy.get("#instruction-step-panel").should("contain.text", "아직 배포된 파일이 없어 확인할 내용이 없습니다");
  });

  it("파일은 놓였어도 읽기 오류가 붙은 배포는 3단계를 열어 주지 않는다", () => {
    openManage("읽기 오류 지침");

    // present는 참이지만 message가 붙어 읽을 수 있는 배포가 아니다.
    tab(3).should("have.class", "muted");
    tab(4).should("not.have.class", "attention");

    tab(3).click();
    cy.get("#instruction-step-panel").should("contain.text", "아직 배포된 파일이 없어 확인할 내용이 없습니다");
  });

  it("외부 수정이 선 배포가 있으면 3단계 흐림이 걷히고 4단계에 주의점이 선다", () => {
    openManage("외부 수정 지침");

    tab(3).should("not.have.class", "muted");
    tab(4).should("have.class", "attention");
    tab(4).find(".instruction-tab-dot").should("exist");

    // 고른 지침을 배포 없는 쪽으로 바꾸면 표시도 함께 되돌아간다.
    openManage("배포 없는 지침");
    tab(3).should("have.class", "muted");
    tab(4).should("not.have.class", "attention");
  });
});
