import assert from "node:assert/strict";
import test from "node:test";

import { roundDecisionQuestionParts, roundTextParagraphs } from "./roundText.ts";

test("stored line breaks become paragraphs and blank lines are dropped", () => {
  assert.deepEqual(roundTextParagraphs("[설계]\r\n• 원본: SKILL.md\n\n• 문진: 병렬 켬\n"), ["[설계]", "• 원본: SKILL.md", "• 문진: 병렬 켬"]);
  assert.deepEqual(roundTextParagraphs("  \n "), []);
});

test("a short single line stays one paragraph", () => {
  assert.deepEqual(roundTextParagraphs("짧은 요약이다. 둘째 문장."), ["짧은 요약이다. 둘째 문장."]);
});

test("a long line without breaks is grouped into sentence paragraphs under the limit", () => {
  const sentence = "가".repeat(40) + "다.";
  const text = Array.from({ length: 6 }, () => sentence).join(" ");
  const paragraphs = roundTextParagraphs(text, 100);
  assert.deepEqual(paragraphs, [`${sentence} ${sentence}`, `${sentence} ${sentence}`, `${sentence} ${sentence}`]);
  assert.equal(paragraphs.join(" "), text);
});

test("dots without a following space (versions, file names) do not split", () => {
  const text = `DSM 7.3.2와 external_processes.rs를 실측했다. ${"나".repeat(30)}.`;
  assert.deepEqual(roundTextParagraphs(text, 40), ["DSM 7.3.2와 external_processes.rs를 실측했다.", `${"나".repeat(30)}.`]);
});

test("one sentence longer than the limit becomes its own paragraph", () => {
  const long = "다".repeat(120) + ".";
  assert.deepEqual(roundTextParagraphs(`앞. ${long} 뒤.`, 50), ["앞.", long, "뒤."]);
});

test("a five-line decision question splits into lead, body and trailing evidence", () => {
  const question = "구현 회차가 사람 질문에 스스로 답했다.\n그대로 두면 배포도 혼자 정한다.\n바꾸면 사람 결정만 기다린다.\n추천: 바꾼다.\n근거: round-fd6de8c1 · 22:23Z";
  assert.deepEqual(roundDecisionQuestionParts(question), {
    lead: "구현 회차가 사람 질문에 스스로 답했다.",
    body: ["그대로 두면 배포도 혼자 정한다.", "바꾸면 사람 결정만 기다린다.", "추천: 바꾼다."],
    evidence: "근거: round-fd6de8c1 · 22:23Z",
  });
});

test("a question without an evidence line keeps every line as text", () => {
  assert.deepEqual(roundDecisionQuestionParts("무슨 일\r\n\n왜 지금\n"), { lead: "무슨 일", body: ["왜 지금"], evidence: null });
});

test("an older single-line question stays one lead line and is not split into sentences", () => {
  const old = "[결정 무단 응답:goal-f9ac] 회차가 답했다. 회차 둘도 시도했다.";
  assert.deepEqual(roundDecisionQuestionParts(old), { lead: old, body: [], evidence: null });
});

test("only a trailing evidence line is detached; one in the middle stays body", () => {
  assert.deepEqual(roundDecisionQuestionParts("무슨 일\n근거: 가운데\n추천"), { lead: "무슨 일", body: ["근거: 가운데", "추천"], evidence: null });
  assert.deepEqual(roundDecisionQuestionParts("근거: 한 줄뿐"), { lead: "근거: 한 줄뿐", body: [], evidence: null });
  assert.deepEqual(roundDecisionQuestionParts("  \n "), { lead: "", body: [], evidence: null });
  assert.deepEqual(roundDecisionQuestionParts("무슨 일\n근거： 전각 쌍점"), { lead: "무슨 일", body: [], evidence: "근거： 전각 쌍점" });
});
