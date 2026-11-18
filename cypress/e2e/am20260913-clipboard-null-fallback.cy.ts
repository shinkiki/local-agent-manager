/// <reference types="cypress" />

const CARD = ".settings-card:has([data-ui-anchor='storage.repository-path'])";

describe("네이티브 클립보드 null 거부 뒤 레거시 폴백 성공", () => {
  it("null 거부를 API 미지원으로 오인하지 않고 경로를 한 번 복사한다", () => {
    cy.visitApp();
    cy.openStorageTab("library");
    cy.anchor("storage.repository-path").should("be.visible");
    cy.get(CARD).should("not.contain.text", "저장소 설정을 불러오는 중…");

    cy.get("#resource-repository-default-path").invoke("val").then((rawValue) => {
      const expected = String(rawValue);
      expect(expected).not.to.equal("");

      cy.window().then((win) => {
        const nativeWrite = cy.stub().callsFake(() => Promise.reject(null)).as("nativeWrite");
        let fallbackValue = "";
        const fallbackCopy = cy.stub(win.document, "execCommand").callsFake((command) => {
          expect(command).to.equal("copy");
          fallbackValue = win.document.querySelector("textarea")?.value ?? "";
          return true;
        }).as("fallbackCopy");

        Object.defineProperty(win.navigator, "clipboard", {
          configurable: true,
          value: { writeText: nativeWrite },
        });

        cy.get("#resource-repository-default-path")
          .parent(".path-field")
          .find("button.path-field-copy")
          .should("have.attr", "aria-label", "경로 복사")
          .click()
          .should("have.class", "copy-action-copied")
          .and("have.attr", "aria-label", "복사됨")
          .then(() => {
            expect(fallbackCopy).to.have.been.calledOnce;
            expect(fallbackValue).to.equal(expected);
            expect(win.document.querySelector("textarea")).to.equal(null);
          });
      });

      cy.get("@nativeWrite").should("have.been.calledOnceWith", expected);
      cy.get("@fallbackCopy").should("have.been.calledOnceWith", "copy");
      cy.get(CARD).find(".copy-action-announcement").contains("복사됨").should("have.attr", "role", "status");
      cy.screenshot("am20260913-clipboard-null-fallback-success");
    });
  });
});
