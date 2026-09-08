import assert from "node:assert/strict";
import test from "node:test";

import { nearestUsageReset, sidebarUsageError, sidebarUsageMeters, sidebarUsageSources } from "./sidebarUsage.ts";

/** 창 하나. 초기화 시각이 없는 창이 대부분이라 기본값을 둔다. */
function win(label, usedPercent, resetsAt = null) {
  return { label, usedPercent, resetsAt };
}

/** 계정 사용량 뷰. 시험마다 실제로 다른 것은 창 목록과 조회 상태뿐이다. */
function usage(windows, overrides = {}) {
  return { status: "ok", windows, updatedAt: 1_700_000_000_000, error: null, ...overrides };
}

function home(overrides = {}) {
  return {
    state: "verified",
    email: "home@example.com",
    displayName: "Home User",
    providerAccountId: "home-provider-id",
    accountId: null,
    accessTokenExpiresAt: null,
    checkedAt: 1_700_000_000_000,
    retryAt: null,
    error: null,
    usage: usage([win("5시간", 22)]),
    ...overrides,
  };
}

function provider(overrides = {}) {
  return {
    provider: "codex",
    activeAccountId: null,
    observedActiveAccountId: null,
    runtimeCount: 0,
    lastAutoSwitch: null,
    home: home(),
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    accounts: [],
    providers: [provider()],
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
    ...overrides,
  };
}

test("기본 계정이 있으면 홈 계정보다 우선한다", () => {
  const account = { id: "codex-1", provider: "codex", displayName: "기본 계정", usage: usage([win("5시간", 71)]) };
  const sources = sidebarUsageSources(snapshot({
    accounts: [account],
    providers: [provider({ activeAccountId: account.id })],
  }));

  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "default");
  assert.equal(sources[0].displayName, "기본 계정");
  assert.equal(sources[0].usage.windows[0].usedPercent, 71);
});

test("기본 계정이 없으면 확인된 홈 계정 사용량을 표시한다", () => {
  const sources = sidebarUsageSources(snapshot());

  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "home");
  assert.equal(sources[0].displayName, "home@example.com");
  assert.equal(sources[0].usage.windows[0].usedPercent, 22);
});

test("기본 계정이 없고 홈 로그인의 신원이 확인되지 않았으면 표시하지 않는다", () => {
  const sources = sidebarUsageSources(snapshot({
    providers: [provider({ home: home({ state: "absent" }) })],
  }));

  assert.deepEqual(sources, []);
});

test("저장된 기본 계정 ID를 찾지 못해도 홈 계정으로 폴백한다", () => {
  const sources = sidebarUsageSources(snapshot({
    providers: [provider({ activeAccountId: "missing-account" })],
  }));

  assert.equal(sources[0].kind, "home");
});

