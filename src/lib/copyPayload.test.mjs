import assert from "node:assert/strict";
import test from "node:test";
import { joinMarkdownBlocks, markdownSectionFromLines } from "./copyPayload.ts";

test("a markdown section includes nested headings and stops at the next peer", () => {
  const lines = [
    "# 문서",
    "## 계획",
    "본문",
    "### 검증",
    "결과",
    "## 다음 작업",
    "후속",
  ];

  assert.equal(markdownSectionFromLines(lines, 1), "## 계획\n본문\n### 검증\n결과");
});

test("headings inside fenced code do not end a markdown section", () => {
  const lines = ["## 결과", "```md", "## 코드 제목", "```", "설명", "## 종료"];
  assert.equal(markdownSectionFromLines(lines, 0), "## 결과\n```md\n## 코드 제목\n```\n설명");
});

test("conversation text blocks are normalized and joined as markdown", () => {
  assert.equal(joinMarkdownBlocks([" 첫 번째\r\n줄 ", "", "두 번째"]), "첫 번째\n줄\n\n두 번째");
});

test("a markdown section extends to the end of document when no following peer heading exists", () => {
  const lines = ["## 마지막 섹션", "본문 1", "### 세부", "본문 2"];
  assert.equal(markdownSectionFromLines(lines, 0), "## 마지막 섹션\n본문 1\n### 세부\n본문 2");
});

test("returns empty string when headingLine is not a valid heading", () => {
  const lines = ["일반 본문", "## 제목"];
  assert.equal(markdownSectionFromLines(lines, 0), "");
});
