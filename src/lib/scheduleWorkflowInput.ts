import type { ProviderId, ScheduledRequest, ScheduledRequestInput, SystemWorkflowSummary } from "../types";
import { buildWorkflowArguments, workflowInputEntries } from "./scheduleWorkflowInputs.ts";

/** 두 실행 대상이 함께 채우는 봉투 — 주기·권한·활성 창·활성화. */
export type ScheduleEnvelope = Pick<ScheduledRequestInput, "mode" | "approvalMode" | "recurrence" | "resumeFailurePolicy" | "enabled" | "activeFrom" | "activeUntil">;

/** 워크플로 반복 요청의 폼 값을 저장 입력으로 접는다. 입력 검증과 확인은 편집기가 맡는다. */
export function workflowScheduleInput(envelope: ScheduleEnvelope, draft: {
  name: string;
  source: ProviderId;
  workflow: SystemWorkflowSummary;
  schema: ReturnType<typeof workflowInputEntries>;
  inputs: Record<string, string>;
  saved: ScheduledRequest["workflow"] | null;
}): ScheduledRequestInput {
  return {
    ...envelope,
    name: draft.name.trim() || draft.workflow.displayName || draft.workflow.id,
    prompt: "",
    source: draft.source,
    accountId: "",
    useActiveAccount: false,
    cwd: "",
    model: null,
    reasoningEffort: null,
    sessionStrategy: "newChat",
    providerSessionId: null,
    sessionReference: null,
    // 지금 등록된 버전을 승인 버전으로 고정한다. 이후 워크플로가 바뀌면 백엔드가 그
    // 회차를 실행하지 않고 반복 요청을 멈춘다.
    // 병렬 실행 설정은 페이싱 탭의 회차 편집기가 소유한다. 여기서 다시 저장해도 지우지 않는다.
    workflow: {
      workflowId: draft.workflow.id,
      approvedVersion: draft.workflow.version ?? 0,
      arguments: buildWorkflowArguments(draft.schema, draft.inputs),
      pacing: draft.saved?.workflowId === draft.workflow.id ? draft.saved.pacing ?? null : null,
    },
  };
}

