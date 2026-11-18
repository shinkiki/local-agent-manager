/**
 * 애드온 화면의 기본도구 접근 상세(`BuiltinToolAccess`, src/components/BuiltinToolAccess.tsx:37)를
 * 붙잡는다. 애드온이 도구 축으로 서면서 탭마다 "이 도구를 어느 에이전트가 어떤 경로로 쓰는가"를
 * 접힌 `<details data-ui-anchor="addons.<도구>.access">`로 달아 두는데, 이 상세는 어느 스펙도
 * 잡은 적이 없다. 기존 애드온 스펙은 탭 줄(줄바꿈·복원·키보드)과 각 카드의 조작(외부 플러그인 폼,
 * Cypress 토글, 데이터베이스 연결 편집기)만 다뤘다.
 *
 * 계약 세 가지를 본다.
 * 1) 표는 화면이 적지 않고 백엔드 카탈로그(`get_agent_builtin_tools`)가 계산한 것을 그대로 그린다 —
 *    탭마다 도구가 다르므로 '제공 작업' 줄도 탭마다 달라야 한다.
 * 2) 애드온 패널은 숨김(`hidden`)일 뿐 언마운트되지 않으므로(SettingsSubTabs.tsx:88), 펼쳐 둔
 *    상세는 다른 탭을 다녀와도 펼친 채 남는다.
 * 3) 카탈로그 읽기가 실패하면 상세를 아예 그리지 않되(BuiltinToolAccess.tsx:33) 도구 카드 자체의
 *    조작은 그대로 남는다 — 표가 없다고 카드까지 사라지면 도구를 끄고 켤 길이 막힌다.
 *
 * 격리 백엔드에는 계정도 CLI 연결도 없지만 기본도구 카탈로그는 에이전트 정의에서 나오므로 이
 * 표는 그대로 그려진다.
 */
function accessDetails(tool: string) {
  return cy.anchor(`addons.${tool}.access`);
}

describe("애드온 기본도구 접근 상세", () => {
  it("탭마다 제공 작업이 다르고, 펼친 상태는 탭을 다녀와도 남는다", () => {
    cy.visitApp();
    cy.openAddonsView("mcp");

    // 처음에는 접혀 있다. 요약 문구는 도구를 타지 않는 공통 문구다.
    accessDetails("mcp").should("exist").and("not.have.attr", "open");
    accessDetails("mcp").find("summary").should("contain.text", "어느 에이전트가 어떤 경로로 쓰는지");

    // 펼치면 에이전트 행이 뜨고, 각 행에 접근 경로 문구가 붙는다.
    accessDetails("mcp").find("summary").click();
    accessDetails("mcp").should("have.attr", "open");
    accessDetails("mcp").find("li").should("have.length.greaterThan", 0);
    accessDetails("mcp").find("li .builtin-tool-route").should("have.length.greaterThan", 0)
      .each((route) => expect(route.text().trim(), "접근 경로 문구").to.not.equal(""));
    // 제공 작업 줄은 카탈로그가 내려준 작업 이름을 잇는다.
    accessDetails("mcp").find(".builtin-tool-operations").should("contain.text", "제공 작업")
      .invoke("text").then((mcpOperations) => {
        // 다른 도구 탭은 같은 컴포넌트를 쓰지만 다른 도구의 표를 그린다.
        cy.openAddonsTab("cypress");
        accessDetails("cypress").should("exist").and("not.have.attr", "open");
        accessDetails("cypress").find("summary").click();
        accessDetails("cypress").find(".builtin-tool-operations").invoke("text").should((cypressOperations) => {
          expect(cypressOperations, "Cypress 제공 작업").to.not.equal(mcpOperations);
        });
      });

    // 숨은 탭의 상세는 DOM에 남되 보이지 않는다.
    accessDetails("mcp").should("exist").and("not.be.visible");

    // 돌아오면 펼쳐 둔 상태가 그대로다(패널이 언마운트되지 않는다).
    cy.openAddonsTab("mcp");
    accessDetails("mcp").should("be.visible").and("have.attr", "open");
    accessDetails("cypress").should("have.attr", "open");
  });

  it("카탈로그 읽기가 실패하면 상세만 사라지고 도구 카드는 남는다", () => {
    cy.stubInvoke("get_agent_builtin_tools", { statusCode: 500, body: { error: "기본도구 카탈로그를 읽지 못했습니다" } });
    cy.visitApp();
    cy.openAddonsView("cypress");

    // 도구 카드(Cypress 작업공간)는 그대로 조작할 수 있어야 한다.
    cy.anchor("addons.cypress-content").should("be.visible");
    accessDetails("cypress").should("not.exist");
  });
});
