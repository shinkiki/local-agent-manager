/**
 * 반복 요청(스케줄러) 명령. 스냅샷 폴링, 요청·실행 상세, 생성·수정·삭제, 즉시 실행과
 * 일시 중지가 여기 모인다.
 *
 * 명령 목록(`ipc.ts`)에 섞여 있으면 미리보기로 잘린 스냅샷과 전문 조회의 짝이 다른
 * 도메인 명령들 사이에 끼어, 어느 것을 불러야 하는지 한눈에 보이지 않았다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  ScheduledRequest,
  ScheduledRequestInput,
  ScheduledRunCancellationReceipt,
  ScheduleRunDetail,
  SchedulerSnapshot,
} from "../types";
import { call } from "./ipcTransport";

/**
 * 주기 폴링용 스냅샷. 요청 프롬프트와 실행 요약은 미리보기로 잘려 있으므로
 * 전문이 필요하면 getScheduledRequestDetail·getScheduledRunDetail을 쓴다.
 */
export function getSchedulerSnapshot(): Promise<SchedulerSnapshot> {
  return call<SchedulerSnapshot>("get_scheduler_snapshot");
}

export function getScheduledRequestDetail(id: string): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("get_scheduled_request_detail", { id });
}

export function getScheduledRunDetail(id: string): Promise<ScheduleRunDetail> {
  return call<ScheduleRunDetail>("get_scheduled_run_detail", { id });
}

export function createScheduledRequest(input: ScheduledRequestInput): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("create_scheduled_request", { request: input });
}

export function updateScheduledRequest(id: string, input: ScheduledRequestInput): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("update_scheduled_request", { request: { id, input } });
}

export function deleteScheduledRequest(id: string): Promise<void> {
  return call<void>("delete_scheduled_request", { id });
}

export function setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("set_schedule_enabled", { request: { id, enabled } });
}

export function runScheduledRequestNow(id: string): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("run_scheduled_request_now", { id });
}

export function cancelScheduledRun(runId: string, reason?: string): Promise<ScheduledRunCancellationReceipt> {
  return call<ScheduledRunCancellationReceipt>("cancel_scheduled_run", { runId, reason });
}

export function setSchedulesPaused(paused: boolean): Promise<SchedulerSnapshot> {
  return call<SchedulerSnapshot>("set_schedules_paused", { paused });
}
