// 애드온 → Cypress 파일 편집기의 보기·편집 모드 계약. 편집기가 늘 원문 textarea만 보여
// README.md 같은 문서가 그대로 원문으로만 보였다. 이제 기본은 보기 모드(Markdown은 문서,
// 그 밖은 문법 강조 코드)이고 '편집' 버튼으로 원문 입력창을 연다
// (CypressWorkspacePanel.tsx CypressFileView·toggleActiveEditing).
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 파일 편집기의 보기·편집 모드", () => {
  const workspace = cypressWorkspace({
    id: "ws-view",
    name: "보기 모드 작업공간",
    path: "/tmp/e2e-cypress-view",
  });

  const files = [
    { path: "cypress.config.js", sizeBytes: 120, sensitive: false },
    { path: "README.md", sizeBytes: 90, sensitive: false },
  ];

  const contents: Record<string, string> = {
    "cypress.config.js": "module.exports = { e2e: {} };\n",
    "README.md": "## 작업공간 안내\n\n- 스펙은 e2e 폴더에 둡니다\n",
  };

  function openPanel() {
    stubCypressRegistry([workspace]);
    stubCypressWorkspaceFiles(files);
    cy.stubInvoke("read_cypress_workspace_file", (req) => {
      const path = (req.body as { path: string }).path;
      req.reply({ statusCode: 200, body: { path, content: contents[path] ?? "", sensitive: false, masked: false } });
    });
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: [] });
    openCypressWorkspacePanel();
  }

  const modeButton = () => cy.get(".cypress-file-active .cypress-file-mode");

  it("파일은 보기 모드로 열리고 편집 버튼으로 원문 입력창이 열린다", () => {
    openPanel();
    // 설정 파일은 문법 강조한 읽기 전용 코드로 보인다.
    cy.get(".cypress-file-active code").should("have.text", "cypress.config.js");
    cy.get(".cypress-file-view .linked-file-code").should("contain.text", "module.exports");
    cy.get(".skill-editor-body textarea").should("not.exist");

    modeButton().should("contain.text", "편집").and("have.attr", "aria-pressed", "false").click();
    cy.get(".skill-editor-body textarea").should("have.value", contents["cypress.config.js"]);
    cy.get(".cypress-file-view").should("not.exist");

    // 다시 누르면 보기로 돌아온다.
    modeButton().should("contain.text", "보기").and("have.attr", "aria-pressed", "true").click();
    cy.get(".skill-editor-body textarea").should("not.exist");
    cy.get(".cypress-file-view").should("be.visible");
  });

  it("Markdown 파일은 보기 모드에서 문서로 그려진다", () => {
    openPanel();
    cy.contains(".cypress-file-list li button", "README.md").click();
    cy.get(".cypress-file-view.markdown").should("be.visible");
    // 원문 '##'이 아니라 제목으로 그려진다.
    cy.get(".cypress-file-view.markdown h2").should("have.text", "작업공간 안내");
    cy.get(".cypress-file-view.markdown li").should("contain.text", "스펙은 e2e 폴더에 둡니다");
    cy.get(".skill-editor-body textarea").should("not.exist");

    // 편집으로 바꾸면 원문이 그대로 보인다.
    modeButton().click();
    cy.get(".skill-editor-body textarea").should("have.value", contents["README.md"]);
  });

  it("고치던 파일은 다시 골라도 편집 모드로 남는다", () => {
    openPanel();
    modeButton().click();
    cy.get(".skill-editor-body textarea").type("// 임시");
    cy.contains(".cypress-file-list li button", "README.md").click();
    cy.get(".cypress-file-view.markdown").should("be.visible");
    cy.contains(".cypress-file-list li button", "cypress.config.js").click();
    cy.get(".skill-editor-body textarea").should("have.value", `${contents["cypress.config.js"]}// 임시`);
  });
});
