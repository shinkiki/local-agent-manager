import type { ScheduledRequest } from "../types";

/**
 * 워크플로마다 표시·실행에 쓸 대표 회차를 고른다. 스케줄러 순서는 그대로 지키되, 같은
 * 워크플로에 켜진 회차가 하나라도 있으면 먼저 만난 일시정지 회차 대신 그것을 쓴다.
 */
export function indexPreferredRounds(schedules: readonly ScheduledRequest[]): Map<string, ScheduledRequest> {
  const rounds = new Map<string, ScheduledRequest>();
  for (const schedule of schedules) {
    const workflowId = schedule.workflow?.workflowId;
    if (!workflowId) continue;
    const known = rounds.get(workflowId);
    if (!known || (schedule.enabled && !known.enabled)) rounds.set(workflowId, schedule);
  }
  return rounds;
}
