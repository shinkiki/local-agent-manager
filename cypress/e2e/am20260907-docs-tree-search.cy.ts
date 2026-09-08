/**
 * 문서 트리 창의 파일 검색 — 늦게 도착한 응답의 폐기와 검색 상태 비우기.
 *
 * 753518e가 검색 결과를 읽어 오는 두 자리(입력 디바운스·검색 결과 더 보기)를
 * fetchSearchPage 한 벌로, 검색 상태를 비우는 두 자리(폴더 전환·검색어 지움)를
 * clearSearch 한 벌로 모았다. 그 계약이 화면에서 지켜지는지 본다.
 * - 요청번호 대조: src/components/DocumentTreePane.tsx:92,97,100 (requestId !== searchRequestRef.current면 버린다)
 * - 검색어 효과: DocumentTreePane.tsx:116-129 (180ms 디바운스, 빈 검색어면 clearSearch)
 * - 결과 영역 갈래: DocumentTreePane.tsx:168 (검색어가 있으면 트리 대신 결과 목록)
 * 기존 AM 문서 시나리오는 폴더 사이드바 접힘·폴더 등록·새 문서 경로·변경 자동화 빈 상태만
 * 다뤘고, 트리 창의 검색 입력 자체는 어떤 스펙도 잡은 적이 없다.
 *
 * 등록한 폴더를 남기면 "폴더 0건"을 전제로 하는 다른 문서 스펙이 무너지므로 이 스펙 안에서
 * 되돌린다.
 */
const SEARCH = '[aria-label="파일명 또는 경로 검색"]';

describe("문서 트리 창 파일 검색", () => {
  const target = `/tmp/am-e2e-docsearch-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}/nested`);
    cy.exec(`printf 'a' > ${target}/alpha-note.md`);
    cy.exec(`printf 'b' > ${target}/beta-note.md`);
    cy.exec(`printf 'c' > ${target}/nested/alpha-deep.md`);
  });

  after(() => {
    cy.request("POST", "/api/invoke/get_doc_roots", {}).then((res) => {
      for (const root of res.body as Array<{ id: string; path: string }>) {
        if (root.path.endsWith(target.slice("/tmp".length))) {
          cy.request("POST", "/api/invoke/delete_doc_root", { id: root.id });
        }
      }
    });
    cy.exec(`rm -rf ${target}`, { failOnNonZeroExit: false });
  });

  // runMode 재시도가 있으므로 등록 상태를 전제하지 않는다. 없으면 API로 등록해 둔다.
  const openRoot = () => {
    cy.visitApp();
    cy.request({ method: "POST", url: "/api/invoke/create_doc_root", body: { request: { name: "", path: target, createIfMissing: false } }, failOnStatusCode: false });
    cy.reload();
    cy.anchor("nav.docs").click();
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  it("검색어를 넣으면 트리 대신 결과 목록이 서고, 지우면 트리로 돌아온다", () => {
    openRoot();
    cy.get(".document-tree-scroll").should("exist");

    cy.get(SEARCH).type("alpha");
    cy.get(".document-search-results").should("exist");
    cy.get(".document-tree-scroll").should("not.exist");
    cy.get(".document-search-row").should("have.length", 2);
    cy.get(".document-search-row code").should("contain.text", "alpha-note.md");
    cy.contains(".document-search-row code", "nested/alpha-deep.md").should("exist");
    cy.get(".document-search-row").should("not.contain.text", "beta-note.md");

    cy.get(SEARCH).clear();
    cy.get(".document-search-results").should("not.exist");
    cy.get(".document-tree-scroll").should("exist");
  });

  it("맞는 파일이 없으면 빈 결과 문구가 서고 결과 줄은 하나도 없다", () => {
    openRoot();
    cy.get(SEARCH).type("zzz-없는파일");
    cy.contains(".document-search-results .tree-empty", "조건에 맞는 파일이 없습니다.").should("be.visible");
    cy.get(".document-search-row").should("not.exist");
  });

  it("앞선 검색의 늦은 응답은 버려지고 마지막 검색어의 결과만 남는다", () => {
    cy.intercept("POST", "**/api/invoke/search_document_entries", (req) => {
      // alpha만 늦게 돌려보내 beta 결과가 먼저 도착하게 만든다.
      if (String(req.body?.query ?? "").includes("alpha")) req.on("response", (res) => res.setDelay(1200));
    }).as("search");

    openRoot();
    cy.get(SEARCH).type("alpha");
    cy.wait("@search").its("request.body.query").should("eq", "alpha");

    cy.get(SEARCH).clear().type("beta");
    cy.get(".document-search-row code").should("contain.text", "beta-note.md");

    // 늦은 alpha 응답이 도착하고도 남을 시간을 준 뒤에도 beta 결과여야 한다.
    cy.get(SEARCH).should("have.value", "beta");
    cy.get(".document-search-row").should("have.length", 1);
    cy.get(".document-search-row").should("not.contain.text", "alpha");
  });

  it("검색이 실패하면 오류 배너가 서고, 검색어를 지우면 배너도 함께 사라진다", () => {
    cy.intercept("POST", "**/api/invoke/search_document_entries", { statusCode: 500, body: { error: "검색에 실패했습니다" } }).as("failed");

    openRoot();
    cy.get(SEARCH).type("alpha");
    cy.wait("@failed");
    cy.get(".document-search-results .error-banner").should("exist");
    cy.get(".document-search-row").should("not.exist");

    cy.get(SEARCH).clear();
    cy.get(".error-banner").should("not.exist");
    cy.get(".document-tree-scroll").should("exist");
  });
});
