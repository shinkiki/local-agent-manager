// Cypress 작업공간 '실행' 구역의 '추가 env' JSON 경계와 오류 안내.
// startRun은 parseEnvJsonText로 먼저 걸러 실패하면 실행을 부르지 않는다
// (CypressWorkspacePanel.tsx:473). 잘못된 입력이 실제 실행으로 새지 않는지,
// 숫자·불리언이 문자열로 바뀌어 넘어가는지를 화면에서 확인한다.
// 격리 백엔드에는 모듈이 설치된 작업공간이 없어 실행 버튼이 잠기므로 목록·파일 응답만 세운다.
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressFileRead,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 실행 폼 추가 env JSON의 경계와 오류 안내", () => {
  const workspace = cypressWorkspace();

  const runCalls: Array<Record<string, unknown>> = [];

  const envInput = () => cy.get("#cypress-env");
  const runButton = () => cy.contains(".detail-card .cypress-form-actions button.primary", "실행");
  // QA #61. 화면이 보내기 전에 걸러낸 입력 오류는 실패 배너가 아니라 안내 배너다 —
  // 요청이 나간 적이 없으므로 '요청을 처리하지 못했습니다'도 오류코드도 붙이지 않는다.
  const banner = () => cy.get(".detail-card .notice-banner");

  beforeEach(() => {
    runCalls.length = 0;
    stubCypressRegistry([workspace]);
    stubCypressWorkspaceFiles([
      { path: "cypress.config.js", sizeBytes: 120, sensitive: false },
      { path: "cypress/e2e/sample.cy.js", sizeBytes: 80, sensitive: false },
    ]);
    stubCypressFileRead("cypress.config.js", "module.exports = {};\n");
    cy.stubInvoke("run_cypress_spec", (req) => {
      runCalls.push(req.body as Record<string, unknown>);
      req.reply({
        statusCode: 200,
        body: {
          jobId: "job-1",
          workspaceId: workspace.id,
          spec: null,
          state: "running",
          startedAt: Date.now(),
          finishedAt: null,
          exitCode: null,
          output: "",
          artifacts: [],
        },
      });
    });

    openCypressWorkspacePanel();
    cy.contains(".settings-subsection header strong", "실행").should("be.visible");
    runButton().should("not.be.disabled");
  });

  it("문법이 깨진 JSON은 실행을 부르지 않고 읽기 실패를 알린다", () => {
    envInput().type('{"BASE_URL": }', { parseSpecialCharSequences: false });
    runButton().click();
    banner().should("contain.text", "env JSON을 읽을 수 없습니다");
    banner().should("have.attr", "role", "note");
    cy.get(".detail-card .error-banner").should("not.exist");
    cy.wrap(null).should(() => expect(runCalls, "실행 호출").to.have.length(0));
  });

  it("배열이나 원시값은 객체 형태를 요구한다", () => {
    envInput().clear().type('["BASE_URL"]', { parseSpecialCharSequences: false });
    runButton().click();
    banner().should("contain.text", "형태의 객체여야 합니다");
    cy.wrap(null).should(() => expect(runCalls).to.have.length(0));
  });

  it("값이 객체인 항목은 키 이름과 함께 거절한다", () => {
    envInput().clear().type('{"TOKEN": {"nested": 1}}', { parseSpecialCharSequences: false });
    runButton().click();
    banner().should("contain.text", "env 값 'TOKEN'");
    cy.wrap(null).should(() => expect(runCalls).to.have.length(0));
  });

  it("숫자·불리언은 문자열로 바뀌어 실행에 실려 가고 오류 안내는 걷힌다", () => {
    envInput().clear().type('["BASE_URL"]', { parseSpecialCharSequences: false });
    runButton().click();
    banner().should("be.visible");

    envInput().clear().type('{"RETRIES": 2, "HEADED": false, "BASE_URL": "https://example.com"}', { parseSpecialCharSequences: false });
    runButton().click();
    cy.get(".detail-card .notice-banner").should("not.exist");
    cy.get(".detail-card .error-banner").should("not.exist");
    cy.wrap(null).should(() => {
      expect(runCalls, "실행 호출").to.have.length(1);
      expect(runCalls[0].env).to.deep.equal({ RETRIES: "2", HEADED: "false", BASE_URL: "https://example.com" });
      expect(runCalls[0].spec, "스펙 미선택이면 전체").to.equal(null);
    });
  });

  it("빈 env는 그대로 실행되고 env 없이 넘어간다", () => {
    envInput().should("have.value", "");
    runButton().click();
    cy.wrap(null).should(() => {
      expect(runCalls).to.have.length(1);
      expect(runCalls[0].env, "빈 env는 null").to.equal(null);
    });
  });
});
