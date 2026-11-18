// Cypress 작업공간 '파일 편집' 구역의 새 파일 추가 경로 경계와 미저장 표시 계약.
// 저장·삭제는 실제 파일시스템을 건드리므로 누르지 않는다 — 아직 저장하지 않은 새 파일만
// 다루면 편집기 지역 상태 안에서 끝난다(CypressWorkspacePanel.tsx의 addFile).
//
// 암묵적인 기본 작업공간은 없어졌다(C7-5a). 편집기는 사용자가 작업공간을 고른 뒤에만 서므로
// 등록부를 파일이 없는 작업공간 하나로 스텁하고 그 작업공간을 명시적으로 고른다. 파일 목록도
// 빈 목록으로 스텁해 두면 예전 기본 작업공간과 같은 출발점(열린 파일 없음)에서 시작한다.
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 작업공간 파일 편집기의 새 파일 경로 경계와 미저장 표시", () => {
  const editor = () => cy.get(".skill-editor");
  const addInput = () => cy.get(".skill-editor-add input");
  const addButton = () => cy.get(".skill-editor-add button");
  const saveButton = () => cy.get(".skill-editor-body .cypress-form-actions button.primary");

  const addPath = (path: string) => {
    addInput().clear().type(path);
    addButton().click();
  };

  beforeEach(() => {
    stubCypressRegistry([cypressWorkspace({ id: "ws-file-editor", name: "파일 편집 작업공간", path: "/tmp/e2e-cypress-file-editor" })]);
    stubCypressWorkspaceFiles([]);
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: [] });
    // 추가는 같은 이름의 파일이 이미 있는지 먼저 읽어 본다. 스텁한 작업공간은 디스크에 없으므로
    // 백엔드가 없는 파일에 답하는 문구(`파일이 없습니다:`)로 돌려주어 "새 파일" 갈래를 탄다.
    const missing = (req: { body: unknown; reply: (response: object) => void }) => {
      const path = (req.body as { path?: string }).path ?? "cypress.env.json";
      req.reply({ statusCode: 404, body: { error: `파일이 없습니다: ${path}` } });
    };
    cy.stubInvoke("read_cypress_workspace_file", missing);
    cy.stubInvoke("read_cypress_env_file", missing);
    openCypressWorkspacePanel();
    // 목록을 다 읽어야 편집기가 그려진다.
    cy.contains(".settings-subsection header strong", "파일 편집").scrollIntoView().should("be.visible");
    editor().scrollIntoView().should("be.visible");
  });

  it("이름이 비어 있으면 추가가 잠긴다", () => {
    addInput().should("have.value", "");
    addButton().should("be.disabled");
    // 공백만으로도 열리지 않는다(trim 경계).
    addInput().type("   ");
    addButton().should("be.disabled");
  });

  it("작업공간 밖으로 나가거나 예약 폴더를 가리키면 안내로 막힌다", () => {
    addPath("../escape.cy.ts");
    cy.get(".error-banner").should("contain.text", "상위 폴더");
    // 막힌 경로는 목록에 남지 않는다 — 빈 작업공간이라 목록 자체가 서지 않는다.
    cy.get(".cypress-file-list").should("not.exist");

    addPath("/tmp/absolute.cy.ts");
    cy.get(".error-banner").should("contain.text", "상대 경로");

    addPath("node_modules/x.js");
    cy.get(".error-banner").should("contain.text", "node_modules/");

    addPath("e2e/");
    cy.get(".error-banner").should("contain.text", "파일 이름으로 끝나야");
  });

  it("유효한 새 파일은 미저장 표시와 저장 개수로 잡히고 파일을 오가도 내용이 남는다", () => {
    addPath("e2e/am-qa-tmp.cy.ts");
    cy.get(".error-banner").should("not.exist");
    // 아직 저장 전이라 이름 옆에 미저장 점이 붙는다.
    cy.contains(".cypress-file-list li", "e2e/am-qa-tmp.cy.ts").should("have.class", "active").find(".cypress-file-dirty").should("exist");
    saveButton().should("contain.text", "저장 (1)").and("not.be.disabled");
    addInput().should("have.value", "");

    cy.get(".skill-editor-body textarea").should("have.value", "").type("// QA 임시 내용");

    // 두 번째 새 파일로 옮겼다가 돌아와도 첫 파일 내용이 남는다.
    addPath("e2e/am-qa-tmp2.cy.ts");
    saveButton().should("contain.text", "저장 (2)");
    cy.get(".skill-editor-body textarea").should("have.value", "");
    cy.contains(".cypress-file-list li button", "e2e/am-qa-tmp.cy.ts").click();
    cy.get(".skill-editor-body textarea").should("have.value", "// QA 임시 내용");

    // 같은 이름을 다시 추가해도 중복 항목이 생기지 않고 그 파일이 선택된다.
    addPath("e2e/am-qa-tmp2.cy.ts");
    cy.get(".cypress-file-list li").filter(':contains("e2e/am-qa-tmp2.cy.ts")').should("have.length", 1);
    cy.contains(".cypress-file-list li", "e2e/am-qa-tmp2.cy.ts").should("have.class", "active");
    saveButton().should("contain.text", "저장 (2)");
  });

  it("cypress.env.json은 새로 추가해도 민감 파일로 잡혀 기본 숨김이다", () => {
    addPath("cypress.env.json");
    cy.get(".cypress-sensitive-bar").should("be.visible").and("contain.text", "민감 파일");
    cy.get(".skill-editor-body textarea").should("not.exist");
    cy.contains(".cypress-sensitive-bar button", "내용 표시").click();
    cy.get(".skill-editor-body textarea").should("be.visible");
    cy.contains(".cypress-sensitive-bar button", "숨기기").click();
    cy.get(".skill-editor-body textarea").should("not.exist");
  });

  it("저장하지 않은 새 파일을 지우면 확인창 없이 사라지고 저장이 다시 잠긴다", () => {
    addPath("e2e/am-qa-tmp.cy.ts");
    saveButton().should("contain.text", "저장 (1)");

    cy.contains(".cypress-file-list li", "e2e/am-qa-tmp.cy.ts").find(".cypress-file-remove").click();
    // 저장 전 파일은 파일시스템에 없으므로 삭제 확인 모달이 뜨지 않는다.
    cy.get(".modal-body").should("not.exist");
    editor().should("not.contain.text", "am-qa-tmp.cy.ts");
    // 하나뿐이던 미저장 파일이 사라지면 열린 파일도 없어 저장 버튼 자체가 걷힌다 — 저장할 것이 없다.
    saveButton().should("not.exist");
    cy.get(".error-banner").should("not.exist");
  });
});
