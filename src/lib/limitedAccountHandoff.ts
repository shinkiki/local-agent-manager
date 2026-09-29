/**
 * 사용량 한도에 걸린 계정에서 돌고 있는 채팅을 지금의 기본 계정으로 옮길지 정한다.
 *
 * 자격증명은 CLI 프로세스가 뜰 때 환경변수로 박히므로(`apply_account_credential_env`)
 * 살아 있는 실행의 계정은 바꿀 수 없다. 그래서 한도 오류를 받은 뒤 "계속"만 보내면 같은
 * 계정으로 다시 나가 같은 오류가 그대로 돌아온다 — 사용자가 기본 계정을 이미 다른 계정으로
 * 바꿔 두었어도 그렇다. 반대로 추론 수준처럼 재기동을 부르는 설정을 건드리면 계정이 다시
 * 풀려 그제야 이어졌다(2026-09-20 실측). 전송 직전에 이 판정을 거쳐, 옮길 자리가 있으면
 * 같은 세션을 그 계정으로 다시 열고 나서 보낸다.
 *
 * 여기서는 "옮길지"만 정한다. 실제 재기동은 호출부(`ChatView`)가 실행설정 변경과 같은
 * 경로로 한다. 계정 한도에 걸린 세션을 통째로 옮기는 자동전환(`handle_auto_switch_signal`)은
 * 그대로 두 — 그쪽은 계정의 `autoSwitch`가 켜져 있어야 움직이고, 이 판정은 사용자가 손으로
 * 기본 계정을 옮겨 둔 경우를 받는다.
 */
import { accountDisplayName, activeAccountId, launchAccountChoices, providerAccount } from "./launchAccount.ts";
import type { AccountSnapshot, AccountUsageView, ProviderId } from "../types";

export interface LimitedAccountHandoffInput {
  accounts: AccountSnapshot | null;
  source: ProviderId;
  /** 지금 실행이 묶여 있는 계정. 계정을 모르는 실행은 옮길 기준이 없다. */
  runtimeAccountId: string | null;
  /** 세션에 고정된 계정. 고정은 "이 계정에서만 돌린다"는 뜻이라 옮기지 않는다. */
  pinnedAccountId: string | null;
}

/** 옮길 자리. 안내 문구에 쓰라고 이름까지 같이 돌려준다. */
export interface LimitedAccountHandoff {
  fromAccountId: string;
  fromLabel: string;
  toAccountId: string;
  toLabel: string;
}

/**
 * 이 계정이 지금 사용량 한도에 걸려 있는지.
 *
 * `rateLimited`는 OAuth 토큰 갱신이 429를 받았을 때도 켜지는데, 그건 남은 사용량과 무관한
 * 갱신 대기다(`report_agent_usage_limit` 주석). 그 표시로 계정을 옮기면 멀쩡한 계정을
 * 버리게 되므로 갱신 제한은 빼고 본다.
 */
export function accountUsageLimited(usage: AccountUsageView): boolean {
  return usage.rateLimited === true && usage.tokenRefreshLimited !== true;
}

export function limitedAccountHandoff({
  accounts,
  source,
  runtimeAccountId,
  pinnedAccountId,
}: LimitedAccountHandoffInput): LimitedAccountHandoff | null {
  if (!accounts || !runtimeAccountId || pinnedAccountId) return null;
  const running = providerAccount(accounts, source, runtimeAccountId);
  if (!running || !accountUsageLimited(running.usage)) return null;

  const targetId = activeAccountId(accounts, source);
  // 기본 계정이 그대로면 옮길 곳이 없다. 다른 계정을 찾아 주는 것은 자동전환의 몫이다.
  if (!targetId || targetId === runtimeAccountId) return null;
  // 새 채팅을 시작할 수 없는 계정이면 이어가기도 같은 이유로 거부된다(`acquire_runtime`).
  const choice = launchAccountChoices(accounts, source).find((candidate) => candidate.id === targetId);
  if (!choice || choice.blocked) return null;
  const target = providerAccount(accounts, source, targetId);
  // 새 기본 계정도 한도에 걸려 있으면 옮겨 봐야 같은 오류다. 재기동 비용만 든다.
  if (!target || accountUsageLimited(target.usage)) return null;

  return {
    fromAccountId: running.id,
    fromLabel: accountDisplayName(running),
    toAccountId: target.id,
    toLabel: accountDisplayName(target),
  };
}
