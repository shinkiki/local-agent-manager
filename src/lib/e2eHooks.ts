import type { ChatEvent, UiElementLocator } from "../types";

// Cypress E2E 전용 훅. localStorage에 이 키가 "1"인 화면에서만 App이 세 콜백을 window에 노출한다.
// 같은 origin의 스크립트는 이미 DOM 전권을 가지므로 새 권한을 여는 것이 아니라 테스트 편의 경로다.
export const E2E_HOOKS_KEY = "agent-manager.e2e-hooks";

export interface AgentManagerE2eHooks {
  showUiGuide: (request: { target: string | null; element: UiElementLocator | null; note: string | null }) => Promise<boolean>;
  answerAiaUiQuery: (event: Extract<ChatEvent, { type: "uiQuery" }>) => void;
  performAiaUiClick: (event: Extract<ChatEvent, { type: "uiClick" }>) => void;
}

declare global {
  interface Window {
    __agentManagerE2E?: AgentManagerE2eHooks;
  }
}

/** 플래그가 정확히 "1"일 때만 true. storage 접근이 막혀 예외가 나면 false. */
export function e2eHooksEnabled(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return (storage ?? window.localStorage).getItem(E2E_HOOKS_KEY) === "1";
  } catch {
    return false;
  }
}

/** 훅을 window에 설치하고 제거 함수를 돌려준다. 다른 훅으로 바뀐 뒤의 제거는 건드리지 않는다. */
export function installE2eHooks(target: Window, hooks: AgentManagerE2eHooks): () => void {
  target.__agentManagerE2E = hooks;
  return () => {
    if (target.__agentManagerE2E === hooks) delete target.__agentManagerE2E;
  };
}
