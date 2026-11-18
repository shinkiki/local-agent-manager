/// <reference types="cypress" />
/**
 * 기기 알림(PWA)을 눌렀을 때 앱이 그 알림의 대상을 여는 계약(`src/lib/notificationOpen.ts`,
 * `useChatAttentionCenter`의 notificationOpen 처리, `public/sw.js`의 notificationclick).
 *
 * 서비스워커는 창이 없으면 `/?open-attention=<id>&open-chat=<chatId>`로 새 창을 열고,
 * 창이 있으면 같은 대상을 `agent-manager.open-attention` 메시지로 보낸다. 두 입구 모두
 * 인앱 알림창에서 그 항목을 누른 것과 같은 곳으로 가야 하고, 알림이 이미 지워졌으면
 * 채팅 ID로 대화만 연다. OS 알림 자체는 Cypress가 누를 수 없으므로 서비스워커가 만드는
 * 입력(주소·메시지)을 그대로 흉내 낸다.
 */
import { seedHarnessStorage } from "../support/appCommands";
import type { ProviderId } from "../../src/types";

const BASE = 1_757_300_000_000;

function item(overrides: Record<string, unknown>) {
  return {
    id: "attn",
    chatId: "chat",
    source: "codex" as ProviderId,
    providerSessionId: null,
    cwd: "/Users/qa/projects/notify-lane",
    resuming: false,
    unattended: false,
    profile: "standard",
    origin: null,
    kind: "completed",
    title: "작업이 끝났습니다",
    detail: null,
    approvalId: null,
    preview: null,
    createdAt: BASE,
    read: false,
    ...overrides,
  };
}

// 계정 전환 알림은 채팅이 없어 설정의 연결 탭으로 간다. 대화 창이 없는 격리 하네스에서도
// "알림 종류별 목적지"를 그대로 볼 수 있는 갈래라 이 스펙의 주 입력으로 쓴다.
const ITEMS = [
  item({ id: "acc-1", chatId: "", kind: "accountSwitch", title: "계정 자동전환", detail: "A → B · 한도" }),
  item({
    id: "round-decision:goal-1:1",
    chatId: "",
    cwd: "",
    kind: "roundDecision",
    title: "회차 결정 대기: M10",
    detail: "사람이 답할 결정 1건",
    createdAt: BASE - 500,
  }),
  item({ id: "done-1", chatId: "chat-done", createdAt: BASE - 1_000 }),
];
const SNAPSHOT = { items: ITEMS, unreadCount: 3, pendingCount: 0 };

const GOALS = [
  {
    id: "goal-1",
    title: "M10",
    goal: "회차 결정 목표",
    targetPath: "/Users/qa/projects/notify-lane",
    verification: "",
    cadence: "auto",
    status: "active",
    decisionMode: "manual",
    notes: "",
    createdAt: BASE,
    updatedAt: BASE,
  },
];

function sendOpenMessage(win: Cypress.AUTWindow, target: { attentionId: string; chatId: string }) {
  win.navigator.serviceWorker.dispatchEvent(new win.MessageEvent("message", {
    data: { type: "agent-manager.open-attention", target },
  }));
}

describe("기기 알림 클릭으로 대상 열기", () => {
  beforeEach(() => {
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: SNAPSHOT });
    cy.stubInvoke("mark_chat_attention_read", { statusCode: 200, body: SNAPSHOT });
    cy.stubInvoke("get_round_goals", { statusCode: 200, body: GOALS });
    cy.stubInvoke("list_round_reports", { statusCode: 200, body: [] });
  });

  it("새 창 주소의 열 대상을 알림 목록이 오면 열고, 주소에서 그 쿼리를 뗀다", () => {
    cy.visit("/?open-attention=done-1&open-chat=chat-done&keep=1", { onBeforeLoad: (win) => seedHarnessStorage(win) });
    // 완료 알림은 붙어 있는 채팅으로 연다 — 채팅 화면이 켜진다.
    cy.view("chat").should("exist");
    cy.location("search").should("eq", "?keep=1");
  });

  it("떠 있는 창은 서비스워커 메시지로 받은 대상을 인앱 알림과 같은 곳으로 연다", () => {
    cy.visitApp();
    cy.anchor("topbar.attention").should("be.visible");
    cy.view("settings").should("not.exist");
    cy.window().then((win) => sendOpenMessage(win, { attentionId: "acc-1", chatId: "" }));
    cy.view("settings").should("exist");
    cy.anchor("settings.tab.connections").should("have.class", "active");
  });

  it("회차 결정 대기 알림을 열면 워크플로 자동화 탭과 그 목표의 회차 상세 모달이 열린다", () => {
    cy.visitApp();
    cy.anchor("topbar.attention").click();
    cy.get(".attention-item-roundDecision").contains("회차 결정 대기: M10").click();
    cy.view("workflows").should("exist");
    cy.anchor("workflows.tab.automation").should("have.class", "active");
    cy.get('.round-report-modal-body[data-goal-id="goal-1"]').should("be.visible");
  });

  it("알림이 이미 지워졌으면 채팅 ID로 대화 화면만 연다", () => {
    cy.visitApp();
    cy.anchor("topbar.attention").should("be.visible");
    cy.openView("sessions");
    cy.window().then((win) => sendOpenMessage(win, { attentionId: "gone-9", chatId: "chat-gone" }));
    cy.view("chat").should("exist");
  });

  it("다른 종류의 서비스워커 메시지는 화면을 바꾸지 않는다", () => {
    cy.visitApp();
    cy.openView("sessions");
    cy.window().then((win) => {
      win.navigator.serviceWorker.dispatchEvent(new win.MessageEvent("message", { data: { type: "something-else", target: { attentionId: "acc-1", chatId: "" } } }));
    });
    cy.view("sessions").should("exist");
    cy.view("settings").should("not.exist");
  });
});
