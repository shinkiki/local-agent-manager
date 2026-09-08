/// <reference types="cypress" />
// 저장소 화면의 폴링은 문서가 보이지 않는 동안 타이머를 두지 않고, 다시 보이는 순간 즉시 한 번
// 갱신한다(src/lib/poll.ts:124 `onVisibilityChange`). 이 스펙이 보는 것은 그 가시성 경로다 —
// 숨은 동안 조회가 멈추는지, 복귀가 조회를 정확히 한 번만 부르는지, 그리고 그 복귀 갱신이
// 실패해도 이미 뜬 수치가 남고 다음 성공에서 되살아나는지(src/components/StorageView.tsx:26·79).

type Mode = "first" | "second" | "fail";

function overview(turnCount: number, fileCount: number) {
  return {
    sourceTotalBytes: 4096,
    managerTotalBytes: 1024,
    totalBytes: 5120,
    sourceItems: [
      { id: "qa-source", label: "QA 원본 묶음", description: "QA 스텁 원본", sizeBytes: 4096, fileCount },
    ],
    managerItems: [
      { id: "qa-state", label: "QA 상태 묶음", description: "QA 스텁 상태", sizeBytes: 1024, fileCount: 1 },
    ],
    supplements: { turnCount, sessionCount: 2, sizeBytes: 512 },
  };
}

const FIRST = overview(7, 3);
const SECOND = overview(9, 5);

describe("저장소 화면의 가시성 복귀 갱신", () => {
  let mode: Mode;
  let calls: number;

  beforeEach(() => {
    mode = "first";
    calls = 0;
    cy.intercept("POST", "**/api/invoke/get_storage_overview", (req) => {
      calls += 1;
      if (mode === "fail") {
        req.reply({ statusCode: 500, body: { error: "QA forced storage refresh failure" } });
        return;
      }
      req.reply(mode === "first" ? FIRST : SECOND);
    }).as("storage");
    cy.visitApp();
    cy.anchor("nav.storage").click();
    // 첫 조회가 그린 수치. 보완 건수와 파일 수 두 자리로 갱신 여부를 가른다.
    supplementCard().should("contain.text", "7건");
    cy.get(".storage-panel").first().find(".storage-row").first().should("contain.text", "3개 파일");
  });

  function supplementCard() {
    return cy.get(".storage-view .stat-grid .stat-card").eq(3);
  }

  /** 문서 가시성을 갈아끼우고 `visibilitychange`를 쏜다. 폴링이 보는 곳은 visibilityState뿐이다. */
  function setVisibility(state: "hidden" | "visible") {
    cy.document().then((doc) => {
      Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => state });
      doc.dispatchEvent(new Event("visibilitychange"));
    });
  }

  /**
   * 숨겼다 되살린다. 두 전환 사이를 반드시 쉰다 — 루프는 이미 도는 회차나 걸린 대기가 있으면
   * 복귀 갱신을 건너뛰므로(poll.ts:126), 직전 회차가 대기를 걸기 전에 몰아서 전환하면 갱신이
   * 나가지 않는다. 이 쉼이 없으면 실패 직후의 복귀에서 새 조회가 아예 나가지 않았다.
   */
  function cycleVisibility() {
    setVisibility("hidden");
    cy.wait(400);
    setVisibility("visible");
  }

  it("숨은 동안에는 다시 조회하지 않고, 보이는 순간 한 번만 갱신한다", () => {
    cy.wrap(null).then(() => {
      const before = calls;
      setVisibility("hidden");
      // 주기는 30초라 이 사이에 예약이 발사될 수 없다. 숨는 순간 조회가 나가지 않는 것만 본다.
      cy.wait(600);
      cy.wrap(null).then(() => {
        expect(calls, "숨은 동안 저장소 조회").to.equal(before);
        mode = "second";
        setVisibility("visible");
        supplementCard().should("contain.text", "9건");
        cy.get(".storage-panel").first().find(".storage-row").first().should("contain.text", "5개 파일");
        cy.wrap(null).should(() => {
          expect(calls, "복귀 갱신 횟수").to.equal(before + 1);
        });
      });
    });
  });

  it("복귀 갱신이 실패해도 이미 뜬 수치를 지우지 않고, 다음 성공에서 갱신된다", () => {
    cy.wrap(null).then(() => {
      const before = calls;
      mode = "fail";
      cycleVisibility();
      cy.wrap(null).should(() => {
        expect(calls, "실패한 복귀 갱신").to.be.greaterThan(before);
      });
    });

    // 실패해도 로딩·오류 화면으로 무너지지 않는다. 옛 수치는 그대로 남고 실패는 화면 안의
    // 배너로 알린다(StorageView.tsx:79). 배너가 어디에 붙는지는 이웃 스펙
    // am20260907-storage-poll-refresh-failure가 본다.
    cy.view("storage").find(".error-banner").should("contain.text", "QA forced storage refresh failure");
    cy.view("storage").find(".state-panel").should("not.exist");
    supplementCard().should("contain.text", "7건");
    cy.get(".storage-panel").first().find(".storage-row").first().should("contain.text", "3개 파일");

    cy.wrap(null).then(() => {
      const before = calls;
      mode = "second";
      cycleVisibility();
      cy.wrap(null).should(() => {
        expect(calls, "회복 갱신 횟수").to.be.greaterThan(before);
      });
    });
    supplementCard().should("contain.text", "9건");
    cy.view("storage").find(".error-banner").should("not.exist");
  });
});
