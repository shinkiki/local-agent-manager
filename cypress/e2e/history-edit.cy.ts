/// <reference types="cypress" />
import { seedHarnessStorage } from "../support/appCommands";
import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";
import { stoppedChat, visitWithFakeChatSocket, type FakeChatSocketHandles } from "../support/chatSessionFixtures";

// G1/G2: fixtures only. Every chat socket is replaced; no provider process or transcript is mutated.
const sessions: SessionSummary[] = ["A", "B", "C"].map((name) => ({
  source: "codex", id: `history-fixture-${name}`, title: `History fixture ${name}`,
  sourceTitle: null, project: "/tmp/history-fixture", cwd: "/tmp/history-fixture",
  startedAt: 1757200000000, updatedAt: 1757200060000, messageCount: 40,
  tokenTotal: 120, tokenUsage: null, model: "gpt-5", gitBranch: "develop",
  isSubagent: false, aiaWorkspace: false, archived: false, readable: true,
  sizeBytes: 4096, filePath: `/tmp/history-fixture/${name}.jsonl`,
  meta: { favorite: false, hidden: false, note: null, customTitle: null,
    folderIds: [], reasoningEffort: null, mode: null, approvalMode: null,
    creationAccountId: null, boundAccountId: null, pinnedAccountId: null },
  lastFailure: null,
}));
const transcript: TranscriptItem[] = Array.from({ length: 40 }, (_, index) => ({
  index, turnId: `turn-${Math.floor(index / 2)}`,
  role: index % 2 ? "assistant" : "user", timestamp: index + 1,
  model: null, typeLabel: null, usage: null,
  blocks: [{ kind: "text", text: index === 0 ? "Original first question" :
    `Message ${index}\n\n${"A paragraph long enough to scroll the conversation. ".repeat(14)}` }],
}));
const branch = stoppedChat({ chatId: "history-edit-branch", providerSessionId: "history-edited-provider", state: "ready", forked: true });
const title = (name: string) => cy.get(".drawer-title").should("contain.text", `History fixture ${name}`);
const close = () => cy.get(".drawer-header-actions button[aria-label='닫기']").click();
const open = (name: string) => {
  cy.contains(".session-table tbody tr", `History fixture ${name}`).click();
  title(name);
  cy.get(".transcript-section").should("contain.text", "Original first question");
};


function selectEditableMessage(selector = ".message-edit-trigger") {
  const article = selector.includes(".chat-message") ? ".chat-message-user[tabindex]" : ".message-user[tabindex]";
  cy.get(article).first().scrollIntoView().then(($message) => {
    if (!$message.find(".message-edit-popup").length) cy.wrap($message).find(".user-message-header").click();
  });
}

function assertEditIcon(selector: string) {
  selectEditableMessage(selector);
  cy.get(selector).first().scrollIntoView().should("be.visible").and("have.attr", "aria-label", "편집 후 다시 진행").then(($button) => {
    const button = $button[0];
    const message = button.closest("article")!;

    const bounds = button.closest(".message-edit-popup")!.getBoundingClientRect();
    const parentBounds = message.getBoundingClientRect();
    expect(button.textContent).to.equal("");
    expect(parentBounds.right - bounds.right, "popup at message right").to.be.within(0, 20);
    expect(Math.abs((bounds.top + bounds.bottom - parentBounds.top - parentBounds.bottom) / 2), "popup vertically centered").to.be.lessThan(2);
    expect(message.querySelector(".user-message-header > strong")!.textContent).to.equal("사용자 요청");
    const height = parentBounds.height;
    button.style.display = "none";
    expect(message.getBoundingClientRect().height, "icon takes no layout space").to.equal(height);
    button.style.removeProperty("display");
  }).find("svg").should("be.visible");
}

