// 예시 스크립트: 페이지 제목과 링크 목록을 수집해 result.json으로 남기고 화면을 찍는다.
// 실행: 설정 → 자동화 탭에서 이 스펙을 골라 실행하거나, AIA에게 run_cypress_spec을 요청한다.
describe("example", () => {
  it("collects the page title and links", () => {
    const url = Cypress.env("exampleUrl") || "https://example.com/";
    cy.visit(url);
    cy.title().then((title) => {
      cy.get("a").then(($links) => {
        const links = [...$links].map((link) => ({ text: link.textContent.trim(), href: link.href }));
        cy.saveResult("result.json", { url, title, links });
      });
    });
    cy.screenshot("example");
  });
});