test("Antigravity 사용량은 창이 있을 때만 공급자 단위 소스로 뒤에 붙는다", () => {
  const antigravity = usage([win("5시간", 12), win("7일", 64), { ...win("Gemini · 7일", 64), modelScoped: true }]);
  const withUsage = sidebarUsageSources(snapshot(), antigravity);
  const idle = sidebarUsageSources(snapshot(), usage([], { status: "idle", updatedAt: null }));
  const failed = sidebarUsageSources(snapshot(), usage([], { status: "error", error: "미설치" }));

  assert.deepEqual(withUsage.map((entry) => entry.kind), ["home", "provider"]);
  assert.equal(withUsage[1].key, "provider:antigravity");
  assert.equal(withUsage[1].provider, "antigravity");
  assert.equal(withUsage[1].displayName, null);
  // 미설치·미실행은 이 기기에서 정상이라 카드 전체를 오류로 만들지 않는다.
  assert.equal(idle.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(sidebarUsageError(failed), false);
});

const LABELS = {
  providerName: (provider) => (provider === "codex" ? "Codex" : provider),
  home: "홈",
  homeAccount: "홈 계정",
  stale: "갱신 실패로 마지막 조회 값",
  unavailable: "사용량 정보 없음",
  error: "오류",
  windowUnavailable: "확인 불가",
  resetsIn: (countdown) => `${countdown} 뒤 초기화`,
};

function source(overrides = {}) {
  return { key: "account:codex-1", provider: "codex", kind: "default", displayName: "기본 계정", usage: usage([win("5시간", 37)]), ...overrides };
}

/** 사용량 하나로 만든 미터 한 줄. 시험 대부분이 계정 하나만 보므로 뽑는 절차는 한 벌만 둔다. */
function meterOf(usageView, now = 0) {
  return sidebarUsageMeters([source({ usage: usageView })], now, LABELS)[0];
}

test("등록 계정 미터는 공급자 이름과 계정 이름을 붙이고 창 값을 반올림한다", () => {
  const [meter] = sidebarUsageMeters([source()], 1_700_000_000_000, LABELS);

  assert.equal(meter.accountLabel, "Codex · 기본 계정");
  assert.equal(meter.windows[0].valueLabel, "37%");
  assert.equal(meter.windows[0].level, "normal");
  assert.equal(meter.windows[0].ariaLabel, "Codex · 기본 계정 · 5시간 37%");
  assert.equal(meter.title, "Codex · 기본 계정 · 5시간 37%");
});

test("공급자 단위 소스의 미터는 공급자 이름만 쓴다", () => {
  const [meter] = sidebarUsageMeters([source({ kind: "provider", provider: "antigravity", displayName: null })], 0, {
    ...LABELS,
    providerName: () => "Antigravity",
  });

  assert.equal(meter.accountLabel, "Antigravity");
  assert.equal(meter.windows[0].ariaLabel, "Antigravity · 5시간 37%");
});

test("접힌 카드는 대표 창만 남기고 도움말에는 모델별 창까지 적는다", () => {
  const mixed = usage([win("5시간", 36), win("7일", 79), { ...win("Fable 7일", 10), modelScoped: true }]);
  const compact = sidebarUsageMeters([source({ usage: mixed })], 0, LABELS, "compact")[0];
  const detailed = sidebarUsageMeters([source({ usage: mixed })], 0, LABELS, "detailed")[0];
  const implicit = sidebarUsageMeters([source({ usage: mixed })], 0, LABELS)[0];

  assert.deepEqual(compact.windows.map((window) => window.label), ["5시간", "7일"]);
  assert.deepEqual(detailed.windows.map((window) => window.label), ["5시간", "7일", "Fable 7일"]);
  assert.deepEqual(implicit.windows.map((window) => window.label), detailed.windows.map((window) => window.label));
  assert.equal(compact.title, "Codex · 기본 계정 · 5시간 36% · 7일 79% · Fable 7일 10%");
  assert.equal(compact.title, detailed.title);
});

test("모델별 창만 있는 계정은 접어도 창을 감추지 않는다", () => {
  const onlyModels = usage([{ ...win("Fable 7일", 10), modelScoped: true }]);
  const compact = sidebarUsageMeters([source({ usage: onlyModels })], 0, LABELS, "compact")[0];

  assert.deepEqual(compact.windows.map((window) => window.label), ["Fable 7일"]);
});

test("홈 계정 미터는 이름을 알면 홈 꼬리표를, 모르면 홈 계정이라고 부른다", () => {
  const named = sidebarUsageMeters([source({ kind: "home", displayName: "home@example.com" })], 0, LABELS);
  const unnamed = sidebarUsageMeters([source({ kind: "home", displayName: null })], 0, LABELS);

  assert.equal(named[0].accountLabel, "Codex · home@example.com (홈)");
  assert.equal(unnamed[0].accountLabel, "Codex · 홈 계정");
});

test("창마다 초기화까지 남은 시간을 두 칸으로 줄여 붙이고 지난 창에는 붙이지 않는다", () => {
  const now = 1_700_000_000_000;
  const windows = meterOf(usage([
    win("5시간", 37, now + 4 * 3_600_000 + 16 * 60_000),
    win("7일", 62, now + 5 * 86_400_000 + 12 * 3_600_000),
    win("남은 창 없음", 10, null),
  ]), now).windows;

  assert.deepEqual(windows.map((window) => window.resetLabel), ["4h 16m", "5d 12h", null]);
  // 읽기 보조 기기에는 수치 뒤에 같은 값을 문장으로 붙인다.
  assert.equal(windows[0].ariaLabel, "Codex · 기본 계정 · 5시간 37% · 4h 16m 뒤 초기화");
  assert.equal(windows[2].ariaLabel, "Codex · 기본 계정 · 남은 창 없음 10%");
  // 초기화 시각이 이미 지난 창은 0%로 떨어지며 남은 시간도 사라진다.
  const elapsed = meterOf(usage([win("5시간", 37, now - 60_000)]), now).windows[0];
  assert.equal(elapsed.resetLabel, null);
});

test("경고 단계는 설정 화면과 같은 70·90% 임계를 쓴다", () => {
  const levels = [69, 70, 89, 90].map((percent) => (
    meterOf(usage([win("5시간", percent)])).windows[0].level
  ));

  assert.deepEqual(levels, ["normal", "warning", "warning", "critical"]);
});

test("조회가 실패해도 남은 수치가 있으면 값을 유지하고 도움말에만 실패를 덧붙인다", () => {
  const stale = usage([win("5시간", 48)], { status: "error", error: "boom" });
  const meter = meterOf(stale);

  assert.equal(meter.windows[0].valueLabel, "48%");
  assert.equal(meter.title, "Codex · 기본 계정 · 5시간 48% · 갱신 실패로 마지막 조회 값");
});

test("보여 줄 창이 없으면 실패 여부에 따라 값 자리를 오류나 대시로 채운다", () => {
  const empty = usage([], { updatedAt: null });
  const failed = usage([], { status: "error", updatedAt: null, error: "boom" });

  assert.equal(meterOf(empty).unavailableValue, "—");
  assert.equal(meterOf(failed).unavailableValue, "오류");
  assert.equal(meterOf(empty).title, "Codex · 기본 계정 · 사용량 정보 없음");
});

test("초기화 시각이 지난 창은 재조회 전이라도 0%로 표시한다", () => {
  const elapsed = usage([win("5시간", 93, 1_000)]);
  const meter = meterOf(elapsed, 2_000);

  assert.equal(meter.windows[0].percent, 0);
  assert.equal(meter.windows[0].level, "normal");
  assert.equal(meter.windows[0].unavailable, false);
  assert.equal(meter.windows[0].valueLabel, "0%");
});

test("초기화가 지난 뒤 재조회까지 실패한 창은 0%가 아니라 확인 불가로 적는다", () => {
  // 초기화 직후 새 사용이 있었을 수 있어 0%라고 단정할 수 없다. 설정 화면 미터와 같은 판정.
  const failed = usage([win("5시간", 93, 1_000)], { status: "error", updatedAt: 500, error: "boom" });
  const meter = meterOf(failed, 2_000);

  assert.equal(meter.windows[0].unavailable, true);
  assert.equal(meter.windows[0].valueLabel, "확인 불가");
  assert.equal(meter.windows[0].percent, 0);
  assert.equal(meter.windows[0].ariaLabel, "Codex · 기본 계정 · 5시간 확인 불가");
  assert.equal(meter.title, "Codex · 기본 계정 · 5시간 확인 불가 · 갱신 실패로 마지막 조회 값");
});

test("같은 계정에서 초기화가 지나지 않은 창은 마지막 수치를 그대로 유지한다", () => {
  const mixed = usage([win("5시간", 93, 1_000), win("7일", 41, 9_000)], {
    status: "error",
    updatedAt: 500,
    error: "boom",
  });
  const meter = meterOf(mixed, 2_000);

  assert.deepEqual(meter.windows.map((window) => window.unavailable), [true, false]);
  assert.deepEqual(meter.windows.map((window) => window.valueLabel), ["확인 불가", "41%"]);
});

test("조회가 성공한 계정은 초기화가 지나도 확인 불가로 보지 않는다", () => {
  const ok = usage([win("5시간", 93, 1_000)]);
  const meter = meterOf(ok, 2_000);

  assert.equal(meter.windows[0].unavailable, false);
});

test("가장 이른 초기화 시각만 고르고 이미 지난 시각은 버린다", () => {
  const sources = [
    source({ usage: usage([win("5시간", 10, 900)]) }),
    source({ usage: usage([win("7일", 20, 3_000), win("5시간", 20, 2_000)]) }),
  ];

  assert.equal(nearestUsageReset(sources, 1_000), 2_000);
  assert.equal(nearestUsageReset([], 1_000), null);
});

test("실패를 문구로 알리는 것은 보여 줄 값이 하나도 없을 때뿐이다", () => {
  const stale = usage([win("5시간", 48)], { status: "error", error: "boom" });
  const failed = usage([], { status: "error", updatedAt: null, error: "boom" });

  assert.equal(sidebarUsageError([source({ usage: stale })]), false);
  assert.equal(sidebarUsageError([source({ usage: stale }), source({ usage: failed })]), true);
});
