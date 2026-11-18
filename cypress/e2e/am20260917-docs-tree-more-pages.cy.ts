/**
 * 문서 트리 창의 폴더별 "더 보기" 페이징 — 루트와 하위 폴더가 각자 커서를 들고 다음 쪽을
 * 이어 붙이는지 본다.
 *
 * - 쪽 합치기: src/lib/documentWorkspace.ts의 mergeDocumentEntryPage를 부르는
 *   src/components/DocumentTreePane.tsx:53 (cursor가 있으면 앞 쪽 뒤에 붙인다)
 * - 더 보기 버튼: DocumentTreePane.tsx:347-353,363-379 (`더 보기 (읽은 수/전체 수)`,
 *   불러오는 중에는 비활성 + "불러오는 중…")
 * - 폴더별 진행 표시: DocumentTreePane.tsx:48,58 (loadingParents는 부모 경로별로 켜진다)
 *
 * 기존 문서 스펙은 검색 창(am20260907-docs-tree-search)·트리 창 언어(am20260916-docs-tree-pane-language)·
 * 새 문서 경로·폴더 등록만 다뤘고, 트리 쪽 "더 보기"는 어떤 스펙도 누른 적이 없다. 검색
 * 결과의 더 보기와 트리의 더 보기는 같은 버튼 컴포넌트를 쓰지만 커서를 들고 있는 자리가
 * 달라(검색은 한 벌, 트리는 부모 경로별) 이 스펙이 보는 것은 트리 쪽이다.
 *
 * 200개짜리 실제 폴더를 만들지 않고 list_document_entries 응답을 세워 쪽을 나눈다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

interface StubEntry {
  name: string;
  relativePath: string;
  parentPath: string;
  sizeBytes: number;
  modifiedAt: number;
  isDirectory: boolean;
  previewKind: string | null;
}

const file = (parentPath: string, name: string): StubEntry => ({
  name,
  relativePath: parentPath ? `${parentPath}/${name}` : name,
  parentPath,
  sizeBytes: 12,
  modifiedAt: 1_700_000_000,
  isDirectory: false,
  previewKind: "markdown",
});

const folder = (parentPath: string, name: string): StubEntry => ({
  ...file(parentPath, name),
  isDirectory: true,
  previewKind: null,
});

// 부모 경로별 쪽. [쪽 항목, 다음 커서] 순서로 읽고, 전체 수는 모든 쪽의 합이다.
const PAGES: Record<string, Array<{ entries: StubEntry[]; nextCursor: string | null }>> = {
  "": [
    { entries: [folder("", "묶음폴더"), file("", "루트-1.md")], nextCursor: "root-2" },
    { entries: [file("", "루트-2.md"), file("", "루트-3.md")], nextCursor: null },
  ],
  "묶음폴더": [
    { entries: [file("묶음폴더", "자식-1.md")], nextCursor: "child-2" },
    { entries: [file("묶음폴더", "자식-2.md")], nextCursor: null },
  ],
};

function pageFor(parentPath: string, cursor: string | null) {
  const pages = PAGES[parentPath] ?? [{ entries: [], nextCursor: null }];
  const index = cursor === null ? 0 : pages.findIndex((page) => page.nextCursor === cursor) + 1;
  const total = pages.reduce((sum, page) => sum + page.entries.length, 0);
  const page = pages[index] ?? { entries: [], nextCursor: null };
  return { entries: page.entries, nextCursor: page.nextCursor, total };
}

describe("문서 트리 창 더 보기 페이징", () => {
  const target = `/tmp/am-e2e-docsmore-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
  });

  after(() => {
    cleanupDocRoot(target);
  });

  // 부른 커서를 순서대로 모아 둔다. 별칭 대기(`cy.wait`)는 앞서 오간 첫 쪽 요청을 먼저
  // 집어 커서가 null인 요청을 보게 되므로, 더 보기가 실제로 부른 커서는 이 목록으로 본다.
  let cursors: Array<string | null> = [];

  const stubPages = (delayMs = 0) => {
    cursors = [];
    cy.stubInvoke("list_document_entries", (req) => {
      const parentPath = String(req.body?.parentPath ?? "");
      const cursorValue = req.body?.cursor;
      const cursor = typeof cursorValue === "string" ? cursorValue : null;
      cursors.push(cursor);
      req.reply({
        statusCode: 200,
        body: pageFor(parentPath, cursor),
        delay: cursor === null ? 0 : delayMs,
      });
    }).as("list");
  };

  const openRoot = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  it("루트의 더 보기는 읽은 수/전체 수를 세고, 누르면 다음 쪽을 이어 붙인 뒤 사라진다", () => {
    stubPages();
    openRoot();

    cy.get(".document-tree-scroll .tree-row").should("have.length", 2);
    cy.get(".document-tree-more").should("have.text", "더 보기 (2/4)");

    cy.get(".document-tree-more").click();
    cy.get(".document-tree-scroll .tree-row").should("have.length", 4);
    cy.then(() => expect(cursors).to.include("root-2"));

    cy.contains(".document-tree-scroll .tree-row", "루트-1.md").should("exist");
    cy.contains(".document-tree-scroll .tree-row", "루트-3.md").should("exist");
    cy.get(".document-tree-more").should("not.exist");
  });

  it("하위 폴더는 자기 커서로만 다음 쪽을 부르고 루트 목록은 그대로다", () => {
    stubPages();
    openRoot();

    cy.contains(".tree-row.directory", "묶음폴더").click();
    cy.get(".document-tree-children .tree-row").should("have.length", 1);
    cy.get(".document-tree-children .document-tree-more").should("have.text", "더 보기 (1/2)");

    cy.get(".document-tree-children .document-tree-more").click();
    cy.get(".document-tree-children .tree-row").should("have.length", 2);
    // 하위 폴더가 부른 커서는 자기 것뿐이다 — 루트 커서는 이 사이에 한 번도 오가지 않는다.
    cy.then(() => {
      expect(cursors).to.include("child-2");
      expect(cursors).to.not.include("root-2");
    });
    cy.get(".document-tree-children .document-tree-more").should("not.exist");
    // 루트 쪽 더 보기는 하위 폴더를 읽는 동안에도 자기 자리를 지킨다.
    cy.get(".document-tree-scroll > .document-tree-level > .document-tree-more")
      .should("have.text", "더 보기 (2/4)");
  });

  it("다음 쪽을 읽는 동안 더 보기는 진행 문구로 바뀌고 다시 눌리지 않는다", () => {
    stubPages(900);
    openRoot();

    cy.get(".document-tree-more").click();
    cy.get(".document-tree-more").should("have.text", "불러오는 중…").and("be.disabled");

    cy.get(".document-tree-scroll .tree-row").should("have.length", 4);
    cy.get(".document-tree-more").should("not.exist");
  });
  it("읽는 중인 폴더를 접었다 다시 펼쳐도 첫 쪽을 다시 부르지 않는다", () => {
    const childRequests: Array<string | null> = [];
    cy.stubInvoke("list_document_entries", (req) => {
      const parentPath = String(req.body?.parentPath ?? "");
      const cursorValue = req.body?.cursor;
      const cursor = typeof cursorValue === "string" ? cursorValue : null;
      if (parentPath === "묶음폴더") childRequests.push(cursor);
      req.reply({ statusCode: 200, body: pageFor(parentPath, cursor), delay: parentPath === "묶음폴더" ? 1200 : 0 });
    });
    openRoot();

    cy.contains(".tree-row.directory", "묶음폴더").click();
    cy.contains(".tree-row.directory", "묶음폴더").click();
    cy.contains(".tree-row.directory", "묶음폴더").click();
    cy.get(".document-tree-children .tree-row").should("have.length", 1);
    cy.then(() => expect(childRequests).to.deep.equal([null]));
  });
});
