/**
 * 파일 화면 본문의 Markdown 내부 링크 클릭 — 하위·상위 이동과 등록 폴더 이탈 차단.
 *
 * 본문 미리보기의 로컬 링크는 새 창으로 나가지 않고 앱 안에서 열린다
 * (src/components/MarkdownPreview.tsx:437-447 → DocsView.tsx:229 openLinkedDoc).
 * `.md`면 같은 등록 폴더 안의 다른 문서로 이동하고(DocsView.tsx:946 resolveDocLink),
 * `..`가 등록 폴더를 벗어나면 null이 돌아와 오류 안내만 서야 한다(DocsView.tsx:233-236).
 * 그 경계를 화면에서 확인한다.
 *
 * 기존 문서 시나리오(AM-5·AM-36·AM-51·AM-101·AM-290 등)는 폴더 등록·트리 검색·새 문서
 * 경로·보기 편집 모드만 다뤘고, AM-218·AM-278은 공용 Markdown 렌더러의 링크 표기와
 * 링크 문서 미리보기 모달을 다뤘다. 문서 본문의 `.md` 링크를 눌러 실제로 다른 문서로
 * 넘어가는 경로와 등록 폴더 이탈 차단은 어느 스펙도 잡은 적이 없다.
 *
 * 등록한 폴더를 남기면 "폴더 0건"을 전제로 하는 다른 문서 스펙이 무너지므로 되돌린다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

describe("파일 화면 문서 내부 링크 이동", () => {
  const target = `/tmp/am-e2e-doclink-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}/nested`);
    // index.md — 하위 문서로 가는 링크와 등록 폴더를 벗어나는 링크를 함께 둔다.
    cy.exec(
      `printf '# 색인\\n\\n- [하위 문서](nested/child.md)\\n- [바깥 문서](../../etc/outside.md)\\n' > ${target}/index.md`,
    );
    // nested/child.md — 상위로 한 칸 되짚어 index.md로 돌아오는 링크.
    cy.exec(`printf '# 하위\\n\\n- [색인으로](../index.md)\\n' > ${target}/nested/child.md`);
  });

  after(() => {
    cleanupDocRoot(target);
  });

  // runMode 재시도가 있으므로 등록 상태를 전제하지 않는다. 없으면 API로 등록해 둔다.
  const openIndex = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.contains(".tree-row.file", "index.md").click();
    cy.get(".doc-header-title span").should("contain.text", "index.md");
  };

  it("하위 폴더 문서 링크를 누르면 새 창이 아니라 같은 화면에서 그 문서가 열린다", () => {
    openIndex();

    // 로컬 링크는 새 창 대상이 아니어야 한다 — 눌러도 앱 밖으로 나가지 않는다.
    cy.contains(".markdown-preview a", "하위 문서").should("not.have.attr", "target");
    cy.contains(".markdown-preview a", "하위 문서").click();

    cy.get(".doc-header-title span").should("contain.text", "nested/child.md");
    cy.get(".doc-header-title strong").should("have.text", "child.md");
    cy.get(".markdown-preview").should("contain.text", "색인으로");
    cy.get(".error-banner").should("not.exist");
  });

  it("상위로 한 칸 되짚는 링크는 등록 폴더 안이므로 색인으로 되돌아간다", () => {
    openIndex();
    cy.contains(".markdown-preview a", "하위 문서").click();
    cy.get(".doc-header-title span").should("contain.text", "nested/child.md");

    cy.contains(".markdown-preview a", "색인으로").click();
    cy.get(".doc-header-title span").should("contain.text", "index.md");
    cy.get(".doc-header-title span").should("not.contain.text", "nested/");
    cy.get(".error-banner").should("not.exist");
  });

  it("이동한 뒤에는 '이전 문서' 단추가 살아나 앞 문서로 돌아온다", () => {
    openIndex();
    cy.get('.doc-history-nav button[aria-label="이전 문서"]').should("be.disabled");

    cy.contains(".markdown-preview a", "하위 문서").click();
    cy.get(".doc-header-title span").should("contain.text", "nested/child.md");

    cy.get('.doc-history-nav button[aria-label="이전 문서"]').should("not.be.disabled").click();
    cy.get(".doc-header-title span").should("contain.text", "index.md");
    cy.get('.doc-history-nav button[aria-label="다음 문서"]').should("not.be.disabled");
  });

  it("등록 폴더를 벗어나는 링크는 열리지 않고 안내만 서며 보던 문서는 그대로 남는다", () => {
    openIndex();

    cy.contains(".markdown-preview a", "바깥 문서").click();

    cy.get(".error-banner").should("contain.text", "등록 폴더 밖의 Markdown 링크는 열 수 없습니다.");
    cy.get(".doc-header-title span").should("contain.text", "index.md");
    cy.get(".markdown-preview").should("contain.text", "하위 문서");
  });
});
