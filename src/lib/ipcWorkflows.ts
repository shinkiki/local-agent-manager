/**
 * 시스템 워크플로(목록·상세·등록·삭제·페이싱·실행) 명령 묶음.
 *
 * `ipc.ts` 끝자락에 붙어 있던 여덟 개다. 워크플로 화면과 페이싱 탭이 함께 쓰는 한
 * 덩어리인데, 바로 앞이 Antigravity 사용량이라 목록에서 경계가 보이지 않았다.
 * 다른 `ipc*` 모듈과 같은 규칙으로 따로 낸다.
 *
 * 계약 타입(`SystemWorkflowContract`·`SystemWorkflowProposal`)은 `ipc.ts`에서 인라인
 * `import("../types")`로 쓰이고 있었다. 모듈을 가르면서 파일 머리의 타입 import로
 * 올려 나머지와 같은 모양으로 맞춘다.
 */
import type {
  SetSystemWorkflowPacingRequest,
  SystemWorkflowContract,
  SystemWorkflowDetail,
  SystemWorkflowExecution,
  SystemWorkflowList,
  SystemWorkflowProposal,
} from "../types";
import { call } from "./ipcTransport";

export function getSystemWorkflows(): Promise<SystemWorkflowList> {
  return call<SystemWorkflowList>("get_system_workflows");
}

export function getSystemWorkflow(workflowId: string): Promise<SystemWorkflowDetail> {
  return call<SystemWorkflowDetail>("get_system_workflow", { workflowId });
}

export function proposeSystemWorkflow(request: SystemWorkflowContract): Promise<SystemWorkflowProposal> {
  return call("propose_system_workflow_schema", { request });
}

/**
 * 등록 결과의 `rounds`는 이 워크플로를 도는 페이싱 회차가 새 버전을 이어받았는지다.
 * 승인 버전은 백엔드가 등록과 함께 올리므로(회차마다 다시 승인하지 않는다), 화면은 무엇이
 * 함께 바뀌었는지 사용자에게 말해 주기 위해 읽는다 — 자동 적용을 조용히 하면 회차 설정이
 * 언제 바뀌었는지 알 길이 없다.
 */
export interface RegisteredWorkflowRound {
  scheduleId: string;
  name: string;
  adopted: boolean;
  resumed: boolean;
  /** 올리지 못한 사유. 저장된 인자가 새 입력 스키마를 못 채우는 경우뿐이다. */
  reason?: string;
}

export function registerSystemWorkflow(request: SystemWorkflowContract): Promise<{
  registered: boolean;
  workflowId: string;
  version: number;
  rounds?: RegisteredWorkflowRound[];
}> {
  return call("register_system_workflow", { request });
}

export function deleteSystemWorkflow(workflowId: string): Promise<unknown> {
  return call<unknown>("delete_system_workflow", { workflowId });
}

/**
 * 워크플로 하나를 사용량 페이싱 대상으로 켜거나 끈다. 갱신된 목록을 그대로 돌려주므로
 * 화면은 한 번의 왕복으로 토글과 배지를 다시 그린다.
 */
export function setSystemWorkflowPacing(request: SetSystemWorkflowPacingRequest): Promise<SystemWorkflowList> {
  return call<SystemWorkflowList>("set_system_workflow_pacing", { request });
}

/**
 * 워크플로를 실행한다. `idempotencyKey`는 같은 실행을 두 번 보내지 않기 위한 것이라
 * 재시도할 때도 같은 값을 유지해야 한다. `expectedVersion`을 주면 그 버전만 실행한다.
 */
export function executeSystemWorkflow(
  workflowId: string,
  idempotencyKey: string,
  args: Record<string, unknown> = {},
  expectedVersion?: number,
): Promise<SystemWorkflowExecution> {
  return call<SystemWorkflowExecution>("execute_system_workflow", {
    workflowId,
    arguments: args,
    idempotencyKey,
    expectedVersion: expectedVersion ?? null,
  });
}
