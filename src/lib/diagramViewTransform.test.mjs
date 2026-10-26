import assert from "node:assert/strict";
import test from "node:test";
import {
  clampScale,
  fitScaleFor,
  IDENTITY,
  MAX_SCALE,
  MIN_SCALE,
  scaledAround,
  wheelZoomFactor,
} from "./diagramViewTransform.ts";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

test("배율은 버튼·휠·핀치 어느 길로 와도 같은 범위로 잘린다", () => {
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(100), MAX_SCALE);
  assert.equal(clampScale(1.5), 1.5);
  assert.equal(scaledAround(IDENTITY, 100, { x: 0, y: 0 }).scale, MAX_SCALE);
  assert.equal(scaledAround(IDENTITY, 0.001, { x: 0, y: 0 }).scale, MIN_SCALE);
});

test("맞춤 배율은 그림을 줄이기만 하고, 잴 수 없으면 1이다", () => {
  assert.equal(fitScaleFor(200, 100, 800, 600), 1);
  close(fitScaleFor(1600, 300, 800, 600), 0.5);
  close(fitScaleFor(400, 2400, 800, 600), 0.25);
  assert.equal(fitScaleFor(100_000, 100, 800, 600), MIN_SCALE);
  assert.equal(fitScaleFor(0, 100, 800, 600), 1);
  assert.equal(fitScaleFor(100, 100, 0, 600), 1);
  assert.equal(fitScaleFor(100, 100, 800, -16), 1);
});

test("확대해도 기준점 아래의 그림 지점은 제자리에 머문다", () => {
  const view = { scale: 2, x: 30, y: -10 };
  const anchor = { x: 50, y: 40 };
  const next = scaledAround(view, 3, anchor);
  assert.equal(next.scale, 3);
  // 기준점 아래의 그림 좌표 (anchor - 이동) / 배율 가 확대 전후로 같아야 한다.
  close((anchor.x - next.x) / next.scale, (anchor.x - view.x) / view.scale);
  close((anchor.y - next.y) / next.scale, (anchor.y - view.y) / view.scale);
});

test("핀치는 시작 중점 아래의 지점을 지금 중점으로 옮긴다", () => {
  const view = { scale: 1, x: 0, y: 0 };
  const next = scaledAround(view, 2, { x: 10, y: 10 }, { x: 40, y: -20 });
  close(next.x, 40 - 10 * 2);
  close(next.y, -20 - 10 * 2);
});

test("바뀐 것이 없으면 같은 객체를 돌려준다", () => {
  const view = { scale: MAX_SCALE, x: 5, y: 5 };
  assert.equal(scaledAround(view, MAX_SCALE * 2, { x: 1, y: 2 }), view);
  assert.notEqual(scaledAround(view, MAX_SCALE, { x: 1, y: 2 }, { x: 3, y: 2 }), view);
});

test("줄 단위 휠은 픽셀로 환산돼 같은 거리의 트랙패드와 같은 만큼 확대한다", () => {
  close(wheelZoomFactor(3, 1), wheelZoomFactor(48, 0));
  close(wheelZoomFactor(400, 0), Math.exp(-1));
  assert.ok(wheelZoomFactor(-100, 0) > 1);
  assert.ok(wheelZoomFactor(100, 0) < 1);
  close(wheelZoomFactor(100, 0) * wheelZoomFactor(-100, 0), 1);
});
