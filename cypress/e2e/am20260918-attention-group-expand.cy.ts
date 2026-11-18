/// <reference types="cypress" />
/**
 * 알림 센터 묶음 머리줄의 펼침 계약(`AttentionGroupRow`,
 * src/components/ChatAttentionCenter.tsx:314). 낱개 알림은 눌러서 대화를 열지만 묶음
 * 머리줄은 같은 누름이 "펼치기"다 — 그래서 머리줄의 `aria-expanded`(:239)와 밑에 붙는
 * 낱개 행(`attention-item-nested`, :294)이 실제로 짝을 이루는지, 여러 묶음을 동시에
 * 펼쳐 둘 수 있는지(`expandedGroups`, :370)를 본다.
 *
 * 승인 대기는 서버가 삭제를 거절하므로 묶음이 통째로 `dismissable`을 잃고(:65,
 * src/lib/attentionGroups.ts) 스와이프 밑판(`attention-swipe-under`, :229)을 내지
 * 않는다. 같은 화면에서 지울 수 있는 묶음과 나란히 세워 두 머리줄이 갈리는지도 함께 본다.
 *
 * 기존 알림 시나리오와 겹치지 않는다 — AM-14·qa16은 묶음 머리줄의 다국어 문구,
 * AM-86은 빈 상태와 열고닫기, AM-315는 99+ 배지, 2026-09-18의 낱개 폴백 시나리오는
 * 낱개 줄의 둘째 줄이다. 머리줄을 눌렀을 때 무엇이 열리고 접히는지는 다룬 적이 없어,
 * 2026-09-18의 행 본문 통합(327d2874) 뒤에도 펼침이 조용히 깨지면 드러나지 않는다.
 */
import type { ProviderId } from "../../src/types";

const BASE = 1_757_300_000_000;

function item(overrides: Record<string, unknown>) {
  return {
    id: "attn",
    chatId: "chat",
    source: "codex" as ProviderId,
    providerSessionId: null,
    cwd: "/Users/qa/projects/group-lane",
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
    read: true,
    ...overrides,
  };
}

// 묶음 기준은 (범위, 공급자, 종류)다. chat-alpha의 완료 알림 셋은 한 묶음으로 접히고
// 그중 하나만 안읽음이라 머리줄은 "3건 · 안읽음 1"이 된다. chat-bravo의 승인 대기 둘은
// 읽음 여부와 무관하게 전부 미확인으로 세므로 "2건"이다. chat-charlie는 한 건뿐이라
// 묶이지 않고 낱개 줄로 선다 — 셋을 함께 두어야 머리줄만 골라 눌렀는지 확인할 수 있다.
const ITEMS = [
  item({ id: "a1", chatId: "chat-alpha", createdAt: BASE, read: false }),
  item({ id: "a2", chatId: "chat-alpha", createdAt: BASE - 1_000 }),
  item({ id: "a3", chatId: "chat-alpha", createdAt: BASE - 2_000 }),
  item({
    id: "b1",
    chatId: "chat-bravo",
    kind: "approval",
    approvalId: "apv-1",
    title: "실행 승인을 기다립니다",
    createdAt: BASE - 3_000,
  }),
  item({
    id: "b2",
    chatId: "chat-bravo",
    kind: "approval",
    approvalId: "apv-2",
    title: "실행 승인을 기다립니다",
    createdAt: BASE - 4_000,
  }),
  item({ id: "c1", chatId: "chat-charlie", kind: "failed", title: "작업이 실패했습니다", createdAt: BASE - 5_000 }),
];

const SNAPSHOT = { items: ITEMS, unreadCount: 3, pendingCount: 2 };

/** 목록의 맨 윗층. 묶음은 `.attention-group`, 한 건짜리는 `.attention-item`으로 선다. */
function topRows() {
  return cy.get(".attention-list > *");
}

function groupHead(index: number) {
  return cy.get(".attention-group").eq(index).find("> .attention-group-head");
}

