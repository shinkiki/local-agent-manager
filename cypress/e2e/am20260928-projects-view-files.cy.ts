/// <reference types="cypress" />
// 프로젝트 화면(C16)의 파일 탭. 선택 박스는 활성이고 폴더가 있는 등록 프로젝트만 나열하고,
// 트리는 문서 화면의 트리 창을 프로젝트 목록 IPC(`list_project_entries`)로 돌려 그린다. 폴더를
// 펼치면 그 폴더의 `parentPath`로 다시 묻고, 파일을 고르면 `read_project_file`의 종류에 따라
// 코드 블록·마크다운·바이너리 안내 가운데 하나가 선다. 프로젝트를 바꾸면 그 경로로 다시 묻고,
// 고른 프로젝트는 localStorage(`agent-manager.projects-selected-path.v1`)에 남아 새로고침을
// 건너 복원된다. 활성 프로젝트가 하나도 없으면 빈 상태와 설정 탭으로 가는 버튼이 선다.
import type {
  DocumentEntry,
  DocumentEntryPage,
  ProjectFileSearchPage,
  ProjectFileView,
} from "../../src/types";
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";

const SELECTED_PATH_KEY = "agent-manager.projects-selected-path.v1";
const ALPHA = "/tmp/amproj/alpha";
const BETA = "/tmp/amproj/beta";

function entry(
  name: string,
  parentPath: string,
  overrides: Partial<DocumentEntry> = {},
): DocumentEntry {
  return {
    name,
    relativePath: parentPath ? `${parentPath}/${name}` : name,
    parentPath,
    sizeBytes: 120,
    modifiedAt: 1_700_000_000_000,
    isDirectory: false,
    previewKind: "text",
    ...overrides,
  };
}

/** 프로젝트마다 같은 모양의 트리. 루트에는 폴더 하나·마크다운·이미지, `src`에는 코드 파일 하나. */
function pageFor(parentPath: string): DocumentEntryPage {
  const entries = parentPath === "src"
    ? [entry("main.ts", "src")]
    : parentPath === ""
      ? [
        entry("src", "", { isDirectory: true, previewKind: null }),
        entry("README.md", "", { previewKind: "markdown" }),
        entry("logo.png", "", { previewKind: "binary" }),
      ]
      : [];
  return { entries, nextCursor: null, total: entries.length };
}

function fileFor(projectPath: string, relativePath: string): ProjectFileView {
  const base = { projectPath, relativePath, sizeBytes: 120, modifiedAt: 1_700_000_000_000 };
  if (relativePath === "README.md") return { ...base, kind: "markdown", content: "# Alpha readme\n\n본문입니다." };
  if (relativePath === "logo.png") return { ...base, kind: "binary", content: null };
  return { ...base, kind: "text", content: "export const answer = 42;\n" };
}

interface ListRequestBody {
  request: { projectPath: string; parentPath?: string };
}

interface SearchRequestBody {
  request: { projectPath: string; query: string };
}

interface ReadRequestBody {
  request: { projectPath: string; relativePath: string };
}

function stubProjectFiles(): void {
  cy.stubInvoke("list_project_entries", (req) => {
    const { request } = req.body as ListRequestBody;
    req.reply(pageFor(request.parentPath ?? ""));
  }).as("list");
  cy.stubInvoke("read_project_file", (req) => {
    const { request } = req.body as ReadRequestBody;
    req.reply(fileFor(request.projectPath, request.relativePath));
  }).as("read");
}

/**
 * 검색 결과 한 쪽. F4가 요구하는 세 칸(git 상태·마지막 수정·overlay 포함)을 실제로 담아
 * 돌려주므로, 화면이 그 셋을 그리는지 시험이 눈으로 본다.
 */
function searchPageFor(query: string): ProjectFileSearchPage {
  return {
    query,
    entries: [
      {
        ...entry("main.ts", "src"),
        gitStatus: "modified",
        modifiedAt: 1_700_000_000_000,
        inOverlay: true,
      },
    ],
    scanned: 4,
    truncated: false,
    gitStatusAvailable: true,
    searchedContents: false,
    excluded: 0,
  };
}

function stubProjectFileSearch(): void {
  cy.stubInvoke("search_project_files", (req) => {
    const { request } = req.body as SearchRequestBody;
    req.reply(searchPageFor(request.query));
  }).as("search");
}

