import assert from "node:assert/strict";
import test from "node:test";
import { joinMarkdownBlocks, markdownSectionAtLine } from "./copyPayload.ts";

test("a markdown section includes nested headings and stops at the next peer", () => {
  const source = [
    "# 문서",
    "## 계획",
    "본문",
    "### 검증",
    "결과",
    "## 다음 작업",
    "후속",
  ].join("\n");

  assert.equal(markdownSectionAtLine(source, 1), "## 계획\n본문\n### 검증\n결과");
});

test("headings inside fenced code do not end a markdown section", () => {
  const source = "## 결과\r\n```md\r\n## 코드 제목\r\n```\r\n설명\r\n## 종료";
  assert.equal(markdownSectionAtLine(source, 0), "## 결과\n```md\n## 코드 제목\n```\n설명");
});

test("conversation text blocks are normalized and joined as markdown", () => {
  assert.equal(joinMarkdownBlocks([" 첫 번째\r\n줄 ", "", "두 번째"]), "첫 번째\n줄\n\n두 번째");
});
