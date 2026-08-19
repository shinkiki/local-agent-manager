import type { AccountSnapshot, ProviderAccountView, ProviderId } from "../types";

export function accountName(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
  accountId: string | null,
): string {
  if (!accountId) return "계정 확인 불가";
  const account = snapshot?.accounts.find((candidate) => (
    candidate.provider === source && candidate.id === accountId
  ));
  if (!account) return snapshot ? "알 수 없는 계정" : "계정 확인 중";
  return account.displayName || account.email || account.id;
}

export function activeAccountId(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
): string | null {
  const provider = snapshot?.providers.find((candidate) => candidate.provider === source);
  return provider?.observedActiveAccountId ?? provider?.activeAccountId ?? null;
}

export function activeAccount(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
): ProviderAccountView | null {
  const accountId = activeAccountId(snapshot, source);
  return snapshot?.accounts.find((account) => account.provider === source && account.id === accountId) ?? null;
}

export function remainingUsagePercent(account: ProviderAccountView | null): number | null {
  if (!account || account.usage.windows.length === 0) return null;
  const usedPercent = Math.max(...account.usage.windows.map((window) => (
    Math.min(100, Math.max(0, window.usedPercent))
  )));
  return Math.max(0, 100 - usedPercent);
}

export interface AccountUsageDisplayState {
  canRefresh: boolean;
  cached: boolean;
  error: string | null;
}

/**
 * 공유 인증과 레지스트리 선택이 일치하는 활성 계정만 실시간 조회한다.
 * 비활성 계정은 이전 성공 결과만 표시하고 과거 조회 오류는 노출하지 않는다.
 */
export function accountUsageDisplayState(
  account: ProviderAccountView,
  observedActiveAccountId: string | null,
): AccountUsageDisplayState {
  const observedMatches = observedActiveAccountId === null
    || observedActiveAccountId === account.id;
  const canRefresh = account.isActive && observedMatches;
  return {
    canRefresh,
    cached: !account.isActive
      && account.usage.updatedAt !== null
      && account.usage.windows.length > 0,
    error: account.isActive ? account.usage.error : null,
  };
}
