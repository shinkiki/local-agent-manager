/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

import type { RouteHandler } from "cypress/types/net-stubbing";

// 하네스 백엔드는 http://127.0.0.1 이라 secure context로 잡혀 public/sw.js가 등록된다.
// 셸 캐시가 이전 테스트의 화면을 되돌려 주지 않도록 매 테스트 전에 서비스워커와 캐시를 비운다.
const E2E_HOOKS_KEY = "agent-manager.e2e-hooks";
const LANGUAGE_SELECT = ".translation-language-actions select";

async function clearServiceWorkersAndCaches(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
}

beforeEach(() => {
  // 스펙 프레임은 baseUrl과 같은 origin이므로 여기서 지운 등록·캐시가 앱 프레임에도 적용된다.
  cy.wrap(clearServiceWorkersAndCaches(), { log: false });
});

// 격리 백엔드는 스펙 파일 사이에 살아 있어 한 스펙이 만든 세션 폴더가 다음 스펙의 개수·경계 단정
// (폴더 0개, 첫째·마지막 폴더)을 깨뜨린다. 스펙 파일마다 끝에서 남은 폴더를 모두 지운다 — 격리 환경에는
// 세션이 없어 폴더 삭제로 잃는 것이 없다. cy.request는 cy.intercept 스텁을 지나지 않으므로 실제 백엔드에 닿는다.
after(() => {
  cy.request({ method: "POST", url: "/api/invoke/get_manager_snapshot", body: {}, failOnStatusCode: false, log: false }).then((response) => {
    const folders: Array<{ id: string }> = Array.isArray(response.body?.folders) ? response.body.folders : [];
    for (const folder of folders) {
      cy.request({ method: "POST", url: "/api/invoke/delete_session_folder", body: { id: folder.id }, failOnStatusCode: false, log: false });
    }
  });
});

Cypress.Commands.add("anchor", (id: string) => cy.get(`[data-ui-anchor="${id}"]`));

// 저장값 복원을 보는 스펙은 앱이 뜨기 전에 localStorage를 심어야 한다. 그 자리마다
// cy.visit을 다시 쓰면 E2E 훅 키가 스펙마다 복사되므로, 씨앗만 받아 여기서 함께 심는다.
// 준비중(개발 중) 화면은 앱 기본값이 숨김이다. 화면 스펙이 저마다 메뉴를 켜고 들어가지 않도록
// 하네스는 모든 메뉴를 보이게 심는다. 기본 숨김 자체를 보는 스펙은 이 키에 빈 문자열을 심어
// 저장값 없음으로 되돌린다.
export const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v2";
const ALL_MENUS_VISIBLE = JSON.stringify({ hidden: [] });

Cypress.Commands.add("visitApp", (seed?: Record<string, string>) =>
  cy.visit("/", {
    onBeforeLoad(win) {
      win.localStorage.setItem(E2E_HOOKS_KEY, "1");
      win.localStorage.setItem(NAVIGATION_PREFERENCES_KEY, ALL_MENUS_VISIBLE);
      for (const [key, value] of Object.entries(seed ?? {})) win.localStorage.setItem(key, value);
    },
  }),
);

Cypress.Commands.add("view", (id: string) => cy.get(`[data-view="${id}"]:not([hidden])`));

// 화면 전환은 언제나 "왼쪽 내비를 누르고 그 화면이 떴는지 본다"의 두 걸음이다. 스펙마다
// 앵커 이름과 data-view 선택자를 따로 적으면 같은 규칙이 스무 곳에 흩어진다.
Cypress.Commands.add("openView", (id: string) => {
  cy.anchor(`nav.${id}`).click();
  return cy.view(id).should("exist");
});

// 설정 화면의 중분류 탭(connections, plugins, service, repository, language, display, automation 등)
// 전환은 "설정 화면을 열고 해당 탭을 눌러 활성화한다"의 공통 절차다.
Cypress.Commands.add("openSettingsTab", (tabId: string) => {
  cy.openView("settings");
  cy.anchor(`settings.tab.${tabId}`).click();
  return cy.anchor(`settings.tab.${tabId}`).should("have.class", "active");
});

// "다른 화면을 다녀와도 유지된다"를 보는 스펙마다 "대시보드를 눌러 그 화면이 사라진 것을
// 확인하고 다시 연다"의 세 걸음을 손으로 적어 왔다. 떠나는 화면이 대시보드라는 것도, 떠난
// 동안 화면이 사라져 있어야 한다는 것도 같은 규칙이므로 여기 한 곳에 둔다.
Cypress.Commands.add("revisitView", (id: string) => {
  cy.anchor("nav.dashboard").click();
  cy.get(`[data-view="${id}"]:not([hidden])`).should("not.exist");
  return cy.openView(id);
});

// 워크플로 → 페이싱 탭은 사용량 예산 스펙 일곱이 저마다 `openPacingTab`을 손으로 적어 두던
// 자리다. 같은 세 걸음인데 탭 선택 확인만 스펙마다 달라(aria-selected·클래스·생략) 규칙이
// 흩어져 있었다. 여기 한 벌로 두고, 예산 카드가 떴는지까지 확인해 넘긴다.
Cypress.Commands.add("openPacingTab", () => {
  cy.openView("workflows");
  cy.anchor("workflows.tab.recurring").click().should("have.attr", "aria-selected", "true");
  return cy.anchor("workflows.usage-budget").should("be.visible");
});

