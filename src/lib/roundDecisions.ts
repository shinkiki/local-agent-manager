/**
 * 회차 결정 방식(수동·추천적용·완전자동)에 따라 미결 결정 중 다음 회차가 맡는 것과 사람이 답할 것을 가른다.
 *
 * 백엔드 `round_decision_automation_brief`(rounds.rs)와 같은 기준이다: 추천적용은 사람 결정이 아니고
 * 추천안이 있는 결정만 회차가 답하고, 완전자동은 모두 회차가 답하며, 수동은 아무것도 맡기지 않는다.
 */
import type { RoundDecision, RoundDecisionMode, RoundGoal, RoundReport } from "../types";

/** 이 결정 방식에서 다음 회차가 추천안·분석으로 대신 답하는 결정인가. */
export function isRoundAnswerable(decision: RoundDecision, mode: RoundDecisionMode): boolean {
  if (decision.resolved) return false;
  switch (mode) {
    case "automatic": return true;
    case "recommended": return !decision.requiresHuman && Boolean(decision.recommendation?.trim());
    case "manual": return false;
  }
}

/** 사람이 답해야 남는 미결 결정 수. 카드의 "결정 대기" 배지가 이것을 센다. */
export function humanPendingDecisionCount(report: RoundReport, mode: RoundDecisionMode): number {
  return report.decisions.filter((decision) => !decision.resolved && !isRoundAnswerable(decision, mode)).length;
}

/** V4: 목표 카드의 배지에 쓸 사람 결정 수를 목표별로 합산한다. */
export function humanPendingDecisionCountsByGoal(
  reports: readonly RoundReport[],
  goals: readonly RoundGoal[],
): Record<string, number> {
  const goalModes = Object.fromEntries(goals.map((goal) => [goal.id, goal.decisionMode])) as Record<string, RoundDecisionMode>;
  const counts: Record<string, number> = {};
  for (const report of reports) {
    if (!report.goalId) continue;
    counts[report.goalId] = (counts[report.goalId] ?? 0) + humanPendingDecisionCount(report, goalModes[report.goalId] ?? "manual");
  }
  return counts;
}

/** 다음 회차가 먼저 처리할 미결 결정 수. */
export function roundAnswerableDecisionCount(report: RoundReport, mode: RoundDecisionMode): number {
  return report.decisions.filter((decision) => isRoundAnswerable(decision, mode)).length;
}
