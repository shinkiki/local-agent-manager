/// <reference types="cypress" />
/**
 * QA #97. 메뉴 번역 진행 줄의 '실패 항목 재시도'가 **거절됐을 때** 무엇이 화면에 서는지
 * 고정한다.
 *
 * 재시도는 번역이 일부 실패한 뒤의 복구 경로다. 거절이 화면에 닿지 않으면 사용자는
 * "눌렀는데 아무 반응이 없다"만 겪고 사유를 알 길이 없다(데스크탑 앱에는 콘솔도 없다).
 * 진행 줄은 이미 사유를 적는 자리(`TranslationProgress.tsx`의 `error ?? status.lastError`)를
 * 갖고 있으므로, 거절 사유가 그리로 흘러들어야 한다.
 *
 * am20260918-menu-translation-progress는 같은 줄이 **세는 값**을 고정하면서 재시도를
 * 성공 응답으로 갈음했다. 이 스펙은 그 반대편 — 거절된 재시도 — 만 본다.
 *
 * `retry_menu_translation`은 스텁하지 않는다. 격리 백엔드는 자동번역이 실제로 꺼져 있어
 * 그대로 거절하므로, 화면이 받는 거절은 진짜 백엔드의 것이다.
 */

const AGENTS = [
  {
    name: "reviewer", description: "코드 리뷰 담당", tools: ["Read"], model: "sonnet",
    maxTurns: null, permissionMode: null, skills: [],
    path: "/tmp/am20260919-xlate-retry/.claude/agents/reviewer.md",
  },
];

const REJECTION = "자동번역이 꺼진 메뉴는 재시도할 수 없습니다";

const line = () => cy.get(".translation-progress");

describe("거절된 메뉴 번역 재시도", () => {
  beforeEach(() => {
    cy.stubSnapshotField("agents", AGENTS);
    cy.stubInvoke("get_system_automation_snapshot", (request) => {
      request.continue((response) => {
        const body = response.body as { settings: { translations: Record<string, boolean> } };
        body.settings.translations.agents = true;
      });
    });
    cy.stubInvoke("get_menu_translations", (request) => {
      request.reply({
        statusCode: 200,
        body: {
          menu: (request.body as { menu: string }).menu,
          language: "en",
          enabled: true,
          status: {
            phase: "partial",
            total: 6, completed: 4, failed: 2, pending: 0, cached: 0,
            segmentTotal: 6, segmentCompleted: 4, segmentFailed: 2, segmentCached: 0,
            currentField: null, lastError: null, updatedAt: null,
          },
          records: [],
        },
      });
    });
    cy.visitApp();
    cy.openView("agents");
    cy.get(".agent-card").should("have.length", 1);
  });

  it("거절 사유가 진행 줄의 사유 자리에 서고, 다시 누르면 지워졌다가 다시 선다", () => {
    // 사유가 없는 동안에는 적을 것도 없다 — 진행률만 서고 사유 줄은 없다.
    line().should("have.class", "partial");
    line().find("span").first().should("have.text", "일부 번역 실패 · 항목 6/6");
    line().find("small").should("not.exist");

    cy.stubInvoke("retry_menu_translation").as("retry");
    line().contains("button", "실패 항목 재시도").click();
    // 거절의 상태 코드(자동번역이 꺼진 메뉴라 409)는 이 스펙이 보는 것이 아니다. 요청이
    // 실제로 나갔고 거절로 끝났다는 것만 확인하고, 그 사유가 화면에 서는지를 본다.
    cy.wait("@retry").its("response.statusCode").should("be.gte", 400);

    // 거절은 조용히 삼켜지지 않는다. 사유가 그대로 사유 자리에 선다.
    line().find("small").last()
      .should("have.text", REJECTION)
      .and("have.attr", "title", REJECTION);

    // 두 번째 클릭은 이전 실패 문구를 먼저 지우고 같은 자리에 새 사유를 세운다.
    line().contains("button", "실패 항목 재시도").click();
    cy.wait("@retry");
    line().find("small").last().should("have.text", REJECTION);
  });
});
