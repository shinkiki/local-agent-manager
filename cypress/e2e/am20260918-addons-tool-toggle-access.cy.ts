/// <reference types="cypress" />
/**
 * 노션 `AM-235`("애드온 도구 사용 토글 후 기본도구 접근 경로 상세가 같은 화면에서 갱신되는가").
 * 2026-09-11에 절차만 확정하고 **보류**로 남았던 건이다 — 그날은 작업 트리가 깨끗하지 않아
 * 스펙을 추가할 수 없었다. 이번 회차에 트리가 깨끗해 처음으로 실행한다.
 *
 * 보는 것은 **도구 상태 변화가 같은 화면의 다른 표시로 전파되는가**다. 애드온 → Cypress 탭에는
 * 위에 접근 경로 상세(`BuiltinToolAccess`, src/components/BuiltinToolAccess.tsx:37)가, 아래에
 * 그 도구의 사용 스위치(`CypressWorkspacePanel`)가 같이 선다(src/components/AddonsView.tsx:116).
 * 백엔드는 두 표시를 같은 값(`state.cypress_enabled`)에서 뽑는다
 * (crates/agent-manager-core/src/agent_builtin_tools.rs:417) — 켜면 배지 `꺼짐`이 사라지고
 * 도구 설명이 "애드온 → Cypress에서 사용을 켜야 함"에서 "설정에서 사용 중"으로 바뀌어야 한다.
 *
 * 의심하는 결함: 카탈로그 조회 `useEffect`의 의존이 `[active]` 하나다
 * (src/components/BuiltinToolAccess.tsx:17). 사용 스위치는 같은 패널 안의 **다른 카드**가
 * 처리하므로 `active`가 바뀌지 않는다. 그러면 스위치는 켜졌는데 바로 위 상세는 `꺼짐`으로 남아
 * 같은 화면의 두 표시가 서로 어긋난다. 형제 탭을 다녀오면 `shown`이 false→true로 뒤집혀
 * (AddonsView.tsx:114) 다시 읽으므로 그때는 맞아야 한다.
 *
 * 축: 설정 · 조건: 상태 변경의 화면 내 전파, 탭 왕복·새로고침 후 잔존.
 */

const TOGGLE =
  '[data-ui-anchor="addons.cypress-content"] [role="switch"][aria-label="에이전트가 Cypress 자동화를 실행할 수 있음"]';
const OFF_NOTE = "애드온 → Cypress에서 사용을 켜야 함";
const ON_NOTE = "설정에서 사용 중";

function access() {
  return cy.anchor("addons.cypress.access");
}

/** 접근 상세 안에서 Cypress 도구를 쓰는 에이전트 줄 중 첫 줄. 배지와 설명이 한 줄에 함께 선다. */
function firstRow() {
  return access().find("li").first();
}

function openCypressTab() {
  cy.visitApp();
  cy.openAddonsView("cypress");
  cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
}

describe("애드온 도구 사용 토글이 같은 화면의 기본도구 접근 상세로 전파되는가 (AM-235)", () => {
  afterEach(() => {
    // 격리 백엔드는 스펙 사이에 살아 있으므로 켜 둔 채 끝내지 않는다.
    cy.get("body").then(($body) => {
      const toggle = $body.find(TOGGLE);
      if (toggle.length > 0 && toggle.attr("aria-checked") === "true") {
        cy.wrap(toggle).click({ force: true });
      }
    });
  });

  it("끈 상태에서는 상세가 '꺼짐' 배지와 켜라는 안내를 단다", () => {
    openCypressTab();
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");

    access().should("exist").and("not.have.attr", "open");
    access().find("summary").click();
    access().should("have.attr", "open");
    // 스위치가 꺼져 있으면 available=false, enabled=false이므로 배지는 '쓸 수 없음'이 아니라 '꺼짐'이다.
    firstRow().find(".builtin-tool-badge.off").should("have.text", "꺼짐");
    firstRow().find("small").should("contain.text", OFF_NOTE);
  });

  /**
   * 사용 스위치와 바로 위 접근 상세는 같은 값을 읽는다. 한때 상세는 패널 활성화 때만
   * 카탈로그를 읽어, 옆 카드가 스위치를 켜도 8초 재시도 내내 `꺼짐`을 말했다 — 한 화면이
   * 두 말을 했다(QA #95). 지금은 바꾼 자리에서 알려(`builtinToolsSignal`) 곧바로 따라온다.
   */
  it("스위치를 켜면 탭을 옮기지 않아도 바로 위 상세가 곧바로 따라온다", () => {
    openCypressTab();
    access().find("summary").click();
    firstRow().find(".builtin-tool-badge.off").should("exist");

    // 4) 같은 탭에 머문 채 사용 스위치를 켠다.
    cy.get(TOGGLE).click({ force: true });
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");

    // 5) 탭 이동 없이 같은 줄을 다시 본다. 두 표시가 같은 말을 한다.
    firstRow().find("small").should("contain.text", ON_NOTE);
    firstRow().find(".builtin-tool-badge.off").should("not.exist");
  });

  it("형제 탭을 다녀오면 반영되고 새로고침 뒤에도 그대로다", () => {
    openCypressTab();
    access().find("summary").click();
    cy.get(TOGGLE).click({ force: true });
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");

    // 6) 형제 탭을 다녀온다 — shown이 false→true로 뒤집혀 카탈로그를 다시 읽는다.
    cy.openAddonsTab("ssh");
    cy.openAddonsTab("cypress");
    access().should("have.attr", "open");
    firstRow().find("small").should("contain.text", ON_NOTE);
    firstRow().find(".builtin-tool-badge.off").should("not.exist");

    // 7) 새로고침해도 저장값에서 다시 조립되므로 같은 상태다.
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openAddonsView("cypress");
    cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    access().find("summary").click();
    firstRow().find("small").should("contain.text", ON_NOTE);
    firstRow().find(".builtin-tool-badge.off").should("not.exist");
  });
});