// 예산 기본값 모달을 여는 두 걸음도 같은 카드 안의 같은 버튼이다.
Cypress.Commands.add("openBudgetDefaultsModal", () => {
  cy.anchor("workflows.usage-budget").contains("button", "예산 기본값").click();
  return cy.get(".modal").should("be.visible");
});

Cypress.Commands.add("stubInvoke", (command: string, response?: RouteHandler) =>
  response === undefined
    ? cy.intercept("POST", `**/api/invoke/${command}`)
    : cy.intercept("POST", `**/api/invoke/${command}`, response),
);

Cypress.Commands.add("e2e", () => cy.window().its("__agentManagerE2E"));

// UI 언어를 고르는 곳은 설정 → 언어 탭의 select 하나뿐인데, 스펙마다 클래스 선택자와
// `aria-label`(한국어라 영어 화면에서는 잡히지 않는다)을 제각각 적어 왔다. 선택자를 아는 곳은
// 여기 하나로 둔다.
Cypress.Commands.add("languageSelect", () => cy.get(LANGUAGE_SELECT));

// "언어 탭을 열고 값을 고른다"는 다국어 스펙마다 되풀이되던 두 걸음이다.
Cypress.Commands.add("setLanguage", (value: string) => {
  cy.openSettingsTab("language");
  return cy.languageSelect().select(value);
});

// UI 언어는 백엔드 설정에 남아 스펙 경계를 넘는다. 하네스는 한 스위트에 백엔드 하나를 쓰므로,
// 영어로 바꾼 스펙이 되돌리지 않으면 알파벳 순서상 뒤에 오는 스펙 전부가 한국어 문구를 찾다가
// 무더기로 실패한다. 선택자는 언어를 타지 않는 클래스·앵커만 쓴다.
Cypress.Commands.add("restoreLanguage", () => {
  cy.visitApp();
  cy.anchor("nav.settings").click();
  cy.anchor("settings.tab.language").click();
  // 값을 읽은 뒤 `cy.wrap`한 참조로 고르면, 그 사이 화면이 다시 그려졌을 때 떨어져 나간
  // 노드에 change를 쏘게 되어 선택이 조용히 무시된다. 고를 때는 다시 조회해 최신 노드를 잡는다.
  cy.get(LANGUAGE_SELECT, { timeout: 20000 }).should("be.enabled").invoke("val").then((value) => {
    if (value !== "ko") cy.languageSelect().select("ko");
  });
  // 되돌림이 백엔드 설정에 실제로 닿을 때까지 기다린다. select만 바꾸고 끝내면 저장이 도는
  // 사이에 스펙이 끝나, 다음 스펙이 그대로 영어 화면을 만난다.
  return cy.anchor("nav.settings").should("contain.text", "설정");
});

// 지침 화면의 모드 탭은 "지침 화면을 열고 모드 버튼을 눌러 눌린 상태를 확인한다"의 세 걸음인데,
// 스펙 셋이 저마다 openManage를 손으로 적어 두고 선택자마저 갈렸다(한국어 aria-label을 박은 것과
// role=group만 쓴 것). 한국어 이름을 선택자에 넣으면 영어 화면에서 잡히지 않으므로, 언어를 타지
// 않는 role=group과 버튼 순서만 아는 한 벌을 여기 둔다.
const INSTRUCTION_MODES = ["info", "manage"] as const;

Cypress.Commands.add("openInstructionMode", (mode: "info" | "manage") => {
  cy.openView("instructions");
  return cy
    .get(".skill-mode-tabs[role=group] button")
    .eq(INSTRUCTION_MODES.indexOf(mode))
    .click()
    .should("have.attr", "aria-pressed", "true");
});

// 애드온 화면의 탭은 "탭을 눌러 활성 상태를 보고 그 탭의 패널이 떴는지 본다"의 두 걸음인데,
// 탭 이름과 패널 앵커 이름이 서로 다르게 붙어 있어(claude → claude-plugins-content) 스펙마다
// 그 대응을 손으로 적어 왔다. 대응을 아는 곳은 여기 하나로 둔다. 화면 열기는 포함하지 않는다 —
// 같은 화면 안에서 탭만 옮기는 스펙이 내비를 다시 누르게 되면 보려던 것이 달라진다.
const ADDONS_PANELS: Record<string, string> = {
  aia: "addons.aia-content",
  claude: "addons.claude-plugins-content",
  codex: "addons.codex-content",
};

Cypress.Commands.add("openAddonsTab", (tab: string) => {
  cy.anchor(`addons.tab.${tab}`).click().should("have.class", "active");
  return cy.anchor(ADDONS_PANELS[tab]).should("be.visible");
});

// 반복 요청 편집기를 여는 절차는 스펙 셋의 beforeEach가 통째로 같았다. 목록 헤더의 버튼을
// 누르고 편집기가 떴는지 보는 뒷걸음은 취소 후 다시 여는 자리에서도 쓰이므로 따로 둔다.
Cypress.Commands.add("newScheduleEditor", () => {
  cy.contains(".schedules-panel header .button", "새 반복 요청").click();
  return cy.get(".schedule-editor").should("be.visible");
});

Cypress.Commands.add("openScheduleEditor", () => {
  cy.openView("chat");
  cy.anchor("chat.tab.schedules").click().should("have.class", "active");
  return cy.newScheduleEditor();
});
