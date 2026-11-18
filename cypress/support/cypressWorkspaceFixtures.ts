/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 애드온 → Cypress 패널을 보는 스펙 여섯이 저마다 작업공간 리터럴 열한 필드를 통째로 적고,
// 이어서 `get_cypress_registry`·`list_cypress_workspace_files` 응답 봉투와 "앱을 띄우고
// 세션 내비를 확인한 뒤 Cypress 탭을 연다"는 네 걸음을 다시 적어 두고 있었다. 백엔드가
// 작업공간에 필드를 하나 늘리면 여섯 파일을 같이 고쳐야 했다. 공통 모양과 봉투를 여기 한
// 벌만 두고, 스펙은 달라지는 값만 넘긴다. 응답의 모양을 적는 타입은 이 모듈 안에서만 쓰이므로
// 내보내지 않는다 — 밖에서 보이는 것은 아래 다섯 함수뿐이다.

interface CypressWorkspaceFixture {
  id: string;
  name: string;
  path: string;
  moduleDir: string | null;
  executionType: "standard" | "agentManagerIsolated";
  recordVideo: boolean;
  headed: boolean;
  createdAt: number;
  moduleReady: boolean;
  cypressVersion: string;
}

interface CypressWorkspaceFileFixture {
  path: string;
  sizeBytes: number;
  sensitive: boolean;
}

const BASE_WORKSPACE: CypressWorkspaceFixture = {
  id: "ws-e2e",
  name: "E2E 작업공간",
  path: "/tmp/e2e-cypress",
  moduleDir: null,
  executionType: "standard",
  recordVideo: false,
  headed: false,
  createdAt: 1_757_000_000_000,
  moduleReady: true,
  cypressVersion: "13.0.0",
};

/** 등록부에 실리는 작업공간 하나. 달라지는 필드만 넘긴다. */
export function cypressWorkspace(overrides: Partial<CypressWorkspaceFixture> = {}): CypressWorkspaceFixture {
  return { ...BASE_WORKSPACE, ...overrides };
}

/** `get_cypress_registry` 응답. 애드온 토글이 꺼진 상태를 보는 스펙만 직접 스텁을 쓴다. */
export function stubCypressRegistry(workspaces: CypressWorkspaceFixture[]): void {
  cy.stubInvoke("get_cypress_registry", { statusCode: 200, body: { enabled: true, workspaces } });
}

// 목록 응답의 꼬리(`truncated`·`limit`)는 여섯 스펙이 모두 같은 값을 적어 두었다. 잘림 안내를
// 보는 스펙이 생기면 그때 인자로 연다.
/** `list_cypress_workspace_files` 응답. 잘리지 않은 전체 목록으로 답한다. */
export function stubCypressWorkspaceFiles(files: CypressWorkspaceFileFixture[]): void {
  cy.stubInvoke("list_cypress_workspace_files", { statusCode: 200, body: { files, truncated: false, limit: 2000 } });
}

/** 어떤 요청에도 같은 파일 한 벌로 답하는 `read_cypress_workspace_file`. 파일마다 내용이 달라야 하는 스펙은 직접 스텁을 쓴다. */
export function stubCypressFileRead(path: string, content: string): void {
  cy.stubInvoke("read_cypress_workspace_file", {
    statusCode: 200,
    body: { path, content, sensitive: false, masked: false },
  });
}

// `openAddonsView("cypress")`가 이미 `addons.cypress-content`가 보이는 것까지 확인하고 넘기므로
// (addonsCommands.ts), 스펙마다 뒤에 붙이던 같은 단언은 여기서 한 번으로 끝난다.
/** 스텁을 세운 뒤 애드온 → Cypress 패널까지 들어간다. 반환값은 그 패널이다. */
export function openCypressWorkspacePanel(): Cypress.Chainable<JQuery<HTMLElement>> {
  cy.visitApp();
  cy.anchor("nav.sessions").should("be.visible");
  cy.openAddonsView("cypress");
  // 제품은 첫 작업공간을 자동 선택하지 않는다. 화면 계약을 보는 스펙도 사용자 선택을 명시한다.
  return cy.get(".cypress-workspace-select").first().click();
}
