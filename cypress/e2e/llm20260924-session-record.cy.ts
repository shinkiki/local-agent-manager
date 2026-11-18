/// <reference types="cypress" />

// 축 — 세션 기록(C14-6). 로컬 대화 한 번 뒤 세션 목록에 그 세션이 뜨는지,
// 공급자 표시가 Ollama이고 모델 칸이 그 모델인지, 그리고 사용자의 OpenCode 대화가
// 섞여 들어오지 않는지(격리 HOME이라 앱이 만든 세션만 있어야 한다).

const SERVER = "http://100.86.20.5:11434/v1";
const MODELS = [{ model: "qwen3.5-gpu-128k:latest" }, { model: "gpt-oss:20b" }];
const slug = (model: string) => model.replace(/[^a-z0-9]+/gi, "-");

/** 임시 작업 폴더 때문에 뜨는 "새 프로젝트 감지" 모달을 닫는다. 떠 있지 않으면 아무 일도 안 한다. */
function dismissNewProjectDialog(): void {
  cy.get("body").then(($body) => {
    if ($body.find(".modal-backdrop").length === 0) return;
    cy.contains(".modal-backdrop button", "나중에").click({ force: true });
    cy.get(".modal-backdrop").should("not.exist");
  });
}

describe("로컬 LLM 세션 기록", { retries: 0 }, () => {
  MODELS.forEach(({ model }) => {
    it(`${model} 대화가 세션 목록에 Ollama 세션으로 남는다`, () => {
      const dir = `/tmp/llm-qa-axis-${slug(model)}-${Date.now()}`;
      cy.writeFile(`${dir}/marker.txt`, "axis\n");

      cy.request("POST", "/api/invoke/set_local_llm_connection", {
        request: {
          baseUrl: SERVER,
          defaultModel: model,
          contextWindow: 32768,
          enabled: true,
          apiKey: null,
        },
      })
        .its("body")
        .should("include", { baseUrl: SERVER, defaultModel: model, enabled: true });

      cy.visit("/", {
        onBeforeLoad(win) {
          win.localStorage.setItem("agent-manager.e2e-hooks", "1");
        },
      });
      // 임시 작업 폴더는 "새 프로젝트 감지" 모달을 띄운다. 정상 동작이지만 화면을 덮으므로 닫는다.
      dismissNewProjectDialog();
      cy.anchor("nav.chat").click({ force: true });
      cy.get(".chat-launch-form", { timeout: 20_000 }).should("be.visible");
      dismissNewProjectDialog();
      cy.get(".chat-launch-form select").first().select("local");
      cy.get(".chat-launch-form input[placeholder='/absolute/project/path']").clear().type(dir, { delay: 0 });
      cy.get(".chat-initial-composer textarea").clear().type("한 문장으로 짧게 인사만 해 주세요.", { delay: 0 });
      cy.get(".chat-start-button").click();
      cy.get(".chat-session-meta, .chat-launch-form .error-banner", { timeout: 30_000 })
        .should("exist")
        .then(($state) => {
          if ($state.hasClass("error-banner")) {
            const message = $state.text().trim();
            cy.screenshot(`llm-axis-${slug(model)}-connection-failed`, { overwrite: true }).then(() => {
              throw new Error(`${model} 로컬 채팅 연결 실패: ${message}`);
            });
          }
        });
      cy.get(".chat-message-assistant .chat-message-markdown", { timeout: 300_000 }).should("not.be.empty");
      cy.get(".terminal-status-ready", { timeout: 600_000 }).should("exist");

      // 세션 목록으로 옮겨 이 대화가 남았는지 본다.
      dismissNewProjectDialog();
      cy.anchor("nav.sessions").click();
      cy.get(".session-list-pane", { timeout: 20_000 }).should("be.visible");
      cy.get(".session-list-pane tbody tr", { timeout: 60_000 }).should("have.length.greaterThan", 0);
      cy.get(".session-list-pane tbody tr")
        .filter((_, row) => row.textContent?.includes(model) ?? false)
        .should("have.length.greaterThan", 0)
        .first()
        .within(() => {
          cy.get(".session-source-mark").should("have.attr", "title", "Ollama");
          cy.get("code").should("contain.text", model);
        });

      cy.screenshot(`llm-axis-${slug(model)}-session-list`, { overwrite: true });
    });
  });
});
