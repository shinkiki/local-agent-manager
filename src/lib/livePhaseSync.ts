import type { ChatPhase } from "../types";

export interface LivePhaseSnapshotDecision {
  /** 폴링 스냅숏을 조회하기 시작한 시각. */
  requestedAt: number;
  /** 마지막으로 반영한 라이브 state 이벤트 시각. 아직 없으면 0. */
  lastStateEventAt: number;
  /** 화면이 지금 보여 주는 단계. */
  localPhase: ChatPhase | "connecting";
  /** 스냅숏이 알려 준 단계. 스냅숏에 이 채팅이 없으면 null. */
  snapshotPhase: ChatPhase | null;
  /** 채팅 전환·실행설정 변경처럼 화면이 스스로 단계를 바꾸는 중인지. */
  busyLocally: boolean;
}

/**
 * 라이브 채팅 폴링 스냅숏으로 화면의 단계를 맞춰도 되는지 판정한다.
 *
 * 스냅숏은 조회를 시작한 시점의 사진이므로, 응답을 기다리는 사이에 도착한 state
 * 이벤트보다 과거일 수 있다. 그 과거 사진을 그대로 적용하면 이미 끝난 턴이 '응답 중'
 * 으로 되살아나고, 그 뒤로는 어떤 이벤트도 남아 있지 않아 중단 버튼만 있는 채로
 * 채팅이 굳는다. 그래서 스냅숏보다 새로운 state 이벤트를 본 적이 있으면 버린다.
 * 그 검사를 통과하면 양방향(실행 중 ↔ 입력 대기) 모두 스냅숏을 신뢰한다.
 */
export function shouldApplyLivePhaseSnapshot({
  requestedAt,
  lastStateEventAt,
  localPhase,
  snapshotPhase,
  busyLocally,
}: LivePhaseSnapshotDecision): boolean {
  if (busyLocally) return false;
  // 연결 중에는 attach가 곧 진짜 상태를 들고 온다.
  if (localPhase === "connecting") return false;
  if (snapshotPhase === null) return false;
  // 같은 밀리초는 순서를 가릴 수 없으니 보수적으로 다음 폴링에 맡긴다.
  if (lastStateEventAt >= requestedAt) return false;
  return snapshotPhase !== localPhase;
}
