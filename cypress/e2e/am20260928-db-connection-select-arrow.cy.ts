/// <reference types="cypress" />
// 데이터베이스 연결 편집기의 선택 박스에서 화살표가 가로로 줄줄이 반복돼 나오던 자리를
// 붙잡는다. 원인은 편집기 규칙(`.db-connection-editor select`)이 배경을 `background`
// 단축 속성으로 적어 기준 규칙(`App.css`의 `select:where(:not([multiple]))`)이 세워 둔
// 화살표 층 — 그림·반복·크기·위치 네 가지 — 를 통째로 되돌린 데 있다. 평소에는 화살표가
// 그냥 사라지지만, :hover·:focus 규칙이 특정도가 더 높아 **그림만** 되살아나고 반복은
// `repeat`, 크기는 `auto`로 남아 24px 화살표가 폭 전체에 깔렸다.
//
// 그래서 보는 것은 "화살표가 보인다"가 아니라 **그림 층과 반복·크기가 짝이 맞는지**다.
// :focus는 `.focus()`로 실제로 걸리므로(:hover는 Cypress가 걸지 못한다) 초점 상태에서
// 계산된 값을 읽는다. 둘은 같은 변수 한 칸에서 나오므로 초점이 맞으면 호버도 맞는다.
describe("데이터베이스 연결 편집기 · 선택 박스 화살표", () => {
  it("초점이 간 선택 박스의 화살표 층이 한 번만 그려진다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openDbConnectionsTab();
    cy.openDbConnectionEditor();

    cy.dbConnectionField("엔진").find("select").as("engine");
    cy.get("@engine").focus();

    cy.get("@engine").then(($select) => {
      const style = window.getComputedStyle($select[0]);
      // 그림 층은 화살표 + 광택 두 겹이다. 단축 속성이 배경을 되돌렸다면 `none`이 된다.
      expect(style.backgroundImage, "background-image").to.contain("svg");
      // 반복·크기가 기본값(repeat / auto)으로 돌아가면 화살표가 폭 전체에 깔린다.
      expect(style.backgroundRepeat, "background-repeat").to.equal("no-repeat, no-repeat");
      expect(style.backgroundSize, "background-size").to.contain("12px");
    });

    cy.get(".db-connection-editor").screenshot("db-connection-editor-select", { overwrite: true });
  });
});

export {};
