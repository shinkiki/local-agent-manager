// 지침정보 탭 필터 축 세 줄(위치·공급자·보관)의 개수 배지가 "자기 축은 빼고 나머지 필터만
// 적용한" 수인지, 0건 칩도 눌러서 그 축으로 옮겨 갈 수 있는지 본다. 개수는
// FilterAxisBar가 countWhere로 받고(src/components/FilterAxisBar.tsx:130), 그 함수는
// filterMatcher.counter가 자기 축을 ignore로 빼고 만든다(src/components/FilterAxisBar.tsx:84).
// 지침정보 탭의 판정 표는 src/components/InstructionsView.tsx:2012, 축 셋은 2024줄이다.
const PROJECT_A = "/Users/qa/am-alpha-guide";
const PROJECT_B = "/Users/qa/am-bravo-guide";

const FILE_NAMES: Record<string, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  antigravity: "GEMINI.md",
};

function deployment(provider: string, projectPath: string | null, managed: boolean) {
  const root = projectPath ?? "/Users/qa";
  return {
    provider,
    scope: projectPath === null ? "personal" : "project",
    projectPath,
    filePath: `${root}/${FILE_NAMES[provider]}`,
    present: true,
    managed,
    contentDigest: "d1",
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

// 여섯 파일을 위치 2 × 공급자 3 × 보관 2 축에 흩어 둔다. 보관 일치는 같은 공급자·위치를
// 관리하는 원본이 있을 때만 붙으므로(archivedInstructionMatch, InstructionsView.tsx:1978)
// 개인/claude와 프로젝트A/claude 두 자리에만 원본을 둔다.
const ARCHIVED = [deployment("claude", null, true), deployment("claude", PROJECT_A, true)];
const DEPLOYMENTS = [
  deployment("claude", null, true), //        개인 · Claude · 보관 일치
  deployment("codex", null, false), //        개인 · Codex · 미보관
  deployment("claude", PROJECT_A, true), //   프로젝트A · Claude · 보관 일치
  deployment("antigravity", PROJECT_A, false), // 프로젝트A · Antigravity · 미보관
  deployment("codex", PROJECT_B, false), //   프로젝트B · Codex · 미보관
  deployment("claude", PROJECT_B, false), //  프로젝트B · Claude · 미보관
];

const LIBRARY = {
  schemaVersion: 1,
  commonRoot: "/Users/qa/.agents/instructions",
  commonRootPresent: true,
  currentPlatform: "macos",
  projects: [PROJECT_A, PROJECT_B],
  entries: [entry("common-guide", "공통 지침", ARCHIVED)],
  deployments: DEPLOYMENTS,
  issues: [],
};

const LOCATION = "지침 위치 필터";
const PROVIDER = "지침 공급자 필터";
const STATE = "지침 보관 상태 필터";

function chip(group: string, label: string) {
  return cy.get(`[role="group"][aria-label="${group}"] button`).contains(label);
}

/** 한 축의 칩 배지를 라벨 순서대로 확인한다. */
function expectCounts(group: string, expected: [string, string][]) {
  for (const [label, count] of expected) {
    chip(group, label).find("small").should("have.text", count);
  }
}

function openInfoTab() {
  cy.openView("instructions");
  cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(0).click();
  return cy.get(".skill-library-filterbar").should("be.visible");
}

describe("지침정보 필터 축의 교차 개수와 0건 칩", () => {
  beforeEach(() => {
    cy.stubInvoke("get_project_instruction_library", { statusCode: 200, body: LIBRARY });
    cy.visitApp();
  });

  it("세 축이 모두 '전체'면 배지가 전체 표본을 그 축으로만 가른 수를 보인다", () => {
    openInfoTab();

    // 1) 위치 축: 개인 2건, 프로젝트 4건.
    expectCounts(LOCATION, [["전체", "6"], ["개인", "2"], ["프로젝트", "4"]]);

    // 2) 공급자 축: Claude 3, Codex 2, Antigravity 1.
    expectCounts(PROVIDER, [["전체", "6"], ["Claude", "3"], ["Codex", "2"], ["Antigravity", "1"]]);

    // 3) 보관 축: 원본과 맞는 두 자리만 '보관 일치'다.
    expectCounts(STATE, [["전체", "6"], ["보관 일치", "2"], ["미보관", "4"]]);

    // 4) 목록에는 위치 두 줄이 서고 파일 여섯 개가 모두 걸린다.
    cy.get(".instruction-info-layout").should("exist");
  });

  it("한 축을 고르면 다른 축 배지만 좁아지고 고른 축의 배지는 그대로다", () => {
    openInfoTab();
    chip(LOCATION, "개인").click().should("have.attr", "aria-pressed", "true");

    // 5) 고른 축은 자기 자신을 빼고 세므로 개인/프로젝트 배지가 그대로 남는다 —
    //    좁아진 수를 보이면 '프로젝트'로 돌아갈 때 몇 건이 되는지 알 수 없다.
    expectCounts(LOCATION, [["전체", "6"], ["개인", "2"], ["프로젝트", "4"]]);

    // 6) 나머지 두 축은 개인 2건 안에서만 센다. Antigravity는 개인에 없어 0이 된다.
    expectCounts(PROVIDER, [["전체", "2"], ["Claude", "1"], ["Codex", "1"], ["Antigravity", "0"]]);
    expectCounts(STATE, [["전체", "2"], ["보관 일치", "1"], ["미보관", "1"]]);

    // 7) 축을 하나 더 겹치면 남은 축이 다시 좁아진다. 공급자를 Claude로 좁히면 개인·Claude
    //    한 건만 남고 그 한 건은 보관 일치다.
    chip(PROVIDER, "Claude").click();
    expectCounts(STATE, [["전체", "1"], ["보관 일치", "1"], ["미보관", "0"]]);
    expectCounts(LOCATION, [["전체", "3"], ["개인", "1"], ["프로젝트", "2"]]);
  });

  it("0건 칩도 눌려서 그 축으로 옮겨 가고, 빈 결과는 안내 문장으로 알린다", () => {
    openInfoTab();
    chip(LOCATION, "개인").click();

    // 8) 배지가 0이어도 잠기지 않는다. 지침정보 축은 칩 줄의 기본 잠금 규칙을 끄고 있어
    //    (InstructionsView.tsx:2031) 0건 칩이 그 축으로 건너가는 길로 남는다.
    chip(PROVIDER, "Antigravity").should("not.be.disabled").click()
      .should("have.attr", "aria-pressed", "true");

    // 9) 개인 + Antigravity는 맞는 파일이 없으므로 트리 대신 안내가 선다.
    cy.get(".instruction-info-layout").should("not.exist");
    cy.contains("조건에 맞는 지침 파일이 없습니다").should("be.visible");
    cy.contains("필터를 넓히거나 지침관리 탭에서 지침을 게시하세요.").should("be.visible");

    // 10) 빈 결과에서도 축 줄은 남아 있고, 위치 축 배지가 "여기로 가면 1건"을 알려 준다.
    expectCounts(LOCATION, [["전체", "1"], ["개인", "0"], ["프로젝트", "1"]]);

    // 11) 그 길을 따라가면 목록이 되살아난다.
    chip(LOCATION, "프로젝트").click();
    cy.get(".instruction-info-layout").should("exist");
    cy.contains("조건에 맞는 지침 파일이 없습니다").should("not.exist");
  });
});
