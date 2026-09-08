/// <reference types="cypress" />
// QA #53 (AM-194 넷째 케이스): '나중에'로 미뤄 둔 새 프로젝트 알림창은 대기 집합이 줄기만 해도
// 다시 뜨지 않는다. 남은 프로젝트는 사용자가 이미 미뤄 둔 바로 그것이라 새로 알릴 것이 없다.
// 반대로 미뤄 둔 적 없는 프로젝트가 더 감지되면 지금처럼 다시 뜬다(대조군).
//
// 하네스에는 결정 대기 프로젝트가 없으므로 `get_manager_snapshot` 응답의 `pendingProjects`를
// 스펙이 쥔 변수로 갈아끼운다. 새로 읽기는 사이드바 로고(데이터 새로고침)로 일으킨다.
import type { ProjectRegistryEntry } from "../../src/types";

function project(name: string): ProjectRegistryEntry {
  return {
    path: `/tmp/qa53/${name}`,
    name,
    sessionCount: 2,
    hiddenSessionCount: 0,
    updatedAt: null,
    providers: ["claude"],
    active: true,
    pending: true,
    exists: true,
  };
}

const alpha = project("alpha");
const beta = project("beta");
const gamma = project("gamma");

// 부정 단언(`not.exist`)은 cy.get 바로 뒤에서만 통과하므로 필터를 겹치지 않고 제목은 따로 본다.
const modal = () => cy.get(".modal");
const TITLE = "새 프로젝트 감지";

describe("새 프로젝트 알림창의 '나중에' 계약", () => {
  it("미뤄 둔 집합이 줄어도 다시 뜨지 않고, 새 프로젝트가 더 감지되면 다시 뜬다", () => {
    let pending: ProjectRegistryEntry[] = [alpha, beta];
    cy.intercept("POST", "**/api/invoke/get_manager_snapshot", (req) => {
      req.continue((res) => {
        res.body = { ...(res.body as Record<string, unknown>), pendingProjects: pending };
      });
    });
    const refreshSnapshot = (alias: string) => {
      cy.intercept("POST", "**/api/invoke/get_manager_snapshot").as(alias);
      cy.get(".brand-logo").click();
      cy.wait(`@${alias}`);
      // 응답이 화면에 반영될 틈. 부정 단언은 기다려 주지 않으므로 여기서 한 번 멈춘다.
      cy.wait(500);
    };

    // 1) 결정 대기 2건으로 시작 — 알림창이 두 줄로 뜬다.
    cy.visitApp();
    modal().should("be.visible").and("contain.text", TITLE);
    modal().find(".new-projects-row").should("have.length", 2);

    // 2) '나중에'로 닫는다.
    modal().contains("button", "나중에").click();
    modal().should("not.exist");

    // 3) 같은 집합을 다시 읽어도 뜨지 않는다(기존 계약).
    refreshSnapshot("same");
    modal().should("not.exist");

    // 4) beta가 설정에서 정리되어 대기 집합이 alpha 하나로 줄었다 — 회귀 지점. alpha는 2)에서
    //    이미 미뤄 둔 프로젝트라 새로 알릴 것이 없다.
    // 대기 집합 교체는 커맨드 큐 안에서 한다 — 테스트 본문의 대입은 첫 커맨드보다 먼저 전부 실행된다.
    cy.then(() => { pending = [alpha]; });
    refreshSnapshot("shrunk");
    modal().should("not.exist");
    cy.screenshot("qa53-no-modal-after-shrink");

    // 5) 대조군: 미뤄 둔 적 없는 gamma가 더 감지되면 다시 뜬다. 목록에는 아직 결정 대기인 alpha도 함께 남는다.
    cy.then(() => { pending = [alpha, gamma]; });
    refreshSnapshot("grown");
    modal().should("be.visible").and("contain.text", TITLE);
    modal().find(".new-projects-row").should("have.length", 2);
    modal().should("contain.text", "gamma");
  });
});
