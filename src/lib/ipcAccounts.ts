/**
 * 공급자 계정을 다루는 백엔드 명령 목록 — 계정 조회·로그인·활성 계정 교체·페일오버
 * 정책·사용량 재조회다. 계정 레지스트리에 없는 Antigravity의 사용량 조회 둘도 여기
 * 있다 — 인증 계정이 아니라 쿼터 자원이지만, 화면은 그 값을 계정 행과 나란히 그리고
 * 소진율도 같은 규칙으로 읽는다.
 *
 * 그 계정을 실행하는 **CLI 설치본**은 여기 두지 않는다(`ipcProviderCli`). 이쪽 명령은
 * 모두 `accountId` 하나에 듣지만 저쪽은 계정과 무관하게 `provider` 단위로 이 기기
 * 전체에 듣고, 바뀌는 이유도 설치 출처·업데이트 명령 쪽이다.
 *
 * `ipc.ts`는 화면이 쓰는 모든 명령을 한 파일에 쌓아 둔 곳이라, 계정 정책 하나를 고칠 때도
 * 천 줄짜리 목록에서 관련 명령이 어디까지인지 눈으로 좇아야 했다. 이미 통로(`ipcTransport`)·
 * 지침(`ipcInstructions`)·애드온 도구(`ipcCypress` 등)·첨부 내려받기(`ipcLinkedFile`)가 같은 방식으로
 * 갈라져 나와 있으므로, 계정 묶음도 같은 규칙으로 자기 파일을 갖는다.
 *
 * 여기서 내보내는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전
 * 그대로 `lib/ipc`다.
 */
import type {
  AccountLoginSessionView,
  AccountSnapshot,
  AccountToolsSnapshot,
  AccountUsageView,
  AutoSwitchPolicy,
  ProviderAccountView,
  ProviderId,
  ResetCreditOutcome,
  ResumeAccountPolicy,
  SwitchActiveProviderAccountReceipt,
  UsageHistorySnapshot,
} from "../types";
import { call } from "./ipcTransport";

export function getProviderAccounts(): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("get_provider_accounts");
}

/** 계정별로 쓸 수 있는 외부 MCP·커넥터·플러그인 요약. 도구를 실행하지 않는 조회다. */
export function getAccountTools(): Promise<AccountToolsSnapshot> {
  return call<AccountToolsSnapshot>("get_account_tools");
}

/** 계정별 사용량 주기 이력. 앱 데이터의 파생 이력만 읽는 순수 조회다. */
export function getAccountUsageHistory(): Promise<UsageHistorySnapshot> {
  return call<UsageHistorySnapshot>("get_account_usage_history");
}

export function beginProviderAccountLogin(
  source: ProviderId,
  accountId?: string | null,
): Promise<AccountLoginSessionView> {
  return call<AccountLoginSessionView>("begin_provider_account_login", { source, accountId });
}

export function finishProviderAccountLogin(
  loginId: string,
  displayName?: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("finish_provider_account_login", { loginId, displayName });
}

export function cancelProviderAccountLogin(loginId: string): Promise<void> {
  return call<void>("cancel_provider_account_login", { loginId });
}

/** 활성 계정을 바꾼다. 자격증명 교체가 없어 실행 중 세션은 종료하지 않는다. */
export function switchActiveProviderAccount(accountId: string): Promise<SwitchActiveProviderAccountReceipt> {
  return call<SwitchActiveProviderAccountReceipt>("switch_active_provider_account", { accountId });
}

export function setProviderAccountDisabled(
  accountId: string,
  disabled: boolean,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_disabled", { accountId, disabled });
}

export function setProviderAccountAutoSwitch(
  accountId: string,
  autoSwitch: boolean,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_auto_switch", { accountId, autoSwitch });
}

/** 계정별 사용자 메모를 저장한다. null을 보내면 저장된 메모를 삭제한다. */
export function setProviderAccountNote(
  accountId: string,
  note: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_note", { accountId, note });
}

/**
 * 계정 표시 이름을 사용자가 정한 값으로 바꾼다. null이나 빈 문자열을 보내면 사용자
 * 지정을 지우고 공급자가 알려 준 이름으로 되돌린다.
 */
