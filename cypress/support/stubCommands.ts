/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

import type { RouteHandler } from "cypress/types/net-stubbing";

// 스텁이 걸리는 자리는 언제나 `POST **/api/invoke/<명령>` 하나다. 스펙이 그 URL 모양을 직접
// 적으면 경로가 바뀔 때 고칠 곳이 스펙 수만큼 늘어난다(열일곱 스펙이 실제로 그렇게 적고 있었다).
// 명령 이름만 받아 여기서 조립한다. 별칭은 `cy.stubInvoke(...).as("x")`로 그대로 붙는다.
// 라우트 일치 조건을 더 거는 스펙(`times` 같은 routeMatcher 옵션)은 이 명령으로 표현할 수
// 없으므로 `cy.intercept`를 그대로 쓴다.
Cypress.Commands.add("stubInvoke", (command: string, response?: RouteHandler) =>
  response === undefined
    ? cy.intercept("POST", `**/api/invoke/${command}`)
    : cy.intercept("POST", `**/api/invoke/${command}`, response),
);

Cypress.Commands.add("e2e", () => cy.window().its("__agentManagerE2E"));

// 격리 백엔드에는 산출물·설치 스킬·세션·에이전트 정의·결정 대기 프로젝트가 하나도 없어,
// "목록이 있는 상태"를 보는 스펙은 실제 `get_manager_snapshot` 응답을 그대로 흘리고 한 필드만
// 갈아 끼운다. 여덟 스펙이 저마다 `req.continue`와 응답 본문 캐스팅 다섯 줄을 적어 두었고,
// 캐스팅 모양마저 갈려 있었다(`{ artifacts: unknown[] }`·`{ sessions: SessionSummary[] }`·본문 통째 교체).
// 필드 이름만 다른 같은 절차이므로 여기 한 벌로 둔다. 값 대신 함수를 주면 요청마다 다시 읽어,
// 테스트 중간에 목록이 바뀌는 스펙도 같은 명령을 쓴다. 스냅샷의 중첩 필드(예: status.providers)를
// 손보는 스펙은 필드 교체가 아니므로 그대로 `stubInvoke`를 쓴다.
Cypress.Commands.add("stubSnapshotField", (field: string, value: unknown) =>
  cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      (res.body as Record<string, unknown>)[field] = typeof value === "function" ? (value as () => unknown)() : value;
    });
  }),
);


