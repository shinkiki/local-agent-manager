/// <reference types="cypress" />
// 영어 UI에서 세션 자동정리(`settings.session-cleanup`) 카드가 한 언어로 읽히는지 본다.
// 카드의 머리말·버튼·조건 이름은 컴포넌트가 `text(ko, en)`으로 들고 있어 영어로 바뀌지만,
// 요약 한 줄들은 `src/lib/sessionCleanup.ts`의 순수 함수(previewSummary·reasonHint·
// receiptSummary)가 만들어 낸다. 그 함수들이 언어 인자를 받지 않으면 영어 화면 한가운데
// 한국어 문장이 남는다 — 숫자가 끼는 문구라 정적 치환기로도 덮이지 않는다.
//
// get_session_cleanup_status 응답만 가로챈다. 버튼은 누르지 않으므로 실제 정리는 돌지 않는다.
const HANGUL = /[가-힣]/;

const status = (overrides: Record<string, unknown> = {}) => ({
  policy: {
    enabled: false,
    retentionDays: 90,
    maxMessageCount: 1,
    perProviderCap: 400,
    perAutomationCap: 30,
    hiddenAfterDays: 7,
    trashRetentionDays: 14,
    intervalHours: 24,
  },
  lastRunAt: 1757000000000,
  nextRunAt: null,
  sessionCount: 2866,
  tombstoneCount: 0,
  preview: {
    targetCount: 2146,
    removableCount: 396,
    removableBytes: 490 * 1024 * 1024,
    protectedCount: 12,
    remainingCount: 720,
    byReason: [
      { reason: "emptySession", label: "빈 세션", count: 874 },
      { reason: "providerCap", label: "공급자별 상한 초과", count: 61 },
      { reason: "automationCap", label: "일정별 회차 상한 초과", count: 1174 },
      { reason: "retention", label: "보존 기간 경과", count: 37 },
      { reason: "hiddenAged", label: "보관 후 경과", count: 0 },
    ],
    orphanAttachmentCount: 0,
    orphanAttachmentBytes: 0,
  },
  receipts: [
    {
      startedAt: 1757000000000,
      finishedAt: 1757000009000,
      manual: true,
      tombstonedCount: 2146,
      removedCount: 396,
      skippedCount: 12,
      skippedReasons: [{ reason: "반복 요청이 이어갈 세션이어서 건너뛰었습니다", count: 12 }],
      failedCount: 0,
      bytesFreed: 490 * 1024 * 1024,
      trashPurgedCount: 0,
      entriesTruncated: true,
      entries: [],
    },
  ],
  ...overrides,
});

function openCard(overrides: Record<string, unknown> = {}) {
  cy.stubInvoke("get_session_cleanup_status", { statusCode: 200, body: status(overrides) });
  cy.visitApp();
  cy.openSettingsTab("connections");
  cy.anchor("settings.session-cleanup").scrollIntoView().should("exist");
}

describe("영어 UI 세션 자동정리 카드", () => {
  before(() => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.anchor("nav.dashboard").should("contain.text", "Dashboard");
  });

  after(() => {
    cy.restoreLanguage();
  });

  it("카드 머리말과 실행 버튼이 영어다", () => {
    openCard();
    cy.anchor("settings.session-cleanup").within(() => {
      cy.get("h2").should("have.text", "Automatic session cleanup");
      cy.get(".session-cleanup-overview-panel.target strong").should("have.text", "Next cleanup estimate");
    });
  });

  // 아래 셋이 보는 요약은 `src/lib/sessionCleanupText.ts`의 순수 함수 셋
  // (previewSummary·reasonHint·receiptSummary)이 만든다. 숫자가 끼는 문장이라 정적
  // 치환기로는 덮이지 않아, 한때 영어 화면 한가운데 한국어가 남았다(QA #92 / AM-381).
  // 지금은 화면이 현재 언어를 넘기고 함수가 언어별 문장을 짓는다.
  it("다음 정리 예상 요약과 축소 배수가 영어로 읽힌다", () => {
    openCard();
    cy.anchor("settings.session-cleanup").find(".session-cleanup-overview-panel.target")
      .invoke("text").should("not.match", HANGUL);
  });

  it("조건별 적중 건수 안내가 영어로 읽힌다", () => {
    openCard();
    cy.anchor("settings.session-cleanup").find(".session-cleanup-hint")
      .should("have.length.greaterThan", 0)
      .each(($hint) => {
        expect($hint.text()).not.to.match(HANGUL);
      });
  });

  it("최근 정리 영수증 한 줄이 영어로 읽힌다", () => {
    openCard();
    // 건너뜀 사유만은 백엔드가 만든 한국어 문장이라 그대로 실린다 — 사유 문자열 자체의
    // 번역은 백엔드 계약을 건드리는 별건이다. 그 괄호 앞까지가 화면이 짓는 문장이다.
    cy.anchor("settings.session-cleanup").find(".session-cleanup-receipts li small")
      .should("have.length", 1)
      .invoke("text").then((line) => {
        const composed = String(line).split(" (mostly:")[0];
        expect(composed).not.to.match(HANGUL);
        expect(composed).to.contain("removed 2,146 from the list");
        expect(composed).to.contain("reclaimed 396");
        expect(composed).to.contain("skipped 12 as protected");
      });
  });
});
