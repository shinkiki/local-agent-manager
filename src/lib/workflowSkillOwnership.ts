import type { SystemWorkflowSummary } from "../types";

/**
 * 이 워크플로와 함께 지울 수 있는 절차 스킬. 계약이 선언한 보관 스킬 가운데 셋을 뺀다 —
 * 이 장치에 없는 것(`missingSkills`: 계약만 오고 절차는 오지 않은 상태라 지울 것이 없다),
 * 다른 등록 워크플로가 같이 거는 것(그쪽 절차가 끊긴다), 중복이다. 남은 것(`exclusive`)만
 * 확인 대화가 선택지로 내고, 다른 워크플로가 쓰는 것은 "남긴다"고 말하기 위해 따로 담는다.
 */
export function relatedSkillKeys(
  workflow: SystemWorkflowSummary,
  workflows: readonly SystemWorkflowSummary[],
): { exclusive: string[]; shared: string[] } {
  const present = Array.from(new Set(workflow.requiredSkills ?? []))
    .filter((key) => !(workflow.missingSkills ?? []).includes(key));
  const elsewhere = new Set(
    workflows
      .filter((other) => other.id !== workflow.id)
      .flatMap((other) => other.requiredSkills ?? []),
  );
  return {
    exclusive: present.filter((key) => !elsewhere.has(key)),
    shared: present.filter((key) => elsewhere.has(key)),
  };
}
