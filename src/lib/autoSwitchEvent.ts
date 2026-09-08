/**
 * 한도 페일오버(자동전환) 이력을 사람이 읽는 문구로 만든다. 설정 화면의 전환 기록이
 * 쓴다. 알림창·OS 알림의 문구는 백엔드가 같은 모양("A → B · 사유")으로 만들어
 * 알림 항목에 실어 보내므로(session_management의 auto_switch_attention_detail), 낱말을
 * 바꾸면 양쪽을 함께 고친다.
 */
import type { AutoSwitchEventView, AutoSwitchReason, ProviderAccountView } from "../types";

/** 계정 자동전환 이력에 붙는 트리거 설명. 설정 화면과 알림이 같은 문구를 쓴다. */
export function autoSwitchReasonLabel(reason: AutoSwitchReason): string {
  if (reason === "usageExhausted") return "사용량 100% 도달";
  if (reason === "usageSpread") return "사용량 격차 도달";
  return "에이전트 제한 응답";
}

export interface AutoSwitchEventSummary {
  fromName: string;
  toName: string;
  reason: string;
  /** 복원된 세션이 있을 때만 붙는 꼬리표. 없으면 빈 문자열이라 그대로 이어 붙인다. */
  resumedNote: string;
  /** 두 표시 지점이 공유하는 본문 — "A → B · 사용량 100% 도달". */
  transition: string;
}

/**
 * 전환 이력 한 건을 문구 조각으로 푼다. 계정 이름은 넘어온 목록에서 찾고, 목록에
 * 없는 계정(삭제됐거나 다른 공급자)은 id를 그대로 쓴다 — 이름을 몰라도 어느 계정
 * 사이에서 일어난 일인지는 남겨야 한다.
 *
 * 시각과 공급자 이름은 조각에 넣지 않는다. 설정 화면은 시각을, 알림은 공급자 이름을
 * 각자 다른 자리에 붙이므로 그 결정은 표시 지점에 남긴다.
 */
export function autoSwitchEventSummary(
  accounts: ProviderAccountView[],
  event: AutoSwitchEventView,
): AutoSwitchEventSummary {
  const name = (id: string) => accounts.find((account) => account.id === id)?.displayName ?? id;
  const fromName = name(event.fromAccountId);
  const toName = name(event.toAccountId);
  const reason = autoSwitchReasonLabel(event.reason);
  return {
    fromName,
    toName,
    reason,
    resumedNote: event.resumedSessionCount > 0 ? ` · 세션 ${event.resumedSessionCount}개 복원` : "",
    transition: `${fromName} → ${toName} · ${reason}`,
  };
}
