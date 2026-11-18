/// <reference types="cypress" />
import { openStoppedChat, stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";
import { CHAT_CLOSE_CONFIRMATION_KEY } from "../../src/lib/chatCloseConfirmation";

// 채팅 목록 행의 X(실행 종료 및 목록에서 제거)는 공용 확인 대화를 띄우고, 그 대화에만
// 붙는 '다음부터 표시 안 함' 체크박스를 단다(ChatView.tsx:1428-1439, 1608). 체크는
// 확인을 눌렀을 때만 localStorage에 남고(Shared.tsx:580 — request.checkbox.onConfirm은
// 확인 버튼 안에서만 불린다), 남으면 그 다음부터 종료가 묻지 않고 바로 실행된다
// (chatCloseConfirmation.ts:24).
//
// 검증 축: 세션·채팅 / 조건: 저장 후 복원(체크가 남아 다음 조작을 바꾸는가)과
// 취소 시 미저장. 기존 확인 대화 스펙(am20260907-confirm-dialog-keyboard,
// am20260906-skill-bulk-bar-confirm, am20260912-db-connection-row-actions)은 모두
// 체크박스가 없는 확인만 다뤘고, 앱 전체에서 checkbox를 넘기는 확인은 이 한 자리뿐인데
// 체크가 실제로 다음 확인을 없애는지는 화면으로 한 번도 확인된 적이 없다.
//
// 격리 백엔드에는 열린 채팅이 없으므로 get_live_chats를 종료된 채팅 한 건으로 스텁하고
// /api/chat 소켓만 가짜로 바꾼다. 운영 인스턴스의 채팅에는 닿지 않는다(스킬 5절).
// 종료가 실제로 끝난 뒤에도 스텁 목록은 같은 행을 계속 돌려주므로, 행이 사라지는지는
// 보지 않는다 — 여기서 보는 것은 확인 대화의 표시 여부와 저장값뿐이다.

const chat = stoppedChat({
  chatId: "qa-close-confirm-chat",
  providerSessionId: "qa-close-confirm-provider-session",
  cwd: "/tmp/qa-close-confirm",
});

const DIALOG = '[role="dialog"]';
const CLOSE_BUTTON = ".chat-runtime-list-close";

/** 채팅 목록만 연다 — 대화 창을 열면 현재 채팅 경로로 갈라지므로 목록에 머문다. */
function openChatList(): void {
  stubLiveChat(chat);
  visitWithFakeChatSocket(chat);
  cy.openView("chat");
  cy.get(".chat-runtime-list-item").should("have.length", 1);
}

function storedFlag(): Cypress.Chainable<string | null> {
  return cy.window().then((win) => win.localStorage.getItem(CHAT_CLOSE_CONFIRMATION_KEY));
}

describe("채팅 종료 확인의 '다음부터 표시 안 함' 체크박스", () => {
  it("취소하면 체크를 해 두었어도 저장되지 않고 다음 종료에서 다시 묻는다", () => {
    openChatList();
    storedFlag().should("be.null");

    cy.get(CLOSE_BUTTON).click();
    cy.get(DIALOG).should("be.visible").and("contain.text", "채팅 실행을 종료할까요?");
    // 종료되지 않은 채팅이므로 '진행 중인 작업'이 아니라 제거 안내만 나온다.
    cy.get(DIALOG).should("contain.text", "이 채팅 실행을 종료하고 채팅 목록에서 제거합니다.");
    // 체크박스는 확인 대화 전용 자리에 꺼진 채로 선다.
    cy.get(DIALOG).find(".confirm-dialog-option input[type=checkbox]").should("not.be.checked").check();
    cy.get(DIALOG).contains("button", "취소").click();
    cy.get(DIALOG).should("not.exist");

    // 취소는 체크를 삼킨다 — 저장값이 생기면 다음 종료가 조용히 실행된다.
    storedFlag().should("be.null");

    cy.get(CLOSE_BUTTON).click();
    cy.get(DIALOG).should("be.visible");
    // 다시 열린 대화의 체크박스는 앞서 켠 값을 물려받지 않는다.
    cy.get(DIALOG).find(".confirm-dialog-option input[type=checkbox]").should("not.be.checked");
    cy.get(DIALOG).contains("button", "취소").click();
    cy.get(DIALOG).should("not.exist");
  });

  it("체크하고 종료하면 저장되고 다음 종료는 확인 없이 바로 실행된다", () => {
    openChatList();

    cy.get(CLOSE_BUTTON).click();
    cy.get(DIALOG).find(".confirm-dialog-option input[type=checkbox]").check();
    cy.get(DIALOG).contains("button", "종료").click();
    cy.get(DIALOG).should("not.exist");

    storedFlag().should("equal", "hidden");

    // 두 번째 종료는 확인 없이 지나간다. 대화가 다시 뜨면 저장값을 읽지 않은 것이다.
    cy.get(CLOSE_BUTTON).should("be.enabled").click();
    cy.get(DIALOG).should("not.exist");
    // 종료 자체는 실패하지 않는다 — 오류 배너가 떴다면 저장값과 무관한 다른 결함이다.
    cy.get(".chat-error, .error-banner").should("not.exist");
  });
});
