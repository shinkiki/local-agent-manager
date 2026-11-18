/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

const E2E_HOOKS_KEY = "agent-manager.e2e-hooks";

Cypress.Commands.add("anchor", (id: string) => cy.get(`[data-ui-anchor="${id}"]`));

// 저장값 복원을 보는 스펙은 앱이 뜨기 전에 localStorage를 심어야 한다. 그 자리마다
// cy.visit을 다시 쓰면 E2E 훅 키가 스펙마다 복사되므로, 씨앗만 받아 여기서 함께 심는다.
// 준비중(개발 중) 화면은 앱 기본값이 숨김이다. 지금은 그런 화면이 없지만, 화면 스펙이 저마다
// 메뉴를 켜고 들어가지 않도록 하네스는 계속 모든 메뉴를 보이게 심는다. 기본값 자체를 보는
// 스펙은 이 키에 빈 문자열을 심어 저장값 없음으로 되돌린다. 키를 아는 곳은 여기 하나다 —
// 세대가 오르면(v2 → v3) 씨앗을 심는 스펙 전부가 함께 옮겨져야 한다.
export const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v3";
const ALL_MENUS_VISIBLE = JSON.stringify({ hidden: [] });

// 하네스가 앱이 뜨기 전에 심는 저장값. `cy.visitApp`이 쓰지 못하는 스펙(창 안을 더 손봐야 해서
// 직접 `cy.visit`을 부르는 자리)도 같은 씨앗을 쓰도록 심는 절차만 따로 내보낸다. 그 스펙들이
// 훅 키 문자열을 저마다 복사해 두면 키를 아는 곳이 다시 늘어난다.
export function seedHarnessStorage(win: Window, seed?: Record<string, string>): void {
  win.localStorage.setItem(E2E_HOOKS_KEY, "1");
  win.localStorage.setItem(NAVIGATION_PREFERENCES_KEY, ALL_MENUS_VISIBLE);
  for (const [key, value] of Object.entries(seed ?? {})) win.localStorage.setItem(key, value);
}

Cypress.Commands.add("visitApp", (seed?: Record<string, string>) =>
  cy.visit("/", { onBeforeLoad: (win) => seedHarnessStorage(win, seed) }),
);

Cypress.Commands.add("view", (id: string) => cy.get(`[data-view="${id}"]:not([hidden])`));

// 화면 전환은 언제나 "왼쪽 내비를 누르고 그 화면이 떴는지 본다"의 두 걸음이다. 스펙마다
// 앵커 이름과 data-view 선택자를 따로 적으면 같은 규칙이 스무 곳에 흩어진다.
Cypress.Commands.add("openView", (id: string) => {
  cy.anchor(`nav.${id}`).click();
  return cy.view(id).should("exist");
});

// 설정 화면의 중분류 탭(connections, aia, service, repository, language, display) 전환은
// "설정 화면을 열고 해당 탭을 눌러 활성화한다"의 공통 절차다. 외부 MCP·SSH·Cypress·Mermaid는
// 설정이 아니라 애드온 화면의 도구 탭이므로 openAddonsTab을 쓴다.
Cypress.Commands.add("openSettingsTab", (tabId: string) => {
  cy.openView("settings");
  cy.anchor(`settings.tab.${tabId}`).click();
  return cy.anchor(`settings.tab.${tabId}`).should("have.class", "active");
});

// 저장소 화면의 중분류 탭(data, library, secrets) 전환. 설정에 있던 라이브러리(공통 저장소
// 경로) 탭이 이리로 옮겨 오면서 `openSettingsTab("repository")`가 하던 자리를 대신한다.
Cypress.Commands.add("openStorageTab", (tabId: string) => {
  cy.openView("storage");
  cy.anchor(`storage.tab.${tabId}`).click();
  return cy.anchor(`storage.tab.${tabId}`).should("have.class", "active");
});

// "다른 화면을 다녀와도 유지된다"를 보는 스펙마다 "대시보드를 눌러 그 화면이 사라진 것을
// 확인하고 다시 연다"의 세 걸음을 손으로 적어 왔다. 떠나는 화면이 대시보드라는 것도, 떠난
// 동안 화면이 사라져 있어야 한다는 것도 같은 규칙이므로 여기 한 곳에 둔다.
Cypress.Commands.add("revisitView", (id: string) => {
  cy.anchor("nav.dashboard").click();
  cy.get(`[data-view="${id}"]:not([hidden])`).should("not.exist");
  return cy.openView(id);
});
