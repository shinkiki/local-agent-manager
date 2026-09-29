/**
 * 반복 요청이 "어느 계정으로 실행되는가"를 답하는 조회 한 벌.
 *
 * 목록 카드는 저장된 계정과 지난 회차가 실제로 쓴 계정을 이름으로 보여 주고, 편집기는
 * 고를 수 있는 계정 목록과 되돌아갈 기본값을 만든다. 두 쪽이 같은 술어(비활성화 제외,
 * 인증 완료 요구 여부, 스냅숏이 아직 읽히지 않아 null일 때)를 쓰므로 어느 한쪽 파일에
 * 두면 다른 쪽이 그 파일을 통째로 끌어오게 된다. 목록·편집기 둘 다 여기만 읽는다.
 */
import { activeAccountId } from "../lib/launchAccount";
import type { AccountSnapshot, ChatSessionInfo, ProviderAccountView, ProviderId, ScheduledRequest } from "../types";

/// 실행 계정 선택에서 특정 계정을 고정하지 않고 실행 시점 활성 계정을 쓰겠다는 값.
/// 계정 id와 겹치지 않게 예약어를 쓰고, 저장할 때 useActiveAccount로 바꾼다.
export const ACTIVE_ACCOUNT_CHOICE = "__active__";


/**
 * 계정 스냅숏 조회 세 갈래. 스냅숏은 아직 안 읽혔으면 null이라 호출부마다 `accounts?.`와
 * 같은 술어를 다시 적고 있었고, "고를 수 있는 계정"의 뜻(비활성화 제외, 인증 완료 요구
 * 여부)이 세 자리에 흩어져 한 곳만 고치면 조용히 어긋났다. 여기 한 벌로 모은다.
 */
export function accountById(accounts: AccountSnapshot | null, accountId: string | null | undefined): ProviderAccountView | undefined {
  return accountId ? accounts?.accounts.find((account) => account.id === accountId) : undefined;
}

/** 이 공급자를 계정 레지스트리가 담는가. 백엔드 `ProviderId::manages_accounts`와 같은 답이다. */
export function providerManagesAccounts(accounts: AccountSnapshot, source: ProviderId): boolean {
  return accounts.providers.some((state) => state.provider === source);
}

/**
 * 그 공급자에서 고를 수 있는 계정. 비활성화된 계정은 어느 쪽에서도 고를 수 없고,
 * `"ready"`는 지금 바로 실행할 수 있는 계정만(인증이 끝난 것) 남긴다 — 편집기가 처음
 * 열릴 때는 저장본이 가리키는 인증 전 계정도 보여야 해서 `"any"`를 쓴다.
 */
export function selectableAccountsFor(accounts: AccountSnapshot | null, source: ProviderId, auth: "ready" | "any"): ProviderAccountView[] {
  return accounts?.accounts.filter((account) =>
    account.provider === source && !account.disabled && (auth === "any" || account.authStatus === "ready")) ?? [];
}

// 공급자를 바꾸거나 고른 계정이 비었을 때 되돌아갈 활성 계정. 활성 계정이 있으면 그것,
// 없으면 지금 바로 실행할 수 있는(비활성화되지 않고 인증이 끝난) 첫 계정이다.
// 편집기가 처음 열릴 때 고르는 계정은 저장본·현재 대화를 먼저 보는 별도 사다리라 여기
// 합치지 않는다(인증 전 계정도 저장본 그대로 보여 주어야 한다).
export function defaultAccountIdFor(accounts: AccountSnapshot | null, source: ProviderId): string {
  return activeAccountId(accounts, source)
    ?? selectableAccountsFor(accounts, source, "ready")[0]?.id
    ?? "";
}

// 편집기가 열릴 때의 실행 계정 사다리. 훅 선언 사이에 끼워 두면 "저장본 → 지금 대화 →
// 공급자 활성 계정 → 첫 사용 가능 계정" 순서가 묻혀 보이지 않아 밖으로 뺐다.
export function initialScheduleAccountId(accounts: AccountSnapshot | null, source: ProviderId, schedule: ScheduledRequest | undefined, currentSession: ChatSessionInfo | null): string {
  return (schedule?.useActiveAccount ? ACTIVE_ACCOUNT_CHOICE : null)
    ?? (schedule?.accountId || null)
    ?? (currentSession?.source === source ? currentSession.accountId : null)
    ?? activeAccountId(accounts, source)
    ?? selectableAccountsFor(accounts, source, "any")[0]?.id
    ?? "";
}
