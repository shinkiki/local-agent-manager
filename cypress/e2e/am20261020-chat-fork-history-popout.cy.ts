/// <reference types="cypress" />
import { stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";

describe("분기 채팅의 이전 기록과 팝업 폭", () => {
  for (const width of [1080, 640]) {
    it(`${width}px 팝업에서 이전 메시지를 표시하고 창 전체를 채운다`, () => {
      const chat = stoppedChat({ forked: true, resuming: false, replayTruncated: false });
      cy.viewport(width, 760);
      stubLiveChat(chat);
      cy.stubInvoke("get_session_detail", (req) => {
        expect(req.body.request.id).to.equal(chat.providerSessionId);
        req.reply({ session: null, transcript: [
          { index: 0, turnId: "prior", role: "user", timestamp: 1600000000000,
            model: null, typeLabel: null, blocks: [{ kind: "text", text: "FORK_INHERITED_MESSAGE" }], usage: null },
        ], truncated: false, skippedLines: 0, unavailableReason: null });
      }).as("history");
      visitWithFakeChatSocket(chat, `/?popout=chat&chat=${chat.chatId}`);
      cy.wait("@history");
      cy.get(".chat-transcript-history").should("contain.text", "FORK_INHERITED_MESSAGE");
      cy.get(".structured-chat").should("not.contain.text", "CLI가 연결되었습니다");
      cy.get(".structured-chat").should(($chat) => {
        const rect = $chat[0].getBoundingClientRect();
        expect(rect.left).to.be.closeTo(0, 2);
        expect(rect.width).to.be.closeTo(width, 2);
      });
      cy.screenshot(`fork-history-popout-${width}`);
    });
  }

  it("Claude 분기의 새 기록이 아직 없으면 오류 대신 원본에서 이전 메시지를 읽는다", () => {
    const chat = stoppedChat({
      source: "claude", forked: true, forkSourceSessionId: "e2e-fork-source",
      providerSessionId: "e2e-fork-new", resuming: false, replayTruncated: false,
    });
    const item = (index: number, timestamp: number, text: string) => ({
      index, turnId: `t${index}`, role: "user", timestamp,
      model: null, typeLabel: null, blocks: [{ kind: "text", text }], usage: null,
    });
    const requested: string[] = [];
    stubLiveChat(chat);
    cy.stubInvoke("get_session_detail", (req) => {
      requested.push(req.body.request.id);
      if (req.body.request.id === chat.providerSessionId) {
        req.reply({ statusCode: 404, body: { error: "세션을 찾을 수 없습니다" } });
        return;
      }
      // fork 뒤 원본 채팅이 이어 쓴 대화는 이 채팅이 이어받은 것이 아니다.
      req.reply({ session: null, transcript: [
        item(0, chat.startedAt - 60_000, "FORK_SOURCE_MESSAGE"),
        item(1, chat.startedAt + 60_000, "SOURCE_AFTER_FORK"),
      ], truncated: false, skippedLines: 0, unavailableReason: null });
    }).as("history");
    visitWithFakeChatSocket(chat, `/?popout=chat&chat=${chat.chatId}`);
    cy.get(".chat-transcript-history").should("contain.text", "FORK_SOURCE_MESSAGE")
      .and("not.contain.text", "SOURCE_AFTER_FORK");
    cy.get(".error-banner").should("not.exist");
    cy.wrap(requested).should((ids) => {
      expect(ids[0]).to.equal("e2e-fork-new");
      expect(ids).to.include("e2e-fork-source");
    });
  });

  it("원본의 최근 구간이 전부 분기 뒤 대화면 앞 구간을 더 읽어 이어받은 메시지를 보인다", () => {
    const chat = stoppedChat({
      source: "claude", forked: true, forkSourceSessionId: "e2e-fork-source",
      providerSessionId: "e2e-fork-new", resuming: false, replayTruncated: false,
    });
    const item = (index: number, timestamp: number, text: string) => ({
      index, turnId: `t${index}`, role: "user", timestamp,
      model: null, typeLabel: null, blocks: [{ kind: "text", text }], usage: null,
    });
    stubLiveChat(chat);
    cy.stubInvoke("get_session_detail", (req) => {
      const { id, transcriptBeforeIndex } = req.body.request;
      if (id === chat.providerSessionId) {
        req.reply({ statusCode: 404, body: { error: "세션을 찾을 수 없습니다" } });
      } else if (transcriptBeforeIndex === undefined || transcriptBeforeIndex === null) {
        req.reply({ session: null, transcript: [item(900, chat.startedAt + 60_000, "SOURCE_AFTER_FORK")],
          truncated: true, skippedLines: 0, unavailableReason: null });
      } else {
        req.reply({ session: null, transcript: [item(100, chat.startedAt - 60_000, "FORK_EARLIER_MESSAGE")],
          truncated: false, skippedLines: 0, unavailableReason: null });
      }
    });
    visitWithFakeChatSocket(chat, `/?popout=chat&chat=${chat.chatId}`);
    cy.get(".chat-transcript-history").should("contain.text", "FORK_EARLIER_MESSAGE")
      .and("not.contain.text", "SOURCE_AFTER_FORK");
    cy.get(".error-banner").should("not.exist");
  });
});
