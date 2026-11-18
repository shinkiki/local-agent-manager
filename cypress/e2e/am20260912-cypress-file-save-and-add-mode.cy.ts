/// <reference types="cypress" />

/**
 * AM-291. Cypress 파일 편집기의 새 파일 추가 시 편집 모드 자동 활성화 및
 * 파일 저장 완료 후 편집 모드 잔존(dirty 해제 후에도 editingPaths 유지),
 * 민감 파일(cypress.env.json)의 모드 전환 버튼 미노출 격리 검증.
 */
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 파일 편집기의 새 파일 추가 및 저장 후 모드 유지", () => {
  const workspace = cypressWorkspace({
    id: "ws-save-mode",
    name: "저장 모드 작업공간",
    path: "/tmp/e2e-cypress-save-mode",
  });

  const initialFiles = [
    { path: "cypress.config.js", sizeBytes: 120, sensitive: false },
    { path: "cypress.env.json", sizeBytes: 50, sensitive: true },
  ];

  const contents: Record<string, string> = {
    "cypress.config.js": "module.exports = { e2e: {} };\n",
    "cypress.env.json": "{\"API_KEY\":\"secret\"}",
  };

  function openPanel() {
    stubCypressRegistry([workspace]);
    stubCypressWorkspaceFiles([...initialFiles]);
    cy.stubInvoke("read_cypress_workspace_file", (req) => {
      const path = (req.body as { path: string }).path;
      if (contents[path] !== undefined) {
        req.reply({ statusCode: 200, body: { path, content: contents[path], sensitive: path === "cypress.env.json", masked: false } });
      } else {
        req.reply({ statusCode: 404, body: { error: `파일이 없습니다: ${path}` } });
      }
    });
    cy.stubInvoke("read_cypress_env_file", {
      statusCode: 200,
      body: { path: "cypress.env.json", content: contents["cypress.env.json"], sensitive: true, masked: false },
    });
    cy.stubInvoke("write_cypress_workspace_file", (req) => {
      const { path, content } = req.body as { path: string; content: string };
      contents[path] = content;
      req.reply({ statusCode: 200, body: { path, sizeBytes: content.length, sensitive: false } });
    });
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: [] });
    openCypressWorkspacePanel();
  }

  it("새 파일 추가 시 즉시 편집 모드로 열리고, 저장 후에도 편집 모드가 유지되며 민감 파일은 모드 버튼이 없다", () => {
    openPanel();

    // 1. 기본 파일 cypress.config.js는 보기 모드로 열려있음
    cy.get(".cypress-file-active code").should("have.text", "cypress.config.js");
    cy.get(".cypress-file-active").scrollIntoView();
    cy.get(".cypress-file-view").should("exist");
    cy.get(".cypress-file-view .linked-file-code").should("contain.text", "module.exports");
    cy.get(".cypress-file-active .cypress-file-mode").should("contain.text", "편집");

    // 2. 민감 파일(cypress.env.json) 선택 시 모드 전환 버튼 미노출 및 민감 파일 바 표시
    cy.contains(".cypress-file-list li button", "cypress.env.json").click();
    cy.get(".cypress-file-active code").should("have.text", "cypress.env.json");
    cy.get(".cypress-file-active .cypress-file-mode").should("not.exist");
    cy.get(".cypress-sensitive-bar").should("exist");
    cy.get(".cypress-masked-view").should("exist");

    // 3. 새 파일 추가 (e2e/test-scenario.cy.js)
    cy.get(".cypress-file-add input").scrollIntoView().type("e2e/test-scenario.cy.js");
    cy.get(".cypress-file-add button").click();

    // 4. 새 파일은 미저장(dirty) 상태이므로 즉시 편집 모드(textarea)로 열린다
    cy.get(".cypress-file-active code").should("have.text", "e2e/test-scenario.cy.js");
    cy.get(".cypress-file-active .skill-sync-pill.partial").should("contain.text", "저장 안 됨");
    cy.get(".skill-editor-body textarea").should("be.visible").should("have.value", "");
    cy.get(".cypress-file-view").should("not.exist");

    // 5. 본문 입력 후 저장
    cy.get(".skill-editor-body textarea").type("describe('새 시나리오', () => {});");
    cy.contains(".cypress-form-actions button", "저장 (1)").click();

    // 6. 저장 완료 후 미저장 뱃지는 사라지지만, 편집 모드(textarea)가 보기 모드로 바뀌지 않고 그대로 유지됨
    cy.get(".cypress-file-active .skill-sync-pill.partial").should("not.exist");
    cy.get(".skill-editor-body textarea").scrollIntoView().should("be.visible").and("have.value", "describe('새 시나리오', () => {});");
    cy.get(".cypress-file-view").should("not.exist");
    cy.get(".cypress-file-active .cypress-file-mode").should("contain.text", "보기").and("have.attr", "aria-pressed", "true");

    // 7. 보기 버튼을 누르면 보기 모드로 정상 전환되고 문법 강조된 코드가 노출됨
    cy.get(".cypress-file-active .cypress-file-mode").click();
    cy.get(".skill-editor-body textarea").should("not.exist");
    cy.get(".cypress-file-view").should("exist");
    cy.get(".cypress-file-view .linked-file-code").should("contain.text", "describe('새 시나리오'");
  });
});
