import type { ScheduleWorkflowBinding, SystemWorkflowSummary } from "../types";
import { joinSummary } from "./sequence.ts";
import { missingRequiredInputNames, workflowInputEntries } from "./scheduleWorkflowInputs.ts";

import { runtimeText } from "./i18nRuntime.ts";
/**
 * 예약에 묶인 워크플로를 다루는 규칙 — 지금 그대로 실행할 수 있는지, 그리고 카드 한 줄에
 * 어떻게 적는지.
 *
 * 계약이 선언한 입력 자체를 다루는 규칙(모델 입력 어휘·선택지, 폼 문자열과 인자 사이의
 * 왕복, 필수 입력 찾기)은 `scheduleWorkflowInputs.ts`가 맡는다. 화면 네 곳이 두 무리를
 * 섞어 이 이름으로 가져다 쓰고 있으므로, 입력 쪽 API는 여기서 다시 내보낸다 — 다만
 * 그 화면들이 실제로 이 이름으로 가져다 쓰는 것만 내보낸다. 창구에 이름을 더 열어 두면
 * 같은 규칙을 두 경로로 가져올 수 있게 되어, 나중에 입력 쪽으로 옮겨야 할 코드가
 * 어느 파일의 계약인지 import 문만 보고는 갈리지 않는다.
 */

export {
  buildWorkflowArguments,
  validateWorkflowModelInputs,
  workflowInputDefaults,
  workflowInputEntries,
  workflowInputsFromArguments,
  workflowModelInputChoices,
  workflowModelInputIsMultiple,
} from "./scheduleWorkflowInputs.ts";

/** 워크플로 등록 승인 버전과 카탈로그 호환성에 문제가 있는지 판정한다. */
function validateWorkflowEligibility(workflow: SystemWorkflowSummary): string[] {
  const problems: string[] = [];
  if (typeof workflow.version !== "number" || workflow.version <= 0) {
    problems.push("워크플로 승인 버전을 확인할 수 없습니다.");
  }
  if (!workflow.compatible) {
    problems.push("현재 카탈로그와 호환되지 않는 워크플로입니다. AIA가 다시 등록해야 합니다.");
  }
  return problems;
}

/**
 * 저장 전에 화면에서 막을 수 있는 문제를 모은다. 승인 버전과 카탈로그 호환성은 백엔드가
 * 다시 확인하지만, 저장 버튼을 누르고 나서야 알려 주면 사용자가 무엇을 고쳐야 하는지
 * 알기 어렵다.
 */
export function validateScheduleWorkflowDraft(draft: {
  workflow: SystemWorkflowSummary | null | undefined;
  inputs: Record<string, string>;
}): string[] {
  const workflow = draft.workflow;
  if (!workflow) return ["실행할 워크플로를 선택하세요."];

  const problems = validateWorkflowEligibility(workflow);
  const missing = missingRequiredInputNames(workflowInputEntries(workflow), draft.inputs);
  if (missing.length > 0) problems.push(`필수 입력이 비어 있습니다: ${missing.join(", ")}`);
  return problems;
}

/**
 * 카드 한 줄에 넣을 워크플로 표기. 등록 버전이 승인 버전과 달라지면 다음 회차가 실행되지
 * 않고 멈추므로, 목록에서 바로 재승인이 필요한 것을 알 수 있게 함께 적는다.
 */
export function describeScheduleWorkflow(
  binding: ScheduleWorkflowBinding,
  workflows: SystemWorkflowSummary[],
): string {
  const known = workflows.find((workflow) => workflow.id === binding.workflowId);
  const name = known?.displayName ?? binding.workflowId;
  const head = runtimeText(`워크플로 ${name} v${binding.approvedVersion}`, `Workflow ${name} v${binding.approvedVersion}`);
  return joinSummary([head, scheduleWorkflowBlocker(binding, known)]);
}

/**
 * 등록된 워크플로가 이 묶음을 지금 그대로 실행하지 못하게 막는 사유. 막을 것이 없으면
 * null이다. 표기 앞머리와 함께 적혀 있던 때에는 사유를 하나 늘릴 때마다 같은 앞머리를
 * 한 번 더 적어야 했고, 그중 하나만 다르게 적혀도 카드마다 표기가 어긋났다.
 */
function scheduleWorkflowBlocker(
  binding: ScheduleWorkflowBinding,
  known: SystemWorkflowSummary | undefined,
): string | null {
  if (!known) return runtimeText("목록에 없음", "Not in list");
  if (known.version !== binding.approvedVersion) return runtimeText(`재승인 필요(현재 v${known.version ?? "?"})`, `Needs re-approval (now v${known.version ?? "?"})`);
  if (!known.compatible) return runtimeText("카탈로그 비호환", "Incompatible with catalog");
  return null;
}
