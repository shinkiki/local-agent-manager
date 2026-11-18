/// <reference types="cypress" />

/**
 * Cypress 작업공간 파일 삭제의 세 갈래를 격리 검증한다.
 * (1) 확인 대화에서 취소하면 삭제 명령이 나가지 않고 목록이 그대로 남는다.
 * (2) 삭제 명령이 실패하면 오류 안내가 뜨고 파일이 목록에 남는다.
 * (3) 성공하면 목록과 개수에서 빠진다.
 * (4) 아직 저장되지 않은 새 파일은 확인 대화 없이 편집기에서만 빠지고 삭제 명령도 나가지 않는다.
 */
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 작업공간 파일 삭제의 취소·실패·성공 갈래", () => {
  const workspace = cypressWorkspace({
    id: "ws-delete-branches",
    name: "삭제 갈래 작업공간",
    path: "/tmp/e2e-cypress-delete-branches",
  });

  const contents: Record<string, string> = {
    "cypress.config.js": "module.exports = { e2e: {} };\n",
    "e2e/login.cy.js": "describe('로그인', () => {});\n",
  };

  const dialog = () => cy.get(".modal[role='dialog']");
  const fileButton = (path: string) => cy.contains(".cypress-file-list li button", path);
  const removeButton = (path: string) =>
    cy.contains(".cypress-file-list li button", path).closest("li").find(".cypress-file-remove");

  function openPanel(deleteResponse: { statusCode: number; body: unknown }) {
    stubCypressRegistry([workspace]);
    stubCypressWorkspaceFiles([
      { path: "cypress.config.js", sizeBytes: 120, sensitive: false },
      { path: "e2e/login.cy.js", sizeBytes: 60, sensitive: false },
    ]);
    cy.stubInvoke("read_cypress_workspace_file", (req) => {
      const path = (req.body as { path: string }).path;
      if (contents[path] !== undefined) {
        req.reply({ statusCode: 200, body: { path, content: contents[path], sensitive: false, masked: false } });
      } else {
        req.reply({ statusCode: 404, body: { error: `파일이 없습니다: ${path}` } });
      }
    });
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: [] });
    cy.stubInvoke("delete_cypress_workspace_file", deleteResponse).as("deleteFile");
    openCypressWorkspacePanel();
  }

  it("취소는 목록을 그대로 두고, 실패는 오류를 알리며 파일을 남긴다", () => {
    openPanel({ statusCode: 500, body: { error: "작업공간 파일을 지우지 못했습니다: 권한 없음" } });

    // 1) 두 파일이 실려 있고 개수 표시도 둘이다.
    cy.get(".cypress-file-list li").should("have.length", 2);
    cy.get(".cypress-file-search span").should("contain.text", "2개");

    // 2) 삭제 버튼은 되돌릴 수 없음을 알리는 위험 확인 대화를 띄우고 대상 경로를 그대로 보여준다.
    removeButton("login.cy.js").click();
    dialog().find(".modal-title").should("contain.text", "파일 삭제");
    dialog().should("contain.text", "되돌릴 수 없습니다");
    dialog().find(".confirm-dialog-items").should("contain.text", "e2e/login.cy.js");

    // 3) 취소하면 대화만 닫히고 삭제 명령이 나가지 않으며 목록은 그대로다.
    dialog().contains("button", "취소").click();
    cy.get(".modal[role='dialog']").should("not.exist");
    cy.get("@deleteFile.all").should("have.length", 0);
    cy.get(".cypress-file-list li").should("have.length", 2);

    // 4) 확인을 누르면 명령이 나가지만 실패하면 오류 안내가 뜨고 파일은 목록에 남는다.
    removeButton("login.cy.js").click();
    dialog().contains("button", "삭제").click();
    cy.get("@deleteFile.all").should("have.length", 1);
    cy.get(".error-banner").should("contain.text", "권한 없음");
    cy.get(".cypress-file-list li").should("have.length", 2);
    fileButton("login.cy.js").should("exist");
    cy.get(".cypress-file-search span").should("contain.text", "2개");
  });

  it("성공하면 목록에서 빠지고, 저장 전 새 파일은 확인 없이 편집기에서만 빠진다", () => {
    openPanel({ statusCode: 200, body: {} });

    // 5) 확인 후 성공하면 파일과 개수 표시가 함께 줄어든다.
    removeButton("login.cy.js").click();
    dialog().contains("button", "삭제").click();
    cy.get(".modal[role='dialog']").should("not.exist");
    cy.get("@deleteFile.all").should("have.length", 1);
    cy.get(".cypress-file-list li").should("have.length", 1);
    cy.get(".cypress-file-search span").should("contain.text", "1개");
    cy.get(".error-banner").should("not.exist");

    // 6) 아직 저장하지 않은 새 파일을 하나 만든다.
    cy.get(".cypress-file-add input").scrollIntoView().type("e2e/draft.cy.js");
    cy.get(".cypress-file-add button").click();
    cy.get(".cypress-file-list li").should("have.length", 2);
    cy.get(".cypress-file-active code").should("have.text", "e2e/draft.cy.js");

    // 7) 작업공간에 없는 파일이므로 확인 대화도 삭제 명령도 없이 편집기에서만 빠진다.
    removeButton("draft.cy.js").click();
    cy.get(".modal[role='dialog']").should("not.exist");
    cy.get("@deleteFile.all").should("have.length", 1);
    cy.get(".cypress-file-list li").should("have.length", 1);
    cy.get(".cypress-file-search span").should("contain.text", "1개");
  });
});
