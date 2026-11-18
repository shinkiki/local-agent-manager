/// <reference types="cypress" />
import { WORKFLOW_LIMITS, stubWorkflowDetailsById, workflowSummary } from "../support/workflowFixtures";

/**
 * 워크플로 관리 화면 **개요 다섯 칸의 숫자**가 아래 목록이 말하는 사실과 어긋나지 않는지 본다.
 *
 * 숫자는 `workflowOverviewCounts`가 목록 한 번 순회로 만들고(WorkflowsView.tsx:678), 같은
 * 판정을 목록 카드의 배지도 쓴다(같은 파일 758~765줄). 개요와 배지가 같은 기준을 쓰는지는
 * 세 가지가 서로 직교하기 때문에 섞어 두고 봐야 드러난다.
 *
 * - `실행 가능`은 `compatible`, `최근 성공`은 `lastExecution.succeeded`를 센다.
 * - `페이싱 회차`는 "페이싱 대상 계약"이 아니라 **켜진 회차가 실제로 도는** 것만 센다
 *   (같은 파일 274~277줄): `pacingEnabled === true`이고 그 워크플로의 대표 회차가
 *   `enabled === true`여야 한다. 회차가 없거나 일시정지면 세지 않고, 회차가 켜져 있어도
 *   계약의 페이싱이 꺼져 있으면 세지 않는다.
 * - `등록`의 꼬리는 한도가 왔을 때만 ` / {maxWorkflows}`이고, 오지 않으면 `개`로 두며 한도
 *   요약은 `한도 확인 중`이 된다(같은 파일 722·728줄).
 *
 * 기존 워크플로 시나리오는 개요의 **이름표**(am20260917-workflow-catalog-language)와
 * 일시정지 회차의 배지·모달(am20260913-workflow-paused-round-run), 빈 목록의 AIA 안내
 * (am20260906-workflow-empty-aia-author)까지만 봤다. 개요에 찍히는 **값**이 목록과 맞는지,
 * 한도가 없을 때의 꼬리가 어떻게 되는지는 어느 시나리오도 확인한 적이 없다.
 *
 * 축은 워크플로·반복요청, 조건은 대량·혼합 상태와 경계값(한도 미도착·등록 0건)이다.
 */

// 셋(실행 가능·최근 성공·페이싱)을 일부러 엇갈리게 둔다. 한 계약이 세 가지를 모두 만족하면
// 개요 숫자가 서로 다른 필드를 보는지 가릴 수 없다.
const ALL_THREE = workflowSummary({
  compatible: true,
  description: "셋 모두 만족",
  displayName: "가-모두",
  id: "wf-all",
  pacingCapable: true,
  pacingEnabled: true,
});
const NONE = workflowSummary({
  compatible: false,
  description: "회차가 일시정지라 페이싱으로 세지 않는다",
  displayName: "나-없음",
  id: "wf-none",
  pacingCapable: true,
  pacingEnabled: true,
});
const COMPATIBLE_ONLY = workflowSummary({
  compatible: true,
  description: "페이싱 대상이지만 도는 회차가 없다",
  displayName: "다-실행가능",
  id: "wf-compatible",
  pacingCapable: true,
  pacingEnabled: true,
});
const SUCCESS_ONLY = workflowSummary({
  compatible: false,
  description: "켜진 회차가 있어도 계약 페이싱이 꺼져 있다",
  displayName: "라-성공",
  id: "wf-success",
});

const SUMMARIES = [ALL_THREE, NONE, COMPATIBLE_ONLY, SUCCESS_ONLY];

function execution(succeeded: boolean) {
  return {
    executionId: `exec-${succeeded ? "ok" : "ng"}`,
    failedStepId: succeeded ? null : "step-1",
    finishedAt: 1_758_000_100,
    startedAt: 1_758_000_000,
    stepStatuses: [],
    succeeded,
    version: 1,
  };
}