function treeRow(name: string) {
  return cy.get(".project-files-layout .tree-row").contains("strong", name).closest(".tree-row");
}

function selector() {
  return cy.anchor("projects.selector").find("select");
}

describe("프로젝트 화면 파일 탭", () => {
  it("활성 프로젝트만 고를 수 있고 트리·뷰어가 프로젝트 파일을 읽기 전용으로 보여 준다", () => {
    stubProjectRegistry([projectEntry("alpha"), projectEntry("beta"), projectEntry("gamma", { active: false })]);
    stubProjectFiles();
    stubProjectFileSearch();
    cy.visitApp();
    cy.openProjectsView("files");

    // 1) 선택 박스는 활성 둘만 나열하고 첫 프로젝트가 골라져 있다. 감마는 제외라 없다.
    selector().find("option").should("have.length", 2);
    selector().should("have.value", ALPHA);
    selector().find("option").should("not.contain.text", "gamma");

    // 2) 루트 목록은 알파 경로로 물었다. 루트 항목 셋이 선다.
    cy.wait("@list").its("request.body.request").should("deep.include", { projectPath: ALPHA, parentPath: "" });
    cy.get(".project-files-layout .tree-row").should("have.length", 3);
    cy.get(".project-files-layout .empty-state").should("contain.text", "파일을 선택하세요");
    // 검색 상자는 트리 위에 서 있다. 비어 있는 동안에는 트리가 그대로이고 검색은 돌지 않는다.
    // (2026-10-04: 이 줄은 원래 `.document-tree-search`가 **없기를** 요구했다. 85db5511이
    // `search_project_files`와 그 입력을 세운 뒤에도 그대로 남아 선행 실패였다. 부재 단언을
    // 지우는 대신 "검색어가 비면 트리"라는 실제 계약으로 바꾼다.)
    cy.get(".project-files-layout .document-tree-search input").should("have.value", "");
    cy.get(".project-files-layout .document-search-results").should("not.exist");
    // 2b) 검색 상자는 `search_project_files`에 닿는다. 이 자리는 한 번 뒤집혔다 — 이 시험이
    // 쓰이던 2026-09-28에는 프로젝트 파일 검색 IPC가 없어 "검색 상자도 없다"를 고정했는데,
    // 85db5511(2026-10-02)이 검색과 `ProjectFileSearchHit`의 세 칸(git 상태·수정 시각·overlay)을
    // 세우면서 ProjectFilesPanel이 상자를 그리게 됐고 그 뒤로 이 줄만 실패해 왔다. 없음이 아니라
    // **배선**을 고정한다: 타이핑이 그 프로젝트 경로로 검색을 부르고, 결과 목록이 트리를 대신한다.
    cy.get(".project-files-layout .document-tree-search input").type("main");
    cy.wait("@search").its("request.body.request").should("include", { projectPath: ALPHA, query: "main" });
    cy.get(".project-files-layout .document-search-row").should("have.length", 1);
    cy.get(".project-files-layout .tree-row").should("not.exist");
    // 질의를 비우면 트리로 돌아온다 — 검색은 트리를 대체하지 삼키지 않는다. 트리 창이 다시
    // 서면서 루트를 한 번 더 묻는데, 그 요청을 여기서 받아 두지 않으면 아래 3)의 `@list`가
    // 그것을 집어 `parentPath`가 "src"가 아니라 ""로 보인다.
    cy.get(".project-files-layout .document-tree-search input").clear();
    cy.wait("@list").its("request.body.request.parentPath").should("eq", "");
    cy.get(".project-files-layout .tree-row").should("have.length", 3);

    // 3) 폴더를 펼치면 그 폴더의 parentPath로 다시 묻고 하위 파일이 선다.
    treeRow("src").click();
    cy.wait("@list").its("request.body.request.parentPath").should("eq", "src");
    treeRow("main.ts").should("exist");

    // 4) 코드 파일은 코드 블록으로, 마크다운은 미리보기로, 이미지는 바이너리 안내로 선다.
    treeRow("main.ts").click();
    cy.wait("@read").its("request.body.request").should("deep.equal", { projectPath: ALPHA, relativePath: "src/main.ts" });
    cy.get(".project-files-layout .document-file-code").should("contain.text", "answer = 42");
    cy.get(".project-files-layout .doc-header").should("contain.text", "main.ts").and("contain.text", "읽기 전용");

    treeRow("README.md").click();
    cy.wait("@read").its("request.body.request.relativePath").should("eq", "README.md");
    cy.get(".project-files-layout .markdown-preview").should("contain.text", "Alpha readme");
    cy.get(".project-files-layout .document-file-code").should("not.exist");

    treeRow("logo.png").click();
    cy.wait("@read").its("request.body.request.relativePath").should("eq", "logo.png");
    cy.get(".project-files-layout .document-file-unavailable")
      .should("contain.text", "바이너리 파일은 미리보기를 지원하지 않습니다.")
      .and("contain.text", "읽기 전용");

    // 5) 프로젝트를 바꾸면 베타 경로로 루트를 다시 묻고, 고른 파일은 남지 않는다.
    selector().select(BETA);
    cy.wait("@list").its("request.body.request").should("deep.include", { projectPath: BETA, parentPath: "" });
    cy.get(".project-files-layout .empty-state").should("contain.text", "파일을 선택하세요");

    // 6) 새로고침을 건너 베타가 복원된다.
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SELECTED_PATH_KEY)).to.eq(BETA);
    });
    cy.reload();
    cy.openProjectsView("files");
    selector().should("have.value", BETA);
    cy.wait("@list").its("request.body.request.projectPath").should("eq", BETA);
  });

  it("좁은 화면에서 파일 탐색기를 접고 펴며 코드 미리보기보다 앞에 표시한다", () => {
    cy.viewport(720, 900);
    stubProjectRegistry([projectEntry("alpha")]);
    stubProjectFiles();
    stubProjectFileSearch();
    cy.visitApp();
    cy.openProjectsView("files");

    // 저장값이 없는 좁은 화면은 본문 폭을 먼저 확보한다. 복원 버튼으로 탐색기를 연다.
    cy.get(".project-files-layout > .docs-sidebar").should("not.exist");
    cy.get(".project-files-layout .secondary-pane-restore").should("contain.text", "파일").click();
    cy.wait("@list");
    cy.get(".project-files-layout > .docs-sidebar").should("be.visible").and("have.css", "z-index", "51");
    cy.get(".project-files-layout > .docs-sidebar-backdrop").should("be.visible");

    treeRow("src").click();
    cy.wait("@list").its("request.body.request.parentPath").should("eq", "src");
    treeRow("main.ts").click();
    cy.wait("@read");
    cy.get(".project-files-layout .document-file-code").should("contain.text", "answer = 42");

    // 코드 줄 번호가 같은 좌표에 있어도 최상단 hit target은 탐색기여야 한다.
    cy.get(".project-files-layout > .docs-sidebar").then(($sidebar) => {
      const bounds = $sidebar[0].getBoundingClientRect();
      cy.window().then((win) => {
        expect(win.document.elementFromPoint(bounds.left + 20, bounds.top + 120)?.closest(".docs-sidebar")).not.to.eq(null);
      });
    });

    cy.get(".project-files-layout > .docs-sidebar-backdrop").click({ force: true });
    cy.get(".project-files-layout > .docs-sidebar").should("not.exist");
    cy.get(".project-files-layout .doc-header .secondary-pane-restore").should("be.visible");
  });


  // 2026-10-04: 파일 검색(F1~F4)이 선 뒤에도 이 파일은 "검색 상자가 없다"만 단언하고 있어
  // 화면 쪽 계약이 비어 있었다. 고정하는 것은 문구가 아니라 일치다 — 검색어가 들어가면
  // `search_project_files`를 그 프로젝트 경로와 질의로 부르고, 결과 줄이 F4의 세 칸을 그리고,
  // 줄을 고르면 트리에서 고른 것과 같은 `read_project_file`이 돈다. 그리고 검색어를 비우면
  // 결과가 아니라 트리로 돌아온다.
  it("검색어를 넣으면 검색 IPC를 부르고 결과 줄이 F4의 세 칸을 그린다", () => {
    stubProjectRegistry([projectEntry("alpha")]);
    stubProjectFiles();
    stubProjectFileSearch();
    cy.visitApp();
    cy.openProjectsView("files");
    cy.wait("@list");

    cy.get(".project-files-layout .document-tree-search input").type("main");
    cy.wait("@search").its("request.body.request").should("deep.include", { projectPath: ALPHA, query: "main" });

    cy.get(".project-files-layout .document-search-row").should("have.length", 1);
    cy.get(".project-files-layout .document-search-path").should("have.text", "src/main.ts");
    // git 상태와 overlay 포함은 각각 뱃지 하나다. 둘 다 서야 F4.ui가 실제로 돈 것이다.
    cy.get(".project-files-layout .document-search-meta .badge").should("have.length", 2);
    cy.get(".project-files-layout .document-search-meta").should("contain.text", "modified").and("contain.text", "오버레이");
    // 트리는 검색 중에는 서지 않는다.
    cy.get(".project-files-layout .tree-row").should("not.exist");

    cy.get(".project-files-layout .document-search-row").first().click();
    cy.wait("@read").its("request.body.request").should("deep.equal", { projectPath: ALPHA, relativePath: "src/main.ts" });
    cy.get(".project-files-layout .document-file-code").should("contain.text", "answer = 42");

    cy.get(".project-files-layout .document-tree-search input").clear();
    cy.get(".project-files-layout .document-search-results").should("not.exist");
    cy.get(".project-files-layout .tree-row").should("have.length", 3);
  });

  // 2026-10-22: 검색과 본문 읽기가 요청 세대 하나를 함께 썼다. 결과 줄을 골라 본문을 읽는
  // 사이 검색어를 더 치면 그 읽기가 낡은 요청으로 버려져 "파일을 읽고 있습니다"에서 멈췄다.
  it("본문을 읽는 사이 검색어를 더 쳐도 고른 파일이 열린다", () => {
    stubProjectRegistry([projectEntry("alpha")]);
    stubProjectFileSearch();
    cy.stubInvoke("list_project_entries", (req) => {
      const { request } = req.body as ListRequestBody;
      req.reply(pageFor(request.parentPath ?? ""));
    }).as("list");
    cy.stubInvoke("read_project_file", (req) => {
      const { request } = req.body as ReadRequestBody;
      req.reply({ body: fileFor(request.projectPath, request.relativePath), delay: 1500 });
    }).as("read");
    cy.visitApp();
    cy.openProjectsView("files");
    cy.wait("@list");

    cy.get(".project-files-layout .document-tree-search input").type("main");
    cy.wait("@search");
    cy.get(".project-files-layout .document-search-row").first().click();
    cy.get(".project-files-layout .document-tree-search input").type(".ts");
    cy.wait("@search").its("request.body.request.query").should("eq", "main.ts");
    cy.wait("@read");
    cy.get(".project-files-layout .document-file-code").should("contain.text", "answer = 42");
    cy.get(".project-files-layout .doc-workspace").should("not.contain.text", "파일을 읽고 있습니다");
  });

  // 같은 날: 오류 칸도 하나였다. 검색 실패가 읽는 중인 본문 자리를 오류로 바꿨다.
  it("검색 실패는 검색 창에만 서고 본문 읽기를 가리지 않는다", () => {
    stubProjectRegistry([projectEntry("alpha")]);
    stubProjectFiles();
    cy.stubInvoke("search_project_files", { statusCode: 500, body: { error: "검색에 실패했습니다" } }).as("search");
    cy.visitApp();
    cy.openProjectsView("files");
    cy.wait("@list");
    treeRow("README.md").click();
    cy.wait("@read");
    cy.get(".project-files-layout .document-tree-search input").type("main");
    cy.wait("@search");
    cy.get(".project-files-layout .docs-sidebar .error-banner").should("contain.text", "검색에 실패했습니다");
    cy.get(".project-files-layout .doc-workspace .error-banner").should("not.exist");
    cy.get(".project-files-layout .markdown-preview").should("contain.text", "Alpha readme");
    cy.get(".project-files-layout .document-tree-search input").clear();
    cy.get(".project-files-layout .docs-sidebar .error-banner").should("not.exist");
  });

  it("활성 프로젝트가 없으면 빈 상태가 서고 그 버튼이 설정 탭을 연다", () => {
    stubProjectRegistry([projectEntry("gamma", { active: false }), projectEntry("delta", { exists: false })]);
    stubProjectFiles();
    cy.visitApp();
    cy.openProjectsView("files");

    cy.anchor("projects.selector").should("not.exist");
    cy.get("#projects-panel-files .projects-empty").should("contain.text", "활성 프로젝트가 없습니다");
    cy.get("#projects-panel-files .projects-empty button").click();
    cy.anchor("projects.tab.settings").should("have.class", "active");
    cy.get("#projects-panel-settings").should("be.visible").and("contain.text", "세션에서 확인한 프로젝트");
  });
});
