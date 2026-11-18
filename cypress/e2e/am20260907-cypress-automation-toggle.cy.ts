/// <reference types="cypress" />
/**
 * 애드온 → Cypress의 자동화 작업공간(addons.cypress-content) 패널.
 * "에이전트가 Cypress 자동화를 실행할 수 있음" 토글(role="switch")의 기본 상태(꺼짐),
 * 켜기 조작 및 백엔드 설정 반영, 껐을 때 하단 실행 구역의 안내 문구 노출
 * ("위 토글이 꺼져 있어도 여기서 직접 실행은 할 수 있습니다."),
 * 새로고침 후 복원, 다시 끄기 조작 라이프사이클을 검증한다.
 *
 * 축: 설정 (Cypress 자동화)
 * 조건: 스위치 조작, 연동 안내 문구 노출/숨김, 새로고침 후 잔존 및 복원.
 *
 * 실행 구역은 사용자가 작업공간을 고른 뒤에만 선다 — 암묵적인 기본 작업공간은 없어졌다(C7-5a).
 * 토글 값(`enabled`)은 실제 격리 백엔드가 저장·복원해야 이 스펙의 뜻이 남으므로, 등록부 응답은
 * 통째로 바꾸지 않고 백엔드 응답을 그대로 흘리며 모듈이 준비된 작업공간 하나만 끼워 넣는다.
 */
import { cypressWorkspace, stubCypressWorkspaceFiles } from "../support/cypressWorkspaceFixtures";

const TOGGLE = '[data-ui-anchor="addons.cypress-content"] [role="switch"][aria-label="에이전트가 Cypress 자동화를 실행할 수 있음"]';
const MANUAL_RUN_NOTE = "위 토글이 꺼져 있어도 여기서 직접 실행은 할 수 있습니다.";

const WORKSPACE = cypressWorkspace({ id: "ws-toggle", name: "토글 작업공간", path: "/tmp/e2e-cypress-toggle" });

/** 백엔드가 돌려준 등록부(토글 값 포함)에 작업공간 하나만 끼워 넣는다. */
function injectWorkspace(req: { continue: (handler: (res: { body: unknown }) => void) => void }): void {
  req.continue((res) => {
    (res.body as { workspaces: unknown[] }).workspaces = [WORKSPACE];
  });
}

describe("Cypress 작업공간 에이전트 자동화 실행 스위치 라이프사이클과 수동 실행 안내", () => {
  beforeEach(() => {
    cy.stubInvoke("get_cypress_registry", injectWorkspace);
    cy.stubInvoke("set_cypress_enabled", injectWorkspace);
    stubCypressWorkspaceFiles([]);
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: [] });
  });

  /** 패널이 등록부를 다 읽은 뒤 작업공간을 명시적으로 골라 실행 구역을 연다. */
  const selectWorkspace = () => {
    cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
    cy.contains(".cypress-workspace-select", WORKSPACE.name).click();
    cy.get(".cypress-workspace-select").should("have.attr", "aria-pressed", "true");
  };

  const openAutomation = () => {
    cy.visitApp();
    cy.openAddonsView("cypress");
    selectWorkspace();
  };

  afterEach(() => {
    // 실패 뒤 재시도도 같은 백엔드 설정을 이어받으므로 매 시도 끝에서 기본값(꺼짐)으로 복구
    cy.get("body").then(($body) => {
      const toggle = $body.find(TOGGLE);
      if (toggle.length > 0 && toggle.attr("aria-checked") === "true") {
        cy.wrap(toggle).click({ force: true });
      }
    });
  });

  it("에이전트 실행 허용 스위치는 기본 꺼짐이며 켜면 수동 안내가 사라지고 새로고침 후에도 유지되며 다시 끄면 안내가 복원된다", () => {
    openAutomation();

    // 1) 초기 상태: 격리 환경에서 에이전트 Cypress 실행 스위치는 기본 꺼짐(false)이고 수동 실행 안내가 보임
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false").and("be.enabled");
    cy.get(".cypress-panel").should("contain.text", MANUAL_RUN_NOTE);

    // 2) 켜기 조작: 스위치가 켜지고(true), 실행 구역에서 수동 실행 안내가 사라짐
    cy.get(TOGGLE).click({ force: true });
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(".cypress-panel").should("not.contain.text", MANUAL_RUN_NOTE);

    // 3) 새로고침 후 복원 확인: 백엔드에 저장되어 새로고침 후에도 켜진 상태가 유지됨
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openAddonsView("cypress");
    selectWorkspace();
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.get(".cypress-panel").should("not.contain.text", MANUAL_RUN_NOTE);

    // 4) 다시 끄기 조작: 스위치가 꺼지고(false), 수동 실행 안내가 다시 나타남
    cy.get(TOGGLE).click({ force: true });
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.get(".cypress-panel").should("contain.text", MANUAL_RUN_NOTE);

    // 5) 다시 새로고침 후 복원 확인: 꺼진 상태가 정상 유지됨
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openAddonsView("cypress");
    selectWorkspace();
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.get(".cypress-panel").should("contain.text", MANUAL_RUN_NOTE);
  });
});
