/** V2: Mermaid의 KaTeX 갱신 뒤에도 실제 앱에서 분수와 지수가 MathML로 렌더링된다. */
// htmlLabels:false인 흐름도는 SVG 글자를 그대로 유지하므로 수식 경로가 있는 시퀀스 메시지를 쓴다.
const MATH_SOURCE = 'sequenceDiagram\n  participant A as Start\n  participant B as End\n  A->>B: $$x^2$$\n  B-->>A: $$\\frac{1}{2}$$';

for (const [name, width, height] of [["pc", 1440, 900], ["mobile", 390, 844]] as const) {
  it(`V2: ${name} Mermaid 수식 라벨이 지수와 분수로 렌더링된다`, () => {
    cy.viewport(width, height);
    cy.visitApp();
    cy.openAddonsView("mermaid");
    cy.anchor("addons.mermaid-content").within(() => {
      cy.get('textarea[aria-label="mermaid 원문"]').clear()
        .type(MATH_SOURCE, { parseSpecialCharSequences: false, delay: 0 });
      cy.get(".diagram-viewer", { timeout: 20_000 }).should("have.attr", "data-state", "ready");
      // 단순 SVG 존재만으로는 수식 처리가 빠진 구현도 통과하므로 MathML 구조를 확인한다.
      cy.get(".diagram-viewer-canvas svg math msup").should("have.length", 1)
        .and("contain.text", "x").and("contain.text", "2");
      cy.get(".diagram-viewer-canvas svg math mfrac").should("have.length", 1)
        .and("contain.text", "1").and("contain.text", "2");
    });
  });
}
