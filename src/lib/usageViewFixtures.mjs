/**
 * 사용량 화면 시험이 공유하는 뷰 픽스처. 좌측 메뉴 미터(`sidebarUsage`)와 대시보드
 * 집계(`usageDashboard`)는 보는 것이 다르지만 재료는 같다 — 창 하나, 계정 사용량 뷰,
 * 계정 스냅샷.
 *
 * 두 시험이 이 셋을 각자 적고 있었고 이미 갈라져 있었다. 한쪽 `usage`에는 `retryAt`·
 * `rateLimited`가 없어, 재조회 차단을 보는 코드가 그 시험에서는 실제 뷰와 다른 모양을
 * 받았다. 재료를 한 벌만 두면 타입이 늘 때 두 시험이 함께 따라간다.
 */

/** 창 하나. 초기화 시각이 없는 창이 대부분이라 기본값을 둔다. `extra`로 `modelScoped` 같은 선택 필드를 얹는다. */
export function usageWindow(label, usedPercent, resetsAt = null, extra = {}) {
  return { label, usedPercent, resetsAt, ...extra };
}

/** 계정 사용량 뷰. 시험마다 실제로 다른 것은 창 목록과 조회 상태뿐이다. */
export function accountUsageView(windows, overrides = {}) {
  return {
    status: "ok",
    windows,
    updatedAt: 1_700_000_000_000,
    error: null,
    retryAt: null,
    rateLimited: false,
    ...overrides,
  };
}

/**
 * 계정 스냅샷. 자동전환·재개 정책은 두 모듈 어느 쪽도 읽지 않으므로 값 하나로 고정하고,
 * 시험이 실제로 고르는 것(`accounts`·`providers`)만 넘기게 한다.
 */
export function accountSnapshot(overrides = {}) {
  return {
    accounts: [],
    providers: [],
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
    ...overrides,
  };
}
