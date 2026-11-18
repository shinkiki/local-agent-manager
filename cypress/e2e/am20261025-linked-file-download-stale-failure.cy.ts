/// <reference types="cypress" />
// 연결 문서 미리보기에서 다운로드가 도는 동안 미리보기 안의 링크로 다른 문서로 넘어가면,
// 앞 문서의 늦은 실패가 새 문서 위에 오류 배너로 뜨면 안 된다. `useLinkedFileDownload`는
// 보는 링크가 바뀌면 앞 링크의 실패 문구를 지우는데, 그 지움은 바뀌는 순간 한 번뿐이라
// 그 뒤에 도착한 앞 링크의 실패가 다시 배너를 세웠다. 미리보기 안에서 링크를 따라갈 수
// 있는 곳은 지침 가져오기 모달의 연결 문서 미리보기뿐이라 그 자리에서 본다.
const PROJECT = "/Users/qa/am-import-project";
const FILE_PATH = `${PROJECT}/CLAUDE.md`;

function deployment() {
  return {
    provider: "claude",
    scope: "project",
    projectPath: PROJECT,
    filePath: FILE_PATH,
    present: true,
    managed: false,
    contentDigest: "deployed",
    sourceDigest: null,
    divergent: false,
    linkedFiles: [],
  };
}

const LIBRARY = {
  schemaVersion: 1,
  commonRoot: "/Users/qa/.agents/instructions",
  commonRootPresent: true,
  currentPlatform: "macos",
  projects: [PROJECT],
  // 보관 원본이 없으니 후보가 '보관됨'으로 빠지지 않고 그대로 고를 수 있다.
  entries: [],
  deployments: [deployment()],
  issues: [],
};

// 링크 사슬을 일부러 계단으로 만든다. docs/a.md → docs/a-1.md → docs/a-1-1.md는 3단이고,
// docs/b.md는 지침 파일에 바로 달린 형제다. orphan.md는 트리에 없는 문서가 링크한 것이라
// 지침 파일에서 걸어서는 닿지 못한다.
function doc(relative: string, source: string, sizeBytes: number) {
  return { relative, source, sizeBytes };
}

const LINKED_DOCS = [
  doc("docs/a.md", "", 1024),
  doc("docs/a-1.md", "docs/a.md", 2048),
  doc("docs/a-1-1.md", "docs/a-1.md", 512),
  doc("docs/b.md", "", 256),
  doc("orphan.md", "docs/missing.md", 128),
];

const PREVIEW = {
  scope: "project",
  projectPath: PROJECT,
  provider: "claude",
  filePath: FILE_PATH,
  sizeBytes: 4096,
  linkedDocs: LINKED_DOCS,
  linkIssues: [],
  totalBytes: 8064,
  maxTotalBytes: 1_048_576,
};


const DOWNLOAD_ROUTE = "**/api/download/linked-file/instruction";

const dialog = () => cy.get(".linked-file-dialog");

describe("연결 문서 미리보기 다운로드 실패의 소속", () => {
  beforeEach(() => {
    cy.stubInvoke("get_project_instruction_library", { statusCode: 200, body: LIBRARY });
    cy.stubInvoke("preview_project_instruction_import", { statusCode: 200, body: PREVIEW }).as("preview");
    cy.stubInvoke("get_deployed_instruction_linked_file", (req) => {
      const href = (req.body as { request?: { href?: string } })?.request?.href ?? "";
      req.reply({
        statusCode: 200,
        body: {
          relativePath: href,
          content: href === "CLAUDE.md" ? "# 지침\n\n[B 문서](docs/b.md)\n" : "# B 문서 QA_B_BODY\n",
          sizeBytes: 64,
          targetLine: null,
        },
      });
    });
    cy.visitApp();
  });

  it("다운로드 중에 다른 문서로 넘어가면 앞 문서의 늦은 실패는 새 문서에 붙지 않는다", () => {
    cy.intercept("POST", DOWNLOAD_ROUTE, {
      statusCode: 500,
      delay: 1500,
      body: { error: "앞 문서 저장 실패 QA_STALE_DOWNLOAD" },
    }).as("download");

    cy.openView("instructions");
    cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(1).click();
    cy.get(".skill-library-toolbar-row button").contains("지침 가져오기").should("not.be.disabled").click();
    cy.get(".instruction-import-row input[type=checkbox]").check();
    cy.wait("@preview");
    cy.get(".instruction-import-doc.root .instruction-import-doc-open").click();
    dialog().find("header strong").should("have.text", "CLAUDE.md");

    // 1) 지침 파일을 내려받기 시작하고, 응답이 오기 전에 본문의 링크로 B 문서로 넘어간다.
    dialog().contains(".linked-file-actions button", "다운로드").click();
    dialog().contains(".linked-file-actions button", "다운로드 중…");
    dialog().contains(".linked-file-body a", "B 문서").click();
    dialog().find("header strong").should("have.text", "docs/b.md");
    dialog().find(".linked-file-body").should("contain.text", "QA_B_BODY");

    // 2) 앞 문서의 실패가 도착해도 B 문서 위에는 오류 배너가 서지 않는다.
    cy.wait("@download");
    dialog().contains(".linked-file-actions button", "다운로드").should("be.enabled").and("have.text", "다운로드");
    dialog().find(".linked-file-download-error").should("not.exist");
  });

  it("보는 문서 그대로의 실패는 전처럼 배너로 남는다", () => {
    cy.intercept("POST", DOWNLOAD_ROUTE, {
      statusCode: 500,
      body: { error: "지금 문서 저장 실패 QA_CURRENT_DOWNLOAD" },
    }).as("download");

    cy.openView("instructions");
    cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(1).click();
    cy.get(".skill-library-toolbar-row button").contains("지침 가져오기").should("not.be.disabled").click();
    cy.get(".instruction-import-row input[type=checkbox]").check();
    cy.wait("@preview");
    cy.get(".instruction-import-doc.root .instruction-import-doc-open").click();
    dialog().contains(".linked-file-actions button", "다운로드").click();
    cy.wait("@download");
    dialog().find(".linked-file-download-error .error-banner").should("contain.text", "QA_CURRENT_DOWNLOAD");
  });
});
