/// <reference types="cypress" />

// 로컬 LLM 회차 스펙이 공유하는 채팅 시작 헬퍼.
//
// 격리 백엔드는 스펙 사이에 살아 있어(E2E 스위트 상태 누출) 앞선 케이스가 등록한
// 임시 작업 폴더가 프로젝트 목록에 남는다. 그러면 ChatLaunchPanel의 "작업 경로"가
// 자유 입력 input에서 프로젝트 select로 바뀌고(`ChatLaunchPanel.tsx:157`),
// input을 바로 찾던 스펙은 두 번째 모델부터 요소를 못 찾아 실패했다. 앱 동작은
// 정상이므로 스펙이 "직접 입력…"을 먼저 고른 뒤 경로를 친다.

/** 임시 작업 폴더 때문에 뜨는 "새 프로젝트 감지" 모달을 닫는다. 떠 있지 않으면 아무 일도 안 한다. */
export function dismissNewProjectDialog(): void {
  cy.get("body").then(($body) => {
    if ($body.find(".modal-backdrop").length === 0) return;
    cy.contains(".modal-backdrop button", "나중에").click({ force: true });
    cy.get(".modal-backdrop").should("not.exist");
  });
}

/** 작업 경로를 친다. 프로젝트 select가 떠 있으면 "직접 입력…"으로 바꾼 뒤 친다. */
export function typeWorkPath(path: string): void {
  cy.get(".chat-launch-form").then(($form) => {
    // 프로젝트 select는 "직접 입력…"(__manual_cwd__) 옵션을 가진 select 하나뿐이다.
    // 순서로 고르면 공급자 select를 집을 수 있어 옵션 값으로 찾는다.
    if ($form.find("select option[value='__manual_cwd__']").length === 0) return;
    cy.get(".chat-launch-form select")
      .filter((_, el) => el.querySelector("option[value='__manual_cwd__']") !== null)
      .first()
      .select("__manual_cwd__");
  });
  cy.get(".chat-launch-form input[placeholder='/absolute/project/path']")
    .clear()
    .type(path, { delay: 0 });
}

/**
 * 지금 열린 대화가 턴을 끝냈는지 기다린다.
 *
 * `.terminal-status-ready`를 문서 전체에서 찾으면 **왼쪽 채팅 목록**의 다른 대화
 * 상태점(`ChatRuntimeList.tsx:128`)에 걸린다. 앞 케이스가 남긴 대화가 "입력 대기"로
 * 떠 있으면 아직 응답 중인 지금 대화를 끝난 것으로 읽어, 뒤이어 작성기에 submit
 * 버튼이 없다(응답 중에는 "대기열 추가"다)는 엉뚱한 실패가 났다. 열린 대화의 헤더
 * (`ChatView.tsx:1600`)로 범위를 좁힌다.
 *
 * 또 하나: 채팅을 막 시작한 직후에는 첫 턴이 아직 붙기 전이라 잠깐 ready다. 상태점만
 * 보면 그 순간에 통과해 버려, 응답이 하나도 오지 않은 화면을 "턴이 끝났다"로 읽는다
 * (2026-09-25 회차에서 코어 B가 58초 만에 거짓 통과했다). 그래서 **먼저 바쁨(작성기의
 * `.chat-composer-actions.is-busy`)이 뜨는 것을 본 뒤** 그것이 사라지기를 기다린다.
 */
export function waitTurnIdle(timeout = 600_000): void {
  waitTurnRunning();
  cy.get(".chat-composer-actions.is-busy", { timeout }).should("not.exist");
  cy.get(".chat-session-header .terminal-status-ready", { timeout: 30_000 }).should("exist");
}

/** 지금 열린 대화가 턴을 시작했는지 기다린다. 범위를 좁히는 이유는 waitTurnIdle과 같다. */
export function waitTurnRunning(timeout = 120_000): void {
  cy.get(".chat-composer-actions.is-busy", { timeout }).should("exist");
}
