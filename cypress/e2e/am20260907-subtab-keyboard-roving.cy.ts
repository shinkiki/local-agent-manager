// 설정 중메뉴(`SettingsSubTabs`)의 키보드 로빙 탭 계약을 붙잡는다.
// 이 부품은 애드온 화면(3탭)과 설정 → 플러그인(2탭)이 함께 쓴다.
// - 로빙 tabIndex: src/components/SettingsSubTabs.tsx:74 (선택된 탭만 0, 나머지는 -1)
// - 화살표·Home·End 이동과 순환: SettingsSubTabs.tsx:44 (좌우/상하 모두 받고 끝에서 감긴다)
// - 이동 뒤 초점 옮김: SettingsSubTabs.tsx:60 (requestAnimationFrame으로 새 탭에 focus)
// - aria 연결과 패널 감춤: SettingsSubTabs.tsx:70,88 (aria-controls ↔ role=tabpanel hidden)
// 키보드로 옮긴 선택도 클릭과 같은 경로(onChange)를 타므로 애드온에서는 저장값까지 따라와야 한다.
// 기존 AM 시나리오는 애드온 탭을 클릭과 저장값 복원으로만 다뤘고, 키보드 조작을 본 스펙은 없다.

const TAB_KEY = "agent-manager.addons-tab.v1";

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

describe("설정 중메뉴 탭의 키보드 로빙", () => {
  const addons = ["addons.tab.aia", "addons.tab.claude", "addons.tab.codex"] as const;

  it("애드온 탭은 화살표로 순환하고 Home·End로 양끝에 닿으며, 옮긴 선택이 저장값에 남는다", () => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");
    tab("addons.tab.aia").should("have.class", "active");

    // 선택되지 않은 탭은 탭 순회에서 빠져 있다 — 로빙 tabIndex.
    tab("addons.tab.aia").should("have.attr", "tabindex", "0");
    tab("addons.tab.claude").should("have.attr", "tabindex", "-1");

    // 오른쪽 화살표는 다음 탭으로 옮기고 초점까지 데려간다.
    tab("addons.tab.aia").focus().trigger("keydown", { key: "ArrowRight" });
    expectRoving(addons, "addons.tab.claude");
    cy.anchor("addons.claude-plugins-content").should("be.visible");
    cy.anchor("addons.aia-content").should("not.be.visible");

    // 아래 화살표도 같은 방향으로 센다.
    tab("addons.tab.claude").trigger("keydown", { key: "ArrowDown" });
    expectRoving(addons, "addons.tab.codex");
    cy.anchor("addons.codex-content").should("be.visible");

    // 끝에서 한 칸 더 가면 처음으로 감긴다.
    tab("addons.tab.codex").trigger("keydown", { key: "ArrowRight" });
    expectRoving(addons, "addons.tab.aia");

    // 반대 방향도 첫 탭에서 마지막으로 감긴다.
    tab("addons.tab.aia").trigger("keydown", { key: "ArrowLeft" });
    expectRoving(addons, "addons.tab.codex");

    // Home·End는 순환이 아니라 양끝으로 바로 간다.
    tab("addons.tab.codex").trigger("keydown", { key: "Home" });
    expectRoving(addons, "addons.tab.aia");
    tab("addons.tab.aia").trigger("keydown", { key: "End" });
    expectRoving(addons, "addons.tab.codex");

    // 다루지 않는 키는 선택을 건드리지 않는다.
    tab("addons.tab.codex").trigger("keydown", { key: "a" });
    expectRoving(addons, "addons.tab.codex");

    // 키보드로 옮긴 선택도 클릭과 같은 경로를 타므로 저장값에 남고 새로고침을 넘어간다.
    cy.window().its("localStorage").invoke("getItem", TAB_KEY).should("equal", "codex");
    cy.reload();
    cy.openView("addons").should("be.visible");
    tab("addons.tab.codex").should("have.class", "active");
  });

  it("탭 두 개뿐인 설정 → 플러그인 중메뉴도 같은 규칙으로 감기고 aria로 패널을 가리킨다", () => {
    const plugins = ["settings.plugins", "settings.ssh-keys"] as const;
    cy.visitApp();
    cy.openSettingsTab("plugins");
    tab("settings.plugins").should("have.class", "active");

    // 탭이 가리키는 패널이 실제로 그 id로 존재하고, 감춰진 쪽은 hidden이다.
    tab("settings.plugins").should("have.attr", "aria-controls", "plugin-panel-external");
    cy.get("#plugin-panel-external").should("have.attr", "role", "tabpanel").and("be.visible");
    cy.get("#plugin-panel-ssh").should("have.attr", "hidden");

    // 두 개짜리에서는 좌우 어느 쪽으로 가도 반대 탭에 닿는다.
    tab("settings.plugins").focus().trigger("keydown", { key: "ArrowLeft" });
    expectRoving(plugins, "settings.ssh-keys");
    cy.anchor("settings.ssh-keys-content").should("be.visible");
    cy.get("#plugin-panel-external").should("have.attr", "hidden");

    tab("settings.ssh-keys").trigger("keydown", { key: "ArrowRight" });
    expectRoving(plugins, "settings.plugins");
    cy.anchor("settings.external-plugins-content").should("be.visible");

    // 설정 화면은 감춰질 뿐 다시 그려지지 않으므로, 저장값이 없어도 고른 중메뉴가 그대로 남는다.
    tab("settings.plugins").trigger("keydown", { key: "End" });
    expectRoving(plugins, "settings.ssh-keys");
    cy.openView("dashboard");
    cy.openSettingsTab("plugins");
    tab("settings.ssh-keys").should("have.class", "active");
  });
});
