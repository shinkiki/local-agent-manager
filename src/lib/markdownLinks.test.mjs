import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { localDocumentLinks } from "./markdownLinks.ts";

// 지침 보관은 백엔드가 같은 규칙으로 연결 문서를 모아야 화면 트리와 보관 세트가
// 어긋나지 않는다. 사례는 Rust `instruction_links`와 같은 파일을 읽어 검증한다.
const cases = JSON.parse(readFileSync(new URL("./markdownLinkCases.json", import.meta.url), "utf8"));

for (const item of cases) {
  test(`연결 문서 수집: ${item.name}`, () => {
    assert.deepEqual(localDocumentLinks(item.source), item.links);
  });
}
