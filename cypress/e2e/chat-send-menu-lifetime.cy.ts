/// <reference types="cypress" />
import {
  stoppedChat, visitWithFakeChatSocket,
  type FakeChatSocketHandles,
} from "../support/chatSessionFixtures";

const chat = stoppedChat({ chatId: "send-menu-lifetime", state: "running" });
let currentChat = chat;
const composer = ".structured-chat .chat-composer";
const trigger = `${composer} .chat-send-action-trigger`;
const menu = `${composer} [role="menu"]`;

function finishResponse() {
  currentChat = { ...chat, state: "ready" };
  cy.window().then((win) => {
    const socket = (win as unknown as FakeChatSocketHandles).__qaChatSocket;
    expect(socket, "attached fake chat socket").not.to.equal(null);
    socket!.dispatchEvent(new win.MessageEvent("message", {
      data: JSON.stringify({ type: "state", session: currentChat }),
    }));
  });
  cy.get(".structured-chat .chat-session-header").should("contain.text", "입력 대기");
}

for (const viewport of [{name:"PC",width:1440,height:900},{name:"모바일",width:390,height:844}]) {
  describe(`V2 전송 메뉴 수명 · ${viewport.name}`, () => {
    beforeEach(() => {
      cy.viewport(viewport.width, viewport.height);
      currentChat = { ...chat };
      cy.stubInvoke("get_live_chats", (req) => req.reply({ statusCode: 200, body: [currentChat] }));
      visitWithFakeChatSocket(chat);
      cy.openView("chat");
      cy.get(".chat-hub-tabs").then(($tabs) => {
        if ($tabs.find(".chat-list-restore").length) cy.get(".chat-list-restore").click();
      });
      cy.get(".chat-runtime-list-item").should("have.length", 1).click();
      cy.get(".structured-chat .chat-session-header").should("be.visible");
      cy.get(`${composer} textarea`).type("후속 질문");
      cy.get(trigger).click().should("have.attr", "aria-expanded", "true");
      cy.get(menu).should("be.visible");
    });

    it("응답이 끝나도 열린 메뉴를 유지하고 고른 메시지를 한 번 보낸다", () => {
      finishResponse();
      cy.get(trigger).should("have.attr", "aria-expanded", "true");
      cy.get(menu).should("be.visible").contains('[role="menuitem"]', "대기열 추가").click();
      cy.get(menu).should("not.exist");
      cy.get(`${composer} textarea`).should("have.value", "");
      cy.window().should((win) => {
        const sent = (win as unknown as FakeChatSocketHandles).__qaSent.map(raw => JSON.parse(raw));
        expect(sent.filter(message => message.type === "send" && message.text === "후속 질문")).to.have.length(1);
      });
      cy.get(`${composer} button[type="submit"]`).should("be.visible");
    });

    it("트리거로 닫은 메뉴는 응답 종료 뒤 전송 버튼으로 돌아온다", () => {
      cy.get(trigger).click().should("have.attr", "aria-expanded", "false");
      finishResponse();
      cy.get(trigger).should("not.exist");
      cy.get(`${composer} button[type="submit"]`).should("be.visible");
      cy.get(`${composer} textarea`).should("have.value", "후속 질문");
    });

    it("응답 종료 뒤 Esc로 닫아도 초안을 보존하고 전송 버튼으로 돌아온다", () => {
      finishResponse();
      cy.get(menu).should("be.visible");
      cy.get("body").type("{esc}");
      cy.get(menu).should("not.exist");
      cy.get(trigger).should("not.exist");
      cy.get(`${composer} textarea`).should("have.value", "후속 질문");
      cy.get(`${composer} button[type="submit"]`).should("be.visible");
    });
  });
}
