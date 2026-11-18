// 애드온 → Cypress '실행' 구역의 런처 열기(수동 단계별 진행).
// 헤드리스 실행과 달리 런처는 사람이 스펙을 고르고 cy.pause()로 끊어 보는 갈래라, 잡에
// 스펙을 싣지 않고(open_cypress_runner에는 spec 인자가 없다) 창을 닫을 때까지 running으로
// 남는다(cypress_runs.rs의 CypressRunMode::Open). 화면이 이 갈래를 실행과 섞어 읽지 않는지
// — 대상 이름을 '전체 스펙'으로 적지 않는지, 격리 실행에서 버튼을 미리 막는지 — 를 본다.
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressFileRead,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 런처 열기의 잡 내용과 화면 표기", () => {
  const workspace = cypressWorkspace();
  const isolated = cypressWorkspace({ id: "ws-isolated", name: "격리 작업공간", executionType: "agentManagerIsolated" });

  const openCalls: Array<Record<string, unknown>> = [];
  const runCalls: Array<Record<string, unknown>> = [];
  const stopCalls: Array<Record<string, unknown>> = [];

  const openButton = () => cy.contains(".detail-card .cypress-form-actions button", "런처 열기");
  const runButton = () => cy.contains(".detail-card .cypress-form-actions button.primary", "실행");
  const runHead = () => cy.get(".cypress-run-result .cypress-run-head");
  const stopButton = () => cy.contains(".detail-card .cypress-form-actions button", "중지");

  function setupPanel(workspaces = [workspace]) {
    openCalls.length = 0;
    runCalls.length = 0;
    stopCalls.length = 0;
    stubCypressRegistry(workspaces);
    stubCypressWorkspaceFiles([
      { path: "cypress.config.js", sizeBytes: 120, sensitive: false },
      { path: "cypress/e2e/sample.cy.js", sizeBytes: 80, sensitive: false },
    ]);
    stubCypressFileRead("cypress.config.js", "module.exports = {};\n");
    cy.stubInvoke("open_cypress_runner", (req) => {
      const body = req.body as Record<string, unknown>;
      openCalls.push(body);
      req.reply({
        statusCode: 200,
        body: {
          jobId: "job-open",
          workspaceId: String(body.id ?? workspace.id),
          mode: "open",
          spec: null,
          state: "running",
          startedAt: Date.now(),
          finishedAt: null,
          summary: null,
          artifacts: [],
          outputTail: "",
          message: null,
        },
      });
    });
    cy.stubInvoke("stop_cypress_run", (req) => {
      stopCalls.push(req.body as Record<string, unknown>);
      req.reply({ statusCode: 200, body: { jobId: "job-open", workspaceId: workspace.id, mode: "open", spec: null, state: "closed", startedAt: Date.now(), finishedAt: Date.now(), summary: null, artifacts: [], outputTail: "", message: "중지했습니다" } });
    });
    cy.stubInvoke("run_cypress_spec", (req) => {
      runCalls.push(req.body as Record<string, unknown>);
      req.reply({ statusCode: 200, body: { jobId: "job-run", workspaceId: workspace.id, mode: "run", spec: null, state: "running", startedAt: Date.now(), finishedAt: null, summary: null, artifacts: [], outputTail: "", message: null } });
    });
    openCypressWorkspacePanel();
  }

  it("스펙을 골라 두어도 런처 잡에는 싣지 않고, 추가 env만 넘긴다", () => {
    setupPanel();
    cy.get("#cypress-spec").select("cypress/e2e/sample.cy.js");
    cy.get("#cypress-env").type('{"BASE_URL": "https://example.com"}', { parseSpecialCharSequences: false });
    openButton().click();

    cy.wrap(null).should(() => {
      expect(openCalls, "런처 열기 호출").to.have.length(1);
      expect(openCalls[0].id).to.equal(workspace.id);
      expect(openCalls[0].env).to.deep.equal({ BASE_URL: "https://example.com" });
      // 스펙 고르기는 런처 안에서 사람이 한다 — 잡에 실렸다면 화면이 실행과 섞어 읽은 것이다.
      expect(openCalls[0], "런처 잡에 스펙 없음").to.not.have.property("spec");
      expect(runCalls, "실행은 부르지 않는다").to.have.length(0);
    });
  });

  it("열린 런처는 '런처 실행 중'으로 적고 창을 닫으라고 안내한다", () => {
    setupPanel();
    openButton().click();

    // 스펙이 비어 있다고 '전체 스펙 실행 중'으로 읽으면, 열어만 둔 런처가 스펙을 모두 돌리는
    // 것처럼 보인다.
    runHead().should("contain.text", "런처 실행 중");
    runHead().should("not.contain.text", "전체 스펙");
    runHead().should("contain.text", "창을 닫으면 끝납니다");
    // 런처가 떠 있는 동안은 헤드리스 실행도 막는다 — 같은 프로젝트를 둘이 잡으면 엉킨다.
    runButton().should("be.disabled");

    // 창이 호스트에 뜨는 갈래라, 그 창을 여기서 끊을 길이 함께 있어야 한다.
    stopButton().should("not.be.disabled").click();
    cy.wrap(null).should(() => {
      expect(stopCalls, "중지 호출").to.have.length(1);
      expect(stopCalls[0].jobId).to.equal("job-open");
    });
    runHead().should("contain.text", "런처 닫힘");
    // 끝난 뒤에는 중지 버튼이 사라지고 다시 열 수 있다.
    cy.contains(".detail-card .cypress-form-actions button", "중지").should("not.exist");
    openButton().should("not.be.disabled");
  });

  it("격리 실행 작업공간도 런처로 연다", () => {
    // 하네스가 임시 포트·상태로 앱을 띄운 채 런처를 열므로 막을 이유가 없다. 앱 자체 QA를
    // 단계별로 보는 것이 이 기능을 가장 많이 쓰는 자리다.
    setupPanel([isolated]);
    openButton().should("not.be.disabled");
    openButton().click();
    cy.wrap(null).should(() => {
      expect(openCalls, "런처 열기 호출").to.have.length(1);
      expect(openCalls[0].id).to.equal(isolated.id);
    });
  });

  it("닫힌 런처는 최근 실행에서 실패가 아니라 '런처 닫힘'으로 남는다", () => {
    openCalls.length = 0;
    stubCypressRegistry([workspace]);
    stubCypressWorkspaceFiles([{ path: "cypress.config.js", sizeBytes: 120, sensitive: false }]);
    stubCypressFileRead("cypress.config.js", "module.exports = {};\n");
    cy.stubInvoke("list_cypress_runs", {
      statusCode: 200,
      body: [{
        jobId: "job-closed",
        workspaceId: workspace.id,
        mode: "open",
        spec: null,
        state: "closed",
        startedAt: 1_757_000_100_000,
        finishedAt: 1_757_000_200_000,
        summary: null,
        artifacts: [],
        outputTail: "",
        message: null,
      }],
    });
    openCypressWorkspacePanel();

    cy.get(".cypress-recent-runs li .cypress-run-summary").should("have.text", "런처 닫힘");
    // 실패·오류와 같은 붉은 표시를 붙이면 수동 점검마다 오류처럼 쌓인다.
    cy.get(".cypress-recent-runs li .skill-sync-pill").should("not.have.class", "conflict");
  });
});
