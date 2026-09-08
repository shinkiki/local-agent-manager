import assert from "node:assert/strict";
import test from "node:test";
import { keyboardInset } from "./keyboardInset.ts";

const metrics = (visualHeight, extra = {}) => ({ layoutHeight: 900, visualHeight, offsetTop: 0, ...extra });

test("키보드가 없으면 0을 돌려준다", () => {
  assert.equal(keyboardInset(metrics(900)), 0);
});

test("주소창·툴바만큼의 차이는 키보드로 보지 않는다", () => {
  assert.equal(keyboardInset(metrics(830)), 0);
});

test("키보드가 덮은 높이를 그대로 돌려준다", () => {
  assert.equal(keyboardInset(metrics(560)), 340);
});

test("보이는 영역이 위로 밀려난 만큼은 가린 높이에서 뺀다", () => {
  assert.equal(keyboardInset(metrics(560, { offsetTop: 40 })), 300);
});

test("손가락 확대로 좁아진 것은 키보드가 아니다", () => {
  assert.equal(keyboardInset(metrics(400, { scale: 2.5 })), 0);
});

test("잰 값이 화면보다 커도 화면 높이를 넘지 않는다", () => {
  assert.equal(keyboardInset({ layoutHeight: 900, visualHeight: 0, offsetTop: -400 }), 900);
});

test("임계값은 바꿔 잴 수 있다", () => {
  assert.equal(keyboardInset(metrics(830), { minimum: 40 }), 70);
});
