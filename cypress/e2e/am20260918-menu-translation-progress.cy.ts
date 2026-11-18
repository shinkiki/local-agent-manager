/// <reference types="cypress" />
/**
 * 에이전트 화면 위의 **메뉴 번역 진행 줄**(`TranslationProgress`,
 * src/components/TranslationProgress.tsx:82)이 무엇을 세는지 고정한다.
 *
 * 이 줄의 숫자는 그대로 받아 적는 값이 아니다.
 *  - 캐시를 재사용한 항목은 이번 실행에서 번역하지 않으므로 분모·분자에서 함께 뺀다
 *    (같은 파일 101~106줄). 그래서 `total`보다 작은 수가 화면에 선다.
 *  - 한 항목이 여러 요청으로 쪼개져 요청 수가 항목 수보다 많아지면(`hasSplitRequests`,
 *    110줄) 막대의 기준 자체가 항목에서 요청으로 바뀐다. 항목 카운트는 그대로 두고
 *    막대만 갈아탄다.
 *  - 뺀 결과가 0이면 `count`도 막대도 서지 않는다 — "항목 0/0"을 적지 않는다.
 *  - `enabled`가 꺼졌거나 `phase === "complete"`면 줄 자체를 그리지 않는다(89·91줄).
 *
 * 기존 번역 시나리오는 UI 언어 전환(am20260906-agents-language, i18n) 과 리소스 단위
 * 번역 버튼의 접근 통제(am20260907-skill-translate-button-gate), 메뉴 카탈로그 한도
 * (i18n-catalog-source-limit)까지만 봤다. **메뉴 번역의 진행 줄**을 확인한 스펙은
 * 저장소에 하나도 없다(`.translation-progress` 선택자를 쓰는 스펙이 없다).
 *
 * 축은 설정(다국어·번역), 조건은 경계값(캐시가 전부인 0건)·실패 응답의 오류 안내·
 * 다국어 전환이다.
 *
 * 격리 백엔드는 시스템 에이전트가 비어 있어 실제 번역을 돌릴 수 없으므로, 진행 상태는
 * `get_menu_translations` 응답으로 세운다. 이 줄이 읽는 값은 그 응답의 `status`가
 * 우선이다(SkillLibraryPanel.tsx:2529).
 */

type Status = {
  phase: string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  cached: number;
  segmentTotal: number;
  segmentCompleted: number;
  segmentFailed: number;
  segmentCached: number;
  currentField: string | null;
  lastError: string | null;
  updatedAt: number | null;
};

function status(patch: Partial<Status>): Status {
  return {
    phase: "running",
    total: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    cached: 0,
    segmentTotal: 0,
    segmentCompleted: 0,
    segmentFailed: 0,
    segmentCached: 0,
    currentField: null,
    lastError: null,
    updatedAt: null,
    ...patch,
  };
}

const AGENTS = [
  {
    name: "reviewer", description: "코드 리뷰 담당", tools: ["Read"], model: "sonnet",
    maxTurns: null, permissionMode: null, skills: [],
    path: "/tmp/am20260918-xlate/.claude/agents/reviewer.md",
  },
];

const line = () => cy.get(".translation-progress");

/** 격리 백엔드가 돌려준 진짜 스냅숏. 재시도 응답을 조립할 때 그대로 되쓴다. */
let lastSnapshot: unknown = null;

/**
 * 메뉴 자동번역 토글(`settings.translations.agents`)과 진행 상태를 갈아 끼우고 화면을 연다.
 * 토글은 스냅숏이, 진행 상태는 메뉴 번역 조회가 들고 있으므로 두 통로를 함께 잡는다.
 */
function openAgents(options: { enabled: boolean; status: Status }) {
  cy.stubSnapshotField("agents", AGENTS);
  cy.stubInvoke("get_system_automation_snapshot", (request) => {
    request.continue((response) => {
      const body = response.body as { settings: { translations: Record<string, boolean> } };
      body.settings.translations.agents = options.enabled;
      lastSnapshot = JSON.parse(JSON.stringify(body));
    });
  });
  cy.stubInvoke("get_menu_translations", (request) => {
    request.reply({
      statusCode: 200,
      body: {
        menu: (request.body as { menu: string }).menu,
        language: "en",
        enabled: options.enabled,
        status: options.status,
        records: [],
      },
    });
  });
  cy.visitApp();
  cy.openView("agents");
  cy.get(".agent-card").should("have.length", 1);
}

