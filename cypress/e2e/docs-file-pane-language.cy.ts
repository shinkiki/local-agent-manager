/**
 * 영어 UI에서 문서 파일 작업대(DocumentFilePane)의 본문 안내 문구(QA #58).
 *
 * 주 메뉴·폴더 사이드바·섹션 탭은 text(ko, en)을 타는데 파일을 고르기 전 빈 상태와
 * 미리보기가 막힌 파일(바이너리·크기 초과)의 안내는 한국어 리터럴로 남아 있었다. 그 안내는
 * "다운로드해서 보라"는 다음 행동을 지시하는 문장이라 영어 화면에서도 읽혀야 한다.
 * - 빈 상태: src/components/DocsView.tsx
 * - 바이너리·크기 초과 안내: src/components/DocumentFilePane.tsx (DocumentUnavailablePreview)
 * - 종류 판정: crates/agent-manager-core/src/document_tree.rs (5MiB 초과면 tooLarge, NUL이면 binary)
 *
 * 등록한 폴더를 남기면 "폴더 0건"을 전제로 하는 다른 문서 스펙이 무너지므로 이 스펙 안에서 되돌린다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

describe("영어 UI에서 문서 파일 작업대 안내 문구", () => {
  const target = `/tmp/am-e2e-docpane-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
    cy.exec(`printf 'A\\000\\001\\002B' > ${target}/blob.bin`);
    cy.exec(`dd if=/dev/zero bs=1024 count=6144 2>/dev/null | tr '\\000' 'a' > ${target}/huge.txt`);
  });

  after(() => {
    cy.restoreLanguage();
    cleanupDocRoot(target);
  });

  const openRoot = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.setLanguage("en");
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  it("파일을 고르기 전 빈 상태 문구가 영어로 나온다", () => {
    openRoot();
    cy.view("docs").find(".empty-state").first()
      .should("contain.text", "Select a file")
      .and("contain.text", "Browse regular files and preview Markdown and UTF-8 text.")
      .invoke("text").should("not.match", /[가-힣]/);
  });

  it("바이너리 파일 안내와 다운로드 문구가 영어로 나온다", () => {
    openRoot();
    cy.contains(".tree-row.file strong", "blob.bin").click();
    cy.get(".document-file-unavailable").should("be.visible")
      .and("contain.text", "Binary files cannot be previewed.")
      .and("contain.text", "Download the file to view it.")
      .invoke("text").should("not.match", /[가-힣]/);
    // 머리말의 다운로드 버튼 이름도 함께 바뀐다.
    cy.get('.document-file-header button[aria-label="Download file"]').should("exist");
  });

  it("미리보기 크기 제한 초과 안내가 영어로 나온다", () => {
    openRoot();
    cy.contains(".tree-row.file strong", "huge.txt").click();
    cy.get(".document-file-unavailable").should("be.visible")
      .and("contain.text", "This file exceeds the preview size limit.")
      .invoke("text").should("not.match", /[가-힣]/);
  });
});
