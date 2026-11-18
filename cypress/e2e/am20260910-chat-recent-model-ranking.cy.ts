/// <reference types="cypress" />
/**
 * 새 채팅 시작 폼 모델 선택기의 "최근 사용 모델" 순위·제외 계약.
 *
 * 18e960a가 세션 목록 중복 제거와 최근 모델 정렬의 순위 튜플 비교를 sequence의
 * compareRankDesc 한 벌로 모았다. 최근 모델 쪽 순위 규칙은
 * src/lib/recentModels.ts:26(updatedAt 내림차순 → count 내림차순)이고, 숨긴 세션 제외는
 * :14, 공급자별 걸러내기는 src/components/ChatView.tsx:769이다. 목록에 붙는 설명과
 * "최근 N회" 배지는 src/components/RuntimeSettings.tsx:74-81, :100이 만든다.
 *
 * AM-91은 "세션·프로젝트·모델 기록이 실제로 있을 때의 목록·순위는 격리 홈의 빈 HOME으로
 * 만들 수 없어 제외"로 남겼고, AM-190 계열의 모델 선택기 스펙은 팝오버 열림·닫힘·선택
 * 반영만 봤다. 세션 기록을 주입해 순위와 제외 규칙을 화면에서 본 스펙은 없다.
 *
 * 격리 백엔드에 잡히는 공급자는 호스트 CLI 탐지에 따라 갈리므로 어느 공급자가 선택돼
 * 있는지 전제하지 않는다. 두 공급자에 같은 모양의 기록을 심고, 시작 폼이 고른 공급자의
 * 것만 순서대로 나오고 다른 공급자의 것은 하나도 섞이지 않는지 확인한다.
 */
import type { ProviderId, SessionSummary } from "../../src/types";

const META: SessionSummary["meta"] = {
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
};

const session = (
  source: ProviderId,
  id: string,
  model: string,
  updatedAt: number,
  hidden = false,
): SessionSummary => ({
  source,
  id,
  title: `최근 모델 표본 ${id}`,
  sourceTitle: null,
  project: "/tmp/qa-recent-models",
  cwd: "/tmp/qa-recent-models",
  startedAt: updatedAt - 60_000,
  updatedAt,
  messageCount: 2,
  tokenTotal: 10,
  tokenUsage: null,
  model,
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 1024,
  filePath: `/tmp/qa-recent-models/${id}.jsonl`,
  meta: hidden ? { ...META, hidden: true } : META,
  lastFailure: null,
});

const TOP = 1_757_000_500_000;
const TIE = 1_757_000_400_000;
const LOW = 1_757_000_300_000;

// 공급자마다 같은 모양의 기록을 심는다.
// - `top`  updatedAt 최댓값 · 3회  → 첫째(updatedAt 우선)
// - `tie`  updatedAt 중간값 · 3회  → 둘째(같은 updatedAt에서는 횟수 많은 쪽)
// - `mid`  updatedAt 중간값 · 2회  → 셋째
// - `low`  updatedAt 최솟값 · 1회  → 넷째
// - `hidden` 숨긴 세션만 쓴 모델   → 목록에 없어야 한다
const sessionsFor = (source: ProviderId): SessionSummary[] => [
  session(source, `${source}-top-1`, `qa-${source}-top`, TOP),
  session(source, `${source}-top-2`, `qa-${source}-top`, TOP - 90_000),
  session(source, `${source}-top-3`, `qa-${source}-top`, TOP - 80_000),
  session(source, `${source}-tie-1`, `qa-${source}-tie`, TIE),
  session(source, `${source}-tie-2`, `qa-${source}-tie`, TIE - 70_000),
  session(source, `${source}-tie-3`, `qa-${source}-tie`, TIE - 60_000),
  session(source, `${source}-mid-1`, `qa-${source}-mid`, TIE),
  session(source, `${source}-mid-2`, `qa-${source}-mid`, TIE - 50_000),
  session(source, `${source}-low-1`, `qa-${source}-low`, LOW),
  session(source, `${source}-hidden-1`, `qa-${source}-hidden`, TOP, true),
];

const PROVIDERS: ProviderId[] = ["claude", "codex"];
const SESSIONS = PROVIDERS.flatMap((provider) => sessionsFor(provider));

const trigger = () => cy.get(".chat-launch-form .model-picker-trigger").first();
const options = () => cy.get(".model-picker-list").find('button[role="option"]');

describe("새 채팅 모델 선택기의 최근 사용 모델 순위와 제외", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", SESSIONS);
    cy.visitApp();
    cy.openView("chat");
    cy.get(".chat-launch-form").should("be.visible");
  });

  // 시작 폼이 고른 공급자를 화면에서 읽어 기대값을 만든다.
  const withSelectedProvider = (check: (selected: ProviderId, other: ProviderId) => void) =>
    cy.get(".chat-launch-form select").first().invoke("val").then((value) => {
      const selected = String(value) as ProviderId;
      expect(PROVIDERS, "시작 폼이 고른 공급자").to.include(selected);
      check(selected, PROVIDERS.find((provider) => provider !== selected) as ProviderId);
    });

  it("최근 모델을 updatedAt 내림차순·같은 시각에서는 횟수 순으로 늘어놓고 숨긴 세션의 모델은 빼놓는다", () => {
    withSelectedProvider((selected) => {
      trigger().click();
      options().then(($options) => {
        const models = [...$options].map((option) => option.querySelector("strong")?.textContent ?? "");
        const ours = models.filter((model) => model.startsWith(`qa-${selected}-`));
        expect(ours, "최근 사용 모델 순서").to.deep.equal([
          `qa-${selected}-top`,
          `qa-${selected}-tie`,
          `qa-${selected}-mid`,
          `qa-${selected}-low`,
        ]);
        expect(models, "숨긴 세션의 모델").to.not.include(`qa-${selected}-hidden`);
      });
    });
  });

  it("최근 모델에는 사용 횟수 배지와 최근 세션 출처 설명이 붙는다", () => {
    withSelectedProvider((selected) => {
      trigger().click();
      const row = (model: string) => options().contains("strong", model).closest('button[role="option"]');
      row(`qa-${selected}-top`).should("contain.text", "최근 3회").and("contain.text", "최근 세션에서 사용한 모델");
      row(`qa-${selected}-mid`).should("contain.text", "최근 2회");
      row(`qa-${selected}-low`).should("contain.text", "최근 1회");
    });
  });

  it("고른 공급자의 기록만 쓰고 다른 공급자 세션의 모델은 섞지 않는다", () => {
    withSelectedProvider((selected, other) => {
      trigger().click();
      options().then(($options) => {
        const models = [...$options].map((option) => option.querySelector("strong")?.textContent ?? "");
        expect(models.some((model) => model.startsWith(`qa-${other}-`)), `${other} 기록 혼입`).to.equal(false);
        expect(models.some((model) => model.startsWith(`qa-${selected}-`)), `${selected} 기록 표시`).to.equal(true);
      });
    });
  });
});
