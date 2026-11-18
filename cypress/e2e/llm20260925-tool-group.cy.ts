/// <reference types="cypress" />

import { dismissNewProjectDialog, typeWorkPath, waitTurnIdle } from "../support/localLlmChat";

// 축 — 도구 묶음 선택(`opencode_config::tool_group_for`).
//
// 코어 C에서 "cypress 작업공간 목록을 조회해 주세요"라는 발화에 모델이 Rust 소스를
// 읽은 듯한 답을 내놓아, SYSTEM_HINTS에 있는 `cypress`가 정말 시스템 묶음을 여는지
// 확인이 필요해졌다. 재는 것은 C14-3 불변식 하나다 — 시스템 낱말이 든 발화의 턴에는
// 작업공간 도구(bash/read/write) 카드가 절대 뜨지 않고, 낱말이 없는 발화의 턴에는
// agent-manager MCP 도구 카드가 절대 뜨지 않는다. 어떤 도구를 골랐는지는 모델 능력이라
// 측정값으로만 남긴다.

const SERVER = "http://100.86.20.5:11434/v1";
const WORKSPACE = "/Users/user/projects/agent-manager-tauri";
const MODELS = [{ model: "qwen3.5-gpu-128k:latest" }, { model: "gpt-oss:20b" }];
const slug = (model: string) => model.replace(/[^a-z0-9]+/gi, "-");

const WORKSPACE_TOOL = /(^|[^-\w])(bash|write|read|glob|grep)\b/i;
// 도구 이름은 `agent-manager_<도구>` 꼴이다. `agent-manager`만 보면 bash 카드에 찍힌
// 작업 경로(`/Users/.../agent-manager-tauri`)에 걸려 거짓 실패한다.
const SYSTEM_TOOL = /agent-manager_/i;

function startLocalChat(model: string, prompt: string): void {
  cy.request("POST", "/api/invoke/set_local_llm_connection", {
    request: { baseUrl: SERVER, defaultModel: model, contextWindow: 32768, enabled: true, apiKey: null },
  })
    .its("body")
    .should("include", { baseUrl: SERVER, defaultModel: model, enabled: true });

  cy.visit("/", {
    onBeforeLoad(win) {
      win.localStorage.setItem("agent-manager.e2e-hooks", "1");
    },
  });
  dismissNewProjectDialog();
  cy.anchor("nav.chat").click({ force: true });
  cy.get(".chat-launch-form", { timeout: 20_000 }).should("be.visible");
  dismissNewProjectDialog();
  cy.get(".chat-launch-form select").first().select("local");
  typeWorkPath(WORKSPACE);
  cy.get(".chat-initial-composer textarea").clear().type(prompt, { delay: 0 });
  cy.get(".chat-start-button").click();
  cy.get(".chat-session-meta, .chat-launch-form .error-banner", { timeout: 30_000 })
    .should("exist")
    .then(($state) => {
      if ($state.hasClass("error-banner")) {
        const message = $state.text().trim();
        cy.screenshot(`llm-group-${slug(model)}-connection-failed`, { overwrite: true }).then(() => {
          throw new Error(`${model} 로컬 채팅 연결 실패: ${message}`);
        });
      }
    });
}

describe("로컬 LLM 축 — 도구 묶음 선택", { retries: 0 }, () => {
  MODELS.forEach(({ model }) => {
    it(`${model}: cypress 발화는 시스템 묶음만 연다`, () => {
      const sentAt = Date.now();
      startLocalChat(model, "cypress 작업공간 목록을 조회해서 어떤 것이 있는지 알려 주세요.");
      waitTurnIdle();
      cy.get("body").then(($body) => {
        const titles = $body.find(".chat-tool-title").text();
        cy.log(`[축/시스템][${model}] 도구: ${titles || "(호출 없음)"} / ${Date.now() - sentAt}ms`);
        expect(titles, "작업공간 도구 부재(C14-3)").to.not.match(WORKSPACE_TOOL);
      });
      cy.screenshot(`llm-group-${slug(model)}-system`, { overwrite: true });
    });

    it(`${model}: 낱말 없는 발화는 작업공간 묶음에 남는다`, () => {
      const sentAt = Date.now();
      startLocalChat(model, "이 폴더에 어떤 파일이 있는지 목록을 보여 주세요.");
      waitTurnIdle();
      cy.get("body").then(($body) => {
        const titles = $body.find(".chat-tool-title").text();
        cy.log(`[축/작업공간][${model}] 도구: ${titles || "(호출 없음)"} / ${Date.now() - sentAt}ms`);
        expect(titles, "시스템 MCP 도구 부재(C14-3)").to.not.match(SYSTEM_TOOL);
      });
      cy.screenshot(`llm-group-${slug(model)}-workspace`, { overwrite: true });
    });
  });
});