describe("알림 묶음 머리줄 펼침", () => {
  beforeEach(() => {
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: SNAPSHOT });
    cy.visitApp();
    cy.anchor("topbar.attention").should("be.visible").click();
    cy.get(".attention-popover").should("be.visible");
  });

  it("접힌 채로 열려 건수만 보이고, 한 건짜리는 묶이지 않는다", () => {
    // 여섯 건이 두 묶음과 낱개 하나, 세 줄로 접힌다.
    topRows().should("have.length", 3);
    cy.get(".attention-group").should("have.length", 2);
    cy.get(".attention-list > .attention-item").should("have.length", 1);

    // 안읽음이 섞인 묶음은 건수 뒤에 안읽음 수까지 적고, 머리줄이 unread로 선다.
    groupHead(0).find(".attention-group-count").should("have.text", "3건 · 안읽음 1");
    groupHead(0).should("have.class", "unread");

    // 승인 대기는 읽음 표시와 무관하게 전부 미확인이라 부분 안읽음 문구가 붙지 않는다.
    groupHead(1).find(".attention-group-count").should("have.text", "2건");
    groupHead(1).should("have.class", "unread");

    // 접힌 동안에는 묶음에 든 낱개 행을 하나도 그리지 않는다.
    cy.get(".attention-item-nested").should("not.exist");
    groupHead(0).find("button.attention-open").should("have.attr", "aria-expanded", "false");
    groupHead(0).find(".attention-group-chevron").should("not.have.class", "open");

    // 한 건짜리는 머리줄이 아니라 낱개 줄이므로 건수·화살표를 달지 않는다.
    cy.get(".attention-list > .attention-item").find(".attention-group-count").should("not.exist");
    cy.get(".attention-list > .attention-item").find("button.attention-open").should("not.have.attr", "aria-expanded");
  });

  it("머리줄을 누르면 묶인 알림이 펼쳐지고 다시 누르면 접힌다", () => {
    groupHead(0).find("button.attention-open").click();

    groupHead(0).find("button.attention-open").should("have.attr", "aria-expanded", "true");
    groupHead(0).find(".attention-group-chevron").should("have.class", "open");
    // 머리줄 아래에 묶음에 든 세 건이 중첩 행으로 붙는다. 대표 항목도 빠지지 않는다.
    cy.get(".attention-group").eq(0).find(".attention-item-nested").should("have.length", 3);
    // 펼쳐도 다른 묶음은 접힌 채다.
    groupHead(1).find("button.attention-open").should("have.attr", "aria-expanded", "false");
    cy.get(".attention-group").eq(1).find(".attention-item-nested").should("not.exist");

    groupHead(0).find("button.attention-open").click();
    groupHead(0).find("button.attention-open").should("have.attr", "aria-expanded", "false");
    cy.get(".attention-item-nested").should("not.exist");
  });

  it("두 묶음을 함께 펼쳐 둘 수 있고 한쪽만 접어도 다른 쪽은 남는다", () => {
    groupHead(0).find("button.attention-open").click();
    groupHead(1).find("button.attention-open").click();

    cy.get(".attention-item-nested").should("have.length", 5);
    groupHead(0).find("button.attention-open").should("have.attr", "aria-expanded", "true");
    groupHead(1).find("button.attention-open").should("have.attr", "aria-expanded", "true");

    // 한쪽을 접어도 다른 쪽의 펼침은 그대로 남는다.
    groupHead(0).find("button.attention-open").click();
    cy.get(".attention-group").eq(0).find(".attention-item-nested").should("not.exist");
    cy.get(".attention-group").eq(1).find(".attention-item-nested").should("have.length", 2);
  });

  it("승인 대기가 든 묶음은 스와이프로 지울 길을 열지 않는다", () => {
    // 지울 수 있는 묶음에는 밀어서 지우기 밑판이 깔린다.
    groupHead(0).find(".attention-swipe-under").should("exist");
    // 승인 대기는 서버가 삭제를 거절하므로 묶음 전체가 밑판을 내지 않는다.
    groupHead(1).find(".attention-swipe-under").should("not.exist");

    // 펼친 뒤의 낱개 승인 행도 마찬가지다 — 묶음만 막고 낱개는 열어 두면 안 된다.
    groupHead(1).find("button.attention-open").click();
    cy.get(".attention-group").eq(1).find(".attention-item-nested .attention-swipe-under").should("not.exist");
  });
});