describe("Conversation history and edited-message branching", () => {
  beforeEach(() => {
    cy.viewport(1100, 700);
    cy.stubSnapshotField("sessions", sessions);
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [] });
    cy.stubInvoke("get_session_summary", (req) => {
      const session = sessions.find((entry) => entry.id === req.body.request.id);
      expect(session, "known fixture session").to.exist;
      req.reply(session);
    }).as("summary");
    cy.stubInvoke("get_session_detail", (req) => {
      const session = sessions.find((entry) => entry.id === req.body.request.id) ?? sessions[0];
      const detail: SessionDetail = { session, transcript, truncated: false, skippedLines: 0, unavailableReason: null };
      req.reply(detail);
    }).as("detail");
    visitWithFakeChatSocket(branch);
    // Keep successful edit handoff in this fixture window, without opening another live app.
    cy.window().then((win) => cy.stub(win, "open").returns({ focus() {} } as Window).as("popout"));
    cy.openView("sessions");
  });

  it("shows edit actions only after message selection and dismisses them outside or with Escape", () => {
    open("A");
    cy.get(".message-edit-trigger").should("not.exist");
    assertEditIcon(".message-edit-trigger");
    cy.get(".drawer-title").click();
    cy.get(".message-edit-trigger").should("not.exist");
    cy.get(".message-user[tabindex]").first().scrollIntoView().focus().trigger("keydown", { key: "Enter" });
    cy.get(".message-edit-trigger").should("be.visible");
    cy.get(".message-edit-trigger").focus().trigger("keydown", { key: "Escape" });
    cy.get(".message-edit-trigger").should("not.exist");
    cy.get(".message-user[tabindex]").first().should("be.focused");
  });

  it("offers touch-sized copy, edit and rewind actions without sending the rewind draft", () => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [branch] });
    open("A");
    cy.viewport(390, 844);
    selectEditableMessage();
    cy.get(".message-edit-popup button").should("have.length", 3).each(($button) => {
      const bounds = $button[0].getBoundingClientRect();
      expect(Math.round(bounds.width)).to.be.at.least(44);
      expect(Math.round(bounds.height)).to.be.at.least(44);
    });
    cy.window().then((win) => cy.stub(win.navigator.clipboard, "writeText").resolves().as("copyMessage"));
    cy.get(".message-edit-popup button[aria-label='메시지 복사']").click();
    cy.get("@copyMessage").should("have.been.calledWith", "Original first question");
    cy.get(".drawer .chat-composer textarea").should("not.have.attr", "placeholder", "기존 대화에 연결하고 있습니다");
    cy.get(".message-rewind-action").click();
    cy.view("chat").should("be.visible");
    cy.get(".chat-composer textarea").should("have.value", "Original first question");
    cy.window().then((win) => {
      const commands = (win as unknown as FakeChatSocketHandles).__qaSent.map((raw) => JSON.parse(raw));
      expect(commands.filter((entry) => entry.type === "send")).to.have.length(0);
      const starts = commands.filter((entry) => entry.type === "start");
      expect(starts).to.have.length(1);
      expect(starts[0].request.editMessage).to.deep.equal({ index: 0, expectedText: "Original first question" });
    });
  });

  it("keeps a message editable when its stored date is outside the supported range", () => {
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: {
      session: sessions[0],
      transcript: [{ ...transcript[0], timestamp: 8640000000000001 }],
      truncated: false, skippedLines: 0, unavailableReason: null,
    } });
    open("A");
    cy.get(".message-user .user-message-header").should("contain.text", "사용자 요청").find("time").should("not.exist");
    selectEditableMessage();
    cy.get(".message-edit-trigger").first().click();
    cy.get(".message-edit-form textarea").should("have.value", "Original first question");
  });

  it("validates and cancels editing without changing the original or creating a branch", () => {
    open("A");
    assertEditIcon(".message-edit-trigger");
    selectEditableMessage();
    cy.get(".message-edit-trigger").first().click();
    cy.get(".message-edit-form textarea").should("have.value", "Original first question").clear().type("   ");
    cy.get(".message-edit-form button[type=submit]").should("be.disabled");
    cy.get(".message-edit-form").contains("button", "취소").click();
    cy.get(".message-edit-form").should("not.exist");
    cy.get(".transcript-section").should("contain.text", "Original first question");
    cy.window().then((win) => expect((win as unknown as FakeChatSocketHandles).__qaSent).to.deep.equal([]));
  });


  it("cancels an unsent edited branch when the original drawer closes during startup", () => {
    open("A");
    type PendingWindow = Window & FakeChatSocketHandles & { releaseEditStart?: () => void };
    cy.window().then((win) => {
      const priorSocket = win.WebSocket;
      class PendingEditSocket extends win.EventTarget {
        readyState = 0;
        constructor(_url: string) {
          super();
          win.setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new win.Event("open"));
          }, 0);
        }
        send(raw: string) {
          const handles = win as unknown as PendingWindow;
          handles.__qaSent.push(raw);
          if (JSON.parse(raw).type === "start") {
            handles.releaseEditStart = () => this.dispatchEvent(new win.MessageEvent("message", {
              data: JSON.stringify({ type: "state", session: branch }),
            }));
          }
        }
        close() {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.dispatchEvent(new win.CloseEvent("close"));
        }
      }
      win.WebSocket = new Proxy(priorSocket, {
        construct(target, args: [string, ...unknown[]]) {
          if (String(args[0]).includes("/api/chat")) return new PendingEditSocket(args[0]);
          return new (target as unknown as new (...rest: unknown[]) => WebSocket)(...args);
        },
      }) as typeof WebSocket;
    });
    selectEditableMessage();
    cy.get(".message-edit-trigger").first().click();
    cy.get(".message-edit-form textarea").clear().type("Canceled edit");
    cy.get(".message-edit-form button[type=submit]").click();
    cy.window().should((win) => expect((win as unknown as PendingWindow).releaseEditStart).to.be.a("function"));
    close();
    cy.get(".drawer").should("not.exist");
    cy.openView("dashboard");
    cy.window().then((win) => (win as unknown as PendingWindow).releaseEditStart!());
    cy.window().should((win) => {
      const messages = (win as unknown as PendingWindow).__qaSent.map((raw) => JSON.parse(raw));
      expect(messages.filter((entry) => entry.type === "stop")).to.have.length(1);
      expect(messages.filter((entry) => entry.type === "send")).to.have.length(0);
      expect(messages.filter((entry) => entry.type === "detach")).to.have.length(1);
    });
    cy.view("dashboard").should("be.visible");
    cy.get("@popout").should("not.have.been.called");
  });

  it("sends the selected original index/text and replacement once, preserving the original session", () => {
    cy.stubInvoke("get_live_chats", { statusCode: 200, body: [branch] });
    open("A");
    selectEditableMessage();
    cy.get(".message-edit-trigger").first().click();
    cy.get(".message-edit-form textarea").clear().type("Edited first question");
    cy.get(".message-edit-form button[type=submit]").click();
    cy.view("chat").should("be.visible");
    cy.get("@popout").should("not.have.been.called");
    cy.get(".message-edit-form").should("not.exist");
    cy.window().then((win) => {
      const messages = (win as unknown as FakeChatSocketHandles).__qaSent.map((raw) => JSON.parse(raw));
      const starts = messages.filter((entry) => entry.type === "start");
      expect(starts).to.have.length(1);
      expect(starts[0].request.forkSessionId).to.equal(sessions[0].id);
      expect(starts[0].request.editMessage).to.deep.equal({ index: 0, expectedText: "Original first question" });
      expect(messages.filter((entry) => entry.type === "send")).to.deep.equal([
        { type: "send", text: "Edited first question", steer: false, attachmentIds: [] },
      ]);
    });
    cy.openView("sessions");
    cy.view("sessions").should("be.visible");
    title("A");
    cy.view("sessions").find(".transcript-section").should("contain.text", "Original first question").and("contain.text", "Message 39");
  });
});