describe("메뉴 번역 진행 줄이 세는 값", () => {
  it("캐시 재사용분은 분모와 분자에서 함께 빠지고, 재사용 수를 따로 알린다", () => {
    openAgents({
      enabled: true,
      status: status({
        phase: "running", total: 10, completed: 6, failed: 0, cached: 4,
        segmentTotal: 10, segmentCompleted: 6, segmentCached: 4, currentField: "description",
      }),
    });

    // 10건 중 4건은 캐시라 이번 실행의 대상은 6건, 그 중 2건이 끝났다.
    line().should("have.attr", "role", "status").and("have.class", "running");
    line().find("span").first().should("have.text", "번역 중 · 항목 2/6");
    line().find("progress").should("have.attr", "max", "6").and("have.attr", "value", "2");

    // 요청 수가 항목 수와 같으므로 '요청 x/y'는 서지 않고, 재사용 수와 현재 필드만 붙는다.
    line().find("small").first().should("have.text", "캐시 재사용 4 · 현재 설명");
    line().should("not.contain.text", "요청 ");
  });

  it("요청이 항목보다 잘게 쪼개지면 막대만 요청 기준으로 갈아타고 항목 카운트는 그대로다", () => {
    openAgents({
      enabled: true,
      status: status({
        phase: "running", total: 4, completed: 1, failed: 0, cached: 0,
        segmentTotal: 12, segmentCompleted: 5, segmentFailed: 1, segmentCached: 0,
      }),
    });

    // 항목은 4건 중 1건이 끝났지만, 요청은 12개 중 6개(성공 5 + 실패 1)가 결판났다.
    line().find("span").first().should("have.text", "번역 중 · 항목 1/4");
    line().find("progress").should("have.attr", "max", "12").and("have.attr", "value", "6");
    line().find("small").first().should("have.text", "요청 6/12");
    // 캐시가 0이면 재사용 문구를 붙이지 않는다 — '캐시 재사용 0'을 적지 않는다.
    line().should("not.contain.text", "캐시 재사용");
  });

  it("모두 캐시로 채워지면 항목 카운트도 막대도 서지 않는다", () => {
    openAgents({
      enabled: true,
      status: status({
        phase: "queued", total: 5, completed: 5, failed: 0, cached: 5,
        segmentTotal: 5, segmentCompleted: 5, segmentCached: 5,
      }),
    });

    // 뺄 것을 다 빼면 0/0이 되지만, 그 숫자는 알릴 값이 아니라 안 적는 값이다.
    line().find("span").first().should("have.text", "번역 대기");
    line().find("progress").should("not.exist");
    line().find("small").first().should("have.text", "캐시 재사용 5");
  });

  it("번역이 끝났거나 메뉴 자동번역이 꺼져 있으면 줄 자체가 없다", () => {
    openAgents({
      enabled: true,
      status: status({ phase: "complete", total: 3, completed: 3, segmentTotal: 3, segmentCompleted: 3 }),
    });
    // 끝난 번역은 알릴 것이 없다.
    line().should("not.exist");

    // 토글이 꺼져 있으면 돌던 상태가 남아 있어도 그리지 않는다.
    openAgents({
      enabled: false,
      status: status({ phase: "running", total: 3, completed: 1, segmentTotal: 3, segmentCompleted: 1 }),
    });
    cy.get(".toolbar-card").should("exist");
    line().should("not.exist");
  });

  it("일부 실패하면 사유를 달고 재시도 버튼이 서며, 누르면 해당 메뉴만 다시 요청한다", () => {
    // 격리 백엔드는 자동번역이 꺼져 있어 진짜 재시도가 거절된다. 이 시나리오가 볼 것은
    // 버튼이 어떤 메뉴로 요청을 내보내는가이므로 성공 응답으로 갈음한다.
    cy.stubInvoke("retry_menu_translation", (request) => {
      request.reply({ statusCode: 200, body: lastSnapshot });
    }).as("retry");
    openAgents({
      enabled: true,
      status: status({
        phase: "partial", total: 6, completed: 4, failed: 2, cached: 1,
        segmentTotal: 6, segmentCompleted: 4, segmentFailed: 2, segmentCached: 1,
        lastError: "공급자 응답이 비어 있습니다",
      }),
    });

    // 실패도 '결판난 항목'이라 분자에 든다: (4 - 1) + 2 = 5, 분모는 6 - 1 = 5.
    line().should("have.class", "partial");
    line().find("span").first().should("have.text", "일부 번역 실패 · 항목 5/5");
    line().find("small").last()
      .should("have.text", "공급자 응답이 비어 있습니다")
      .and("have.attr", "title", "공급자 응답이 비어 있습니다");

    line().find("button").should("have.text", " 실패 항목 재시도").click();
    cy.wait("@retry").its("request.body.menu").should("eq", "agents");
  });

  it("영어 UI에서는 같은 줄이 items·reused·current로 적힌다", () => {
    // 언어 전환은 설정 화면을 거치므로 앱을 먼저 띄운다. 값은 백엔드 설정에 남아
    // 다시 띄워도 유지된다.
    openAgents({ enabled: false, status: status({ phase: "complete" }) });
    cy.setLanguage("en");
    openAgents({
      enabled: true,
      status: status({
        phase: "running", total: 10, completed: 6, cached: 4,
        segmentTotal: 10, segmentCompleted: 6, segmentCached: 4, currentField: "description",
      }),
    });

    line().find("span").first().should("have.text", "Translating · items 2/6");
    line().find("small").first().should("have.text", "reused 4 · current description");
    cy.restoreLanguage();
  });
});
