/**
 * 지침 화면 툴바의 모드 탭과 '일괄 마이그레이션' 버튼.
 *
 * 2026-09-17 리팩토링(e229a894)이 스킬 화면과 지침 화면에 두 벌로 있던 모드 탭과 이 버튼을
 * SkillLibraryPanel의 ViewModeTabs·BulkMigrationButton 한 벌로 모았다
 * (SkillLibraryPanel.tsx:1020, :1046). 스킬 쪽 게이팅은 AM-283 계열
 * (am20260913-skill-bulk-migration-gate.cy.ts)이 보지만, 공통화된 뒤 **지침 쪽 호출부**
 * (InstructionsView.tsx:239, :274-291)가 같은 계약을 지키는지는 어느 스펙도 확인하지 않았다.
 * 기존 지침 스펙들은 1단계 지원 OS·배포 매트릭스·문서 트리만 봤고 툴바는 건드리지 않았다.
 *
 * 축은 UI 공통, 조건은 화면 전환 후 상태 잔존과 경계값(변형 필요 0건).
 * 확인하는 것:
 *  - 배지 개수는 currentPlatformSupported=false인 지침만 센다(스킬과 달리 managed 필터가 없다)
 *  - 시스템 에이전트가 없는 격리 백엔드에서는 버튼이 잠기고 그 사유를 title로 알린다
 *  - 모드 탭은 aria-pressed가 배타적으로 뒤집히고, '지침정보' 모드에는 이 버튼이 아예 없다
 *  - 변형이 필요한 지침이 없으면 배지가 사라진다
 */
type Seed = { key: string; name: string; platforms: string[]; currentPlatformSupported: boolean };

function entry(seed: Seed) {
  return {
    key: seed.key,
    name: seed.name,
    description: `${seed.name} 설명`,
    directory: `/Users/qa/.agents/instructions/${seed.key}`,
    sourceDigest: "d1",
    providers: ["claude"],
    platforms: seed.platforms,
    currentPlatformSupported: seed.currentPlatformSupported,
    currentPlatformVariant: null,
    autoSync: false,
    linkedFiles: [],
    deployments: [],
  };
}

function library(seeds: Seed[]) {
  return {
    schemaVersion: 1,
    commonRoot: "/Users/qa/.agents/instructions",
    commonRootPresent: true,
    currentPlatform: "macos",
    projects: ["/Users/qa/alpha-ledger"],
    entries: seeds.map(entry),
    deployments: [],
    issues: [],
  };
}

const PORTABLE: Seed = { key: "portable-guide", name: "이식 지침", platforms: [], currentPlatformSupported: true };
const WINDOWS_ONLY: Seed = { key: "windows-guide", name: "윈도우 전용 지침", platforms: ["windows"], currentPlatformSupported: false };
const LINUX_ONLY: Seed = { key: "linux-guide", name: "리눅스 전용 지침", platforms: ["linux"], currentPlatformSupported: false };

const NEEDS_AGENT = "연결된 시스템 에이전트를 설정하세요";

function migrateButton() {
  return cy.get(".skill-mode-toolbar .skill-transfer-buttons button");
}

describe("지침 화면 툴바의 모드 탭과 일괄 마이그레이션 게이팅", () => {
  it("배지는 현재 OS 미지원 지침만 세고 버튼은 에이전트 없음 사유로 잠긴다", () => {
    cy.stubInvoke("get_project_instruction_library", {
      statusCode: 200,
      body: library([PORTABLE, WINDOWS_ONLY, LINUX_ONLY]),
    });
    cy.visitApp();

    cy.openInstructionMode("manage");

    // 목록 세 건 중 현재 OS(macos)를 지원하지 않는 둘만 개수에 들어간다.
    cy.get(".skill-library-row").should("have.length", 3);
    migrateButton().should("contain.text", "일괄 마이그레이션");
    migrateButton().find("small").should("have.text", "2");
    migrateButton().should("be.disabled").and("have.attr", "title", NEEDS_AGENT);
  });

  it("모드 탭은 배타적으로 뒤집히고 지침정보 모드에는 마이그레이션 버튼이 없다", () => {
    cy.stubInvoke("get_project_instruction_library", {
      statusCode: 200,
      body: library([PORTABLE, WINDOWS_ONLY, LINUX_ONLY]),
    });
    cy.visitApp();

    cy.openInstructionMode("manage");
    cy.get(".skill-mode-tabs[role=group]").should("have.attr", "aria-label", "지침 화면 모드");
    cy.get(".skill-mode-tabs button").eq(1).should("have.class", "active");
    cy.get(".skill-mode-tabs button").eq(0).should("have.attr", "aria-pressed", "false").and("not.have.class", "active");

    // 정보 모드로 돌아오면 눌린 탭이 뒤집히고 툴바에는 탭 줄만 남는다.
    cy.openInstructionMode("info");
    cy.get(".skill-mode-tabs button").eq(1).should("have.attr", "aria-pressed", "false").and("not.have.class", "active");
    cy.get(".skill-mode-toolbar .skill-transfer-buttons").should("not.exist");

    // 다시 관리 모드로 오면 배지 개수가 그대로 돌아온다.
    cy.openInstructionMode("manage");
    migrateButton().find("small").should("have.text", "2");
  });

  it("현재 OS 변형이 필요한 지침이 없으면 배지가 서지 않는다", () => {
    cy.stubInvoke("get_project_instruction_library", {
      statusCode: 200,
      body: library([PORTABLE, { ...WINDOWS_ONLY, platforms: ["windows", "macos"], currentPlatformSupported: true }]),
    });
    cy.visitApp();

    cy.openInstructionMode("manage");
    cy.get(".skill-library-row").should("have.length", 2);
    migrateButton().should("be.disabled");
    migrateButton().find("small").should("not.exist");
  });
});
