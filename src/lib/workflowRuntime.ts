import type { SystemWorkflowContract, WorkflowChatRuntime } from "../types.ts";

export const UNATTENDED_WORKFLOW_RUNTIME: WorkflowChatRuntime = {
  mode: "fullAccess", approvalMode: "never", decisionPolicy: "recommended",
};

export function workflowRuntimeDraft(contract: SystemWorkflowContract): WorkflowChatRuntime {
  return { ...contract.chatRuntime };
}

/** 상속을 뜻하는 빈 값을 걷어 저장 계약에 남길 실행설정만 만든다. */
function persistedWorkflowRuntime(runtime: WorkflowChatRuntime): WorkflowChatRuntime | undefined {
  const persisted = Object.fromEntries(Object.entries(runtime).filter(([, value]) => value != null));
  return Object.keys(persisted).length ? persisted : undefined;
}

/** 다음 버전을 지정해 편집 도중 다른 사람이 저장한 계약을 덮어쓰지 않는다. */
export function workflowRuntimeContract(contract: SystemWorkflowContract, runtime: WorkflowChatRuntime): SystemWorkflowContract {
  return {
    ...contract,
    version: (contract.version ?? 0) + 1,
    chatRuntime: persistedWorkflowRuntime(runtime),
  };
}
