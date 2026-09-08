import assert from "node:assert/strict";
import test from "node:test";
import { anchoredPopoverPlacement, samePopoverPlacement } from "./popoverPlacement.ts";

const anchor = (top, left, width, height = 48) => ({ top, bottom: top + height, left, right: left + width, width });

test("공간이 넉넉하면 트리거 아래에 오른쪽 끝을 맞춰 놓는다", () => {
  const placement = anchoredPopoverPlacement(anchor(300, 200, 400), { width: 1200, height: 900 });
  assert.equal(placement.direction, "down");
  assert.equal(placement.top, 355);
  assert.equal(placement.bottom, null);
  assert.equal(placement.left, 200);
  assert.equal(placement.width, 400);
  assert.equal(placement.maxHeight, 520);
});

test("아래 공간이 좁고 위가 넓으면 위로 뒤집고 아래를 고정한다", () => {
  const placement = anchoredPopoverPlacement(anchor(700, 200, 400), { width: 1200, height: 900 });
  assert.equal(placement.direction, "up");
  assert.equal(placement.top, null);
  assert.equal(placement.bottom, 207);
  assert.equal(placement.maxHeight, 520);
});

test("트리거 폭은 최소·최대 폭과 화면 폭 안으로 제한한다", () => {
  const narrow = anchoredPopoverPlacement(anchor(200, 100, 180), { width: 1200, height: 900 });
  assert.equal(narrow.width, 320);
  const wide = anchoredPopoverPlacement(anchor(200, 100, 900), { width: 1200, height: 900 });
  assert.equal(wide.width, 540);
});

test("화면이 좁으면 좌우 여백 안으로 밀어 넣는다", () => {
  const placement = anchoredPopoverPlacement(anchor(200, 8, 344), { width: 360, height: 900 });
  assert.equal(placement.left, 12);
  assert.equal(placement.width, 336);
  assert.ok(placement.left + placement.width <= 360 - 12);
});

test("창이 낮아 위아래 모두 부족하면 화면 기준으로 펼친다", () => {
  const placement = anchoredPopoverPlacement(anchor(120, 200, 400), { width: 1200, height: 260 });
  assert.equal(placement.top, 12);
  assert.equal(placement.bottom, null);
  assert.equal(placement.maxHeight, 236);
});

test("같은 좌표는 같은 배치로 본다", () => {
  const viewport = { width: 1200, height: 900 };
  const first = anchoredPopoverPlacement(anchor(300, 200, 400), viewport);
  const second = anchoredPopoverPlacement(anchor(300, 200, 400), viewport);
  assert.equal(samePopoverPlacement(first, second), true);
  assert.equal(samePopoverPlacement(first, anchoredPopoverPlacement(anchor(301, 200, 400), viewport)), false);
  assert.equal(samePopoverPlacement(null, first), false);
  assert.equal(samePopoverPlacement(null, null), true);
});
