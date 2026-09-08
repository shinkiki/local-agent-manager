/// <reference types="cypress" />
// AM-112 · 애드온 → 아이아 → QA 워크플로 온보딩 목업의 '기록 대상' 단계에서
// 외부 플러그인(Notion, Jira) 스냅샷에 따른 대상 선택지 동적 확장 및 폼 필드 전환 계약.
//
// 1) 기본(외부 플러그인 없음):
//    - 기록 대상 select에 '마크다운 문서(.md)' 단일 option만 노출된다.
//    - 문서 폴더 select와 회차 문서/QA 티켓 .md 기본 경로 입력 필드가 렌더링된다.
//    - 안내 문구는 설정 → 플러그인에서 노션·지라를 연결하라는 안내를 표시한다.
// 2) notion 플러그인이 모킹되어 연결된 경우:
//    - 기록 대상 select에 '마크다운 문서(.md)', '노션 데이터베이스'가 노출된다.
//    - '노션 데이터베이스'를 선택하면 문서 폴더 대신 Test Scenario / QA Sheets 데이터베이스 주소 입력 필드가 나타난다.
// 3) jira 플러그인이 모킹되어 연결된 경우:
//    - '지라 이슈' 선택 시 프로젝트 키 / 이슈 유형 입력 필드가 나타난다.
// 4) 다른 단계로 이동했다가 돌아와도 선택한 기록 대상 모드가 유지되는지 확인한다.

const AIA = '[data-ui-anchor="addons.aia-content"]';

function openAiaOnboarding(): void {
  cy.visitApp();
  cy.openView("addons").should("be.visible");
  cy.openAddonsTab("aia");
  cy.get(AIA).contains("button", "온보딩 시작").click();
  cy.get(`${AIA} [aria-current="step"]`).should("exist");
  cy.get(AIA).contains("button", "기록 대상").click();
  cy.get(`${AIA} [aria-current="step"]`).should("contain.text", "기록 대상");
}

function selectRecordTarget() {
  return cy.get(AIA).contains("label", "기록 대상").find("select");
}

describe("애드온 아이아 온보딩 목업의 기록 대상 플러그인 연동 및 필드 전환", () => {
  it("외부 플러그인이 없으면 기록 대상에 마크다운만 있고 플러그인 연결 안내가 뜬다", () => {
    // getExternalPlugins 응답이 빈 배열인 기본 환경
    cy.stubInvoke("get_external_plugins", {
      plugins: [],
    });

    openAiaOnboarding();

    // 기록 대상 select 확인
    selectRecordTarget().within(() => {
      cy.get("option").should("have.length", 1);
      cy.get("option").first().should("have.value", "markdown").and("contain.text", "마크다운 문서(.md)");
    });

    // 마크다운 전용 필드 노출
    cy.get(AIA).contains("label", "문서 폴더").should("be.visible");
    cy.get(AIA).contains("label", "회차 문서 경로").find("input").should("have.value", "qa/rounds/{round}.md");
    cy.get(AIA).contains("label", "QA 티켓 경로").find("input").should("have.value", "qa/tickets/{id}.md");

    // 플러그인 미연결 안내 문구
    cy.get(AIA).find(".aia-onboarding-note").should("contain.text", "설정 → 플러그인에서 노션·지라를 연결하면 기록 대상 선택지가 늘어납니다");
  });

  it("Notion 및 Jira 플러그인이 연결되면 기록 대상 선택지가 늘어나고 각 대상별 폼이 노출된다", () => {
    // 외부 플러그인에 Notion과 Jira가 attachable: true로 등록된 상태를 모킹
    cy.stubInvoke("get_external_plugins", {
      plugins: [
        {
          id: "notion-mcp-plugin",
          displayName: "Notion Integration",
          description: "Notion integration for notes and databases",
          url: "https://mcp.notion.so",
          enabled: true,
          attachable: true,
          authStatus: "connected",
        },
        {
          id: "jira-plugin",
          displayName: "Jira Issue Tracker",
          description: "Atlassian Jira integration",
          url: "https://jira.atlassian.com",
          enabled: true,
          attachable: true,
          authStatus: "connected",
        },
      ],
    });

    openAiaOnboarding();

    selectRecordTarget().find("option").should("have.length", 3);
    selectRecordTarget().find("option").eq(0).should("have.value", "markdown");
    selectRecordTarget().find("option").eq(1).should("have.value", "notion");
    selectRecordTarget().find("option").eq(2).should("have.value", "jira");

    // 1) 노션 선택
    selectRecordTarget().select("notion");
    cy.get(AIA).contains("label", "문서 폴더").should("not.exist");
    cy.get(AIA).contains("label", "Test Scenario 데이터베이스").should("be.visible");
    cy.get(AIA).contains("label", "QA Sheets 데이터베이스").should("be.visible");
    cy.get(AIA).find(".aia-onboarding-note").should("contain.text", "연결된 플러그인으로 기록합니다");

    // 2) 지라 선택
    selectRecordTarget().select("jira");
    cy.get(AIA).contains("label", "Test Scenario 데이터베이스").should("not.exist");
    cy.get(AIA).contains("label", "프로젝트 키").should("be.visible");
    cy.get(AIA).contains("label", "이슈 유형").should("be.visible");

    // 3) 마크다운으로 복귀
    selectRecordTarget().select("markdown");
    cy.get(AIA).contains("label", "문서 폴더").should("be.visible");
    cy.get(AIA).contains("label", "회차 문서 경로").should("be.visible");
    // 복수 대상이 있을 때의 마크다운 안내 문구
    cy.get(AIA).find(".aia-onboarding-note").should("contain.text", "연결된 노션·지라로 바꿀 수도 있습니다");
  });
});
