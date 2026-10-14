import assert from "node:assert/strict";
import test from "node:test";

import { roundTextParagraphs } from "./roundText.ts";

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
