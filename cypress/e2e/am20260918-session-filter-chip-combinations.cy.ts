/// <reference types="cypress" />
/**
 * AM-403 — 세션 목록 빠른 필터 칩 세 개(즐겨찾기·보관함·실패)를 혼합 표본 위에서 조합해 확인한다.
 *
 * 칩 세 개는 src/components/SessionsView.tsx:197(SESSION_FILTER_CHIPS)에서 한 표로 서고,
 * 실제 걸러내기는 :264(보관함)·:286(즐겨찾기)·:290(실패) 세 축이 맡는다. 이 가운데
 * 보관함 축만 `filters.showHidden === session.meta.hidden`이라 **양방향**이다 — 끄면
 * 보관하지 않은 세션만, 켜면 보관한 세션만 남는다. 나머지 두 축은 켰을 때만 좁히는
 * 한방향이다.
 *
 * 기존 세션 스펙은 칩의 **눌림 상태**까지만 봤다. sessions.cy.ts:42-74는 칩 세 개의
 * aria-pressed·화면 전환 잔존·빈 목록 문구를 확인하지만 목록이 비어 있는 격리 백엔드에서
 * 돌아 걸러낸 결과가 없고, am20260907-sessions-more-filters는 '추가 필터' 팝오버의
 * 열림·배지만, am20260917-session-list-load-more는 검색어로만 좁혔다. 그래서 칩이
 * aria-pressed만 바꾸고 목록은 그대로여도, 보관함이 한방향으로 동작해 보관한 세션이 기본
 * 목록에 섞여 나와도 지금까지는 드러나지 않는다. 이 스펙은 표본을 심어 **걸러낸 결과**로
 * 본다.
 *
 * 표식 조합 8건을 심어 아래를 본다.
 * 1. 기본 상태는 보관하지 않은 5건만 보이고, 표 머리말이 그 수를 적는다.
 * 2. 즐겨찾기 칩은 aria-pressed와 목록이 함께 움직인다(2건).
 * 3. 즐겨찾기+실패를 겹치면 둘 다 만족하는 1건만 남는다.
 * 4. 보관함 칩을 켜면 기본 목록의 5건이 전부 빠지고 보관한 3건으로 바뀐다(양방향 계약).
 * 5. 보관함+즐겨찾기는 보관한 즐겨찾기 1건이다.
 * 6. 세 칩을 모두 겹쳐 0건이 되면 빈 상태 안내가 서고 표가 사라진다.
 * 7. 칩을 켠 채 대시보드를 다녀와도 칩과 목록이 남는다.
 */
import type { ProviderId, SessionSummary } from "../../src/types";

const BASE = 1_757_100_000_000;

type Mark = {
  id: string;
  title: string;
  favorite: boolean;
  hidden: boolean;
  failed: boolean;
};

/** 즐겨찾기·보관·실패 세 표식의 조합. 세 칩이 서로를 가리지 않는지 보려고 겹쳐 둔다. */
const MARKS: Mark[] = [
  { id: "plain-a", title: "표본 일반 A", favorite: false, hidden: false, failed: false },
  { id: "plain-b", title: "표본 일반 B", favorite: false, hidden: false, failed: false },
  { id: "fav-a", title: "표본 즐겨찾기 A", favorite: true, hidden: false, failed: false },
  { id: "fail-a", title: "표본 실패 A", favorite: false, hidden: false, failed: true },
  { id: "fav-fail", title: "표본 즐겨찾기+실패", favorite: true, hidden: false, failed: true },
  { id: "arch-a", title: "표본 보관 A", favorite: false, hidden: true, failed: false },
  { id: "arch-fav", title: "표본 보관+즐겨찾기", favorite: true, hidden: true, failed: false },
  { id: "arch-fail", title: "표본 보관+실패", favorite: false, hidden: true, failed: true },
];