export function setProviderAccountLabel(
  accountId: string,
  label: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_label", { accountId, label });
}

export function setAutoSwitchResume(enabled: boolean): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_resume", { enabled });
}

/** 페일오버 우선순위. null을 보내면 지정을 해제한다. */
export function setProviderAccountAutoSwitchPriority(
  accountId: string,
  priority: number | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_auto_switch_priority", { accountId, priority });
}

export function setAutoSwitchPolicy(policy: AutoSwitchPolicy): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_policy", { policy });
}

/**
 * 사용량 분산 교체 폭(1~99, %p)을 바꾼다. null을 보내면 분산 교체를 끄고 100% 도달과
 * 에이전트 제한 응답에서만 페일오버한다.
 */
export function setAutoSwitchUsageGap(percent: number | null): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_usage_gap", { percent });
}

/**
 * 이어가기 실행 계정 선택 방식을 바꾼다. 이미 떠 있는 런타임은 시작 시점 계정을
 * 유지하므로 다음 이어가기부터 적용된다.
 */
export function setResumeAccountPolicy(policy: ResumeAccountPolicy): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_resume_account_policy", { policy });
}

/**
 * 계정 사용량을 계정별로 동시에 다시 조회한다. 계정별 응답이 전체 스냅샷이라
 * 순차 호출은 서로의 결과를 덮어쓰므로, 여러 계정을 갱신할 때는 이 호출을 쓴다.
 * 백엔드는 계정마다 갱신 주기(활성·실행 중 5분, 유휴 30분)를 지켜 대상을 다시 거르므로,
 * 폴링은 그대로 부르고 사용자가 직접 누른 새로고침만 `force`로 주기를 무시한다.
 */
export function refreshProviderAccountUsages(provider?: ProviderId, force = false): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("refresh_provider_account_usages", { ...(provider ? { provider } : {}), ...(force ? { force } : {}) });
}

export function deleteProviderAccount(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("delete_provider_account", { accountId });
}

export function refreshProviderAccountUsage(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("refresh_provider_account_usage", { accountId });
}

/**
 * 한도 리셋 크레딧 한 장을 써서 소진된 사용량 창을 되돌린다. 되돌릴 수 없고 장수가
 * 한정돼 있으므로 확인을 받은 뒤에만 부른다. 한도를 충분히 쓰지 않았으면
 * `nothingToReset`으로 물리고 크레딧은 남는다.
 */
export function consumeAccountResetCredit(accountId: string): Promise<{ outcome: ResetCreditOutcome; accounts: AccountSnapshot }> {
  return call<{ outcome: ResetCreditOutcome; accounts: AccountSnapshot }>("consume_account_reset_credit", { accountId });
}

export function revalidateProviderAccountCredential(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("revalidate_provider_account_credential", { accountId });
}

/**
 * Antigravity 기계 전역 사용량. 계정을 등록하기 전의 값이다 — 등록한 계정의 잔량은 다른
 * 공급자와 같이 계정 스냅샷에 실려 온다. 값은 실행 중인 language server에서 읽으므로,
 * 회차도 IDE도 돌지 않는 동안에는 status가 `idle`로 온다.
 *
 * `fresh`는 표시 캐시가 지났으면 CLI 응답을 기다리고(수십 초), `cachedFirst`는 캐시를 바로
 * 돌려주고 갱신은 뒤에서 한다. 주기적으로 폴링하는 화면은 `cachedFirst`를 써야 폴링마다
 * CLI가 뜨지 않는다.
 */
export function getAntigravityUsage(freshness: "fresh" | "cachedFirst" = "fresh"): Promise<AccountUsageView> {
  return call<AccountUsageView>("get_antigravity_usage", { freshness });
}

/**
 * Antigravity 모델군별 사용량 자원. 인증 계정이 아니라 쿼터 자원이라 계정 목록에는
 * 없지만, 모델군마다 주간·5시간 쿼터를 따로 소비하므로 계정 행과 같은 모양으로 온다.
 * 소진율 그래프가 계정과 나란히 그리고 주기 이력을 붙일 때 쓴다.
 */
export function getAntigravityPacingUsage(): Promise<ProviderAccountView[]> {
  return call<ProviderAccountView[]>("get_antigravity_pacing_usage");
}
