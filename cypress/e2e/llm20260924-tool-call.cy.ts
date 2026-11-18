/// <reference types="cypress" />

const SERVER = "http://100.86.20.5:11434/v1";
const WORKSPACE = "/Users/user/projects/agent-manager-tauri";
const MODELS = [
  { model: "qwen3.5-gpu:latest" },
  { model: "gpt-oss:20b" },
];

describe("로컬 LLM 작업공간 read 도구 호출", { retries: 0 }, () => {
  MODELS.forEach(({ model }) => {
    it(`${model}이 read 도구를 호출하고 성공 결과를 화면에 표시한다`, () => {
      const consoleErrors: string[] = [];
      let sentAt = 0;
      let firstResponseMs = 0;
      let toolCompleteMs = 0;

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
        .type("반드시 read 도구를 한 번 사용해 package.json을 읽고, 파일을 읽었다고 짧게 답하세요. bash나 write는 사용하지 마세요.", { delay: 0 });

      cy.then(() => { sentAt = Date.now(); });
      cy.get(".chat-start-button").click();
      cy.get(".chat-session-meta, .chat-launch-form .error-banner", { timeout: 30_000 })
        .should("exist")
        .then(($state) => {
          if ($state.hasClass("error-banner")) {
            const failedMs = Date.now() - sentAt;
            const message = $state.text().trim();
            cy.screenshot(
              `llm20260924-tool-call-${model.replace(/[^a-z0-9]+/gi, "-")}-connection-failed-${failedMs}ms`,
              { overwrite: true },
            ).then(() => {
              throw new Error(`${model} 채팅 연결 실패(${failedMs}ms): ${message}`);
            });
          }
        });
      cy.get(".chat-session-meta").should("contain.text", model);
      cy.get(".chat-message-assistant, .chat-tool", { timeout: 120_000 })
        .should("exist")
        .then(() => { firstResponseMs = Date.now() - sentAt; });
      cy.get(".chat-tool", { timeout: 300_000 })
        .should("contain.text", "read")
        .find(".chat-tool-state")
        .should("have.class", "chat-tool-state-completed")
        .then(() => { toolCompleteMs = Date.now() - sentAt; });
      cy.get(".terminal-status-ready", { timeout: 300_000 }).should("exist");
      cy.then(() => {
        const completedMs = Date.now() - sentAt;
        expect(consoleErrors, "브라우저 console.error").to.deep.equal([]);
        cy.saveResult(`llm20260924-tool-call-${model.replace(/[^a-z0-9]+/gi, "-")}.json`, {
          model,
          firstResponseMs,
          toolCompleteMs,
          completedMs,
          tool: "read",
          succeeded: true,
          consoleErrors,
        });
        cy.screenshot(
          `llm20260924-tool-call-${model.replace(/[^a-z0-9]+/gi, "-")}-first-${firstResponseMs}ms-tool-${toolCompleteMs}ms-complete-${completedMs}ms`,
          { overwrite: true },
        );
      });
    });
  });
});
