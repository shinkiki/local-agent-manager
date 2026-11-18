// 애드온 → Cypress 작업공간 '최근 실행' 목록 한 줄의 상태별 요약 문구와 목록 경계.
// summarizeCypressRun이 다섯 상태를 RUN_STATE_SUMMARY 표 한 곳에서 조립하도록 바뀌었고
// (bc74e85, src/lib/cypressWorkspace.ts:62), 목록은 선택한 작업공간의 실행만 10건까지
// 자른다(CypressWorkspacePanel.tsx:492). 꼬리가 없는 상태에서 ' · '가 남지 않는지,
// 소요 시간 표기가 구간마다 바뀌는지, 남의 작업공간 실행이 섞이지 않는지를 화면에서 본다.
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressFileRead,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 최근 실행 목록의 상태별 요약 문구와 목록 경계", () => {
  const workspace = cypressWorkspace();
  const other = cypressWorkspace({ id: "ws-other", name: "다른 작업공간" });

  type RunSeed = {
    jobId: string;
    workspaceId?: string;
    spec: string | null;
    state: "running" | "passed" | "failed" | "timedOut" | "error";
    message?: string | null;
    summary?: { passed: number; failed: number; pending: number; durationMs: number } | null;
  };

  const run = (seed: RunSeed) => ({
    jobId: seed.jobId,
    workspaceId: seed.workspaceId ?? workspace.id,
    spec: seed.spec,
    state: seed.state,
    startedAt: 1_757_000_100_000,
    finishedAt: seed.state === "running" ? null : 1_757_000_200_000,
    summary: seed.summary
      ? { ...seed.summary, specs: [], screenshots: [] }
      : null,
    artifacts: [],
    outputTail: "",
    message: seed.message ?? null,
  });

  const items = () => cy.get(".cypress-recent-runs li .cypress-run-summary");
  const header = () => cy.contains(".cypress-recent-runs .section-title h3", "최근 실행").parent();

  function openPanel(runs: ReturnType<typeof run>[]) {
    stubCypressRegistry([workspace, other]);
    stubCypressWorkspaceFiles([{ path: "cypress.config.js", sizeBytes: 120, sensitive: false }]);
    stubCypressFileRead("cypress.config.js", "module.exports = {};\n");
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: runs });
    openCypressWorkspacePanel();
  }

  it("상태마다 정해진 낱말을 쓰고 꼬리가 없으면 이음말을 남기지 않는다", () => {
    openPanel([
      run({ jobId: "j-pass", spec: "cypress/e2e/sample.cy.js", state: "passed", summary: { passed: 3, failed: 0, pending: 1, durationMs: 12_400 } }),
      run({ jobId: "j-fail", spec: null, state: "failed", summary: null }),
      run({ jobId: "j-timeout", spec: "cypress/e2e/slow.cy.js", state: "timedOut", message: "제한 시간을 넘겼습니다" }),
      run({ jobId: "j-error", spec: null, state: "error", message: null }),
      run({ jobId: "j-run", spec: "cypress/e2e/live.cy.js", state: "running", summary: { passed: 9, failed: 9, pending: 9, durationMs: 1_000 } }),
    ]);

    items().should("have.length", 5);
    items().eq(0).should("have.text", "cypress/e2e/sample.cy.js 통과 · 통과 3 · 실패 0 · 보류 1 · 12초");
    // 집계가 없는 실패는 낱말에서 끝난다 — 꼬리 자리가 비었다고 ' · '가 남으면 안 된다.
    items().eq(1).should("have.text", "전체 스펙 실패");
    items().eq(2).should("have.text", "cypress/e2e/slow.cy.js 시간 초과 · 제한 시간을 넘겼습니다");
    items().eq(3).should("have.text", "전체 스펙 실행 오류");
    // 실행 중은 집계가 딸려 와도 낱말에서 끝난다.
    items().eq(4).should("have.text", "cypress/e2e/live.cy.js 실행 중");
  });

  it("소요 시간은 1초·1분 경계마다 표기 단위가 바뀐다", () => {
    const durations = [820, 4_560, 12_400, 59_400, 90_000, 120_000];
    openPanel(durations.map((durationMs, index) => run({
      jobId: `j-${index}`,
      spec: `cypress/e2e/d${index}.cy.js`,
      state: "passed",
      summary: { passed: 1, failed: 0, pending: 0, durationMs },
    })));

    const expected = ["820ms", "4.6초", "12초", "59초", "1분 30초", "2분"];
    expected.forEach((tail, index) => {
      items().eq(index).should("have.text", `cypress/e2e/d${index}.cy.js 통과 · 통과 1 · 실패 0 · 보류 0 · ${tail}`);
    });
  });

  it("다른 작업공간 실행은 섞이지 않고 목록은 10건에서 끊긴다", () => {
    const mine = Array.from({ length: 12 }, (_, index) => run({
      jobId: `mine-${index}`,
      spec: `cypress/e2e/mine${index}.cy.js`,
      state: "passed",
      summary: { passed: 1, failed: 0, pending: 0, durationMs: 2_000 },
    }));
    const theirs = run({ jobId: "theirs", workspaceId: other.id, spec: "cypress/e2e/theirs.cy.js", state: "failed", summary: null });
    openPanel([...mine.slice(0, 6), theirs, ...mine.slice(6)]);

    items().should("have.length", 10);
    header().find("span").should("have.text", "10건");
    cy.get(".cypress-recent-runs").should("not.contain.text", "theirs.cy.js");
    // 앞선 열 건만 남으므로 열한 번째부터는 화면에 없다.
    items().eq(0).should("contain.text", "cypress/e2e/mine0.cy.js");
    items().eq(9).should("contain.text", "cypress/e2e/mine9.cy.js");
    cy.get(".cypress-recent-runs").should("not.contain.text", "mine10.cy.js");
    cy.get(".cypress-recent-runs").should("not.contain.text", "mine11.cy.js");
  });
});
