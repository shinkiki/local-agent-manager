import type { RoundGoal } from "../types";

/**
 * 목표 하나를 AIA 에게 설계시키는 요청문(M10). 순수 함수라 시험으로 고정한다.
 *
 * 무엇을 만들지는 round-designer 스킬이 정한다. 여기서는 목표의 사실(제목·목표·대상·검증·주기·id)과
 * 끝낼 때 해야 할 일(등록 뒤 update_round_goal 로 상태·id 연결)만 적는다. 등록은 승인 카드로
 * 사람이 확인한다 — 요청문이 그것을 건너뛰라고 말하지 않는다.
 */
export function roundDesignPrompt(goal: RoundGoal): string {
  const lines = [
    `round-designer 스킬을 따라 회차 목표를 설계해줘. 목표 id: ${goal.id}`,
    `- 이름: ${goal.title}`,
    `- 목표: ${goal.goal}`,
    `- 대상 경로: ${goal.targetPath}`,
    `- 검증 방식: ${goal.verification.trim() || "(설계가 정한다 — 기준선을 먼저 재고 실패 종류로 판정)"}`,
    `- 주기: ${goal.cadence.trim() || "(설계가 정한다)"}`,
    "",
    "만든 스킬·스크립트·시험·워크플로 계약·반복 요청은 각각 승인 카드로 등록하고, 등록이 끝나면 update_round_goal 로 목표 상태를 active 로 옮기며 skillKey·workflowId·scheduleId 와 설계 메모(notes)를 적어라.",
    "회차가 끝날 때마다 record_round_report 로 구조화된 보고(측정표·실패 종류 전후·커밋·되돌린 것·사람이 정할 것)를 남기도록 스킬에 적어라.",
  ];
  return lines.join("\n");
}
