// 지침 가져오기 모달에서 지침 하나를 체크하면 그 지침이 @경로·링크로 함께 읽는 문서가
// 트리로 펼쳐진다. 트리 순서와 체크 전파는 같은 링크 관계를 봐야 맞으므로 2026-09-07에
// importDocLinks(docs) 한 벌로 모였다(36aa169, src/components/InstructionsView.tsx:2270).
// 순서(flattenImportDocs, :2286)와 전파(toggleImportDoc, :2312)를 화면에서 보는 스펙은
// 없었다 — 트리 계단, 닿지 못한 문서의 뒤붙임, 끄면 아래로·켜면 위로 번지는 전파, 개수
// 머리줄을 한자리에서 본다.
//
// 격리 백엔드에는 등록 프로젝트도 배포 파일도 없어 툴바의 '지침 가져오기'가 막혀 있다.
// 그래서 배포 후보 한 벌을 가진 라이브러리와 연결 문서 미리보기를 세워 준 뒤 모달을 연다.
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

const DOC_ROWS = ".instruction-import-doc:not(.root)";

/** 트리 한 줄의 이름. 체크박스가 아니라 원문 열기 버튼 안의 code에 적힌다. */
function docNames() {
  return cy.get(`${DOC_ROWS} .instruction-import-doc-open code`);
}

/** 이름으로 그 줄의 체크박스를 잡는다. */
function docCheck(relative: string) {
  return cy.get(`${DOC_ROWS} input[type=checkbox][aria-label="${relative} 함께 보관"]`);
}

function openDocTree() {
  cy.openView("instructions");
  cy.get('.skill-mode-tabs[aria-label="지침 화면 모드"] button').eq(1).click();
  cy.get(".skill-library-toolbar-row button").contains("지침 가져오기").should("not.be.disabled").click();
  cy.get(".modal").should("be.visible").contains("기존 지침 가져오기");
  // 위치를 고르면 그 위치의 지침 파일이 트리로 뜬다. 체크해야 연결 문서를 읽는다.
  cy.get(".instruction-import-row input[type=checkbox]").check();
  cy.wait("@preview");
  return cy.get(".instruction-import-docs").should("exist");
}

describe("지침 가져오기 모달의 연결 문서 트리", () => {
  beforeEach(() => {
    cy.stubInvoke("get_project_instruction_library", { statusCode: 200, body: LIBRARY });
    cy.stubInvoke("preview_project_instruction_import", { statusCode: 200, body: PREVIEW }).as("preview");
    cy.visitApp();
  });

  it("링크 사슬을 계단으로 펴고 닿지 못한 문서는 맨 뒤에 1단으로 붙인다", () => {
    openDocTree();

    // 1) 뿌리는 지침 파일 자신이고, 체크는 켠 채 잠겨 있다.
    cy.get(".instruction-import-doc.root").should("have.length", 1).as("root");
    cy.get("@root").find("code").should("have.text", "CLAUDE.md");
    cy.get("@root").find("input[type=checkbox]")
      .should("be.checked").and("be.disabled")
      .and("have.attr", "aria-label", "CLAUDE.md은 항상 함께 보관합니다");

    // 2) 순서는 지침 파일에서 걸어 나간 깊이 우선이다. 형제 docs/b.md는 docs/a.md의
    //    사슬을 다 내려간 뒤에 오고, 닿지 못한 orphan.md가 맨 뒤에 붙는다.
    docNames().should("have.length", 5);
    docNames().then(($names) => {
      expect([...$names].map((node) => node.textContent)).to.deep.equal([
        "docs/a.md", "docs/a-1.md", "docs/a-1-1.md", "docs/b.md", "orphan.md",
      ]);
    });

    // 3) 계단은 --import-doc-depth로 그린다. 뿌리가 0이므로 1단부터 시작한다.
    cy.get(DOC_ROWS).then(($rows) => {
      expect([...$rows].map((node) => node.style.getPropertyValue("--import-doc-depth"))).to.deep.equal([
        "1", "2", "3", "1", "1",
      ]);
    });

    // 4) 어느 문서에 딸린 것인지는 줄의 title이 말한다. 닿지 못한 문서도 자기가 적힌
    //    출처를 그대로 보여준다.
    cy.get(DOC_ROWS).eq(0).should("have.attr", "title", "지침 파일에서 링크");
    cy.get(DOC_ROWS).eq(2).should("have.attr", "title", "docs/a-1.md 에서 링크");
    cy.get(DOC_ROWS).eq(4).should("have.attr", "title", "docs/missing.md 에서 링크");
  });

  it("끄면 딸린 문서까지 함께 꺼지고 켜면 위쪽 사슬이 함께 켜진다", () => {
    openDocTree();

    // 5) 지침은 한 세트이므로 처음에는 찾은 문서를 모두 고른 상태다.
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 5/5개");
    cy.get(`${DOC_ROWS} input[type=checkbox]:checked`).should("have.length", 5);

    // 6) 사슬 머리를 끄면 그 아래 두 단이 함께 꺼진다. 형제와 닿지 못한 문서는 남는다.
    docCheck("docs/a.md").uncheck();
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 2/5개");
    docCheck("docs/a-1.md").should("not.be.checked");
    docCheck("docs/a-1-1.md").should("not.be.checked");
    docCheck("docs/b.md").should("be.checked");
    docCheck("orphan.md").should("be.checked");

    // 7) 맨 끝만 켜도 중간이 빠지면 링크가 끊기므로 위쪽 사슬이 함께 켜진다.
    docCheck("docs/a-1-1.md").check();
    docCheck("docs/a-1.md").should("be.checked");
    docCheck("docs/a.md").should("be.checked");
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 5/5개");

    // 8) 사슬 가운데를 끄면 아래 한 단만 꺼지고 위쪽은 남는다.
    docCheck("docs/a-1.md").uncheck();
    docCheck("docs/a-1-1.md").should("not.be.checked");
    docCheck("docs/a.md").should("be.checked");
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 3/5개");

    // 9) 닿지 못한 문서는 위로 이어지는 문서가 트리에 없으므로 자기 하나만 꺼진다.
    docCheck("orphan.md").uncheck();
    docCheck("docs/b.md").should("be.checked");
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 2/5개");
    docCheck("orphan.md").check();
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 3/5개");

    // 10) '모두 해제'는 연결 문서만 비우고 뿌리 지침 파일은 켠 채 잠긴 그대로 둔다.
    cy.get(".instruction-import-docs-head button").contains("모두 해제").click();
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 0/5개");
    cy.get(`${DOC_ROWS} input[type=checkbox]:checked`).should("have.length", 0);
    cy.get(".instruction-import-doc.root input[type=checkbox]").should("be.checked").and("be.disabled");

    // 11) '모두 선택'으로 한 번에 되돌아온다.
    cy.get(".instruction-import-docs-head button").contains("모두 선택").click();
    cy.get(".instruction-import-docs-head strong").should("have.text", "연결 문서 5/5개");
  });
});
