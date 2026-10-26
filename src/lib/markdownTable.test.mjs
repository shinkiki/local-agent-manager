import assert from "node:assert/strict";
import test from "node:test";
import { markdownTableAlignment, splitMarkdownTableRow, startsMarkdownTable } from "./markdownTable.ts";

test("머리 줄과 정렬 줄의 칸 수가 같을 때만 표가 시작한다", () => {
  assert.equal(startsMarkdownTable(["| a | b |", "| --- | :---: |"], 0), true);
  assert.equal(startsMarkdownTable(["a | b", "---|---"], 0), true);
  // 파이프가 든 문장 뒤의 구분선은 표가 아니다 — 문장과 구분선으로 남아야 한다.
  assert.equal(startsMarkdownTable(["ls | grep x 로 거른다", "---"], 0), false);
  assert.equal(startsMarkdownTable(["| a | b |", "| --- |"], 0), false);
  assert.equal(startsMarkdownTable(["a | b"], 0), false);
  assert.equal(startsMarkdownTable(["a b", "---"], 0), false);
  assert.equal(startsMarkdownTable(["a | b", "---|---|---"], 0), false);
  assert.equal(startsMarkdownTable(["| a | b", "---|---|"], 0), true);
  assert.equal(startsMarkdownTable(["| a |", "|---|"], 0), true);
  // 이스케이프한 파이프는 칸 경계가 아니다.
  assert.equal(startsMarkdownTable(["| a \\| b | c |", "|---|---|"], 0), true);
});

test("칸 나누기와 정렬", () => {
  assert.deepEqual(splitMarkdownTableRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitMarkdownTableRow("| a \\| b | c \\|"), ["a \\| b", "c \\|"]);
  assert.equal(markdownTableAlignment("---"), "left");
  assert.equal(markdownTableAlignment(":---:"), "center");
  assert.equal(markdownTableAlignment("---:"), "right");
  assert.equal(markdownTableAlignment(":---"), "left");
});