const session = (mark: Mark, index: number): SessionSummary => {
  const source: ProviderId = index % 2 === 0 ? "claude" : "codex";
  return {
    source,
    id: `qa-chip-${mark.id}`,
    title: mark.title,
    sourceTitle: null,
    project: "/tmp/qa-session-filter-chips",
    cwd: "/tmp/qa-session-filter-chips",
    startedAt: BASE - index * 60_000 - 30_000,
    updatedAt: BASE - index * 60_000,
    messageCount: 4,
    tokenTotal: 120,
    tokenUsage: null,
    model: "qa-model",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: false,
    archived: false,
    readable: true,
    sizeBytes: 4096,
    filePath: `/tmp/qa-session-filter-chips/${mark.id}.jsonl`,
    meta: {
      favorite: mark.favorite,
      hidden: mark.hidden,
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
    lastFailure: mark.failed
      ? { kind: "error", occurredAt: BASE - index * 60_000, message: "요청이 오류로 끝났습니다" }
      : null,
  };
};

const SESSIONS = MARKS.map(session);

const chip = (label: string) => cy.get(".filter-chip").contains("span", label).parent("button");
const rows = () => cy.get(".session-table tbody tr");
const caption = () => cy.get(".table-panel .table-caption strong");

/** 지금 목록에 보이는 제목 집합이 기대와 정확히 같은지 본다(빠짐도 덤도 잡는다). */
function expectTitles(titles: string[]) {
  caption().should("have.text", `세션 ${titles.length}개`);
  if (titles.length === 0) {
    cy.get(".session-table").should("not.exist");
    cy.contains("조건에 맞는 세션이 없습니다").should("be.visible");
    return;
  }
  rows().should("have.length", titles.length);
  rows().then(($rows) => {
    const seen = [...$rows].map((row) => row.querySelector(".title-cell strong")?.textContent ?? "");
    // 실패 칩·별표가 제목 앞에 붙으므로 정확 일치 대신 포함으로 본다.
    const matched = titles.every((title) => seen.some((text) => text.includes(title)));
    expect(matched, `보이는 제목: ${seen.join(" / ")}`).to.equal(true);
  });
}

describe("세션 목록 빠른 필터 칩 조합", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", SESSIONS);
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
    cy.get(".table-panel").should("be.visible");
  });

  it("기본 상태는 보관하지 않은 세션만 세우고 칩 세 개가 모두 꺼져 있다", () => {
    cy.get(".filter-chip").should("have.length", 3);
    chip("즐겨찾기").should("have.attr", "aria-pressed", "false");
    chip("보관함").should("have.attr", "aria-pressed", "false");
    chip("실패").should("have.attr", "aria-pressed", "false");
    expectTitles(["표본 일반 A", "표본 일반 B", "표본 즐겨찾기 A", "표본 실패 A", "표본 즐겨찾기+실패"]);
    cy.contains(".title-cell strong", "표본 보관 A").should("not.exist");
  });

  it("즐겨찾기 칩은 눌림 표시와 목록이 함께 움직이고, 실패 칩과 겹치면 교집합만 남는다", () => {
    chip("즐겨찾기").click();
    chip("즐겨찾기").should("have.attr", "aria-pressed", "true").and("have.class", "active");
    expectTitles(["표본 즐겨찾기 A", "표본 즐겨찾기+실패"]);

    chip("실패").click();
    chip("실패").should("have.attr", "aria-pressed", "true");
    expectTitles(["표본 즐겨찾기+실패"]);

    // 다시 눌러 끄면 각 축이 제 몫만 되돌린다.
    chip("실패").click();
    expectTitles(["표본 즐겨찾기 A", "표본 즐겨찾기+실패"]);
    chip("즐겨찾기").click();
    expectTitles(["표본 일반 A", "표본 일반 B", "표본 즐겨찾기 A", "표본 실패 A", "표본 즐겨찾기+실패"]);
  });

  it("보관함 칩은 양방향이라 켜면 보관한 세션'만' 남는다", () => {
    chip("보관함").click();
    chip("보관함").should("have.attr", "aria-pressed", "true");
    expectTitles(["표본 보관 A", "표본 보관+즐겨찾기", "표본 보관+실패"]);
    // 끈 상태에서 보이던 세션은 하나도 남지 않는다.
    cy.contains(".title-cell strong", "표본 일반 A").should("not.exist");
    cy.contains(".title-cell strong", "표본 즐겨찾기 A").should("not.exist");

    chip("즐겨찾기").click();
    expectTitles(["표본 보관+즐겨찾기"]);
  });

  it("세 칩을 겹쳐 걸리는 세션이 없으면 빈 상태 안내가 선다", () => {
    chip("보관함").click();
    chip("즐겨찾기").click();
    chip("실패").click();
    expectTitles([]);

    // 하나를 풀면 곧바로 되살아난다.
    chip("즐겨찾기").click();
    expectTitles(["표본 보관+실패"]);
  });

  it("칩을 켠 채 다른 화면을 다녀와도 칩과 목록이 남는다", () => {
    chip("보관함").click();
    expectTitles(["표본 보관 A", "표본 보관+즐겨찾기", "표본 보관+실패"]);

    cy.openView("dashboard").should("be.visible");
    cy.openView("sessions").should("be.visible");

    chip("보관함").should("have.attr", "aria-pressed", "true");
    expectTitles(["표본 보관 A", "표본 보관+즐겨찾기", "표본 보관+실패"]);
  });
});
