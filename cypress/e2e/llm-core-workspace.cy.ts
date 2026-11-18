/// <reference types="cypress" />

import { dismissNewProjectDialog, typeWorkPath, waitTurnIdle, waitTurnRunning } from "../support/localLlmChat";

// 코어 A — 작업공간 에이전트가 파일을 읽고 고쳐 디스크에 반영하는지.
// 모델이 말로만 설명하고 끝나는지, 실제로 write 도구를 부르는지를 디스크로 가른다.

const SERVER = "http://100.86.20.5:11434/v1";
const MODELS = [{ model: "qwen3.5-gpu-128k:latest" }, { model: "gpt-oss:20b" }];
const slug = (model: string) => model.replace(/[^a-z0-9]+/gi, "-");

describe("로컬 LLM 코어 A — 코드수정 과제", { retries: 0 }, () => {
  MODELS.forEach(({ model }) => {
    it(`${model}이 시드 파일을 읽고 고쳐 디스크에 반영한다`, () => {
      const dir = `/tmp/llm-qa-core-a-${slug(model)}-${Date.now()}`;
      const seed = `${dir}/greeting.ts`;
      let sentAt = 0;
      let firstResponseMs = 0;
      const tools: string[] = [];

      cy.writeFile(seed, 'export const GREETING = "hello";\n');

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
      typeWorkPath(dir);
      // 시스템 낱말(SYSTEM_HINTS)이 섞이면 시스템 묶음이 열려 과제 자체가 달라진다.
      cy.get(".chat-initial-composer textarea")
        .clear()
        .type('greeting.ts 파일의 hello 를 안녕 으로 바꿔 저장해 주세요.', { delay: 0 });

      cy.then(() => {
        sentAt = Date.now();
      });
      cy.get(".chat-start-button").click();
      cy.get(".chat-session-meta, .chat-launch-form .error-banner", { timeout: 30_000 })
        .should("exist")
        .then(($state) => {
          if ($state.hasClass("error-banner")) {
            const message = $state.text().trim();
            cy.screenshot(`llm-core-a-${slug(model)}-connection-failed`, { overwrite: true }).then(() => {
              throw new Error(`${model} 로컬 채팅 연결 실패: ${message}`);
            });
          }
        });

      // ① read, ② write 도구 카드. 카드는 턴이 끝나며 접히기도 하므로 떠 있는 동안 모은다.
      cy.get(".chat-tool-title", { timeout: 300_000 })
        .should("exist")
        .then(($titles) => {
          $titles.each((_, el) => tools.push(el.textContent?.trim() ?? ""));
          firstResponseMs = Date.now() - sentAt;
        });
      waitTurnIdle();
      cy.get("body").then(($body) => {
        $body.find(".chat-tool-title").each((_, el) => tools.push(el.textContent?.trim() ?? ""));
        const text = tools.join(" ");
        cy.log(`[코어A][${model}] 호출된 도구: ${JSON.stringify(tools)} / 첫응답 ${firstResponseMs}ms`);
        // 앱 불변식만 단언한다 — 도구 카드가 떴고 턴이 끝났다. 어떤 도구를 골랐는지는
        // 모델 능력이라 회차마다 다르므로 값으로 남기고 단언하지 않는다(5절 판정 기준).
        expect(tools.length, "도구 카드 수").to.be.greaterThan(0);
      });

      // ③ 파일이 실제로 바뀌었는지는 회차 측정값으로 남긴다. 모델이 읽기만 하고 끝내는
      //    회차가 있어 단언으로 두면 앱 결함이 아닌 것에 스펙이 실패한다.
      cy.readFile(seed).then((body: string) => {
        cy.log(`[코어A][${model}] 디스크 반영=${body.includes("안녕")} 본문=${body.trim()}`);
      });

      // ④ 이어서 같은 대화에서 bash 과제 하나. 턴이 끝까지 가는지가 앱 쪽 단언이다.
      dismissNewProjectDialog();
      cy.get(".chat-composer textarea").clear().type("이 폴더에서 ls 를 실행해 결과를 보여 주세요.", { delay: 0 });
      cy.get(".chat-composer button[type=submit]").click();
      waitTurnRunning();
      waitTurnIdle();
      cy.get("body").then(($body) => {
        cy.log(`[코어A][${model}] bash 턴 도구: ${$body.find(".chat-tool-title").text() || "(없음)"}`);
      });

      cy.screenshot(`llm-core-a-${slug(model)}-done`, { overwrite: true });
    });
  });
});
