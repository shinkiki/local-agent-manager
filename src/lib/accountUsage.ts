import type { AccountSnapshot, AccountUsageView, AccountUsageWindow, ProviderAccountView } from "../types";

export interface DisplayUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  resetElapsed: boolean;
  /** 특정 모델에만 걸린 창인지. 표시에는 남기고 대표 소진율에서는 뺀다. */
  modelScoped: boolean;
  /**
   * 모델군 창들을 합쳐 만든 계정 대표 창인지(Antigravity). 가장 빡빡한 모델군의
   * 복사본이라 대표 소진율에는 쓰지만 소진 판정에서는 뺀다
   * (`accountExhaustionWindows`).
   */
  aggregate: boolean;
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

/** 시각이 이미 지났는지 여부. 값이 없으면 거짓이다. */
function isElapsed(at: number | null | undefined, now: number): boolean {
  return elapsedAt(at, now) !== null;
}

/** 아직 오지 않은 시각인지 여부. 값이 없거나 지났으면 거짓이다. */
function isPending(at: number | null | undefined, now: number): boolean {
  return pendingAt(at, now) !== null;
}

/**
 * 저장된 초기화 시각이 지난 창은 재조회 전이라도 0%로 표시한다. 실제 수치는
 * 계정 활성화 직후 전환 경로의 사용량 재조회가 다시 맞춘다.
 */
