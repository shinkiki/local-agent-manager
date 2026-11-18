// 중메뉴 부품(`SettingsSubTabs`)의 키보드 로빙 탭 계약을 붙잡는다.
// 이 부품을 쓰는 곳은 애드온 화면의 도구 탭(7탭)과 저장소 화면의 탭이다 — 설정 → 플러그인
// 중메뉴는 애드온으로 옮겨 오며 없어졌고, 자동화 탭은 워크플로 화면(자체 탭 줄을 쓴다)으로
// 옮겨 갔다. 탭 목록은 `AddonsView.tsx`의 `addonsTabs` 순서 그대로여야 한다(한 칸 이동이
// 어느 탭에 닿는지가 그 순서로 정해진다).
// - 로빙 tabIndex: src/components/SettingsSubTabs.tsx:74 (선택된 탭만 0, 나머지는 -1)
// - 화살표·Home·End 이동과 순환: SettingsSubTabs.tsx:44 (좌우/상하 모두 받고 끝에서 감긴다)
// - 이동 뒤 초점 옮김: SettingsSubTabs.tsx:60 (requestAnimationFrame으로 새 탭에 focus)
// - aria 연결과 패널 감춤: SettingsSubTabs.tsx:70,88 (aria-controls ↔ role=tabpanel hidden)
// 키보드로 옮긴 선택도 클릭과 같은 경로(onChange)를 타므로 저장값까지 따라와야 한다.
// 기존 AM 시나리오는 애드온 탭을 클릭과 저장값 복원으로만 다뤘고, 키보드 조작을 본 스펙은 없다.

const TAB_KEY = "agent-manager.addons-tab.v2";

function tab(anchor: string) {
  return cy.anchor(anchor);
}

/** 로빙 계약: 선택된 탭만 tabIndex 0·aria-selected true이고 초점도 그 탭에 있다. */
function expectRoving(anchors: readonly string[], selected: string) {
  anchors.forEach((anchor) => {
    const on = anchor === selected;
    tab(anchor)
      .should("have.attr", "aria-selected", on ? "true" : "false")
      .and("have.attr", "tabindex", on ? "0" : "-1");
  });
  tab(selected).should("have.focus");
}

describe("애드온 도구 탭의 키보드 로빙", () => {
  const addons = [
    "addons.tab.mcp",
    "addons.tab.ssh",
    "addons.tab.db",
    "addons.tab.runners",
    "addons.tab.cypress",
    "addons.tab.mermaid",
    "addons.tab.claude",
  ] as const;

  it("화살표로 순환하고 Home·End로 양끝에 닿으며, 옮긴 선택이 저장값에 남는다", () => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");
    tab("addons.tab.mcp").should("have.class", "active");

    // 선택되지 않은 탭은 탭 순회에서 빠져 있다 — 로빙 tabIndex.
    tab("addons.tab.mcp").should("have.attr", "tabindex", "0");
    tab("addons.tab.ssh").should("have.attr", "tabindex", "-1");

    // 오른쪽 화살표는 다음 탭으로 옮기고 초점까지 데려간다.
    tab("addons.tab.mcp").focus().trigger("keydown", { key: "ArrowRight" });
    expectRoving(addons, "addons.tab.ssh");
    cy.anchor("addons.ssh-content").should("be.visible");
    cy.anchor("addons.mcp-content").should("not.be.visible");

    // 아래 화살표도 같은 방향으로 센다 — ssh 다음 자리는 데이터베이스다.
    tab("addons.tab.ssh").trigger("keydown", { key: "ArrowDown" });
    expectRoving(addons, "addons.tab.db");
    cy.anchor("addons.db-content").should("be.visible");

    // 마지막 탭에서 한 칸 더 가면 처음으로 감긴다.
    tab("addons.tab.db").trigger("keydown", { key: "End" });
    expectRoving(addons, "addons.tab.claude");
    tab("addons.tab.claude").trigger("keydown", { key: "ArrowRight" });
    expectRoving(addons, "addons.tab.mcp");

    // 반대 방향도 첫 탭에서 마지막으로 감긴다.
    tab("addons.tab.mcp").trigger("keydown", { key: "ArrowLeft" });
    expectRoving(addons, "addons.tab.claude");

    // Home은 순환이 아니라 첫 탭으로 바로 간다.
    tab("addons.tab.claude").trigger("keydown", { key: "Home" });
    expectRoving(addons, "addons.tab.mcp");

    // 다루지 않는 키는 선택을 건드리지 않는다.
    tab("addons.tab.mcp").trigger("keydown", { key: "a" });
    expectRoving(addons, "addons.tab.mcp");

    // 키보드로 옮긴 선택도 클릭과 같은 경로를 타므로 저장값에 남고 새로고침을 넘어간다.
    tab("addons.tab.mcp").trigger("keydown", { key: "ArrowRight" });
    expectRoving(addons, "addons.tab.ssh");
    cy.window().its("localStorage").invoke("getItem", TAB_KEY).should("equal", "ssh");
    cy.reload();
    cy.openView("addons").should("be.visible");
    tab("addons.tab.ssh").should("have.class", "active");
  });

  it("탭이 가리키는 패널만 보이고 나머지는 hidden으로 감춰진다", () => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");

    // 탭이 가리키는 패널이 실제로 그 id로 존재하고, 감춰진 쪽은 hidden이다.
    tab("addons.tab.mcp").should("have.attr", "aria-controls", "addons-panel-mcp");
    cy.get("#addons-panel-mcp").should("have.attr", "role", "tabpanel").and("be.visible");
    cy.get("#addons-panel-ssh").should("have.attr", "hidden");

    tab("addons.tab.mcp").focus().trigger("keydown", { key: "ArrowRight" });
    expectRoving(["addons.tab.mcp", "addons.tab.ssh"], "addons.tab.ssh");
    cy.get("#addons-panel-mcp").should("have.attr", "hidden");
    cy.get("#addons-panel-ssh").should("be.visible");
  });
});
