// 대시보드 순위 패널의 대량·경계 표기. 기존 대시보드 스펙은 계정 소진율 잔존
// (dashboard.cy.ts), 다섯 패널이 비었을 때의 안내와 도달 경로
// (am20260906-dashboard-empty-panels), 사용량 즉시 툴팁·이력 오류만 봤고,
// 값이 들어찬 상태에서 세 순위 패널이 지켜야 하는 표시 규칙 —
// 모델 분포의 상위 8종 컷, 프로젝트 Top 10의 최댓값 기준 막대 비율,
// 주간 추이의 0인 주 최소 높이와 제공자별 flex 비율 — 과 상단 통계 4장의
// 천단위·단위 축약 표기는 어느 시나리오도 확인하지 않았다.
// 집계 자체는 catalog.rs의 build_dashboard가 내지만(2026-09-17 R02 리팩토링으로
// 누적기로 재편됨), 여기서는 그 결과를 받은 화면이 규칙대로 그리는지만 본다.
import type { DashboardStats } from "../../src/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 주 경계에 맞춘 고정 시각. 12주 막대의 마지막 칸이 이 주다.
const CURRENT_WEEK = 1_757_808_000_000 - (1_757_808_000_000 % WEEK_MS);

// 12주 중 세 주만 값이 있다. 최댓값 20인 주, 절반인 10인 주, 그리고 나머지는 0이다.
const WEEKLY_VALUES: Record<number, [number, number, number]> = {
  9: [12, 6, 2],   // 합 20 — 최댓값
  10: [6, 4, 0],   // 합 10 — 절반
  11: [1, 0, 0],   // 합 1 — 최솟값(0이 아닌)
};

const DASHBOARD: DashboardStats = {
  sessionCount: 1_234_567,
  sessionsBySource: { claude: 7, codex: 5, antigravity: 3 },
  tokens: { claude: 1_500_000, codex: 900_000, antigravity: 100_000, total: 2_500_000 },
  disk: { claude: 2_147_483_648, codex: 1_073_741_824, antigravity: 0, total: 3_221_225_472 },
  skillCount: 42,
  agentCount: 7,
  // 12종을 내려보내 상위 8종 컷을 본다. 이름은 순위와 같은 순서로 붙였다.
  models: Array.from({ length: 12 }, (_, index) => ({
    model: `rank-model-${String(index + 1).padStart(2, "0")}`,
    count: 12 - index,
  })),
  // 최댓값 40, 절반 20, 그리고 동점 2건을 섞은 10개.
  topProjects: [
    { name: "가장 많은 프로젝트", path: "/Users/tester/projects/top", count: 40 },
    { name: "절반 프로젝트", path: "/Users/tester/projects/half", count: 20 },
    { name: "동점 A", path: "/Users/tester/projects/tie-a", count: 8 },
    { name: "동점 B", path: "/Users/tester/projects/tie-b", count: 8 },
    { name: "다섯째", path: "/Users/tester/projects/p5", count: 6 },
    { name: "여섯째", path: "/Users/tester/projects/p6", count: 5 },
    { name: "일곱째", path: "/Users/tester/projects/p7", count: 4 },
    { name: "여덟째", path: "/Users/tester/projects/p8", count: 3 },
    { name: "아홉째", path: "/Users/tester/projects/p9", count: 2 },
    { name: "열째", path: "/Users/tester/projects/p10", count: 1 },
  ],
  weekly: Array.from({ length: 12 }, (_, index) => {
    const [claude, codex, antigravity] = WEEKLY_VALUES[index] ?? [0, 0, 0];
    return { weekStart: CURRENT_WEEK - (11 - index) * WEEK_MS, claude, codex, antigravity };
  }),
  recent: [],
};

const panel = (title: string) =>
  cy.view("dashboard").find(".dashboard-grid .panel").filter(`:contains("${title}")`).first();

describe("대시보드 순위 패널의 대량·경계 표기", () => {
  beforeEach(() => {
    cy.stubSnapshotField("dashboard", DASHBOARD);
    cy.visitApp();
    cy.openView("dashboard");
  });

  it("상단 통계 4장이 천단위·축약 단위로 값을 적는다", () => {
    cy.view("dashboard").find(".stat-grid .stat-card").should("have.length", 4).then(($cards) => {
      const read = (index: number) => ({
        label: $cards.eq(index).find("span").text(),
        value: $cards.eq(index).find("strong").text(),
        detail: $cards.eq(index).find("small").text(),
      });
      expect(read(0)).to.deep.equal({
        label: "전체 세션",
        value: "1,234,567",
        detail: "Claude 7 · Codex 5 · AG 3",
      });
      expect(read(1).value).to.equal("2.5M");
      expect(read(2).value).to.equal("3.0 GB");
      expect(read(3).value).to.equal("42 / 7");
    });
  });

  it("모델 분포는 상위 8종만 순번과 함께 남기고 9위 아래는 그리지 않는다", () => {
    panel("모델 분포").within(() => {
      cy.get(".rank-row").should("have.length", 8);
      cy.get(".rank-row").first().should("contain.text", "1")
        .and("contain.text", "rank-model-01")
        .and("contain.text", "12");
      cy.get(".rank-row").last().should("contain.text", "8")
        .and("contain.text", "rank-model-08")
        .and("contain.text", "5");
      cy.contains("rank-model-09").should("not.exist");
      cy.get(".empty-state").should("not.exist");
    });
  });

  it("프로젝트 Top 10은 열 줄을 그리고 막대 너비를 최댓값 기준 비율로 잡는다", () => {
    panel("프로젝트 Top 10").within(() => {
      cy.get(".project-row").should("have.length", 10);
      cy.get(".project-row").first().find(".progress span")
        .should("have.attr", "style").and("include", "width: 100%");
      cy.get(".project-row").eq(1).find(".progress span")
        .should("have.attr", "style").and("include", "width: 50%");
      // 동점 두 줄은 같은 너비를 갖는다.
      cy.get(".project-row").eq(2).find(".progress span").invoke("attr", "style").then((tied) => {
        cy.get(".project-row").eq(3).find(".progress span").should("have.attr", "style", tied);
      });
      cy.get(".project-row").last().should("contain.text", "열째");
    });
  });

  it("주간 추이는 12칸을 세우고 0인 주도 최소 높이를 남긴다", () => {
    panel("주간 세션 추이").within(() => {
      cy.get(".week-column").should("have.length", 12);
      cy.get(".week-column").eq(9).should("have.attr", "title", "20개")
        .find(".week-bar").should("have.attr", "style").and("include", "height: 100%");
      cy.get(".week-column").eq(10).find(".week-bar")
        .should("have.attr", "style").and("include", "height: 50%");
      // 값이 없는 주는 4% 높이의 빈 막대로 남는다.
      cy.get(".week-column").first().should("have.attr", "title", "0개")
        .find(".week-bar").should("have.attr", "style").and("include", "height: 4%");
      cy.get(".week-column").first().find(".week-bar span").should("not.exist");
    });
  });

  it("값이 있는 주의 막대는 제공자별 비율만큼 칸을 나눈다", () => {
    panel("주간 세션 추이").find(".week-column").eq(9).find(".week-bar span").should(($spans) => {
      expect($spans).to.have.length(3);
      expect($spans.eq(0).attr("class")).to.equal("bar-claude");
      expect($spans.eq(0).attr("style")).to.include("flex: 12");
      expect($spans.eq(1).attr("style")).to.include("flex: 6");
      expect($spans.eq(2).attr("style")).to.include("flex: 2");
    });
  });
});
