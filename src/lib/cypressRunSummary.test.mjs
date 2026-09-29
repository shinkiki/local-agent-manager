import assert from "node:assert/strict";
import test from "node:test";

import { cypressArtifactLabel, failedCypressTests, summarizeCypressRun } from "./cypressRunSummary.ts";

// 실행 한 건을 사람이 읽는 모양으로 바꾸는 규칙만 본다. 작업공간 안의 파일을 어디까지
// 만질 수 있는지는 cypressWorkspace.test.mjs가 맡는다 — 모듈이 갈라진 경계와 같다.

function runStatus(overrides = {}) {
  return {
    jobId: "job-1",
    workspaceId: "ws-1",
    spec: "e2e/login.cy.js",
    state: "passed",
    startedAt: 1000,
    finishedAt: 5000,
    summary: {
      passed: 3,
      failed: 1,
      pending: 0,
      durationMs: 4200,
      specs: [
        { spec: "e2e/login.cy.js", tests: [
          { title: "로그인 성공", state: "passed", error: null },
          { title: "잘못된 비밀번호", state: "failed", error: "AssertionError: expected 200 to equal 401" },
        ] },
      ],
      screenshots: [],
    },
    artifacts: [],
    outputTail: "",
    message: null,
    ...overrides,
  };
}

test("summarizeCypressRun renders one line per state", () => {
  assert.equal(
    summarizeCypressRun(runStatus({ state: "failed" })),
    "e2e/login.cy.js 실패 · 통과 3 · 실패 1 · 보류 0 · 4.2초",
  );
  assert.equal(
    summarizeCypressRun(runStatus({ spec: null, summary: { passed: 8, failed: 0, pending: 2, durationMs: 125000, specs: [], screenshots: [] } })),
    "전체 스펙 통과 · 통과 8 · 실패 0 · 보류 2 · 2분 5초",
  );
  assert.equal(summarizeCypressRun(runStatus({ state: "running", summary: null, finishedAt: null })), "e2e/login.cy.js 실행 중");
  assert.equal(summarizeCypressRun(runStatus({ state: "timedOut", summary: null, message: "10분 초과" })), "e2e/login.cy.js 시간 초과 · 10분 초과");
  assert.equal(summarizeCypressRun(runStatus({ state: "error", summary: null, message: null })), "e2e/login.cy.js 실행 오류");
  assert.equal(summarizeCypressRun(runStatus({ state: "passed", summary: null })), "e2e/login.cy.js 통과");
});

test("failedCypressTests flattens failed tests with their spec", () => {
  const status = runStatus();
  status.summary.specs.push({
    spec: "e2e/settings.cy.js",
    tests: [
      { title: "설정 열기", state: "passed", error: null },
      { title: "설정 저장", state: "failed", error: "저장 실패" },
    ],
  });

  const failed = failedCypressTests(status);
  assert.deepEqual(failed.map(({ spec, test }) => [spec, test.title]), [
    ["e2e/login.cy.js", "잘못된 비밀번호"],
    ["e2e/settings.cy.js", "설정 저장"],
  ]);
  assert.deepEqual(failedCypressTests(runStatus({ summary: null })), []);
});

test("cypressArtifactLabel drops the run directory prefix", () => {
  assert.equal(
    cypressArtifactLabel("artifacts/runs/9e01fcab6eb04bcca9bad87b7169aa12/screenshots/a.png"),
    "screenshots/a.png",
  );
  assert.equal(cypressArtifactLabel("artifacts/runs/job1/hydration.json"), "hydration.json");
  // 잡 폴더 바로 밑이 아니거나 접두가 다르면 그대로 둔다.
  assert.equal(cypressArtifactLabel("artifacts/runs/job1"), "artifacts/runs/job1");
  assert.equal(cypressArtifactLabel("e2e/login.cy.js"), "e2e/login.cy.js");
});