/** 개요가 보는 세 필드를 요약마다 다르게 심은 목록 응답. */
const LIST = [
  { ...ALL_THREE, lastExecution: execution(true) },
  { ...NONE, lastExecution: execution(false) },
  { ...COMPATIBLE_ONLY, lastExecution: null },
  { ...SUCCESS_ONLY, lastExecution: execution(true) },
];

function round(id: string, workflowId: string, enabled: boolean) {
  return {
    enabled,
    id,
    name: `${workflowId} 회차`,
    workflow: { approvedVersion: 1, arguments: {}, pacing: { maxRuns: 1 }, workflowId },
  };
}

const SCHEDULES = [
  round("sched-all", "wf-all", true),
  round("sched-none", "wf-none", false),
  // wf-compatible에는 회차가 없다.
  round("sched-success", "wf-success", true),
];

const stat = (index: number) => cy.get(".workflow-overview-stats > div").eq(index).find("dd");

function openWorkflows(limits: unknown, workflows: unknown[], schedules: unknown[]): void {
  const body: Record<string, unknown> = { workflows };
  if (limits) body.limits = limits;
  cy.stubInvoke("get_system_workflows", body);
  stubWorkflowDetailsById(SUMMARIES);
  cy.stubInvoke("get_scheduler_snapshot", { paused: false, runnerActive: true, runs: [], schedules });
  cy.visitApp();
  cy.openView("workflows");
  cy.get(".workflow-overview").should("exist");
}

describe("워크플로 개요 다섯 칸의 값", () => {
  it("실행 가능·페이싱 회차·최근 성공을 각자 다른 필드로 세고, 목록 배지와 같은 수를 말한다", () => {
    openWorkflows(WORKFLOW_LIMITS, LIST, SCHEDULES);

    cy.get(".workflow-list .workflow-card-main").should("have.length", 4);

    // 등록 4 / 64 — 꼬리는 한도의 maxWorkflows다.
    stat(0).should("have.text", `4 / ${WORKFLOW_LIMITS.maxWorkflows}`);
    // 실행 가능: 가-모두, 다-실행가능
    stat(1).should("have.text", "2개");
    // 페이싱 회차: 켜진 회차가 도는 가-모두 하나뿐. 일시정지(나-없음)·회차 없음(다-실행가능)·
    // 계약 페이싱 꺼짐(라-성공)은 모두 빠진다.
    stat(2).should("have.text", "1개");
    // 최근 성공: 가-모두, 라-성공. 실패(나-없음)와 실행 전(다-실행가능)은 빠진다.
    stat(3).should("have.text", "2개");

    // 목록 배지가 같은 사실을 말한다.
    cy.get(".workflow-card-badges em.compatible").should("have.length", 2);
    cy.get(".workflow-card-badges em.succeeded").should("have.length", 2);
    cy.get(".workflow-card-badges em.failed").should("have.length", 1);
    cy.get(".workflow-card-badges em.idle").should("have.length", 1);
    cy.get(".workflow-card-badges em.paced").should("have.length", 1);

    // 한도 요약은 단계·반복·호출 세 수치를 함께 적는다.
    cy.get(".workflow-limit-summary dd").should(
      "have.text",
      `단계 ${WORKFLOW_LIMITS.maxSteps} · 반복 ${WORKFLOW_LIMITS.maxForEachIterations}`
        + ` · 호출 ${WORKFLOW_LIMITS.maxTotalOperationCalls}`,
    );
  });

  it("한도가 오지 않고 등록이 0건이면 등록 꼬리는 개로 두고 한도는 확인 중으로 알린다", () => {
    openWorkflows(null, [], []);

    stat(0).should("have.text", "0개");
    stat(1).should("have.text", "0개");
    stat(2).should("have.text", "0개");
    stat(3).should("have.text", "0개");
    cy.get(".workflow-limit-summary dd").should("have.text", "한도 확인 중");
    cy.get(".workflow-catalog-empty").should("contain.text", "아직 워크플로가 없습니다");
  });
});
