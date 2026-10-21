import assert from "node:assert/strict";
import test from "node:test";

import { usageSeriesColor } from "./usageSeriesColor.ts";

// 격자 크기(색상 24 · 명도 5 · 채도 3). 모듈은 이 값을 내보내지 않으므로 시험이 같은 곱을 적는다.
const LIMIT = 24 * 5 * 3;

for (const dark of [true, false]) {
  const theme = dark ? "dark" : "light";

  test(`${theme}: 격자 안의 자리는 모두 다른 sRGB 색이다`, () => {
    const colors = Array.from({ length: LIMIT }, (_, index) => usageSeriesColor(index, dark));
    for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/);
    assert.equal(new Set(colors).size, LIMIT);
  });

  test(`${theme}: 격자를 넘으면 처음 색부터 다시 돈다`, () => {
    assert.equal(usageSeriesColor(LIMIT, dark), usageSeriesColor(0, dark));
    assert.equal(usageSeriesColor(LIMIT + 7, dark), usageSeriesColor(7, dark));
    assert.equal(usageSeriesColor(-1, dark), usageSeriesColor(LIMIT - 1, dark));
  });

  test(`${theme}: 첫 색은 초록 계열이다`, () => {
    const [r, g, b] = usageSeriesColor(0, dark).slice(1).match(/../g).map((hex) => parseInt(hex, 16));
    assert.ok(g > r && g > b, usageSeriesColor(0, dark));
  });
}

test("테마가 다르면 같은 자리라도 다른 명도 폭에서 고른다", () => {
  assert.notEqual(usageSeriesColor(0, true), usageSeriesColor(0, false));
});

test("앞자리 색은 뒷자리를 먼저 물어도 바뀌지 않는다", async () => {
  // 캐시를 비운 새 모듈 인스턴스에서 뒷자리부터 물은 결과와, 이 인스턴스에서 앞자리부터 물은 결과를 견준다.
  const fresh = await import(`./usageSeriesColor.ts?fresh=${Date.now()}`);
  const late = fresh.usageSeriesColor(40, true);
  for (let index = 0; index <= 40; index += 1) {
    assert.equal(fresh.usageSeriesColor(index, true), usageSeriesColor(index, true));
  }
  assert.equal(late, usageSeriesColor(40, true));
});
