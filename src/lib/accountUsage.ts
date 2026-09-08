import type { AccountSnapshot, AccountUsageView, AccountUsageWindow, ProviderAccountView } from "../types";

export interface DisplayUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  resetElapsed: boolean;
  /** 특정 모델에만 걸린 창인지. 표시에는 남기고 대표 소진율에서는 뺀다. */
  modelScoped: boolean;
}

/**
 * 시각 비교 술어 두 벌. 이 모듈의 판정은 거의 모두 "저장된 시각이 지났는가 / 아직
 * 남았는가"이고, 그 비교가 창 초기화·재시도 허용 시각마다 조금씩 다른 문장으로
 * 여섯 벌 퍼져 있었다(`x !== null && x <= now`, `(x ?? 0) > now`, ...). 한 벌만 고쳐
 * 두 판정이 어긋나면 갱신을 열어야 할 때 막거나 막아야 할 때 여는 쪽으로 갈리므로
 * 여기 두 술어만 두고 모두 이 문장을 쓴다.
 *
 * 불리언 대신 시각 자체를 돌려주는 것은 호출부가 그 시각을 다시 쓰기 때문이다
 * (마지막 조회 시각과 견주거나, 재시도 허용 시각을 그대로 표시한다).
 */

/** 이미 지난 시각. 아직 오지 않았거나 값이 없으면 null. */
function elapsedAt(at: number | null | undefined, now: number): number | null {
  return at !== null && at !== undefined && at <= now ? at : null;
}

/** 아직 오지 않은 시각. 이미 지났거나 값이 없으면 null. */
function pendingAt(at: number | null | undefined, now: number): number | null {
  return at !== null && at !== undefined && at > now ? at : null;
}

/**
 * 저장된 초기화 시각이 지난 창은 재조회 전이라도 0%로 표시한다. 실제 수치는
 * 계정 활성화 직후 전환 경로의 사용량 재조회가 다시 맞춘다.
 */
export function displayUsageWindows(windows: AccountUsageWindow[], now: number): DisplayUsageWindow[] {
  return windows.map((window) => {
    const resetElapsed = elapsedAt(window.resetsAt, now) !== null;
    return {
      label: window.label,
      usedPercent: resetElapsed ? 0 : Math.min(100, Math.max(0, window.usedPercent)),
      resetsAt: window.resetsAt,
      resetElapsed,
      modelScoped: window.modelScoped === true,
    };
  });
}

/**
 * 초기화 시각이 지난 뒤 실제 조회까지 실패했으면 0%라고 단정할 수 없다. 초기화 직후
 * 새 사용이 있었을 수 있으므로, 설정 화면은 숫자 대신 확인 불가 상태를 보여준다.
 */
export function usageWindowValueUnavailable(
  usage: AccountUsageView,
  window: DisplayUsageWindow,
): boolean {
  return usage.status === "error" && window.resetElapsed;
}

/** 마지막 성공 조회 이후 초기화 시각이 지나 실제 사용량 재조회가 필요한지 판정한다. */
export function usageResetElapsedSinceUpdate(usage: AccountUsageView, now: number): boolean {
  return usage.windows.some((window) => {
    const resetAt = elapsedAt(window.resetsAt, now);
    return resetAt !== null && (usage.updatedAt ?? 0) < resetAt;
  });
}

/**
 * 활성 계정과 런타임이 붙은 계정의 사용량 갱신 주기(ms). 이 계정들만 사용량이 실제로
 * 올라간다. 백엔드 `BUSY_USAGE_REFRESH_INTERVAL_MS`와 같은 값이다.
 */
export const BUSY_USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * 아무것도 돌지 않는 계정의 사용량 갱신 주기(ms). 쓰이지 않는 계정의 사용량은 올라갈
 * 수 없고 리셋으로 내려갈 뿐이라, 창 초기화 시각이 지나면 주기와 무관하게 즉시 다시
 * 읽는다. 백엔드 `IDLE_USAGE_REFRESH_INTERVAL_MS`와 같은 값이다.
 */
export const IDLE_USAGE_REFRESH_INTERVAL_MS = 30 * 60_000;

/**
 * 이 계정의 자동 사용량 갱신 주기. 활성이거나 런타임이 붙어 있으면 짧게, 아무것도
 * 돌지 않으면 길게 본다. 백엔드 `usage_refresh_fresh_for_interval`과 같은 판정이라
 * 프론트가 부른 갱신을 백엔드가 도로 걸러 헛도는 일이 없다.
 */
export function usageRefreshInterval(account: ProviderAccountView): number {
  return account.isActive || account.runtimeCount > 0
    ? BUSY_USAGE_REFRESH_INTERVAL_MS
    : IDLE_USAGE_REFRESH_INTERVAL_MS;
}

/**
 * 사용량 한도(rateLimited)로 갱신 요청 자체를 보내면 안 되는 동안의 재시도 허용
 * 시각. 제한 상태가 아니거나 시각이 이미 지났으면 null이고, 이때 갱신은 다시 열린다.
 */
export function usageRetryBlockedUntil(usage: AccountUsageView, now: number): number | null {
  return usage.rateLimited ? pendingAt(usage.retryAt, now) : null;
}

/**
 * 폴링이 스스로 사용량을 다시 조회해도 되는지. 한도든 일반 오류든 백엔드가 정한
 * 재시도 시각까지는 자동 조회를 미룬다. 수동 갱신 차단(usageRetryBlockedUntil)은
 * 이 조건의 부분집합이라 자동·수동 보호가 어긋나지 않는다.
 */
