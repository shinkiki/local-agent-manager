/**
 * 문서 폴더 등록의 "없는 폴더를 만들까요?" 승인 갈래(QA #13).
 *
 * 등록 → NotFound → 확인 대화 승인 → 같은 경로를 `createIfMissing`으로 재제출까지가 한
 * 흐름이라, 중간에 끊기면 폴더도 안 생기고 목록에 경고 행만 남는다. 경로는 실행마다
 * 새로 잡는다 — 남은 폴더에 기대면 이 스펙이 "이미 있는 폴더 등록"을 검사하게 된다.
 */
describe("문서 폴더 등록", () => {
  // 하네스는 한 스위트에 백엔드 하나를 쓴다. 등록한 폴더를 그대로 두면 "폴더 0건"을 전제로
  // 하는 뒤 스펙이 무너지므로, 등록본과 만든 폴더를 이 스펙 안에서 되돌린다.
  const target = `/tmp/am-e2e-docroot-${Date.now()}`;

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

  it("없는 경로를 승인하면 폴더를 만들고 등록까지 끝낸다", () => {
    cy.visitApp();
    cy.request("POST", "/api/invoke/get_doc_roots", {}).its("body").should("have.length", 0);
    cy.anchor("nav.docs").click();
    cy.get('[aria-label="문서 폴더 추가"]').first().click({ force: true });
    cy.get(".root-form input").eq(1).type(target);
    cy.contains(".root-form button", "폴더 등록").click();

    // 등록이 끝나면 폼은 닫히고 오류 배너 없이 새 폴더 한 줄만 남는다.
    cy.get(".root-form").should("not.exist");
    cy.get(".error-banner").should("not.exist");
    cy.get(".root-row").should("have.length", 1);
    // 경고 아이콘(exists=false)으로 남지 않고 실제로 만들어져야 한다.
    cy.request("POST", "/api/invoke/get_doc_roots", {}).its("body.0.exists").should("eq", true);
  });
});
