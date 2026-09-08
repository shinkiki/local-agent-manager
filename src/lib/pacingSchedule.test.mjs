import assert from "node:assert/strict";
import test from "node:test";

import { defaultQuietHours, describeQuietHours, describeWeekdays, quietWeekdays, WEEKDAY_NAMES, WEEKDAY_NAMES_EN, WEEKDAY_ORDER } from "./pacingSchedule.ts";

test("describeQuietHours is null when the schedule is off and summarizes days when on", () => {
  assert.equal(describeQuietHours(null), null);
  assert.equal(describeQuietHours(defaultQuietHours("Asia/Seoul")), null);
  assert.equal(
    describeQuietHours({ ...defaultQuietHours("Asia/Seoul"), enabled: true }),
    "제한 09:00~18:00 · 월~금",
  );
  assert.equal(
    describeQuietHours({ enabled: true, start: "22:00", end: "06:00", timezone: "Asia/Seoul", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    "제한 22:00~06:00 · 매일",
  );
});

test("describeWeekdays lists days in Monday-first order and abbreviates runs", () => {
  assert.equal(describeWeekdays([1, 3, 5]), "월·수·금");
  assert.equal(describeWeekdays([5, 6, 0]), "금~일");
  assert.equal(describeWeekdays([0, 1]), "월·일");
  assert.equal(describeWeekdays([1, 3, 5], (ko, en) => en), "Mon·Wed·Fri");
});

test("quietWeekdays reads a missing weekday list from an old backend as every day", () => {
  assert.deepEqual(quietWeekdays({ weekdays: [] }), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(quietWeekdays(undefined), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(quietWeekdays({ weekdays: [2] }), [2]);
});

// 이름 배열은 요일 정본 표에서 뽑고 표시 순서만 따로 적으므로, 둘이 같은 요일 집합을
// 가리키는지가 이 파일의 유일한 손으로 맞춘 짝이다. 순서 표에 요일이 빠지면 그 요일은
// 화면에서 사라지고 "매일"도 영원히 뜨지 않는다.
test("표시 순서는 이름 표의 요일 번호를 하나도 빠뜨리지 않는다", () => {
  assert.equal(WEEKDAY_NAMES.length, WEEKDAY_NAMES_EN.length);
  assert.deepEqual([...WEEKDAY_ORDER].sort((left, right) => left - right), WEEKDAY_NAMES.map((_, day) => day));
  assert.equal(describeWeekdays(WEEKDAY_ORDER), "매일");
});
