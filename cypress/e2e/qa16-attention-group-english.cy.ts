/// <reference types="cypress" />
// QA #16 회귀: 알림 묶음 머리줄의 건수·안읽음·출처 요약이 UI 언어를 따라야 한다.
// 예전에는 `{n}건`처럼 숫자와 단위를 따로 그려 정적 치환기가 단위만 "items"로 바꿔
// "3items"가 됐고, groupSubtitle의 "반복 회차"·"외 N곳"은 한국어로 남았다. 이제 세 문구는
// ChatAttentionCenter가 text(ko, en)으로 언어별 통째 문장을 짓는다.
// 묶음은 같은 반복 요청(consumerId)의 회차 알림 3건, 갈래 폴더 3곳, 그중 1건 읽음이다.

function scheduleItem(id: string, folder: string, read: boolean) {
  return {
    id,
    chatId: `chat-${id}`,
    source: "codex",
    providerSessionId: null,
    cwd: `/tmp/am-e2e/.rounds/${folder}`,
    resuming: false,
    unattended: true,
    profile: "standard",
    origin: { kind: "schedule", scheduleId: "schedule-qa16", runId: id, consumerId: "schedule-qa16" },
    kind: "completed",
    title: "회차 작업 완료",
    detail: null,
    approvalId: null,
    preview: null,
    createdAt: 1_700_000_000_000,
    read,
  };
}

const items = [
  scheduleItem("run-3", "wt-C", false),
  scheduleItem("run-2", "wt-B", false),
  scheduleItem("run-1", "wt-A", true),
];

describe("QA #16 알림 묶음 줄의 언어", () => {
  beforeEach(() => {
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: { items, unreadCount: 2, pendingCount: 0 } });
    cy.visitApp();
    cy.anchor("topbar.attention").should("be.visible");
  });

  after(() => {
    cy.restoreLanguage();
  });

  it("한국어에서는 건수·안읽음·출처가 한 문장으로 붙는다", () => {
    cy.anchor("topbar.attention").click();
    cy.get(".attention-group-head .attention-group-count").should("have.text", "3건 · 안읽음 2");
    cy.get(".attention-group-head .attention-group-sub").should("have.text", "반복 회차 · wt-C, wt-B 외 1곳");
  });

  it("영어에서는 세 문구가 모두 영어이고 숫자와 단위 사이가 붙지 않는다", () => {
    cy.setLanguage("en");
    cy.anchor("topbar.attention").click();
    cy.get(".attention-group-head .attention-group-count").should("have.text", "3 items · 2 unread");
    cy.get(".attention-group-head .attention-group-sub").should("have.text", "Recurring run · wt-C, wt-B and 1 more");
    // 묶음 머리줄 어디에도 한글이 남지 않는다(알림 제목은 서버가 준 원문이라 제외).
    cy.get(".attention-group-head .attention-group-count").invoke("text").should("not.match", /[가-힣]/);
    cy.get(".attention-group-head .attention-group-sub").invoke("text").should("not.match", /[가-힣]/);
  });
});
