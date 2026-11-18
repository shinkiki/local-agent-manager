/**
 * 문서 작업대 파일 창 — 파일 종류가 머리말 액션과 본문 갈래를 함께 가르는지 본다.
 *
 * - 머리말 액션: src/components/DocumentFilePane.tsx:107,133-148
 *   (편집 토글과 저장 버튼은 `file.kind === "markdown"`일 때만 붙는다. 다운로드는 종류와 무관)
 * - 본문 갈래: DocumentFilePane.tsx:165-183 (markdown은 편집 칸/미리보기, text는 읽기 전용
 *   코드 블록 `.document-file-code`, 그 밖은 안내 패널)
 * - 종류 판정: crates/agent-manager-core/src/document_tree.rs:565-566,613-618
 *   (.md/.markdown만 Markdown, NUL 없는 나머지는 Text)
 * - 문서 이동 시 편집 상태: src/components/DocsView.tsx:712 (showDocument(file, false))
 *
 * 이 스펙이 새로 보는 것은 **종류가 다른 파일을 거쳤을 때 편집 상태가 남는지**다. AM-189가
 * 텍스트·바이너리 파일의 본문 갈래를 한 번 봤지만 그때는 파일 하나씩 따로 열었고, 편집
 * 상태를 들고 종류를 건너뛰는 갈래는 어떤 스펙도 본 적이 없다. 초안(dirty)을 만들지 않으므로
 * 이탈 되묻기(am20260907-docs-unsaved-draft-guard)와도 겹치지 않는다 — 되묻기 없이 조용히
 * 넘어가야 하고, 돌아왔을 때 편집 칸이 아니라 미리보기로 서야 한다.
 * 앞의 두 it은 그 전환의 양쪽 끝(종류별 머리말 액션)을 고정하는 자리다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

const NOTE_BODY = "# 종류 확인 문서\\n본문 한 줄.\\n";
const CODE_BODY = '{\\n  "name": "kind-probe"\\n}\\n';

describe("문서 파일 창의 종류별 액션", () => {
  const target = `/tmp/am-e2e-dockind-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
    cy.exec(`printf '${NOTE_BODY}' > ${target}/kind-note.md`);
    cy.exec(`printf '${CODE_BODY}' > ${target}/kind-config.json`);
  });

  after(() => {
    cleanupDocRoot(target);
  });

  // runMode 재시도가 있으므로 등록 상태를 전제하지 않는다. 없으면 API로 등록해 둔다.
  const openRoot = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  const selectFile = (name: string) => {
    cy.contains(".tree-row.file", name).click();
    cy.get(".doc-header-title strong").should("have.text", name);
  };

  it("텍스트 파일은 편집·저장 버튼 없이 읽기 전용 코드 미리보기로 선다", () => {
    openRoot();
    selectFile("kind-config.json");

    // 종류와 무관한 다운로드만 남고, 마크다운 전용 두 액션은 붙지 않는다.
    cy.get('.document-file-header [aria-label="파일 다운로드"]').should("exist");
    cy.get('.document-file-header [aria-label="편집"]').should("not.exist");
    cy.get('.document-file-header [aria-label="미리보기"]').should("not.exist");
    cy.get(".document-file-header .button.primary").should("not.exist");

    // 본문은 코드 블록이고 편집 칸도 마크다운 미리보기도 아니다.
    cy.get('.document-file-code[aria-label="읽기 전용 텍스트 미리보기"]')
      .should("exist")
      .and("contain.text", "kind-probe");
    cy.get("textarea.doc-editor").should("not.exist");
    cy.get(".markdown-preview").should("not.exist");
  });

  it("마크다운은 편집 토글을 내주고, 초안 없이 저장 버튼은 비활성이다", () => {
    openRoot();
    selectFile("kind-note.md");

    // 고른 직후에는 미리보기라 저장 버튼 자체가 없다.
    cy.get(".markdown-preview").should("contain.text", "종류 확인 문서");
    cy.get(".document-file-header .button.primary").should("not.exist");

    cy.get('.document-file-header [aria-label="편집"]').click();
    cy.get("textarea.doc-editor").should("exist");
    // 아직 한 글자도 고치지 않았으니 저장은 눌리지 않는다.
    cy.get(".document-file-header .button.primary").should("have.text", "저장").and("be.disabled");
  });

  it("마크다운 편집 중에 텍스트 파일로 옮기면 편집 칸이 새지 않고 되돌아와도 미리보기로 선다", () => {
    openRoot();
    selectFile("kind-note.md");
    cy.get('.document-file-header [aria-label="편집"]').click();
    cy.get("textarea.doc-editor").should("exist");

    // 초안을 만들지 않았으므로 이탈 되묻기는 뜨지 않아야 한다.
    selectFile("kind-config.json");
    cy.get(".modal .confirm-dialog").should("not.exist");
    cy.get("textarea.doc-editor").should("not.exist");
    cy.get('.document-file-header [aria-label="편집"]').should("not.exist");
    cy.get(".document-file-code").should("exist");

    // 다시 마크다운으로 돌아와도 편집이 아니라 미리보기 상태다.
    selectFile("kind-note.md");
    cy.get("textarea.doc-editor").should("not.exist");
    cy.get(".markdown-preview").should("contain.text", "종류 확인 문서");
    cy.get('.document-file-header [aria-label="편집"]').should("exist");
  });
});
