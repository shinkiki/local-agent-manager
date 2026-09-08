describe("AIA separate window screen routing", () => {
  it("shows the popout's requested pointer in the main document", () => {
    cy.visitApp();
    cy.anchor("nav.settings").should("be.visible");
    // A separate same-origin browsing context runs the real popout App and callbacks.
    cy.document().then((doc) => {
      const frame = doc.createElement("iframe");
      frame.id = "aia-popout-test";
      frame.src = "/?popout=aia&window=screen-guide-test";
      doc.body.append(frame);
    });
    cy.get<HTMLIFrameElement>("#aia-popout-test").should(($frame) => {
      expect(($frame[0].contentWindow as any).__agentManagerE2E).to.exist;
    }).then(async ($frame) => {
      const popup = $frame[0].contentWindow as any;
      expect(await popup.__agentManagerE2E.showUiGuide({ target: "settings.repository-path", element: null, note: "메인 창 안내" })).to.eq(true);
      expect(popup.document.querySelector(".ui-guide")).to.eq(null);
    });
    cy.get(".ui-guide-note").should("contain.text", "메인 창 안내");
    cy.view("settings").should("exist");
  });
});
