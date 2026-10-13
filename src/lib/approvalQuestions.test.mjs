import assert from "node:assert/strict";
import test from "node:test";
import { recommendedPicks, splitRecommendedLabel } from "./approvalQuestions.ts";

test("라벨 꼬리의 추천 표시를 떼어 낸다", () => {
  assert.deepEqual(splitRecommendedLabel("동시 3건 (추천)"), { display: "동시 3건", recommended: true });
  assert.deepEqual(splitRecommendedLabel("Commit only (Recommended)"), { display: "Commit only", recommended: true });
  assert.deepEqual(splitRecommendedLabel("끔(권장)"), { display: "끔", recommended: true });
  assert.deepEqual(splitRecommendedLabel("켬 （추천）"), { display: "켬", recommended: true });
});

test("꼬리가 아닌 자리의 추천이나 꼬리만 있는 라벨은 그대로 둔다", () => {
  assert.deepEqual(splitRecommendedLabel("(추천) 동시 3건"), { display: "(추천) 동시 3건", recommended: false });
  assert.deepEqual(splitRecommendedLabel("추천값으로 진행"), { display: "추천값으로 진행", recommended: false });
  assert.deepEqual(splitRecommendedLabel("(추천)"), { display: "(추천)", recommended: false });
});

const option = (label) => ({ label, description: "" });

test("추천 선택지를 미리 골라 두되, 하나만 고르는 질문에 추천이 여럿이면 비운다", () => {
  const picks = recommendedPicks([
    { question: "병렬", header: "", multiSelect: false, options: [option("3건 (추천)"), option("1건")] },
    { question: "관문", header: "", multiSelect: true, options: [option("코드리뷰 (추천)"), option("보안 (추천)"), option("없음")] },
    { question: "반영", header: "", multiSelect: false, options: [option("커밋만"), option("푸시")] },
    { question: "모호", header: "", multiSelect: false, options: [option("가 (추천)"), option("나 (추천)")] },
  ]);
  assert.deepEqual(picks, { 병렬: ["3건 (추천)"], 관문: ["코드리뷰 (추천)", "보안 (추천)"] });
});
