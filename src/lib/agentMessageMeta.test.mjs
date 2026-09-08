import assert from "node:assert/strict";
import test from "node:test";

import { splitAgentMessageMeta } from "./agentMessageMeta.ts";

const CITATION = [
  "<oai-mem-citation>",
  "<citation_entries>",
  "MEMORY.md:189-197|note=[registry]",
  "</citation_entries>",
  "</oai-mem-citation>",
].join("\n");

test("Codex 메모리 인용 묶음은 본문에서 빠지고 메타로 남는다", () => {
  const parts = splitAgentMessageMeta(`검증을 마쳤습니다.\n\n${CITATION}\n`);
  assert.equal(parts.text, "검증을 마쳤습니다.");
  assert.equal(parts.meta.length, 1);
  assert.equal(parts.meta[0].label, "메모리 인용");
  assert.match(parts.meta[0].text, /MEMORY\.md:189-197/);
});

test("메타 블록이 없으면 원문을 그대로 돌려준다", () => {
  const source = "## 미검증 항목\n\n- 수동 확인은 하지 않았습니다.";
  const parts = splitAgentMessageMeta(source);
  assert.equal(parts.text, source);
  assert.deepEqual(parts.meta, []);
});

test("코드 펜스 안의 태그 예시는 건드리지 않는다", () => {
  const source = ["```xml", "<oai-mem-citation>", "</oai-mem-citation>", "```"].join("\n");
  const parts = splitAgentMessageMeta(source);
  assert.equal(parts.text, source);
  assert.deepEqual(parts.meta, []);
});

test("아직 닫히지 않은 블록도 흘러오는 동안 본문에 새지 않는다", () => {
  const parts = splitAgentMessageMeta("정리했습니다.\n\n<oai-mem-citation>\n<citation_entries>");
  assert.equal(parts.text, "정리했습니다.");
  assert.equal(parts.meta.length, 1);
  assert.equal(parts.meta[0].text, "<citation_entries>");
});
