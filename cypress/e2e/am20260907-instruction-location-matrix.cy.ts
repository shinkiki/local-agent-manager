// 지침 배포 매트릭스(2단계 "위치별 배포")의 위치 행 보임 규칙. 기본은 개인 설정과 이미
// 배포된 프로젝트만 보이고, 나머지는 검색하거나 펼쳐야 나온다. 프로젝트가 6곳 이상일 때만
// 검색칸이 생기고, 검색 중에는 "더 보기"가 사라지며, 고른 지침을 바꾸면 보임 상태가 처음으로
// 되돌아간다(useDeploymentLocationRows, src/components/InstructionsView.tsx:492).
const DEPLOYED = "/Users/qa/am-deployed-project";
const PROJECTS = [
  DEPLOYED,
  "/Users/qa/alpha-ledger",
  "/Users/qa/bravo-console",
  "/Users/qa/charlie-portal",
  "/Users/qa/delta-gateway",
  "/Users/qa/echo-registry",
  "/Users/qa/foxtrot-runner",
  "/Users/qa/golf-archive",
];

function deployment(projectPath: string, scope: string, managed: boolean) {
  return {
    provider: "claude",
    scope,
    projectPath,
    filePath: `${projectPath}/CLAUDE.md`,
    present: managed,
    managed,
    contentDigest: managed ? "d1" : null,
    sourceDigest: "d1",
    divergent: false,
    linkedFiles: [],
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

const LIBRARY = {
  schemaVersion: 1,
  commonRoot: "/Users/qa/.agents/instructions",
  commonRootPresent: true,
  currentPlatform: "macos",
  projects: PROJECTS,
  entries: [
    entry("first-guide", "첫 지침", [deployment(DEPLOYED, "project", true)]),
    entry("second-guide", "둘째 지침", []),
  ],
  deployments: [deployment(DEPLOYED, "project", true)],
  issues: [],
};

function openMatrix(instructionName: string) {
  cy.openView("instructions");
  cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(1).click();
  cy.get(".skill-library-row").contains(instructionName).click();
  cy.get('.instruction-tabs [role="tab"]').eq(1).click().should("have.attr", "aria-selected", "true");
  return cy.get(".skill-location-matrix").should("be.visible");
}

function locationLabels() {
  return cy.get(".skill-location-matrix tbody tr td:first-child");
}

describe("지침 배포 매트릭스의 위치 행 보임 규칙", () => {
  beforeEach(() => {
    cy.stubInvoke("get_project_instruction_library", { statusCode: 200, body: LIBRARY });
    cy.visitApp();
  });

  it("기본은 개인 설정과 배포된 곳만 보이고 나머지는 '더 보기'로 펼쳐진다", () => {
    openMatrix("첫 지침");

    // 1) 기본 보임: 개인 설정 + 이미 배포된 프로젝트 한 곳.
    locationLabels().should("have.length", 2);
    locationLabels().eq(0).should("have.text", "개인 설정");
    locationLabels().eq(1).should("have.attr", "title", DEPLOYED);

    // 2) 나머지 7곳은 접혀 있고 그 수를 버튼이 알린다.
    cy.get(".instruction-location-toolbar button").contains("프로젝트 7곳 더 보기").click();

    // 3) 펼치면 개인 설정 + 프로젝트 8곳이 모두 나오고, 되접는 버튼으로 바뀐다.
    locationLabels().should("have.length", 9);
    cy.get(".instruction-location-toolbar button").contains("더 보기").should("not.exist");
    cy.get(".instruction-location-toolbar button").contains("배포된 곳만 보기").click();
    locationLabels().should("have.length", 2);
  });

  it("검색칸은 접힌 곳을 꺼내고, 검색 중에는 '더 보기'가 사라진다", () => {
    openMatrix("첫 지침");
    cy.get(".instruction-location-toolbar input[type=search]")
      .should("have.attr", "placeholder", "프로젝트 검색")
      .as("search");

    // 4) 접혀 있던 프로젝트도 검색으로 꺼내진다. 개인 설정은 검색과 무관하게 남는다.
    cy.get("@search").type("echo");
    locationLabels().should("have.length", 2);
    locationLabels().eq(0).should("have.text", "개인 설정");
    locationLabels().eq(1).should("have.attr", "title", "/Users/qa/echo-registry");

    // 5) 검색 중에는 접힌 수를 세지 않으므로 '더 보기'가 없다.
    cy.get(".instruction-location-toolbar button").should("not.exist");

    // 6) 맞는 것이 없으면 개인 설정만 남고 그 사실을 문장으로 알린다.
    cy.get("@search").clear().type("존재하지-않는-프로젝트");
    locationLabels().should("have.length", 1);
    cy.get("#instruction-step-panel").contains("검색과 맞는 프로젝트가 없습니다.").should("be.visible");

    // 7) 검색을 비우면 기본 보임으로 돌아온다.
    cy.get("@search").clear();
    locationLabels().should("have.length", 2);
    cy.get(".instruction-location-toolbar button").contains("프로젝트 7곳 더 보기").should("be.visible");
  });

  it("새로 고침은 보던 2단계와 매트릭스를 그대로 두고, 지침을 바꾸면 1단계로 가며 검색·펼침도 초기화된다", () => {
    cy.intercept("POST", "**/api/invoke/get_project_instruction_library", { statusCode: 200, body: LIBRARY }).as("library");
    openMatrix("첫 지침");
    cy.get(".instruction-location-toolbar button").contains("프로젝트 7곳 더 보기").click();
    locationLabels().should("have.length", 9);

    // 8) 목록 툴바의 '새로 고침'은 같은 지침을 다시 읽을 뿐이므로(QA #37) 진행 단계와 매트릭스가
    //    그대로 남아야 한다. 예전에는 초기화 효과가 entry.platforms·entry.providers 배열 신원에
    //    걸려 있어 값이 같아도 다시 읽으면 1단계로 튀었다. 배포 체크를 켜고 끄는 조작도 끝에서
    //    같은 refresh를 부르므로 같은 경로다.
    cy.get(".skill-library-toolbar-row button").contains("새로 고침").click();
    cy.wait("@library");
    cy.get('.instruction-tabs [role="tab"]').eq(1).should("have.attr", "aria-selected", "true");
    cy.get(".skill-location-matrix").should("exist");

    // 9) 펼침 상태도 살아 있어 9행이 그대로 보인다.
    locationLabels().should("have.length", 9);

    // 10) 다른 지침으로 옮기면 1단계로 가고 보임 상태도 초기화된다. 이 지침은 배포된 곳이
    //     없어 개인 설정 한 행만 남고 접힌 8곳을 알린다.
    cy.get(".skill-library-row").contains("둘째 지침").click();
    cy.get('.instruction-tabs [role="tab"]').eq(1).click();
    cy.get(".instruction-location-toolbar input[type=search]").should("have.value", "");
    locationLabels().should("have.length", 1);
    cy.get(".instruction-location-toolbar button").contains("프로젝트 8곳 더 보기").should("be.visible");
  });
});