export function usageRefreshDeferred(usage: AccountUsageView, now: number): boolean {
  return pendingAt(usage.retryAt, now) !== null;
}

/**
 * 스냅샷 JSON이 같아도 시간 경과로 표시가 달라져야 하는 시점을 잡아내는 서명.
 * 폴링 주기마다 비교해 값이 바뀌면 동일 데이터라도 다시 그린다. 초기화 시각과
 * 재시도 허용 시각을 함께 담아, 재시도 시각이 지나면 갱신 버튼도 다시 열린다.
 */
export function elapsedResetSignature(snapshot: AccountSnapshot, now: number): string {
  return snapshot.accounts.flatMap((account) => {
    const elapsed = account.usage.windows
      .filter((window) => elapsedAt(window.resetsAt, now) !== null)
      .map((window) => `${account.id}:${window.label}`);
    return elapsedAt(account.usage.retryAt, now) !== null ? [...elapsed, `${account.id}:retryAt`] : elapsed;
  }).join("|");
}

/**
 * 계정에 남은 사용량 여유(%). 가장 빡빡한 창을 기준으로 본다. 모델별 창은 그 모델을
 * 쓰는 실행에만 걸리므로 빼고 본다 — Fable 주간 한도가 찼다고 이 계정 전체를 쓸 수
 * 없다고 보면 실제로 남은 한도를 버리게 된다. 백엔드의 `governing_windows`와 같은 기준이다.
 */
export function remainingUsagePercent(account: ProviderAccountView | null, now: number): number | null {
  if (!account) return null;
  const windows = governingUsageWindows(displayUsageWindows(account.usage.windows, now));
  if (windows.length === 0) return null;
  return Math.max(0, 100 - Math.max(...windows.map((window) => window.usedPercent)));
}

/**
 * 이 창들 중 아직 오지 않은 가장 이른 초기화 시각. 좌측 메뉴 상태줄과 대시보드
 * 주간 행이 "다음 초기화"를 같은 기준으로 말하도록 한 자리에 둔다. 이미 지난 시각은
 * 다음 초기화가 아니므로 버린다.
 */
export function nextUsageReset(windows: DisplayUsageWindow[], now: number): number | null {
  return windows
    .map((window) => pendingAt(window.resetsAt, now))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0] ?? null;
}

/** 계정 전체의 가용성을 대표하는 창만 남긴다. 모델별 창은 표시 전용이다. */
export function governingUsageWindows(windows: DisplayUsageWindow[]): DisplayUsageWindow[] {
  return windows.filter((window) => !window.modelScoped);
}

export interface AccountUsageDisplayState {
  canRefresh: boolean;
  cached: boolean;
  /** 보여줄 마지막 수치가 없어 오류 문구 말고는 표시할 것이 없을 때만 채운다. */
  error: string | null;
  /**
   * 마지막 조회는 실패했지만 이전 수치를 그대로 보여주는 중일 때의 실패 사유.
   * 표시는 마지막 값과 그 기준 시각으로 하고, 이 문구는 도움말로만 쓴다.
   */
  staleError: string | null;
  /**
   * 다른 조건은 모두 갖췄는데 한도 때문에 갱신을 막고 있을 때의 재시도 허용 시각.
   * 애초에 조회 대상이 아닌 계정에서는 막힌 이유가 아니므로 null이다.
   */
  retryBlockedUntil: number | null;
}

/**
 * 자격증명이 계정별로 갈려 있어 활성 계정이 아니어도 자기 자격증명으로 사용량을
 * 조회한다. 그래서 조회 대상 여부는 활성 여부가 아니라 "쓸 수 있는 계정인지"로
 * 판단한다(중지·재인증 필요 계정은 제외). 한도로 재시도 시각이 잡혀 있으면 그
 * 시각까지는 수동 갱신도 보내지 않고, 조회할 수 없는 계정은 이전 성공 결과를
 * 보관 값으로 표시한다.
 *
 * 조회에 실패해도 마지막으로 성공한 수치가 남아 있으면 오류 문구 대신 그 수치를
 * 계속 보여준다. 네트워크가 잠깐 끊겨도 남은 한도를 볼 수 있어야 하고, 실패
 * 사유는 기준 시각과 도움말로 충분히 드러난다.
 */
export function accountUsageDisplayState(
  account: ProviderAccountView,
  now: number,
): AccountUsageDisplayState {
  const eligible = !account.disabled && account.authStatus === "ready";
  const retryBlockedUntil = eligible ? usageRetryBlockedUntil(account.usage, now) : null;
  const failure = eligible ? account.usage.error : null;
  const hasStoredValue = hasStoredUsage(account.usage);
  const keepsLastValue = failure !== null && hasStoredValue;
  return {
    canRefresh: eligible && retryBlockedUntil === null,
    retryBlockedUntil,
    cached: !eligible && hasStoredValue,
    error: keepsLastValue ? null : failure,
    staleError: keepsLastValue ? failure : null,
  };
}

/** 마지막 성공 조회로 남겨 둔 수치가 있는지. 보관 표시와 실패 시 유지 판정이 같은 기준을 쓴다. */
function hasStoredUsage(usage: AccountUsageView): boolean {
  return usage.updatedAt !== null && usage.windows.length > 0;
}

/** 사용률 색 단계. 좌측 메뉴·설정 화면·대시보드가 같은 임계(70·90%)를 쓴다. */
export type UsageLevel = "normal" | "warning" | "critical";

export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}
