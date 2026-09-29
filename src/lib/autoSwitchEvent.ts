/**
 * 한도 페일오버(자동전환) 이력을 사람이 읽는 문구로 만든다. 설정 화면의 전환 기록이
 * 쓴다. 알림창·OS 알림의 문구는 백엔드가 같은 모양("A → B · 사유")으로 만들어
 * 알림 항목에 실어 보내므로(session_management의 auto_switch_attention_detail), 낱말을
 * 바꾸면 양쪽을 함께 고친다.
 */
import type { AutoSwitchEventView, AutoSwitchReason, ProviderAccountView } from "../types";

/** 사유 종류와 표시 문구를 한 줄씩 대응시켜 새 종류의 문구 누락을 타입 검사에서 막는다. */
const AUTO_SWITCH_REASON_LABELS: Record<AutoSwitchReason, string> = {
  usageExhausted: "사용량 100% 도달",
  usageSpread: "사용량 격차 도달",
  agentLimited: "에이전트 제한 응답",
};

/** 계정 자동전환 이력에 붙는 트리거 설명. 설정 화면과 알림이 같은 문구를 쓴다. */
export function autoSwitchReasonLabel(reason: AutoSwitchReason): string {
  return AUTO_SWITCH_REASON_LABELS[reason];
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
 * 계정 목록을 표시 이름 색인으로 옮긴다. 자동전환의 출발·도착 이름이 같은 목록을 각자
 * `find`로 되훑고 있었으므로 한 번만 순회한다. 중복 id는 기존 `find`와 같이 처음 나온
 * 계정을 남긴다 — 뒤 항목으로 덮으면 같은 입력에서 표시 이름이 바뀐다.
 */
function accountDisplayNames(accounts: ProviderAccountView[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const account of accounts) {
    if (!names.has(account.id)) names.set(account.id, account.displayName);
  }
  return names;
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
  const names = accountDisplayNames(accounts);
  const name = (id: string) => names.get(id) ?? id;
  const fromName = name(event.fromAccountId);
  const toName = name(event.toAccountId);
  const reason = autoSwitchReasonLabel(event.reason);
  return {
    fromName,
    toName,
    reason,
    resumedNote: resumedNote(event, name),
    transition: `${fromName} → ${toName} · ${reason}${event.defaultRotated === false ? " · 기본 계정 유지" : ""}`,
  };
}

/**
 * 복원 세션 문구. 세션이 기본 계정과 다른 곳으로 갔으면 그 행방을 말한다 — 기본 계정은
 * 열린 모델군을 잃지 않는 곳으로, 세션은 자기 모델군이 남은 곳으로 각각 가므로 둘이 갈릴 수
 * 있고, 그때 "A → B · 세션 2개 복원"은 세션까지 B로 갔다고 읽힌다. 다른 곳인지의 판정은
 * 백엔드 기록이 소유하고, 여기는 값이 있으면 그대로 말한다.
 */
function resumedNote(event: AutoSwitchEventView, name: (id: string) => string): string {
  if (event.resumedSessionCount <= 0) return "";
  // 같은 곳으로 갔으면 백엔드가 비워 보낸다 — 여기서 다시 비교하지 않는다.
  const sessionsTo = event.sessionsToAccountId;
  if (sessionsTo) {
    return ` · 세션 ${event.resumedSessionCount}개는 ${name(sessionsTo)}로 복원`;
  }
  return ` · 세션 ${event.resumedSessionCount}개 복원`;
}