export function displayUsageWindows(windows: AccountUsageWindow[], now: number): DisplayUsageWindow[] {
  return windows.map((window) => {
    const resetElapsed = isElapsed(window.resetsAt, now);
    return {
      label: window.label,
      usedPercent: resetElapsed ? 0 : Math.min(100, Math.max(0, window.usedPercent)),
      resetsAt: window.resetsAt,
      resetElapsed,
      modelScoped: window.modelScoped === true,
      aggregate: window.aggregate === true,
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
  return isPending(usage.retryAt, now);
}

/** 계정 하나에서 초기화·재시도 시각이 지난 항목의 서명 토큰을 모은다. */
function accountResetTokens(account: ProviderAccountView, now: number): string[] {
  const tokens: string[] = [];
  for (const window of account.usage.windows) {
    if (isElapsed(window.resetsAt, now)) {
      tokens.push(`${account.id}:${window.label}`);
    }
  }
  if (isElapsed(account.usage.retryAt, now)) {
    tokens.push(`${account.id}:retryAt`);
  }
  return tokens;
}

/**
 * 스냅샷 JSON이 같아도 시간 경과로 표시가 달라져야 하는 시점을 잡아내는 서명.
 * 폴링 주기마다 비교해 값이 바뀌면 동일 데이터라도 다시 그린다. 초기화 시각과
 * 재시도 허용 시각을 함께 담아, 재시도 시각이 지나면 갱신 버튼도 다시 열린다.
 */
export function elapsedResetSignature(snapshot: AccountSnapshot, now: number): string {
  return snapshot.accounts.flatMap((account) => accountResetTokens(account, now)).join("|");
}

/**
 * 이 창들 중 아직 오지 않은 가장 이른 초기화 시각. 좌측 메뉴 상태줄과 대시보드
 * 주간 행이 "다음 초기화"를 같은 기준으로 말하도록 한 자리에 둔다. 이미 지난 시각은
 * 다음 초기화가 아니므로 버린다.
 */
export function nextUsageReset(windows: DisplayUsageWindow[], now: number): number | null {
  let earliest: number | null = null;
  for (const window of windows) {
    const at = pendingAt(window.resetsAt, now);
    if (at !== null && (earliest === null || at < earliest)) {
      earliest = at;
    }
  }
  return earliest;
}

/**
 * 계정 전체의 가용성을 대표하는 창만 남긴다. 모델별 창은 그 모델을 쓰는 실행에만
 * 걸리므로 뺀다 — Fable 주간 한도가 찼다고 이 계정 전체를 쓸 수 없다고 보면 실제로
 * 남은 한도를 버리게 된다. 백엔드의 `governing_windows`와 같은 기준이고, 남은 창이
 * 없으면 이 계정의 여유를 알 수 없다는 뜻이다(모두 찼다는 뜻이 아니다).
 */
export function governingUsageWindows(windows: DisplayUsageWindow[]): DisplayUsageWindow[] {
  return windows.filter((window) => !window.modelScoped);
}

/**
 * 이 계정을 **통째로** 막고 있는 소진 창. 백엔드 `accounts::account_exhausted`와 같은
 * 규칙이고, 비어 있으면 계정은 아직 쓸 수 있다.
 *
 * 계정이 자기 것으로 보고하는 창이 있으면 그 창만 본다. 모델군 창을 합쳐 만든 대표
 * 창(`aggregate`)은 가장 빡빡한 모델군의 복사본이라 소진 판정에 세면 안 된다 — 한
 * 모델군이 찼다고 계정 전체를 못 쓴다고 말하면, 실행은 되는데 화면만 소진이라고 하는
 * 어긋남이 생긴다. 대표 창뿐인 계정은 **모든 모델군이 찼을 때만** 막힌 것이다.
 */
export function accountExhaustionWindows(windows: DisplayUsageWindow[]): DisplayUsageWindow[] {
  const full = (window: DisplayUsageWindow) => window.usedPercent >= 100;
  const exhausted = exhaustionGroups(windows).map((group) => group.filter(full));
  // 묶음이 하나도 없는 계정(창을 읽지 못했거나 모델군을 모르는 계정)은 소진이 아니다 —
  // 모르는 것과 다 쓴 것은 다르므로 빈 묶음 목록은 아래 `every`에서 빈 결과가 된다.
  if (exhausted.length === 0) return [];
  return exhausted.every((group) => group.length > 0) ? exhausted.flat() : [];
}

/**
 * 소진을 판정하는 단위. 이 묶음들이 **모두** 찼을 때만 계정이 막힌 것이고, 다시 열리는
 * 시각도 같은 단위로 잰다. 계정이 자기 것으로 보고하는 창이 있으면 그 대표 창들이 한
 * 묶음이고, 대표 창(`aggregate`)뿐이면 모델군 하나하나가 묶음이다.
 */
function exhaustionGroups(windows: DisplayUsageWindow[]): DisplayUsageWindow[][] {
  return windows.some((window) => window.aggregate)
    ? modelGroups(windows)
    : [governingUsageWindows(windows)];
}

/** 모델군별 창 묶음. 라벨은 `{그룹 이름} · {창}`으로 만들어진다. */
function modelGroups(windows: DisplayUsageWindow[]): DisplayUsageWindow[][] {
  const groups = new Map<string, DisplayUsageWindow[]>();
  for (const window of windows.filter((candidate) => candidate.modelScoped)) {
    const [group] = window.label.split(" · ");
    const key = group ?? window.label;
    groups.set(key, [...(groups.get(key) ?? []), window]);
  }
  return [...groups.values()];
}

/** 이 창들이 **모두** 풀리는 시각. 시각을 모르는 창은 셈에서 빠진다. */
function windowsClearAt(windows: DisplayUsageWindow[]): number | null {
  const resets = windows
    .filter((window) => window.usedPercent >= 100)
    .map((window) => window.resetsAt)
    .filter((value): value is number => value !== null);
  return resets.length > 0 ? Math.max(...resets) : null;
}

/**
 * 소진된 계정이 다시 열리는 시각. 소진이 아니면 `null`이고, 소진인데 시각을 모르면 `0`이다.
 *
 * 백엔드 `accounts::account_clear_at`과 같은 규칙이다 — 한 그룹 안에서는 찬 창이 **모두**
 * 풀려야 하므로 늦은 쪽, 그룹 사이에서는 하나만 풀려도 쓸 수 있으므로 이른 쪽이다.
 * 창을 뭉뚱그려 가장 이른 시각을 말하면 아직 거부되는 시각을 "그때 풀린다"고 알리게 된다.
 */
export function accountExhaustionResetAt(windows: DisplayUsageWindow[]): number | null {
  if (accountExhaustionWindows(windows).length === 0) return null;
  const clearAt = exhaustionGroups(windows)
    .map(windowsClearAt)
    .filter((value): value is number => value !== null);
  return clearAt.length > 0 ? Math.min(...clearAt) : 0;
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
