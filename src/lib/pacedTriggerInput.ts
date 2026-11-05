import type { ScheduleFrequency, ScheduledRequest, ScheduledRequestInput, SystemWorkflowSummary } from "../types";
import { clampScheduleNumber, INTERVAL_HOURS, RUN_HOUR, RUN_MINUTE } from "./scheduleNumber.ts";
import { buildWorkflowArguments, workflowInputEntries } from "./scheduleWorkflowInputs.ts";

/*
 * 페이싱 회차 편집기(`PacedTriggerEditor`)가 저장할 입력 한 벌을 조립하는 순수 규칙.
 * 컴포넌트 안에 있어 시험이 닿지 않았는데, 활성 창·공급자·권한 같은 저장본 값을 다시 저장할 때
 * 지우지 않는 규칙이 여기 모여 있다 — 한 줄이 빠지면 반복 요청 편집기에서 정한 값이 조용히 사라진다.
 */

/**
 * 간격·시·분은 문자열 초안이다. 숫자로 들고 있으면 칸을 비우는 순간 0이 끼어들고, 범위 밖
 * 시각이 그대로 저장으로 간다. 칸을 떠날 때와 저장할 때만 `clampScheduleNumber`로 자른다.
 */
export interface PacedRecurrenceDraft {
  frequency: ScheduleFrequency;
  interval: string;
  hour: string;
  minute: string;
  weekday: number;
  cron: string;
}

/**
 * 페이싱 회차에 맞는 반복 주기 입력을 정규화해 조립한다.
 * 칸을 비웠거나 범위를 벗어났어도, 자동 주기처럼 간격을 쓰지 않는 상태여도 저장이 막히지 않게 유효 범위로 눌러 보낸다.
 */
export function buildPacedRecurrence({
  frequency,
  interval,
  hour,
  minute,
  weekday,
  cron,
  timezone,
}: PacedRecurrenceDraft & { timezone: string }) {
  return {
    frequency,
    interval: clampScheduleNumber(interval, INTERVAL_HOURS),
    hour: clampScheduleNumber(hour, RUN_HOUR),
    minute: clampScheduleNumber(minute, RUN_MINUTE),
    weekday,
    cron: frequency === "cron" ? cron : null,
    timezone,
  };
}

/**
 * 편집기 상태와 기존 회차에서 저장 커맨드의 입력 한 벌을 조립한다. 생성·수정 갈래가 공유하는
 * 기본값 보존 규칙을 제출 절차에서 떼어, 검증과 IPC 호출 사이에는 조립 결과만 남긴다.
 */
export function buildPacedTriggerInput({
  selected,
  schedule,
  name,
  inputs,
  paced,
  maxRuns,
  recurrence,
  enabled,
}: {
  selected: SystemWorkflowSummary;
  schedule?: ScheduledRequest;
  name: string;
  inputs: Record<string, string>;
  paced: boolean;
  maxRuns: number;
  recurrence: ReturnType<typeof buildPacedRecurrence>;
  enabled: boolean;
}): ScheduledRequestInput {
  return {
    name: name.trim() || selected.displayName || selected.id,
    prompt: "",
    source: schedule?.source ?? "claude",
    accountId: "",
    useActiveAccount: false,
    cwd: "",
    model: null,
    reasoningEffort: null,
    mode: schedule?.mode ?? "workspace",
    approvalMode: schedule?.approvalMode ?? "never",
    recurrence,
    sessionStrategy: "newChat",
    resumeFailurePolicy: schedule?.resumeFailurePolicy ?? "retryThenNewChat",
    providerSessionId: null,
    enabled,
    sessionReference: null,
    workflow: {
      workflowId: selected.id,
      approvedVersion: selected.version ?? 0,
      arguments: buildWorkflowArguments(workflowInputEntries(selected), inputs),
      pacing: paced ? { maxRuns } : null,
    },
    // 활성 창은 이 편집기에 없다. 반복 요청 편집기에서 정한 창을 다시 저장하며
    // 지우지 않도록 저장본 값을 그대로 돌려보낸다.
    activeFrom: schedule?.activeFrom ?? null,
    activeUntil: schedule?.activeUntil ?? null,
  };
}
