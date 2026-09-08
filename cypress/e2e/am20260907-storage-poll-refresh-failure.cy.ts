/// <reference types="cypress" />
/**
 * 저장소 화면(StorageView.tsx)은 `usePoll(load, 30_000)`으로 30초마다 사용량을 다시 잰다.
 * 이미 값을 그린 뒤 갱신이 실패하면 옛 수치는 남기되, 실패 배너는 **본문 맨 위**에 붙고
 * 측정 시각 안내 줄과 지표 카드가 `is-stale`로 낡은 값임을 알린다(QA #47 조치). 첫 조회가
 * 실패했을 때는 지표 없이 오류 배너만 남는다.
 *
 * 기존 저장소 스펙(AM-32)은 다국어 문구만 봤고, 다른 새로고침 스펙(상태 카드·사이드바)은
 * 각자 다른 화면이다. 폴링 갱신 실패의 잔존 계약을 잡은 스펙은 없다.
 *
 * 30초를 기다리지 않고 갱신을 부르기 위해 폴링 루프의 가시성 복귀 경로를 쓴다
 * (poll.ts:120) — 문서를 숨기면 대기 타이머가 풀리고, 다시 보이는 순간 즉시 한 회차가
 * 돈다. 격리 백엔드의 실제 값은 건드리지 않고 응답만 가로챈다.
 */
const REFRESH_ERROR = "저장소 사용량을 다시 재지 못했습니다.";

const storageView = () => cy.get('[data-view="storage"]');

const openStorage = () => {
  cy.anchor("nav.storage").click();
  return cy.get(".storage-view", { timeout: 20000 }).should("be.visible");
};

/** 문서 가시성을 갈아끼우고 폴링 루프에 알린다. */
function setVisibility(state: "hidden" | "visible") {
  cy.document().then((doc) => {
    Object.defineProperty(doc, "visibilityState", { value: state, configurable: true });
    doc.dispatchEvent(new Event("visibilitychange"));
  });
}

/** 실패 응답으로 갈아끼운 뒤 가시성 복귀로 즉시 한 회차를 돌린다. */
function failNextRefresh(alias: string) {
  cy.stubInvoke("get_storage_overview", { statusCode: 500, body: { error: REFRESH_ERROR } }).as(alias);
  setVisibility("hidden");
  setVisibility("visible");
  cy.wait(`@${alias}`);
}

describe("저장소 화면의 폴링 갱신 실패와 값 잔존", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("첫 조회가 실패하면 지표 없이 오류 배너만 남는다", () => {
    cy.stubInvoke("get_storage_overview", { statusCode: 500, body: { error: REFRESH_ERROR } });
    cy.anchor("nav.storage").click();
    storageView().find(".error-banner", { timeout: 20000 }).should("contain.text", REFRESH_ERROR);
    // 지표·목록은 이 화면 안에 하나도 그려지지 않는다(다른 화면의 stat-grid와 섞지 않도록 뷰로 좁힌다).
    storageView().find(".storage-view").should("not.exist");
    storageView().find(".stat-grid").should("not.exist");
    storageView().find(".storage-panel").should("not.exist");
    // 되돌릴 수단은 화면 안에 없다 — 다시 시도 버튼이 붙지 않는다.
    storageView().find("button").should("not.exist");
  });

  it("값을 그린 뒤 갱신이 실패하면 옛 수치가 남고 오류 배너가 맨 위에 붙는다", () => {
    openStorage();
    // 격리 백엔드에도 공급자 원본 3행 + 자체 저장소 1행은 항상 온다(catalog.rs:1172).
    cy.get(".storage-view .stat-grid .stat-card").should("have.length", 4);
    cy.get(".storage-view .storage-row").should("have.length.at.least", 4);
    cy.get(".storage-view .error-banner").should("not.exist");

    cy.get(".storage-view .stat-grid .stat-card").eq(0).find("strong").invoke("text").then((before) => {
      failNextRefresh("failedRetain");

      // 실패해도 지표와 목록은 그대로 남는다.
      cy.get(".storage-view .stat-grid .stat-card").should("have.length", 4);
      cy.get(".storage-view .stat-grid .stat-card").eq(0).find("strong").should("have.text", before);
      cy.get(".storage-view .storage-row").should("have.length.at.least", 4);
      // 오류 배너는 본문 맨 위에 붙어 스크롤 없이 보인다(QA #47).
      cy.get(".storage-view .error-banner").should("contain.text", REFRESH_ERROR);
      cy.get(".storage-view > *").first().should("have.class", "error-banner");
    });
  });

  /**
   * QA #47 조치: 기본 뷰포트(1000×660)에서 저장소 본문은 화면보다 길다. 갱신 실패 배너는
   * 본문 맨 위에 붙어 스크롤 없이 보이고, 그 아래 측정 시각 줄과 지표 카드가 낡은 값임을
   * 표시한다.
   */
  it("갱신 실패 배너는 스크롤 없이 보이고 지표에는 마지막 측정 시각이 붙는다", () => {
    openStorage();
    // 성공 상태의 안내 줄은 마지막 측정 시각만 적고 낡음 표시가 없다.
    cy.anchor("storage.refresh-status").should("contain.text", "마지막 측정 시각").and("not.have.class", "is-stale");
    cy.get(".storage-view .stat-grid").should("not.have.class", "is-stale");

    failNextRefresh("failedClipped");

    cy.get(".storage-view .error-banner").should("be.visible");
    cy.anchor("storage.refresh-status").should("have.class", "is-stale")
      .and("contain.text", "갱신 실패")
      .and("contain.text", "마지막 측정 시각")
      .and("have.attr", "role", "status");
    // 지표 카드마다 측정 시각과 갱신 실패 표시가 붙는다.
    cy.get(".storage-view .stat-grid").should("have.class", "is-stale");
    cy.get(".storage-view .stat-grid .stat-card").each(($card) => {
      cy.wrap($card).should("have.class", "is-stale").find("small").should("contain.text", "측정 · 갱신 실패");
    });
  });

  it("갱신이 다시 성공하면 오류 배너가 사라진다", () => {
    // 실제 응답을 한 번 받아 두고 그 본문을 성공 스텁으로 되돌려 쓴다. 가로채기를
    // 겹쳐 놓으면 Cypress는 나중에 등록한 것부터 보므로, 응답 없는 spy만 얹어서는
    // 앞서 등록한 500 스텁이 계속 답한다.
    cy.stubInvoke("get_storage_overview").as("initial");
    openStorage();
    cy.wait("@initial").then((initial) => {
      const body = initial.response?.body;
      expect(body, "실제 저장소 응답 본문").to.be.an("object");
      failNextRefresh("failedThenOk");
      cy.get(".storage-view .error-banner").should("exist");

      cy.stubInvoke("get_storage_overview", { statusCode: 200, body }).as("recovered");
      setVisibility("hidden");
      setVisibility("visible");
      cy.wait("@recovered");
      cy.get(".storage-view .error-banner", { timeout: 20000 }).should("not.exist");
      cy.get(".storage-view .stat-grid .stat-card").should("have.length", 4);
    });
  });
});
