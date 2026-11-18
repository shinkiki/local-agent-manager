/// <reference types="cypress" />

// 프로젝트 레지스트리(프로젝트 화면 → 설정 탭의 '프로젝트 활성여부' 카드. 예전에는 설정 →
// 라이브러리에 있었다)를 보는 스펙 넷이 저마다
// `ProjectRegistryEntry` 아홉 필드 리터럴을 통째로 적어 두고 있었고, 그중 셋은 카드를 집는
// 선택자("세션에서 확인한 프로젝트" 제목을 가진 settings-card)와 "레지스트리를 세우고 설정
// 탭을 열어 카드가 떴는지 본다"는 절차까지 글자 그대로 같았다. 백엔드가 항목에 필드를 하나
// 늘리거나 카드 제목이 바뀌면 네 곳을 함께 고쳐야 했으므로 기본 모양과 여는 절차를 여기 한 벌만
// 둔다. 여는 절차는 화면 방문을 품지 않는다 — 스펙마다 `cy.visitApp()`을 부르는 자리가 달라
// (스텁 전·스텁 후·beforeEach) 방문까지 묶으면 세우는 순서가 달라진다.
import type { ProjectRegistryEntry } from "../../src/types";

/** 레지스트리 항목 하나. 이름만 주면 활성·결정 완료·존재하는 프로젝트가 선다. */
export function projectEntry(
  name: string,
  overrides: Partial<ProjectRegistryEntry> = {},
): ProjectRegistryEntry {
  return {
    path: `/tmp/amproj/${name}`,
    name,
    sessionCount: 2,
    hiddenSessionCount: 0,
    updatedAt: null,
    providers: ["claude"],
    active: true,
    pending: false,
    exists: true,
    ...overrides,
  };
}

/** 프로젝트 화면 → 설정 탭의 '프로젝트 활성여부' 카드. 제목으로 찾아 카드 전체를 돌려준다. */
export function projectRegistryCard(): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.get(".settings-card").contains("h2", "세션에서 확인한 프로젝트").closest(".settings-card");
}

/** 백엔드가 들고 있는 레지스트리를 고정값으로 세운다. */
export function stubProjectRegistry(entries: ProjectRegistryEntry[]): void {
  cy.stubInvoke("get_project_registry", entries);
}

/** 프로젝트 화면의 설정 탭으로 옮겨 카드가 떴는지까지 확인한다. 방문은 스펙이 직접 한다. */
export function openProjectRegistryCard(): void {
  cy.openProjectsView("settings");
  projectRegistryCard().should("exist");
}
