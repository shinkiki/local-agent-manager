/// <reference types="cypress" />

const SERVER = "http://100.86.20.5:11434/v1";
const WORKSPACE = "/Users/user/projects/agent-manager-tauri";
const MODELS = [
  { model: "qwen3.5-gpu:latest" },
  { model: "gpt-oss:20b" },
];

describe("로컬 LLM 첫 응답 대기와 완료 표시", { retries: 0 }, () => {
  MODELS.forEach(({ model }) => {
    it(`${model}이 첫 응답을 화면에 그리고 완료 상태로 돌아온다`, () => {
      const consoleErrors: string[] = [];
      let sentAt = 0;
      let firstResponseMs = 0;

      cy.request("POST", "/api/invoke/set_local_llm_connection", {
        request: {
          baseUrl: SERVER,
          defaultModel: model,
          contextWindow: 32768,
          enabled: true,
          apiKey: null,
        },
      }).its("body").should("include", {
        baseUrl: SERVER,
        defaultModel: model,
        enabled: true,
      });

      cy.visit("/", {
        onBeforeLoad(win) {
          win.localStorage.setItem("agent-manager.e2e-hooks", "1");
          const original = win.console.error.bind(win.console);
          win.console.error = (...args: unknown[]) => {
            consoleErrors.push(args.map(String).join(" "));
            original(...args);
          };
        },
      });
      cy.anchor("nav.chat").click();
      cy.get(".chat-launch-form", { timeout: 20_000 }).should("be.visible");
      cy.get(".chat-launch-form select").first().select("local");
      cy.get(".chat-launch-form input[placeholder='/absolute/project/path']")
        .clear()
        .type(WORKSPACE, { delay: 0 });
      cy.get(".chat-initial-composer textarea")
        .clear()
        .type("짧은 한 문장으로 오늘 날짜와 무관한 인사만 답해 주세요.", { delay: 0 });

      cy.then(() => { sentAt = Date.now(); });
      cy.get(".chat-start-button").click();
      cy.get(".chat-session-meta, .chat-launch-form .error-banner", { timeout: 30_000 })
        .should("exist")
        .then(($state) => {
          if ($state.hasClass("error-banner")) {
            const failedMs = Date.now() - sentAt;
            const message = $state.text().trim();
            cy.screenshot(
              `llm20260924-first-response-${model.replace(/[^a-z0-9]+/gi, "-")}-connection-failed-${failedMs}ms`,
              { overwrite: true },
            ).then(() => {
              throw new Error(`${model} 채팅 연결 실패(${failedMs}ms): ${message}`);
            });
          }
        });
      cy.get(".chat-session-meta").should("contain.text", model);
      cy.get(".terminal-status-running", { timeout: 120_000 }).should("exist");
      cy.get(".chat-message-assistant .chat-message-markdown", { timeout: 120_000 })
        .should("not.be.empty")
        .then(() => { firstResponseMs = Date.now() - sentAt; });
      cy.get(".terminal-status-ready", { timeout: 300_000 }).should("exist");
      cy.then(() => {
        const completedMs = Date.now() - sentAt;
        expect(consoleErrors, "브라우저 console.error").to.deep.equal([]);
        cy.screenshot(
          `llm20260924-first-response-${model.replace(/[^a-z0-9]+/gi, "-")}-first-${firstResponseMs}ms-complete-${completedMs}ms`,
          { overwrite: true },
        );
      });
    });
  });
});