describe("Live chat edited-message branching", () => {
  for (const source of ["codex", "claude"] as const) for (const rejectFork of [false, true]) for (const rewind of [false, true]) {
    it(source + (rewind ? " rewind: " : " edit: ") + (rejectFork ? "keeps the original connection and editor draft when fork is rejected" : "adopts the edited branch once and keeps the original chat selectable"), () => {
      const original = stoppedChat({ source, chatId: "live-edit-original", providerSessionId: sessions[0].id, cwd: "/tmp/live-original", state: "ready" });
      const edited = stoppedChat({ source, chatId: "live-edit-result", providerSessionId: "live-edit-result-session", cwd: "/tmp/live-edited", state: "ready", forked: true });
      let branchCreated = false;
      type LiveHandles = Window & { liveEditCommands: { owner: string; message: { type: string; text?: string; request?: { editMessage?: unknown; forkSessionId?: string } } }[] };
      cy.viewport(1100, 700);
      cy.stubInvoke("get_live_chats", (req) => req.reply(branchCreated ? [original, edited] : [original]));
      cy.stubInvoke("get_session_detail", (req) => req.reply({
        session: sessions[0], transcript: req.body.request.id === sessions[0].id ? transcript.slice(0, 2) : [],
        truncated: false, skippedLines: 0, unavailableReason: null,
      }));
      cy.visit("/", { onBeforeLoad(win) {
        seedHarnessStorage(win);
        const handles = win as unknown as LiveHandles;
        handles.liveEditCommands = [];
        const RealWebSocket = win.WebSocket;
        class LiveSocket extends win.EventTarget {
          readyState = 0;
          owner = "";
          constructor(_url: string) {
            super();
            win.setTimeout(() => {
              this.readyState = 1;
              this.dispatchEvent(new win.Event("open"));
            }, 0);
          }
          emit(event: unknown) {
            this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
          }
          replay(info: typeof original, text: string) {
            this.emit({ type: "state", session: info });
            this.emit({ type: "turn", id: info.chatId + "-turn", status: "started", timestamp: 1 });
            this.emit({ type: "userInput", id: info.chatId + "-user", text, attachments: [] });
            this.emit({ type: "messageDelta", id: info.chatId + "-answer", role: "assistant", kind: "message", delta: "Fixture response" });
            this.emit({ type: "turn", id: info.chatId + "-turn", status: "completed", timestamp: 2 });
            this.emit({ type: "state", session: info });
          }
          send(raw: string) {
            const message = JSON.parse(raw);
            if (message.type === "attach") this.owner = message.chatId;
            if (message.type === "start") this.owner = edited.chatId;
            handles.liveEditCommands.push({ owner: this.owner, message });
            if (message.type === "attach") {
              win.setTimeout(() => this.replay(this.owner === original.chatId ? original : edited,
                this.owner === original.chatId ? "Original first question" : "Edited live question"), 0);
            } else if (message.type === "start") {
              win.setTimeout(() => {
                if (rejectFork) this.emit({ type: "rejected", code: "invalid", message: "Fixture fork rejection" });
                else {
                  branchCreated = true;
                  this.emit({ type: "state", session: edited });
                }
              }, 0);
            } else if (message.type === "send") {
              this.replay(edited, message.text);
            }
          }
          close() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.dispatchEvent(new win.CloseEvent("close"));
          }
        }
        win.WebSocket = new Proxy(RealWebSocket, {
          construct(target, args: [string, ...unknown[]]) {
            if (String(args[0]).includes("/api/chat")) return new LiveSocket(args[0]);
            return new (target as unknown as new (...rest: unknown[]) => WebSocket)(...args);
          },
        }) as typeof WebSocket;
      } });
      cy.openView("chat");
      cy.get(".chat-runtime-list-item").should("have.length", 1).click();
      cy.get(".chat-message-markdown").should("contain.text", "Original first question");
      assertEditIcon(".chat-message .message-edit-trigger");
      selectEditableMessage(".chat-message .message-edit-trigger");
      if (rewind) cy.get(".chat-message .message-rewind-action").click();
      else {
        cy.get(".chat-message .message-edit-trigger").first().click();
        cy.get(".message-edit-form textarea").clear().type("Edited live question");
        cy.get(".message-edit-form button[type=submit]").click();
      }
      if (rejectFork) {
        cy.get(rewind ? ".message-action-error" : ".message-edit-form [role=alert]").should("contain.text", "Fixture fork rejection");
        // 실패 문구는 작업 막대 안에 있다 — 그것을 눌러도 막대와 문구가 닫히지 않는다.
        if (rewind) cy.get(".message-action-error").click().should("contain.text", "Fixture fork rejection");
        if (!rewind) cy.get(".message-edit-form textarea").should("have.value", "Edited live question").and("not.be.disabled");
        cy.get(".chat-message-markdown").should("contain.text", "Original first question");
      } else {
        cy.get(".message-edit-form").should("not.exist");
        if (rewind) {
          cy.get(".chat-composer textarea").should("have.value", "Original first question");
          cy.get(".chat-message-markdown").should("not.exist");
        } else cy.get(".chat-message-markdown").should("contain.text", "Edited live question");
        cy.contains(".chat-runtime-list-item", "live-original").click();
        cy.get(".chat-message-markdown").should("contain.text", "Original first question");
      }
      cy.window().then((win) => {
        const commands = (win as unknown as LiveHandles).liveEditCommands;
        const starts = commands.filter(({ message }) => message.type === "start");
        expect(starts).to.have.length(1);
        expect(starts[0].message.request?.forkSessionId).to.equal(sessions[0].id);
        expect(starts[0].message.request?.editMessage).to.deep.equal({ index: 0, expectedText: "Original first question" });
        const sends = commands.filter(({ message }) => message.type === "send");
        expect(sends).to.have.length(rejectFork || rewind ? 0 : 1);
        if (!rejectFork && !rewind) expect(sends[0].message.text).to.equal("Edited live question");
        if (rejectFork) expect(commands.filter(({ owner, message }) => owner === original.chatId && (message.type === "detach" || message.type === "stop"))).to.have.length(0);
      });
    });
  }
});
