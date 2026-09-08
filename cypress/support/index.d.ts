import type { RouteHandler } from "cypress/types/net-stubbing";
import type { AgentManagerE2eHooks } from "../../src/lib/e2eHooks";

declare global {
  namespace Cypress {
    interface Chainable {
      /** `[data-ui-anchor="<id>"]` 요소. AIA 화면 안내가 쓰는 앵커와 같은 이름을 쓴다. */
      anchor(id: string): Chainable<JQuery<HTMLElement>>;
      /** E2E 훅 플래그를 켠 채 모든 주 메뉴를 보이게 하여 앱 루트를 연다. `seed`를 주면 앱이 뜨기 전에 localStorage에 함께 심는다(같은 키는 seed가 이긴다). */
      visitApp(seed?: Record<string, string>): Chainable<Cypress.AUTWindow>;
      /** `[data-view="<id>"]` 중 열려 있는 화면. */
      view(id: string): Chainable<JQuery<HTMLElement>>;
      /** `nav.<id>` 내비를 눌러 그 화면을 열고, 열린 화면을 넘긴다. */
      openView(id: string): Chainable<JQuery<HTMLElement>>;
      /** 설정 화면을 열고(`settings.tab.<tabId>`) 탭을 누른 뒤 선택 상태를 넘긴다. */
      openSettingsTab(tabId: string): Chainable<JQuery<HTMLElement>>;
      /** 대시보드를 다녀와 `<id>` 화면을 다시 연다. 떠난 동안 그 화면이 사라진 것도 함께 본다. */
      revisitView(id: string): Chainable<JQuery<HTMLElement>>;
      /** 지침 화면을 열고 모드 탭(`info`·`manage`)을 눌러 눌린 상태를 넘긴다. */
      openInstructionMode(mode: "info" | "manage"): Chainable<JQuery<HTMLElement>>;
      /** 워크플로 화면의 페이싱 탭을 열고 사용량 예산 카드가 뜬 것까지 확인해 넘긴다. */
      openPacingTab(): Chainable<JQuery<HTMLElement>>;
      /** 사용량 예산 카드의 '예산 기본값' 모달을 열고 그 모달을 넘긴다. */
      openBudgetDefaultsModal(): Chainable<JQuery<HTMLElement>>;
      /** `POST /api/invoke/<command>` 응답을 세운다. 응답을 빼면 가로채기만 건다. */
      stubInvoke(command: string, response?: RouteHandler): Chainable<null>;
      /** App이 window에 설치한 E2E 훅. 설치될 때까지 재시도한다. */
      e2e(): Chainable<AgentManagerE2eHooks>;
      /** 설정 → 언어 탭의 UI 언어 select. 선택자는 언어를 타지 않는 클래스만 쓴다. */
      languageSelect(): Chainable<JQuery<HTMLSelectElement>>;
      /** 언어 탭을 연 뒤 UI 언어를 `value`로 고른다. */
      setLanguage(value: string): Chainable<JQuery<HTMLSelectElement>>;
      /** 애드온 화면의 탭을 누르고 그 탭의 패널이 뜬 것까지 확인해 넘긴다. 화면 열기는 따로 한다. */
      openAddonsTab(tab: string): Chainable<JQuery<HTMLElement>>;
      /** 반복 요청 목록의 '새 반복 요청'을 눌러 편집기를 열고 그 편집기를 넘긴다. */
      newScheduleEditor(): Chainable<JQuery<HTMLElement>>;
      /** 채팅 화면의 반복 요청 탭을 열고 새 반복 요청 편집기까지 연다. */
      openScheduleEditor(): Chainable<JQuery<HTMLElement>>;
      /** UI 언어를 한국어로 되돌린다. 영어로 바꾼 스펙이 `after`에서 부른다. */
      restoreLanguage(): Chainable<JQuery<HTMLElement>>;
    }
  }
}

export {};
