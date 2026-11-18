/// <reference types="cypress" />

// 설정 → 연결의 Ollama 카드가 여는 드로워 안의 로컬 LLM 연결 카드
// (src/components/LocalLlmConnectionCard.tsx) 계약.
//
// 이 카드는 다른 공급자와 달리 계정도 로그인도 없고, 사용자가 적은 주소 하나로 성립한다.
// 그래서 "주소를 적고 → 확인을 눌러 모델 목록을 받고 → 그 가운데 하나를 골라 저장한다"가
// 전부인데, 그 한 줄기를 잡는 스펙이 없었다. 여기서 보는 것은 셋이다.
// 1) 확인이 probe 를 부르고 받은 모델 수·서버 이름을 그대로 보여 준다.
// 2) 목록을 받으면 기본 모델 칸이 select 로 열리고, 저장 전에 고른 값이 저장 요청에 실린다.
// 3) API 키는 되읽지 않는다 — 저장본이 키가 있다고 알려도 입력칸은 비어 있고,
//    빈 칸으로 저장하면 요청에 apiKey 가 실리지 않는다("그대로 두기"이지 "지우기"가 아니다).

import {
  localLlmConnection,
  localLlmProbe,
  stubProvidersDetected,
} from "../support/localLlmFixtures";

function openLocalDrawer() {
  cy.openSettingsTab("connections");
  cy.anchor("settings.connections").contains(".cli-settings-provider", "Ollama")
    .find(".cli-settings-provider-states button.button").click();
  // 드로워 본문은 스크롤 영역이라 카드가 뷰포트 밖에 놓일 수 있다. 여기서 보는 것은
  // 배치가 아니라 카드의 내용이므로 존재로 확인하고 화면 안으로 끌어온다.
  return cy.anchor("settings.local-llm").should("exist").scrollIntoView();
}

describe("설정 · 연결 · 로컬 LLM 연결 카드", () => {
  it("주소를 확인하면 모델 목록이 열리고, 고른 모델과 컨텍스트 크기가 저장 요청에 실린다", () => {
    stubProvidersDetected("local");
    cy.stubInvoke("get_local_llm_connection", localLlmConnection());
    cy.stubInvoke("probe_local_llm_connection", localLlmProbe()).as("probe");
    cy.stubInvoke("set_local_llm_connection", (req) => {
      const request = (req.body as { request: Record<string, unknown> }).request;
      expect(request).deep.eq({
        baseUrl: "http://127.0.0.1:11434/v1",
        defaultModel: "gpt-oss:20b",
        contextWindow: 65536,
        enabled: true,
      });
      req.reply(localLlmConnection({
        baseUrl: request.baseUrl as string,
        defaultModel: request.defaultModel as string,
        contextWindow: request.contextWindow as number,
        enabled: true,
      }));
    }).as("save");

    cy.visitApp();
    openLocalDrawer();

    // 주소가 비어 있으면 확인도 저장도 열리지 않는다.
    cy.get("#local-llm-base-url").should("have.value", "");
    cy.contains(".settings-subsection button", /^확인$/).should("be.disabled");

    cy.get("#local-llm-base-url").type("http://127.0.0.1:11434/v1");
    cy.contains(".settings-subsection button", /^확인$/).click();
    cy.wait("@probe").its("request.body.baseUrl").should("eq", "http://127.0.0.1:11434/v1");
    cy.anchor("settings.local-llm").should("contain.text", "모델 2개 · ollama/0.34.2");

    // 목록을 받았으므로 기본 모델은 select 로 고른다. 저장된 값이 목록에 없었으니
    // 카드가 첫 모델로 맞춰 두고, 사용자는 그 가운데 다른 것을 고를 수 있다.
    cy.get("#local-llm-model").should("have.value", "qwen3:8b")
      .find("option").should("have.length", 3);
    cy.get("#local-llm-model").select("gpt-oss:20b");
    cy.get("#local-llm-context").type("65536");
    cy.anchor("settings.local-llm").find('input[type="checkbox"]').check();

    cy.contains(".settings-subsection button", /^저장$/).click();
    cy.wait("@save");
    cy.anchor("settings.local-llm").should("contain.text", "연결을 저장했습니다.");
    cy.anchor("settings.local-llm").contains(".health", "사용 중").should("exist");
  });

  it("저장된 API 키는 되읽지 않고, 빈 칸으로 저장하면 키를 건드리지 않는다", () => {
    stubProvidersDetected("local");
    cy.stubInvoke("get_local_llm_connection", localLlmConnection({
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen3:8b",
      apiKeyConfigured: true,
      enabled: true,
    }));
    cy.stubInvoke("set_local_llm_connection", (req) => {
      const request = (req.body as { request: Record<string, unknown> }).request;
      // 빈 입력칸은 "그대로 두기"이므로 apiKey 키 자체가 없어야 한다.
      expect(request).not.to.have.property("apiKey");
      req.reply(localLlmConnection({
        baseUrl: request.baseUrl as string,
        defaultModel: request.defaultModel as string,
        apiKeyConfigured: true,
        enabled: true,
      }));
    }).as("save");

    cy.visitApp();
    openLocalDrawer();

    cy.get("#local-llm-api-key").should("have.value", "")
      .and("have.attr", "placeholder", "저장됨 — 바꾸려면 새 값을 입력하세요");
    // 키가 있을 때만 지우기 버튼이 붙는다. 지우는 것은 저장이 아니라 따로 시키는 일이다.
    cy.contains(".settings-subsection button", "키 지우기").should("exist");

    // probe 를 하지 않았으므로 목록이 없고 기본 모델 칸은 자유 입력으로 열려 있다.
    cy.get("#local-llm-model").should("be.disabled").and("have.value", "__custom__");
    cy.anchor("settings.local-llm").find('input[placeholder="gpt-oss:20b"]').should("have.value", "qwen3:8b");

    cy.contains(".settings-subsection button", /^저장$/).click();
    cy.wait("@save");
  });
});
