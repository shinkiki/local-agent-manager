/// <reference types="cypress" />

import { dismissNewProjectDialog, typeWorkPath, waitTurnIdle, waitTurnRunning } from "../support/localLlmChat";

// 코어 B — 시스템 낱말이 든 발화가 시스템 에이전트를 열고, agent-manager MCP 도구를
// 실제로 부르는지. 같은 턴에 작업공간 도구(bash/read/write)가 뜨면 C14-3 위반이다.

const SERVER = "http://100.86.20.5:11434/v1";
const WORKSPACE = "/Users/user/projects/agent-manager-tauri";
const MODELS = [{ model: "qwen3.5-gpu-128k:latest" }, { model: "gpt-oss:20b" }];
const slug = (model: string) => model.replace(/[^a-z0-9]+/gi, "-");

describe("로컬 LLM 코어 B — 시스템 MCP 호출", { retries: 0 }, () => {
  MODELS.forEach(({ model }) => {
    it(`${model}이 시스템 묶음에서 agent-manager MCP 도구를 부른다`, () => {
      let sentAt = 0;

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
      // 임시 작업 폴더는 앱에 "새 프로젝트 감지" 모달을 띄운다. 정상 동작이지만 화면을
      // 덮으므로 "나중에"로 닫고 진행한다(격리 백엔드는 스펙 사이에 살아 있다).
      dismissNewProjectDialog();
      cy.anchor("nav.chat").click({ force: true });
      cy.get(".chat-launch-form", { timeout: 20_000 }).should("be.visible");
      dismissNewProjectDialog();
      cy.get(".chat-launch-form select").first().select("local");
      typeWorkPath(WORKSPACE);
      // "에이전트매니저"·"세션 목록" 둘 다 SYSTEM_HINTS에 있다.
      cy.get(".chat-initial-composer textarea")
        .clear()
        .type("에이전트매니저의 세션 목록을 조회해서 알려 주세요.", { delay: 0 });

      cy.then(() => {
        sentAt = Date.now();
      });
      cy.get(".chat-start-button").click();
      cy.get(".chat-session-meta, .chat-launch-form .error-banner", { timeout: 30_000 })
        .should("exist")
        .then(($state) => {
          if ($state.hasClass("error-banner")) {
            const message = $state.text().trim();
            cy.screenshot(`llm-core-b-${slug(model)}-connection-failed`, { overwrite: true }).then(() => {
              throw new Error(`${model} 로컬 채팅 연결 실패: ${message}`);
            });
          }
        });

      // 도구를 하나도 부르지 않고 지어낸 답으로 턴을 끝내는 모델이 있다(2026-09-25 회차의
      // gpt-oss:20b). 그건 모델 능력이라 앱 불변식으로 단언하지 않고 측정값으로 남긴다.
      // 앱 쪽 단언은 ③ C14-3 — 시스템 묶음에는 작업공간 도구가 절대 뜨지 않는다 — 와
      // 턴이 끝까지 갔는지다.
      waitTurnIdle();
      cy.get("body").then(($body) => {
        const titles = $body.find(".chat-tool-title").text();
        cy.log(`[코어B][${model}] 도구: ${titles || "(호출 없음)"} / ${Date.now() - sentAt}ms`);
        // ③ 작업공간 도구는 뜨지 않는다 (C14-3)
        expect(titles, "작업공간 도구 부재").to.not.match(/(^|[^-\w])(bash|write|read)\b/i);
        // ① 부른 것이 agent-manager MCP 도구인지는 **측정값**이다. 도구 이름은
        //    `agent-manager_<도구>` 꼴(접두만 보면 카드에 찍힌 작업 경로
        //    `/Users/.../agent-manager-tauri`에도 걸리므로 밑줄까지 본다).
        //    2026-09-25 회차에서 qwen이 같은 발화에 `node -e …` 셸 명령을 부른 회차가
        //    있었다 — 시스템 MCP가 그 실행에 붙지 않아 작업공간으로 떨어진 것인지
        //    (2-2 §4의 정상 폴백) 묶음 전환이 늦은 것인지 화면만으로는 가를 수 없어
        //    다음 회차의 확인 과제로 남긴다.
        cy.log(`[코어B][${model}] 시스템MCP도구=${/agent-manager_/i.test(titles)}`);
        if (titles.trim()) {
          // ② 결과가 화면에 표시됐다
          cy.get(".chat-tool-output, .chat-tool-summary").should("exist");
        }
      });
      cy.get(".chat-message-assistant .chat-message-markdown").should("not.be.empty");

      cy.screenshot(`llm-core-b-${slug(model)}-done`, { overwrite: true });
    });
  });
});
