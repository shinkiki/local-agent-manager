/// <reference types="cypress" />

const MAIN_KEY = "agent-manager.aia-chat.v1";
const SCOPED_KEY = "agent-manager.aia-window-sessions.v1";

function chat(chatId: string) {
  return {
    chatId, startedAt: 1, source: "codex", accountId: null, providerSessionId: null,
    resuming: false, cwd: "/tmp/aia-window-test", model: null, reasoningEffort: "medium",
    mode: "workspace", approvalMode: "manual", state: "ready", turnCount: 0,
    lastTurnStatus: null, replayTruncated: false, unattended: false, origin: { kind: "aia" },
    attached: true, interactiveApprovals: true, profile: "aia", systemTools: true,
    contextUsedTokens: null, contextWindowTokens: null,
  };
}

describe("독립 AIA 팝업창", () => {
  let chats: ReturnType<typeof chat>[];
  let requests: Array<{ type: string; chatId?: string; text?: string }>;

  beforeEach(() => {
    chats = [chat("existing-main")];
    requests = [];
    cy.stubInvoke("get_system_automation_snapshot", (req) => req.continue((res) => {
      res.body.settings.systemProvider = "codex";
    }));
    cy.stubInvoke("get_manager_snapshot", (req) => req.continue((res) => {
      res.body.status.providers.forEach((provider: { provider: string; cli: { detected: boolean } }) => {
        if (provider.provider === "codex") provider.cli.detected = true;
      });
    }));
    cy.stubInvoke("get_live_chats", (req) => req.reply({ statusCode: 200, body: chats }));
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: { items: [], unreadCount: 0, pendingCount: 0 } });
    cy.on("window:before:load", (win) => {
      win.localStorage.setItem("agent-manager.e2e-hooks", "1");
      win.localStorage.setItem(MAIN_KEY, "existing-main");
      const RealSocket = win.WebSocket;
      class ChatSocket extends win.EventTarget {
        readyState = 1;
        session: ReturnType<typeof chat> | undefined;
        constructor() {
          super();
          win.setTimeout(() => this.dispatchEvent(new win.Event("open")), 0);
        }
        send(raw: string) {
          const request = JSON.parse(raw);
          requests.push(request);
          if (request.type === "start" || request.type === "attach") {
            this.session = request.type === "start" ? chat(`new-${chats.length}`) : chats.find((item) => item.chatId === request.chatId);
            if (request.type === "start") chats.push(this.session!);
            this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ type: "state", session: this.session }) }));
          }
        }
        close() { this.readyState = 3; }
      }
      win.WebSocket = new Proxy(RealSocket, {
        construct(target, args) {
          return String(args[0]).includes("/api/chat") ? new ChatSocket() : Reflect.construct(target, args);
        },
      });
    });
  });

  it("대화창 버튼을 누를 때마다 서로 다른 창을 요청하고 메인 모달을 유지한다", () => {
    cy.visitApp();
    cy.anchor("topbar.aia").click();
    cy.get(".aia-chat-popup.open").should("be.visible");
    cy.window().then((win) => cy.stub(win, "open").returns({ focus() {} }).as("openPopup"));
    cy.anchor("topbar.aia-popout").should("not.exist");
    cy.get('.aia-chat-popup button[title="새 AIA 팝업창 열기"]').click().click();
    cy.get("@openPopup").should("have.been.calledTwice").then((stub: any) => {
      const first = stub.getCall(0).args;
      const second = stub.getCall(1).args;
      expect(first[1]).not.to.equal(second[1]);
      expect(new URL(first[0]).searchParams.get("popout")).to.equal("aia");
      expect(new URL(first[0]).searchParams.get("window")).not.to.equal(new URL(second[0]).searchParams.get("window"));
    });
    cy.get(".aia-chat-popup.open").should("be.visible");
    cy.then(() => expect(requests.filter((r) => r.type === "attach").map((r) => r.chatId)).to.deep.equal(["existing-main"]));
  });

  it("두 창은 새 대화를 만들고 각 창을 다시 열면 자기 대화만 복원한다", () => {
    cy.visit("/?popout=aia&window=one");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.then(() => expect(requests.filter((r) => r.type === "start")).to.have.length(1));
    cy.visit("/?popout=aia&window=two");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.then(() => expect(requests.filter((r) => r.type === "start")).to.have.length(2));
    cy.visit("/?popout=aia&window=one");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.then(() => expect(requests.filter((r) => r.type === "attach").map((r) => r.chatId)).to.deep.equal(["new-1"]));
    cy.visit("/?popout=aia&window=two");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.then(() => expect(requests.filter((r) => r.type === "attach").map((r) => r.chatId)).to.deep.equal(["new-1", "new-2"]));
    cy.window().then((win) => {
      expect(win.localStorage.getItem(MAIN_KEY)).to.equal("existing-main");
      expect(win.localStorage.getItem(SCOPED_KEY)).to.equal("1");
    });
  });

  it("작은 창에서도 대화가 창 크기에 맞고 창 닫기가 현재 창에만 전달된다", () => {
    cy.viewport(600, 500);
    cy.visit("/?popout=aia&window=small");
    cy.get(".aia-chat-popup.standalone.open").should(($popup) => {
      const rect = $popup[0].getBoundingClientRect();
      expect(rect.x).to.equal(0);
      expect(rect.y).to.equal(0);
      expect(rect.width).to.equal(600);
      expect(rect.height).to.equal(500);
    });
    cy.window().then((win) => cy.stub(win, "close").as("closePopup"));
    cy.get('.aia-chat-popup button[title="AIA 닫기"]').click();
    cy.get("@closePopup").should("have.been.calledOnce");
    cy.then(() => expect(requests.filter((r) => r.type === "stop")).to.have.length(0));
  });

  it("팝업 차단은 기존 대화를 유지한 채 오류로 표시한다", () => {
    cy.visit("/?popout=aia&window=blocked");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.window().then((win) => cy.stub(win, "open").returns(null));
    cy.get('.aia-chat-popup button[title="새 AIA 팝업창 열기"]').click();
    cy.contains("브라우저가 팝업을 차단했습니다").should("be.visible");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
  });

  it("메인 창이 없으면 안내를 대신 표시하지 않고 독립 대화를 유지한다", () => {
    cy.visit("/?popout=aia&window=guide");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.e2e().then((hooks) => hooks.showUiGuide({ target: "nav.settings", element: null, note: "설정 위치" })).should("eq", false);
    cy.get(".ui-guide").should("not.exist");
    cy.get(".aia-chat-popup.standalone.open textarea").should("be.enabled");
    cy.then(() => expect(requests.filter((r) => r.type === "start")).to.have.length(1));
  });
});
