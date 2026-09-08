/**
 * 문서 화면 "새 문서 만들기" 경로 정규화 경계.
 *
 * DocsView.tsx:276은 입력을 trim한 뒤 `.md`로 끝나지 않을 때만 확장자를 붙인다. 비교가
 * `toLowerCase().endsWith(".md")`라, 대문자 `.MD`는 이미 마크다운으로 보고 그대로 둔다.
 * 이 정규화가 무너지면 `문서.md.md`나 앞뒤 공백이 섞인 파일명이 디스크에 남고, 트리에서
 * 다시 열 수 없는 문서가 생긴다. 그래서 파일명을 UI가 아니라 디스크에서 확인한다.
 *
 * 등록한 폴더를 그대로 두면 "폴더 0건"을 전제로 하는 다른 문서 스펙이 무너지므로, 등록본과
 * 만든 폴더를 이 스펙 안에서 되돌린다.
 */
describe("문서 새 문서 경로 정규화", () => {
  const target = `/tmp/am-e2e-newdoc-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
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

  // runMode 재시도가 있으므로 등록 상태를 전제하지 않는다. 남은 등록본을 지우고 시작한다.
  const purgeRoots = () => {
    cy.request("POST", "/api/invoke/get_doc_roots", {}).then((res) => {
      for (const root of res.body as Array<{ id: string }>) {
        cy.request("POST", "/api/invoke/delete_doc_root", { id: root.id });
      }
    });
  };

  const openRoot = () => {
    cy.visitApp();
    // 재시도가 돌아도 같은 폴더를 다시 고를 수 있게, 없으면 API로 등록해 둔다.
    cy.request({ method: "POST", url: "/api/invoke/create_doc_root", body: { request: { name: null, path: target, createIfMissing: false } }, failOnStatusCode: false });
    cy.reload();
    cy.anchor("nav.docs").click();
    cy.contains(".root-row code", target).click();
    cy.get(".new-doc-row").should("exist");
  };

  it("이미 있는 폴더를 등록하면 확인 대화 없이 새 문서 입력칸이 열린다", () => {
    cy.visitApp();
    purgeRoots();
    cy.reload();
    cy.anchor("nav.docs").click();
    cy.get(".root-row").should("not.exist");
    cy.get('[aria-label="문서 폴더 추가"]').first().click({ force: true });
    cy.get(".root-form input").eq(1).type(target);
    cy.contains(".root-form button", "폴더 등록").click();

    cy.get(".root-form").should("not.exist");
    cy.get(".error-banner").should("not.exist");
    // 등록이 끝나면 그 폴더가 곧바로 선택되어, 한 번 더 고르지 않아도 새 문서 입력칸이 선다.
    cy.get(".root-row.active code").should("contain", target);
    cy.get(".new-doc-row input").should("have.value", "");
    cy.get('[aria-label="새 문서 만들기"]').should("be.disabled");
  });

  it("공백만 넣으면 만들기 버튼이 잠긴 채로 남는다", () => {
    openRoot();
    cy.get('[aria-label="새 문서 만들기"]').should("be.disabled");
    cy.get(".new-doc-row input").type("   ");
    // trim 결과가 비면 버튼은 계속 잠겨 있어야 한다.
    cy.get('[aria-label="새 문서 만들기"]').should("be.disabled");
    cy.exec(`ls ${target}`).its("stdout").should("eq", "");
  });

  it("앞뒤 공백은 잘리고 확장자 없는 경로에는 .md가 한 번만 붙는다", () => {
    openRoot();
    cy.get(".new-doc-row input").type("  경계값-문서  ");
    cy.get('[aria-label="새 문서 만들기"]').click();

    // 만든 문서로 이동하고 입력칸은 비워진다.
    cy.get(".new-doc-row input").should("have.value", "");
    cy.exec(`ls ${target}`).its("stdout").should("eq", "경계값-문서.md");
  });

  it("대문자 .MD로 끝나는 경로에는 .md를 덧붙이지 않는다", () => {
    openRoot();
    cy.get(".new-doc-row input").type("대문자.MD{enter}");

    cy.get(".new-doc-row input").should("have.value", "");
    // `대문자.MD.md`가 되면 안 된다.
    cy.exec(`ls ${target}`).its("stdout").should("contain", "대문자.MD");
    cy.exec(`ls ${target}`).its("stdout").should("not.contain", ".MD.md");
  });
});
