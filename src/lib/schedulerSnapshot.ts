import type { ProviderId, ScheduleRunStatus, SchedulerSnapshot, ScheduledRequest } from "../types";

type ScheduleModelContext = Pick<ScheduledRequest, "source" | "model">;

/**
 * 편집 중인 반복 요청이 있으면 요청의 source/model 쌍을 그대로 쓴다. model이 null인
 * 기존 요청도 현재 채팅 모델로 폴백하지 않고 빈 선택으로 남겨, 해당 source의 카탈로그가
 * 공급자 기본값을 표시하도록 한다. 현재 채팅은 새 반복 요청을 만들 때만 상속한다.
 */
export function initialScheduleEditorModelSelection(
  schedule: ScheduleModelContext | undefined,
  currentSession: ScheduleModelContext | null,
  fallbackSource: ProviderId,
): { source: ProviderId; model: string } {
  const context = schedule ?? currentSession;
  return {
    source: context?.source ?? fallbackSource,
    model: context?.model ?? "",
  };
}

/**
 * 스케줄 목록에서 ID로 대상을 찾아 불변 갱신한다.
 * 대상을 찾지 못했거나 갱신기가 같은 객체를 돌려주면 스냅샷 참조를 그대로 보존한다.
 */
function updateSchedule(
  snapshot: SchedulerSnapshot,
  id: string,
  updater: (current: ScheduledRequest) => ScheduledRequest,
): SchedulerSnapshot {
  const index = snapshot.schedules.findIndex((schedule) => schedule.id === id);
  if (index < 0) return snapshot;
  const current = snapshot.schedules[index];
  const updated = updater(current);
  if (updated === current) return snapshot;
  const schedules = [...snapshot.schedules];
  schedules[index] = updated;
  return { ...snapshot, schedules };
}

/**
 * 반복 요청 하나를 서버가 돌려준 값으로 갈아 끼운다. 목록 전체를 다시 받지 않아도
 * `nextRunAt`처럼 서버가 계산하는 값까지 반영된다. 모르는 ID면 스냅샷을 그대로 둔다.
 */
export function withSchedule(
  snapshot: SchedulerSnapshot,
  schedule: ScheduledRequest,
): SchedulerSnapshot {
  return updateSchedule(snapshot, schedule.id, () => schedule);
}

/**
 * 활성 여부만 먼저 바꿔 화면에 올린다. 다음 실행 시각은 서버가 정하므로 응답이 올 때까지
 * 예전 값이 남는다. 껐을 때는 카드가 다음 실행을 아예 표시하지 않아 어긋나지 않는다.
 */
export function withScheduleEnabled(
  snapshot: SchedulerSnapshot,
  id: string,
  enabled: boolean,
): SchedulerSnapshot {
  return updateSchedule(snapshot, id, (target) => (
    target.enabled === enabled ? target : { ...target, enabled }
  ));
}

/**
 * 다음 틱에서 같은 회차를 이어서 다시 시도하는 상태인지. 아직 끝나지 않은 실행이므로
 * 카드는 이 상태를 최근 결과가 아니라 진행 중으로 읽어야 한다. 대기 사유(계정 준비,
 * 사용량 복구)가 늘어도 판정을 한 군데에서만 고치도록 여기에 모아 둔다.
 */
export function isWaitingRunStatus(status: ScheduleRunStatus): boolean {
  return status === "waitingForAccount" || status === "waitingForUsage";
}
