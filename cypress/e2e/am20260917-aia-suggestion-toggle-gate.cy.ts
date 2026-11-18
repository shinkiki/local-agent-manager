/// <reference types="cypress" />

/**
 * 설정 → AIA 설정, 'AIA 선제 제안 팩' 스위치의 사전조건 게이트와 저장 실패 갈래.
 *
 * AM-264(am20260916-aia-suggestion-pack-restore)는 같은 패널의 **팩 카드**만 봤다 —
 * 설치 상태별 버튼 3상태와 복구 승인의 IPC 순서다. 그 위에 서 있는 스위치는 어느
 * 시나리오에도 없었고, `aiaSuggestions` 설정을 만지는 스펙 자체가 없다.
 *
 * 축은 AIA, 조건은 권한·사전조건 게이트와 실패 응답의 오류 안내, 그리고 저장 중
 * 빠른 연속 조작이다. 스위치를 띄울지는 `AiaSuggestionPackPanel.tsx:160`의
 * `automation && systemProvider`가 정하고, systemProvider는 `aiaRuntime.ts:29`가
 * 시스템 에이전트로 고를 수 있는 공급자(codex·claude)일 때만 돌려준다. 격리 백엔드는
 * 시스템 에이전트가 비어 있으므로 기본 상태가 곧 게이트 닫힌 상태다.
 *
 * 확인하는 것:
 *  - 시스템 에이전트 미선택이면 스위치 대신 '설정 → AIA 설정' 안내가 서고 스위치가 없다
 *  - codex를 고르면 스위치가 뜨고 저장된 값(true)을 따른다
 *  - 끄면 set_system_automation_settings가 aiaSuggestions=false로 나가고 응답대로 꺼진다
 *  - 저장이 실패하면 오류 배너가 뜨고 스위치는 원래 값을 지킨다(낙관적 갱신 아님)
 *  - 저장이 끝나기 전 다시 눌러도 스위치가 잠겨 요청이 한 번만 나간다
 */

let lastSnapshot: { settings: Record<string, unknown> } | null = null;

const HINT = "위에서 시스템 에이전트를 골라야 켤 수 있습니다.";

function panel() {
  return cy.anchor("settings.aia-suggestions");
}

function suggestionToggle() {
  return panel().find(".system-setting-group .app-toggle");
}

/** 격리 백엔드의 진짜 스냅숏을 흘리되 시스템 에이전트와 제안 값만 갈아 끼운다. */
function stubAutomation(options: { systemProvider: string | null; aiaSuggestions: boolean }) {
  cy.stubInvoke("get_system_automation_snapshot", (request) => {
    request.continue((response) => {
      const body = response.body as { settings: Record<string, unknown> };
      body.settings.systemProvider = options.systemProvider;
      body.settings.aiaSuggestions = options.aiaSuggestions;
      // 저장 응답을 조립할 때 쓰려고 마지막 스냅숏을 들고 있는다.
      lastSnapshot = JSON.parse(JSON.stringify(body));
    });
  });
}

/** 저장 요청이 보낸 설정을 그대로 반영한 스냅숏으로 답한다. 실제 저장은 하지 않는다. */
function stubSave(alias: string, options: { delayMs?: number } = {}) {
  cy.stubInvoke("set_system_automation_settings", (request) => {
    const sent = (request.body as { request: Record<string, unknown> }).request;
    const snapshot = lastSnapshot as { settings: Record<string, unknown> };
    request.reply({
      statusCode: 200,
      delay: options.delayMs ?? 0,
      body: { ...snapshot, settings: { ...snapshot.settings, ...sent } },
    });
  }).as(alias);
}

function openSuggestionPanel() {
  cy.visitApp();
  cy.openSettingsTab("aia");
  // 선제 제안은 시스템 에이전트 카드 아래에 서므로 좁은 뷰포트에서는 접힌 자리에 있다.
  panel().scrollIntoView().should("be.visible");
}

describe("AIA 선제 제안 스위치의 사전조건 게이트와 저장 실패", () => {
  it("시스템 에이전트를 고르지 않았으면 스위치 대신 안내만 선다", () => {
    stubAutomation({ systemProvider: null, aiaSuggestions: true });
    openSuggestionPanel();

    panel().find(".aia-suggestion-pack-hint").should("have.text", HINT);
    panel().find(".system-setting-group .app-toggle").should("not.exist");
  });

  it("시스템 에이전트로 쓸 수 없는 공급자가 남아 있어도 게이트는 닫힌 채다", () => {
    stubAutomation({ systemProvider: "antigravity", aiaSuggestions: true });
    openSuggestionPanel();

    panel().find(".aia-suggestion-pack-hint").should("have.text", HINT);
    panel().find(".system-setting-group .app-toggle").should("not.exist");
  });

  it("codex를 고르면 스위치가 저장값을 따르고, 끄면 aiaSuggestions=false로 나간다", () => {
    stubAutomation({ systemProvider: "codex", aiaSuggestions: true });
    stubSave("saveSuggestions");
    openSuggestionPanel();

    panel().find(".aia-suggestion-pack-hint").should("not.exist");
    suggestionToggle().should("have.attr", "aria-checked", "true").and("not.be.disabled");

    suggestionToggle().click();
    cy.wait("@saveSuggestions").its("request.body.request.aiaSuggestions").should("eq", false);
    suggestionToggle().should("have.attr", "aria-checked", "false");
    panel().find(".error-banner").should("not.exist");
  });

  it("저장이 실패하면 오류를 알리고 스위치는 원래 값을 지킨다", () => {
    stubAutomation({ systemProvider: "codex", aiaSuggestions: true });
    openSuggestionPanel();
    suggestionToggle().should("have.attr", "aria-checked", "true");

    cy.intercept(
      { method: "POST", url: "**/api/invoke/set_system_automation_settings", times: 1 },
      { statusCode: 500, body: { error: "QA forced suggestion toggle failure" } },
    ).as("failedSave");

    suggestionToggle().click();
    cy.wait("@failedSave");

    panel().find(".error-banner").should("contain.text", "QA forced suggestion toggle failure");
    suggestionToggle().should("have.attr", "aria-checked", "true").and("not.be.disabled");
  });

  it("저장이 끝나기 전 다시 눌러도 스위치가 잠겨 요청은 한 번만 나간다", () => {
    stubAutomation({ systemProvider: "codex", aiaSuggestions: true });
    stubSave("slowSave", { delayMs: 700 });
    openSuggestionPanel();

    suggestionToggle().click();
    suggestionToggle().should("be.disabled");
    suggestionToggle().click({ force: true });

    cy.wait("@slowSave");
    suggestionToggle().should("have.attr", "aria-checked", "false").and("not.be.disabled");
    cy.get("@slowSave.all").should("have.length", 1);
  });
});
