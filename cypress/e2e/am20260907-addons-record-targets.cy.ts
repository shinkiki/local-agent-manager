/// <reference types="cypress" />
// AM-112 · 워크플로 → 자동화 → 'QA 워크플로 온보딩' 카드의 '기록 대상' 단계에서
// 외부 플러그인(Notion, Jira) 스냅샷에 따른 대상 선택지 동적 확장 및 폼 필드 전환 계약.
// 카드는 팩이 그리는 선언형 카드가 되었다(c9de7c43). 기록 대상은 고르기 전에는 비어 있고
// ("선택하세요"), 고른 갈래의 칸만 선다. 목업 시절의 플러그인 안내 각주는 없어졌다.
//
// 1) 기본(외부 플러그인 없음):
//    - 기록 대상 select에는 빈 선택과 '마크다운 문서(.md)'만 있다.
//    - 마크다운을 고르면 등록 폴더 select와 회차 문서/QA 티켓 .md 기본 경로 칸이 선다.
// 2) notion·jira 플러그인이 모킹되어 연결된 경우:
//    - 기록 대상 select에 '노션', '지라'가 더해진다.
//    - '노션'을 고르면 등록 폴더 대신 Test Scenario / QA Sheets 데이터베이스 주소 칸이 선다.
//    - '지라'를 고르면 지라 프로젝트 키 / 이슈 유형 칸이 선다.
// 3) 다른 단계로 이동했다가 돌아와도 고른 기록 대상과 그 갈래의 칸이 유지된다.

// 모듈로 두어 다른 스펙의 같은 이름 상수(AIA 등)와 전역에서 부딪히지 않게 한다.
export {};

const AIA = '[data-ui-anchor="workflows.automation-content"]';
const WIZARD = `${AIA} .aia-onboarding-wizard`;

function openAiaOnboarding(): void {
  // 자동화 탭은 워크플로 화면의 마지막 탭이다. 애드온 화면을 거치지 않으므로 이 스펙이 세운
  // 부분 스텁을 외부 플러그인 카드가 먼저 읽는 일도 없다.
  cy.visitApp();
  cy.openAutomationTab();
  cy.get(AIA).contains(".aia-onboarding-start", "QA 워크플로 온보딩").contains("button", "시작").click();
  cy.get(`${WIZARD} [aria-current="step"]`).should("exist");
  cy.get(WIZARD).contains("button", "기록 대상").click();
  cy.get(`${WIZARD} [aria-current="step"]`).should("contain.text", "기록 대상");
}

function selectRecordTarget() {
  return cy.get(WIZARD).contains("label", "기록 대상").find("select");
}

/** 펼친 카드 안의 칸 이름표. 스크롤 상자 아래에 설 수 있어 보이게 옮긴 뒤 본다. */
function visibleLabel(label: string) {
  return cy.get(WIZARD).contains("label", label).scrollIntoView().should("be.visible");
}

describe("워크플로 자동화 QA 온보딩 카드의 기록 대상 플러그인 연동 및 필드 전환", () => {
  it("외부 플러그인이 없으면 기록 대상에 마크다운만 있고, 고른 뒤에야 마크다운 칸이 선다", () => {
    // getExternalPlugins 응답이 빈 배열인 기본 환경
    cy.stubInvoke("get_external_plugins", {
      plugins: [],
    });

    openAiaOnboarding();

    // 기록 대상 select 확인 — 고르기 전의 빈 선택과, 플러그인 없이도 되는 마크다운 하나뿐이다.
    selectRecordTarget().should("have.value", "").within(() => {
      cy.get("option").should("have.length", 2);
      cy.get("option").eq(0).should("have.value", "").and("contain.text", "선택하세요");
      cy.get("option").eq(1).should("have.value", "markdown").and("contain.text", "마크다운 문서(.md)");
    });
    // 고르기 전에는 어느 갈래의 칸도 서지 않는다.
    cy.get(WIZARD).contains("label", "등록 폴더").should("not.exist");

    // 마크다운 전용 필드 노출
    selectRecordTarget().select("markdown");
    visibleLabel("등록 폴더");
    cy.get(WIZARD).contains("label", "회차 문서 경로").find("input").should("have.value", "qa/rounds/{round}.md");
    cy.get(WIZARD).contains("label", "QA 티켓 경로").find("input").should("have.value", "qa/tickets/{id}.md");
  });

  it("Notion 및 Jira 플러그인이 연결되면 기록 대상 선택지가 늘어나고 각 대상별 폼이 노출되며 단계를 오가도 유지된다", () => {
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

    selectRecordTarget().find("option").should("have.length", 4);
    selectRecordTarget().find("option").eq(0).should("have.value", "");
    selectRecordTarget().find("option").eq(1).should("have.value", "markdown");
    selectRecordTarget().find("option").eq(2).should("have.value", "notion").and("contain.text", "노션");
    selectRecordTarget().find("option").eq(3).should("have.value", "jira").and("contain.text", "지라");

    // 1) 노션 선택
    selectRecordTarget().select("notion");
    cy.get(WIZARD).contains("label", "등록 폴더").should("not.exist");
    visibleLabel("Test Scenario 데이터베이스");
    visibleLabel("QA Sheets 데이터베이스");

    // 2) 지라 선택
    selectRecordTarget().select("jira");
    cy.get(WIZARD).contains("label", "Test Scenario 데이터베이스").should("not.exist");
    visibleLabel("지라 프로젝트 키");
    visibleLabel("이슈 유형");

    // 3) 다른 단계를 다녀와도 고른 대상과 그 갈래의 칸이 남는다 — 값은 카드가 칸 이름으로 쥔다.
    cy.get(WIZARD).contains("button", "회차 운영·생성").click();
    cy.get(`${WIZARD} [aria-current="step"]`).should("contain.text", "회차 운영·생성");
    cy.get(WIZARD).contains("button", "기록 대상").click();
    selectRecordTarget().should("have.value", "jira");
    visibleLabel("지라 프로젝트 키");

    // 4) 마크다운으로 복귀
    selectRecordTarget().select("markdown");
    visibleLabel("등록 폴더");
    visibleLabel("회차 문서 경로");
    cy.get(WIZARD).contains("label", "지라 프로젝트 키").should("not.exist");
  });
});
