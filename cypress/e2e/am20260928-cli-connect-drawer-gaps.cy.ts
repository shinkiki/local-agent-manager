/// <reference types="cypress" />
// 연결 안내 드로워(`CliConnectionDrawer.tsx`)의 본문은 세로 간격을 한 규칙이 준다 —
// `.drawer-body > * + * { margin-top: 12px }`. 그런데 그 규칙도 클래스 하나짜리라, 본문에
// 놓이는 블록이 목록·문단의 기본 여백을 지우려고 `margin: 0`을 적는 순간 특정도가 같아
// 파일에서 뒤에 있는 쪽이 이기고 간격이 통째로 사라진다. 실제로 "하네스를 찾았습니다"
// 요약 카드와 1단계 카드가 맞붙어 있었다(둘 다 y=162, 간격 0).
//
// 한 자리만 보면 같은 실수가 다음 블록에서 되풀이된다. 그래서 본문의 이웃한 블록 전부를
// 훑어 간격이 0인 짝이 없는지 본다.
describe("설정 · 연결 · 연결 안내 드로워의 본문 간격", () => {
  it("로컬 드로워 본문에서 맞붙은 블록이 없다", () => {
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").within(() => {
      cy.contains(".cli-settings-provider", "Ollama").find(".cli-settings-provider-states button.button").click();
    });
    cy.anchor("cli-connect.summary").should("exist");

    cy.get(".drawer-body").then(($body) => {
      const blocks = Array.from($body[0].children) as HTMLElement[];
      const gaps: { after: string; gap: number }[] = [];
      for (let i = 1; i < blocks.length; i += 1) {
        const previous = blocks[i - 1].getBoundingClientRect();
        const current = blocks[i].getBoundingClientRect();
        gaps.push({
          after: blocks[i - 1].className || blocks[i - 1].tagName,
          gap: Math.round(current.top - previous.bottom),
        });
      }
      // 하나라도 0이면 어느 블록 뒤인지 메시지에 실어 준다 — 다음에 같은 자리를 찾느라
      // 다시 재지 않도록.
      const touching = gaps.filter((entry) => entry.gap <= 0);
      expect(touching, `맞붙은 블록: ${JSON.stringify(gaps)}`).to.have.length(0);
    });
  });
});

export {};
