/// <reference types="cypress" />
/**
 * 알림 낱개 줄의 둘째 줄에 서는 "대화 이름"이 세션 제목 → 작업 폴더 이름 → 공급자 이름
 * 순으로 내려가는지 본다(attentionSessionLabel, src/components/ChatAttentionCenter.tsx:33).
 * 세션은 `source`와 `providerSessionId`가 **둘 다** 맞아야 제목을 내주므로, 같은 id가
 * 다른 공급자 목록에 있으면 남의 제목을 가져다 쓰면 안 된다. 계정 전환 알림만 이 사슬을
 * 타지 않고 detail을 그대로 보인다(:257).
 *
 * 기존 알림 시나리오는 묶음 쪽만 봤다 — AM-53·AM-62·AM-69는 묶음 집계, AM-14·qa16은
 * 묶음 머리줄의 다국어, AM-86은 빈 상태, AM-315는 99+ 배지다. 낱개 줄의 둘째 줄이
 * 어디서 오는지는 다룬 적이 없어, 세션 카탈로그가 비었을 때 폴더 이름 대신 빈 줄이
 * 서거나 공급자가 어긋난 제목이 붙어도 지금까지는 드러나지 않는다.
 */
import type { ProviderId, SessionSummary } from "../../src/types";

const BASE = 1_757_200_000_000;

function session(source: ProviderId, id: string, title: string): SessionSummary {
  return {
    source,
    id,
    title,
    sourceTitle: null,
    project: "/tmp/qa-attention-label",
    cwd: "/tmp/qa-attention-label",
    startedAt: BASE - 60_000,
    updatedAt: BASE,
    messageCount: 2,
    tokenTotal: 40,
    tokenUsage: null,
    model: "qa-model",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 1024,
    filePath: `/tmp/qa-attention-label/${id}.jsonl`,
    meta: {
      favorite: false,
      hidden: false,
      note: null,
      customTitle: null,
      folderIds: [],
      reasoningEffort: null,
      mode: null,
      approvalMode: null,
      creationAccountId: null,
      boundAccountId: null,
      pinnedAccountId: null,
    },
    lastFailure: null,
  };
}

// 같은 id를 공급자만 달리해 두 곳에 둔다. 알림은 codex 쪽이므로 claude 제목을 집어 오면
// 안 된다 — 그 경우 화면에는 "클로드가 들고 있는 대화"가 codex 알림 밑에 붙는다.
const SESSIONS = [
  session("codex", "sess-known", "카탈로그에 있는 대화"),
  session("claude", "sess-crossed", "다른 공급자 대화"),
];

function item(overrides: Record<string, unknown>) {
  return {
    id: "attn",
    chatId: "chat",
    source: "codex" as ProviderId,
    providerSessionId: null,
    cwd: "/Users/qa/projects/quiet-runner",
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

// chatId가 다르면 묶이지 않고 낱개 줄로 선다(groupScope, src/lib/attentionGroups.ts:50).
// 목록은 준 순서 그대로다.
const ITEMS = [
  item({ id: "a-known", chatId: "chat-a", providerSessionId: "sess-known" }),
  item({ id: "b-missing", chatId: "chat-b", providerSessionId: "sess-gone", cwd: "/Users/qa/projects/bravo-lane" }),
  item({ id: "c-nosession", chatId: "chat-c", cwd: "/Users/qa/projects/charlie-lane/" }),
  item({ id: "d-nocwd", chatId: "chat-d", cwd: "" }),
  item({ id: "e-crossed", chatId: "chat-e", providerSessionId: "sess-crossed", cwd: "/Users/qa/projects/echo-lane" }),
  item({
    id: "f-account",
    chatId: "chat-f",
    kind: "accountSwitch",
    providerSessionId: "sess-known",
    title: "계정을 바꿔 이어갑니다",
    detail: "업무 계정 → 개인 계정 · 주간 한도 소진",
  }),
];

const SNAPSHOT = { items: ITEMS, unreadCount: 0, pendingCount: 0 };

function rows() {
  return cy.get(".attention-list > .attention-item");
}

/** 낱개 줄의 둘째 줄 문구. 앞에 선 출처 배지를 빼고 대화 이름 칸만 읽는다. */
function secondLine(index: number) {
  return rows().eq(index).find(".attention-session > span").last();
}

describe("알림 낱개 줄의 대화 이름 폴백", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", SESSIONS);
    cy.stubInvoke("get_chat_attention_snapshot", { statusCode: 200, body: SNAPSHOT });
    cy.visitApp();
    cy.anchor("topbar.attention").should("be.visible").click();
    rows().should("have.length", 6);
  });

  it("세션 카탈로그에 있으면 그 제목을 쓰고, 없으면 작업 폴더 이름으로 내려간다", () => {
    // 1) 공급자·id가 모두 맞는 대화는 카탈로그 제목을 그대로 보인다.
    secondLine(0).should("have.text", "카탈로그에 있는 대화");

    // 2) id가 카탈로그에 없으면 제목 자리가 비는 대신 작업 경로의 폴더 이름이 선다.
    secondLine(1).should("have.text", "bravo-lane");

    // 3) 세션 id 자체가 없는 알림도 같은 폴더 이름 규칙을 탄다. 경로 끝의 구분자는 이름에
    //    섞이지 않는다(attentionFolderName, src/lib/attentionGroups.ts:94).
    secondLine(2).should("have.text", "charlie-lane");

    // 4) 경로마저 비면 마지막 자리인 공급자 이름으로 내려가, 둘째 줄이 빈 채 남지 않는다.
    secondLine(3).should("have.text", "codex");
  });

  it("공급자가 다르면 같은 id라도 그 제목을 가져오지 않는다", () => {
    // 5) sess-crossed는 claude 목록에 있고 알림은 codex다. 제목을 집어 오면 알림이 남의
    //    대화를 가리키게 되므로 폴더 이름으로 내려가야 맞다.
    secondLine(4).should("have.text", "echo-lane");
    secondLine(4).should("not.have.text", "다른 공급자 대화");
  });

  it("계정 전환 알림은 대화 이름 사슬을 타지 않고 전환 사유를 보인다", () => {
    // 6) 세션 id가 카탈로그와 맞아도 계정 전환 줄은 detail을 그대로 쓴다 — 이 알림이
    //    알리는 것은 대화가 아니라 어느 계정에서 어느 계정으로 왜 넘어갔는지다.
    secondLine(5).should("have.text", "업무 계정 → 개인 계정 · 주간 한도 소진");
    secondLine(5).should("not.have.text", "카탈로그에 있는 대화");
  });
});
