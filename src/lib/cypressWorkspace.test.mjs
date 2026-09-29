import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCypressFilePaths,
  isCypressSpecFile,
  isMissingCypressFile,
  isSensitiveCypressFile,
  specFiles,
  validateWorkspaceRelativePath,
} from "./cypressWorkspace.ts";

// 작업공간 안의 파일을 어디까지 만질 수 있고 무엇이 스펙인지만 본다. 실행 요약은
// cypressRunSummary.test.mjs가, env JSON 파싱은 cypressEnv.test.mjs가 맡는다 — 모듈이
// 갈라진 경계와 같다. 예전에는 이 파일이 그 셋을 창구(다시 내보내기) 너머로 한 번 더
// 시험해, env 시험은 두 파일에 글자까지 같은 한 벌로 남아 있었다.

function file(path, extra = {}) {
  return { path, sizeBytes: 10, sensitive: false, ...extra };
}

test("only cypress.env.json is treated as the sensitive file, wherever it sits", () => {
  assert.equal(isSensitiveCypressFile("cypress.env.json"), true);
  assert.equal(isSensitiveCypressFile("config/cypress.env.json"), true);
  assert.equal(isSensitiveCypressFile("  cypress.env.json "), true);
  assert.equal(isSensitiveCypressFile("cypress.config.js"), false);
  assert.equal(isSensitiveCypressFile("e2e/cypress.env.json.bak"), false);
  assert.equal(isSensitiveCypressFile("my-cypress.env.json"), false);
});

test("only a missing-file failure lets the editor open a path as a new file", () => {
  assert.equal(isMissingCypressFile("파일이 없습니다: /ws/e2e/new.cy.js"), true);
  // 호출부가 앞에 자기 문장을 붙여 보내는 경로도 있다.
  assert.equal(isMissingCypressFile("요청을 처리하지 못했습니다. 파일이 없습니다: e2e/a.cy.js"), true);
  // 아래는 모두 "없는 파일"이 아니다. 새 파일로 열면 저장 때 원본이 빈 파일이 된다.
  assert.equal(isMissingCypressFile("파일이 너무 큽니다. 최대 524288바이트까지 허용됩니다"), false);
  assert.equal(isMissingCypressFile("작업공간 폴더가 없습니다: /ws"), false);
  assert.equal(isMissingCypressFile("원격에서 읽을 수 없습니다"), false);
  assert.equal(isMissingCypressFile(""), false);
});

test("isCypressSpecFile recognizes *.cy.{js,ts} under any e2e/ folder", () => {
  assert.equal(isCypressSpecFile("e2e/login.cy.js"), true);
  assert.equal(isCypressSpecFile("cypress/e2e/repo.cy.ts"), true);
  assert.equal(isCypressSpecFile("packages/app/e2e/deep.cy.js"), true);
  assert.equal(isCypressSpecFile("cypress\\e2e\\windows.cy.ts"), true);
  assert.equal(isCypressSpecFile("e2e/readme.md"), false);
  assert.equal(isCypressSpecFile("support/e2e2/x.cy.js"), false);
  assert.equal(isCypressSpecFile("my-e2e/x.cy.js"), false);
  assert.equal(isCypressSpecFile(""), false);
});

test("specFiles keeps *.cy.{js,ts} under any e2e/ folder and sorts by path", () => {
  const files = [
    file("e2e/zeta.cy.ts"),
    file("cypress.config.js"),
    file("e2e/alpha.cy.js"),
    file("e2e/nested/beta.cy.js"),
    file("e2e/helpers.js"),
    file("support/e2e.cy.js"),
    file("e2e/readme.md"),
    // 저장소를 그대로 등록하면 스펙은 Cypress 기본 배치인 cypress/e2e/ 아래에 있다.
    file("cypress/e2e/repo.cy.ts"),
    file("packages/app/e2e/deep.cy.js"),
    // e2e는 폴더 이름일 때만 센다. 파일 이름에 들어 있는 것은 스펙이 아니다.
    file("support/e2e2/x.cy.js"),
    file("my-e2e/x.cy.js"),
  ];
  assert.deepEqual(specFiles(files).map((item) => item.path), [
    "cypress/e2e/repo.cy.ts",
    "e2e/alpha.cy.js",
    "e2e/nested/beta.cy.js",
    "e2e/zeta.cy.ts",
    "packages/app/e2e/deep.cy.js",
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
  // 백엔드가 거절하는 폴더는 화면도 같이 거절해야 한다. 예전에는 .git만 빠져 있어, 다 적고
  // 저장할 때가 되어서야 못 쓴다는 걸 알았다.
  assert.match(validateWorkspaceRelativePath(".git/config"), /\.git/);
  // 빌드 산출물은 목록에서만 빠진다. 경로를 대면 열 수 있어야 한다.
  assert.equal(validateWorkspaceRelativePath("target/debug/a.js"), null);
  assert.match(validateWorkspaceRelativePath("e2e/"), /파일 이름/);
  assert.match(validateWorkspaceRelativePath("e2e//a.cy.js"), /빈 폴더/);
});

test("filterCypressFilePaths narrows by substring and keeps the active file", () => {
  const paths = ["cypress.config.js", "e2e/login.cy.js", "e2e/smartfarm-genie.cy.js", "support/e2e.js"];
  assert.deepEqual(filterCypressFilePaths(paths, ""), paths);
  assert.deepEqual(filterCypressFilePaths(paths, "  "), paths);
  assert.deepEqual(filterCypressFilePaths(paths, "LOGIN"), ["e2e/login.cy.js"]);
  assert.deepEqual(filterCypressFilePaths(paths, "genie"), ["e2e/smartfarm-genie.cy.js"]);
  assert.deepEqual(filterCypressFilePaths(paths, "없는파일"), []);
  // 편집 중인 파일은 검색어에 걸리지 않아도 남는다.
  assert.deepEqual(filterCypressFilePaths(paths, "login", "cypress.config.js"), ["cypress.config.js", "e2e/login.cy.js"]);
});
