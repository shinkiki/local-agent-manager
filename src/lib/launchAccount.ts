/**
 * 실행 계정을 고르고 이름 붙이는 일. 새 채팅·실행설정 메뉴가 쓰며 사용량 수치와는
 * 무관하다 — 사용량 창·갱신 주기·소진율 판정은 `accountUsage.ts`가 가진다.
 */
import type { AccountSnapshot, ProviderId } from "../types";

interface AccountNameCandidate {
  id: string;
  displayName?: string | null;
  email?: string | null;
}

type ProviderAccount = AccountSnapshot["accounts"][number];

/**
 * 스냅숏에서 이 공급자의 계정 하나를 찾는다. 없거나 id를 모르면 null.
 *
 * 계정 스냅숏은 세 공급자의 계정을 한 배열에 담으므로 id만으로 찾으면 안 되는데, 이름을
 * 짓는 자리와 한도 인계를 판단하는 자리가 이 조회를 각자 적고 있었고 그중 한 자리
 * (`limitedAccountHandoff`의 옮겨 갈 계정)는 공급자 조건을 빠뜨린 채였다. 지금은 그 앞에서
 * 공급자별 선택지로 이미 걸러 같은 답이 나오지만, 걸러 두는 순서가 바뀌면 다른 공급자의
 * 계정을 집어 드는 자리로 남는다. 조회 규칙을 한 벌만 둔다.
 */
export function providerAccount(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
  accountId: string | null,
): ProviderAccount | null {
  if (!accountId) return null;
  return snapshot?.accounts.find((candidate) => (
    candidate.provider === source && candidate.id === accountId
  )) ?? null;
}

/** 계정의 표시 이름. displayName -> email -> id 순으로 우선 적용한다. */
export function accountDisplayName(account: AccountNameCandidate): string {
  return account.displayName || account.email || account.id;
}

export function accountName(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
  accountId: string | null,
): string {
  if (!accountId) return "계정 확인 불가";
  const account = providerAccount(snapshot, source, accountId);
  if (!account) return snapshot ? "알 수 없는 계정" : "계정 확인 중";
  return accountDisplayName(account);
}

/** 활성 계정 id. 새 채팅·터미널의 활성 실행 계정이자 헤더 사용량 표시 대상이다. */
export function activeAccountId(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
): string | null {
  const provider = snapshot?.providers.find((candidate) => candidate.provider === source);
  return provider?.activeAccountId ?? null;
}

/** 새 채팅에서 고를 수 있는 실행 계정 하나. 빈 선택("")은 실행 시점 활성 계정이다. */
export interface LaunchAccountChoice {
  id: string;
  label: string;
  /** 자격증명 격리를 쓸 수 없어 이 계정으로는 새 실행을 시작할 수 없는 상태. */
  blocked: boolean;
  /** 막힌 이유(격리 폴백 사유). 막히지 않았으면 null. */
  blockedReason: string | null;
}

/** 공급자와 실행 가능 상태가 맞는 계정만 선택지 후보로 남긴다. */
function isLaunchableAccount(account: ProviderAccount, source: ProviderId): boolean {
  return account.provider === source && !account.disabled && account.authStatus === "ready";
}

/** 후보 계정 하나의 기본 표시와 자격증명 격리 차단 상태를 조립한다. */
function launchAccountChoice(account: ProviderAccount, activeAccountId: string | null): LaunchAccountChoice {
  const blocked = !account.credentialIsolated && account.credentialIsolationNote !== null;
  const baseLabel = accountDisplayName(account);
  return {
    id: account.id,
    label: `${baseLabel}${account.id === activeAccountId ? " · 활성" : ""}`,
    blocked,
    blockedReason: blocked ? account.credentialIsolationNote : null,
  };
}

/**
 * 이 공급자에서 실행 계정으로 고를 수 있는 계정 목록. 중지·재인증 필요 계정은 애초에
 * 실행할 수 없어 빼고, 자격증명 격리가 실패로 확정된 계정은 목록에는 두되 고를 수 없게
 * 표시한다(백엔드 `acquire_runtime`이 같은 이유로 거부한다 — 활성 계정도 예외가 아니다).
 * 아직 한 번도 실행하지 않아 격리 판정 전인 계정(사유 없음)은 막지 않는다 — 프로필은
 * 첫 실행 때 준비되며 그때 판정된다.
 */
export function launchAccountChoices(
  snapshot: AccountSnapshot | null,
  source: ProviderId,
): LaunchAccountChoice[] {
  const active = activeAccountId(snapshot, source);
  return (snapshot?.accounts ?? [])
    .filter((account) => isLaunchableAccount(account, source))
    .map((account) => launchAccountChoice(account, active));
}

/**
 * 고른 실행 계정을 현재 선택지에 맞춘다. 공급자를 바꿨거나 계정이 사라지거나 막히면
 * 기본값(실행 시점 활성 계정)으로 되돌린다.
 */
export function resolveLaunchAccountId(selected: string, choices: LaunchAccountChoice[]): string {
  if (!selected) return "";
  return choices.some((choice) => choice.id === selected && !choice.blocked) ? selected : "";
}
