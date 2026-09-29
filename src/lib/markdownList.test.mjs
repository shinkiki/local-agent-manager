import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownList } from "./markdownList.ts";

/** 구조만 비교하기 위해 본문과 번호만 남긴다. */
const shape = (list) => ({
  kind: list.kind,
  start: list.start,
  items: list.items.map((item) => ({ body: item.body, children: item.children.map(shape) })),
});

const parse = (text) => {
  const parsed = parseMarkdownList(text.split("\n"), 0);
  return parsed ? { lists: parsed.lists.map(shape), next: parsed.next } : null;
};

test("목록이 아닌 줄에서는 null", () => {
  assert.equal(parseMarkdownList(["문단"], 0), null);
  assert.equal(parseMarkdownList(["1.붙어있음"], 0), null);
});

test("같은 단계의 항목은 한 목록으로 묶인다", () => {
  const parsed = parse("1. 첫째\n2. 둘째\n3. 셋째");
  assert.equal(parsed.next, 3);
  assert.equal(parsed.lists.length, 1);
  assert.equal(parsed.lists[0].kind, "ordered");
  assert.deepEqual(parsed.lists[0].items.map((item) => item.body), ["첫째", "둘째", "셋째"]);
});

// 덩어리가 갈려도 번호가 이어지려면 첫 항목의 번호가 남아 있어야 한다.
test("순서 있는 목록은 원문의 첫 번호를 들고 있다", () => {
  assert.equal(parse("1. 첫째").lists[0].start, 1);
  assert.equal(parse("2. 둘째").lists[0].start, 2);
  assert.equal(parse("- 항목").lists[0].start, null);
});

// 전에는 들여쓴 하위 항목이 형제로 납작해져 상위 목록이 1·2·3으로 이어 세어졌다.
test("더 깊이 들여쓴 항목은 하위 목록이 된다", () => {
  const parsed = parse("1. 첫째\n   1. 하위 가\n   2. 하위 나\n2. 둘째");
  assert.equal(parsed.next, 4);
  assert.equal(parsed.lists.length, 1);
  const top = parsed.lists[0];
  assert.deepEqual(top.items.map((item) => item.body), ["첫째", "둘째"]);
  assert.equal(top.items[0].children.length, 1);
  assert.deepEqual(top.items[0].children[0].items.map((item) => item.body), ["하위 가", "하위 나"]);
  assert.equal(top.items[1].children.length, 0);
});

test("하위 목록의 갈래는 제 줄에서 정해진다", () => {
  const top = parse("- 항목\n  1. 하위").lists[0];
  assert.equal(top.kind, "unordered");
  assert.equal(top.items[0].children[0].kind, "ordered");
  assert.equal(top.items[0].children[0].start, 1);
});

test("세 단계까지 겹친다", () => {
  const top = parse("- 하나\n  - 둘\n    - 셋\n- 넷").lists[0];
  assert.equal(top.items.length, 2);
  assert.equal(top.items[0].children[0].items[0].body, "둘");
  assert.equal(top.items[0].children[0].items[0].children[0].items[0].body, "셋");
});

test("같은 단계에서 갈래가 바뀌면 목록이 끝난다", () => {
  const parsed = parse("- 항목\n1. 다른 갈래");
  assert.equal(parsed.next, 1);
  assert.equal(parsed.lists.length, 1);
  assert.equal(parsed.lists[0].items.length, 1);
});

test("목록이 아닌 줄에서 멈춘다", () => {
  const parsed = parse("- 항목\n\n문단");
  assert.equal(parsed.next, 1);
});

// 읽어들인 목록 줄이 어느 항목에도 끼지 못하면 그 줄이 화면에서 조용히 사라진다.
test("들여쓰기가 거꾸로 가도 모든 줄이 어딘가에 들어간다", () => {
  const parsed = parse("  1. 들여쓴 첫 줄\n2. 되돌아온 줄");
  assert.equal(parsed.next, 2);
  const bodies = parsed.lists.flatMap((list) => list.items.map((item) => item.body));
  assert.deepEqual(bodies, ["들여쓴 첫 줄", "되돌아온 줄"]);
});

test("탭 들여쓰기도 하위 목록으로 본다", () => {
  const top = parse("- 하나\n\t- 둘").lists[0];
  assert.equal(top.items.length, 1);
  assert.equal(top.items[0].children[0].items[0].body, "둘");
});

test("마커만 도착한 줄도 빈 항목으로 소비한다", () => {
  const parsed = parse("1. 첫째\n2. ");
  assert.equal(parsed.next, 2);
  assert.deepEqual(parsed.lists[0].items.map((item) => item.body), ["첫째", ""]);
});
