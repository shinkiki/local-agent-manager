/**
 * 되묻기 카드의 "추천" 표시. Claude `AskUserQuestion`에는 추천을 담을 칸이 없고, 모델은
 * 관례대로 라벨 끝에 `(Recommended)`를 붙인다. 회차 문진 스킬은 같은 자리에 `(추천)`을
 * 붙이게 한다. 그래서 라벨 꼬리만 보고 알아보고, 화면에는 꼬리를 뗀 라벨과 배지를 그린다.
 *
 * 돌려보내는 답은 원래 라벨 그대로다 — 모델은 자기가 보낸 라벨과 맞춰 답을 읽는다.
 */
import type { ChatApprovalQuestion } from "../types";

const RECOMMENDED_SUFFIX = /\s*[(（]\s*(?:추천|권장|recommended)\s*[)）]\s*$/i;

/** 라벨을 화면에 그릴 글자와 추천 여부로 나눈다. 꼬리만 남는 라벨은 그대로 둔다. */
export function splitRecommendedLabel(label: string): { display: string; recommended: boolean } {
  const display = label.replace(RECOMMENDED_SUFFIX, "");
  if (display === label || display.trim().length === 0) return { display: label, recommended: false };
  return { display: display.trimEnd(), recommended: true };
}

/**
 * 카드가 처음 열릴 때 미리 골라 둘 답. 추천 선택지가 있는 질문만 담는다. 하나만 고르는
 * 질문에서 추천이 여럿이면 어느 것도 고르지 않는다 — 모델이 추천을 정하지 못한 것이다.
 */
export function recommendedPicks(questions: ChatApprovalQuestion[]): Record<string, string[]> {
  const picks: Record<string, string[]> = {};
  for (const question of questions) {
    const labels = question.options
      .map((option) => option.label)
      .filter((label) => splitRecommendedLabel(label).recommended);
    if (labels.length === 0) continue;
    if (!question.multiSelect && labels.length > 1) continue;
    picks[question.question] = labels;
  }
  return picks;
}
