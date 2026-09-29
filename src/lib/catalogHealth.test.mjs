import assert from "node:assert/strict";
import test from "node:test";

import { catalogHealthNotice, catalogRefreshNeeded, degradedScanMessages } from "./catalogHealth.ts";

const healthy = {
  sessionRevision: 12,
  resourceRevision: 3,
  lastReconciledAt: 1_000_000,
  lastReconcileError: null,
  reconcileInFlight: false,
  lastResourceScanAt: 1_000_000,
  degradedScans: [],
  stale: false,
  checkedAt: 1_000_000,
};

test("a healthy catalog shows nothing", () => {
  assert.equal(catalogHealthNotice(healthy, 1_000_100), null);
  assert.equal(catalogHealthNotice(null, 1_000_100), null);
});

test("a stale catalog says how old the list is", () => {
  const notice = catalogHealthNotice({ ...healthy, stale: true }, 1_000_000 + 3 * 60_000);
  assert.equal(notice?.tone, "warning");
  assert.equal(notice?.headline, "세션 목록이 3분 전 기준입니다");
  assert.equal(notice?.detail, null);
});

test("a catalog that never reconciled says so instead of showing an age", () => {
  const notice = catalogHealthNotice({ ...healthy, stale: true, lastReconciledAt: null }, 1_000_000);
  assert.equal(notice?.headline, "세션 목록이 아직 갱신되지 않았습니다");
});

test("stale lists name the scan and the reconcile error that caused it", () => {
  const notice = catalogHealthNotice({
    ...healthy,
    stale: true,
    lastReconcileError: "세션 목록 갱신이 진행 중입니다",
    degradedScans: [{ kind: "skills", label: "스킬", retryAt: 1_060_000, message: "스킬 스캔이 2초 안에 응답하지 않아 이전 결과를 유지합니다" }],
  }, 1_000_000 + 60_000);
  assert.equal(notice?.tone, "warning");
  assert.equal(
    notice?.detail,
    "스킬 스캔이 2초 안에 응답하지 않아 이전 결과를 유지합니다 · 세션 목록 갱신이 진행 중입니다",
  );
});

test("a degraded scan on a fresh list is informational, not a warning", () => {
  const notice = catalogHealthNotice({
    ...healthy,
    degradedScans: [{ kind: "artifacts", label: "아티팩트", retryAt: null, message: "아티팩트 스캔이 응답하지 않습니다" }],
  }, 1_000_100);
  assert.equal(notice?.tone, "info");
  assert.equal(notice?.headline, "일부 갱신이 지연되고 있습니다");
});

test("stale catalog ages read as 방금, 분, 시간", () => {
  const staleHeadline = (ageMs) => catalogHealthNotice(
    { ...healthy, stale: true },
    healthy.lastReconciledAt + ageMs,
  )?.headline;

  assert.equal(staleHeadline(5_000), "세션 목록이 방금 전 기준입니다");
  assert.equal(staleHeadline(7 * 60_000), "세션 목록이 7분 전 기준입니다");
  assert.equal(staleHeadline(60 * 60_000), "세션 목록이 1시간 전 기준입니다");
  assert.equal(staleHeadline(185 * 60_000), "세션 목록이 3시간 5분 전 기준입니다");
});

test("skipped-path messages are picked per scan kind", () => {
  const health = {
    ...healthy,
    degradedScans: [
      { kind: "skills", label: "스킬", retryAt: 1_300_000, message: "/Users/x/Documents/a/.claude/skills 외 1곳 경로가 응답하지 않아 스킬 목록에서 건너뛰었습니다" },
      { kind: "agents", label: "에이전트", retryAt: null, message: "에이전트 스캔이 응답하지 않습니다" },
    ],
  };
  assert.deepEqual(degradedScanMessages(health, "skills"), [
    "/Users/x/Documents/a/.claude/skills 외 1곳 경로가 응답하지 않아 스킬 목록에서 건너뛰었습니다",
  ]);
  assert.deepEqual(degradedScanMessages(health, "artifacts"), []);
});

test("a healthy or missing catalog reports no skipped paths", () => {
  assert.deepEqual(degradedScanMessages(healthy, "skills"), []);
  assert.deepEqual(degradedScanMessages(null, "skills"), []);
});

// 목록을 다시 받을지는 세션 개정만으로 정할 수 없다. AIA가 스킬을 게시하거나 산출물이
// 늘어도 대화가 오가지 않으면 세션 개정은 그대로라, 그 축만 보면 화면이 옛 목록에 굳는다.
const held = { sessionCatalogRevision: 12, resourceCatalogRevision: 3 };

test("두 개정이 모두 같으면 다시 받지 않는다", () => {
  assert.equal(catalogRefreshNeeded(held, healthy), false);
  assert.equal(catalogRefreshNeeded(null, healthy), false);
  assert.equal(catalogRefreshNeeded(held, null), false);
});

test("세션 개정이 달라지면 다시 받는다", () => {
  assert.equal(catalogRefreshNeeded(held, { ...healthy, sessionRevision: 13 }), true);
});

test("리소스 개정만 달라져도 다시 받는다", () => {
  assert.equal(catalogRefreshNeeded(held, { ...healthy, resourceRevision: 4 }), true);
});
