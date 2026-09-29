import assert from "node:assert/strict";
import test from "node:test";

import { eachProseSegment, mapProseSegments } from "./markdownProse.ts";

/**
 * 조각 경계 규칙은 지금까지 링크 수집 사례(`markdownLinkCases.json`)로만 간접 확인됐다.
 * 스캐너를 가른 뒤에는 "이어 붙이면 원문"과 "산문만 골라 준다"는 두 불변식을 직접 짚는다 —
 * 링크 표기가 바뀌어도 이 시험은 그대로 남아야 할 사실이다.
 */

const mark = (source) => mapProseSegments(source, (segment) => `[${segment}]`);

test("바꾸지 않는 변환은 줄바꿈만 정규화한 원문을 돌려준다", () => {
  const source = "첫 줄\r\n```ts\r코드 `x`\n```\n`인라인` 뒤";
  assert.equal(mapProseSegments(source, (segment) => segment), source.replace(/\r\n?/g, "\n"));
});

test("코드 펜스 안쪽과 인라인 코드는 변환에서 빠진다", () => {
  assert.equal(mark("앞 `코드` 뒤"), "[앞 ]`코드`[ 뒤]");
  assert.equal(mark("```\n안쪽\n```\n밖"), "```\n안쪽\n```\n[밖]");
});

test("산문 조각만 나온 순서대로 넘긴다", () => {
  const seen = [];
  eachProseSegment("문단\n```\n펜스 안\n```\n`코드` 끝", (segment) => seen.push(segment));
  assert.deepEqual(seen.filter((segment) => segment.length > 0), ["문단", " 끝"]);
});
