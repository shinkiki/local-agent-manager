import assert from "node:assert/strict";
import test from "node:test";

import {
  failedCypressTests,
  isSensitiveCypressFile,
  parseEnvJsonText,
  specFiles,
  summarizeCypressRun,
  validateWorkspaceRelativePath,
} from "./cypressWorkspace.ts";

function file(path, extra = {}) {
  return { path, sizeBytes: 10, sensitive: false, ...extra };
}

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

test("only cypress.env.json is treated as the sensitive file, wherever it sits", () => {
  assert.equal(isSensitiveCypressFile("cypress.env.json"), true);
  assert.equal(isSensitiveCypressFile("config/cypress.env.json"), true);
  assert.equal(isSensitiveCypressFile("  cypress.env.json "), true);
  assert.equal(isSensitiveCypressFile("cypress.config.js"), false);
  assert.equal(isSensitiveCypressFile("e2e/cypress.env.json.bak"), false);
  assert.equal(isSensitiveCypressFile("my-cypress.env.json"), false);
});

test("specFiles keeps only e2e/*.cy.{js,ts} and sorts by path", () => {
  const files = [
    file("e2e/zeta.cy.ts"),
    file("cypress.config.js"),
    file("e2e/alpha.cy.js"),
    file("e2e/nested/beta.cy.js"),
    file("e2e/helpers.js"),
    file("support/e2e.cy.js"),
    file("e2e/readme.md"),
  ];
  assert.deepEqual(specFiles(files).map((item) => item.path), [
    "e2e/alpha.cy.js",
    "e2e/nested/beta.cy.js",
    "e2e/zeta.cy.ts",
  ]);
  assert.deepEqual(specFiles([]), []);
});

test("workspace relative paths reject empty, traversal, absolute and reserved folders", () => {
  assert.equal(validateWorkspaceRelativePath("e2e/login.cy.js"), null);
  assert.equal(validateWorkspaceRelativePath("cypress.config.js"), null);
  assert.equal(validateWorkspaceRelativePath("support/commands.js"), null);
  assert.match(validateWorkspaceRelativePath(""), /입력/);
  assert.match(validateWorkspaceRelativePath("   "), /입력/);
  assert.match(validateWorkspaceRelativePath("../secret.txt"), /상위 폴더/);
  assert.match(validateWorkspaceRelativePath("e2e/../../x.js"), /상위 폴더/);
  assert.match(validateWorkspaceRelativePath("/etc/passwd"), /상대 경로/);
  assert.match(validateWorkspaceRelativePath("C:\\Users\\x.js"), /상대 경로/);
  assert.match(validateWorkspaceRelativePath("node_modules/cypress/package.json"), /node_modules/);
  assert.match(validateWorkspaceRelativePath("artifacts/run.json"), /artifacts/);
  assert.match(validateWorkspaceRelativePath("e2e/"), /파일 이름/);
  assert.match(validateWorkspaceRelativePath("e2e//a.cy.js"), /빈 폴더/);
});

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
  const failed = failedCypressTests(runStatus());
  assert.equal(failed.length, 1);
  assert.equal(failed[0].spec, "e2e/login.cy.js");
  assert.equal(failed[0].test.title, "잘못된 비밀번호");
  assert.deepEqual(failedCypressTests(runStatus({ summary: null })), []);
});

test("parseEnvJsonText accepts flat objects and returns Error otherwise", () => {
  assert.deepEqual(parseEnvJsonText(""), {});
  assert.deepEqual(parseEnvJsonText("   \n"), {});
  assert.deepEqual(parseEnvJsonText('{"BASE_URL": "https://example.com", "RETRIES": 2, "HEADLESS": true}'), {
    BASE_URL: "https://example.com",
    RETRIES: "2",
    HEADLESS: "true",
  });
  assert.ok(parseEnvJsonText("{ not json") instanceof Error);
  assert.ok(parseEnvJsonText("[1, 2]") instanceof Error);
  assert.ok(parseEnvJsonText("null") instanceof Error);
  assert.ok(parseEnvJsonText('"text"') instanceof Error);
  const nested = parseEnvJsonText('{"A": {"b": 1}}');
  assert.ok(nested instanceof Error);
  assert.match(nested.message, /'A'/);
});
