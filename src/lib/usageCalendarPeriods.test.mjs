import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// V4: 달력 월은 고정된 30일이나 24시간의 합이 아니다. TZ를 자식 프로세스에만
// 지정해 시험 실행 기기의 시간대와 다른 시험의 실행 순서에 영향을 받지 않는다.
const moduleUrl = new URL("./usageCumulative.ts", import.meta.url).href;
const cases = [
  {
    name: "평년 2월", zone: "UTC", now: [2023, 2, 15, 12], key: "2023-02",
    from: "2023-02-01T00:00:00.000Z", to: "2023-03-01T00:00:00.000Z", hours: 672,
  },
  {
    name: "윤년 2월", zone: "America/New_York", now: [2024, 2, 15, 12], key: "2024-02",
    from: "2024-02-01T05:00:00.000Z", to: "2024-03-01T05:00:00.000Z", hours: 696,
  },
  {
    name: "서머타임 시작 월", zone: "America/New_York", now: [2024, 3, 15, 12], key: "2024-03",
    from: "2024-03-01T05:00:00.000Z", to: "2024-04-01T04:00:00.000Z", hours: 743,
  },
  {
    name: "서머타임 종료 월", zone: "America/New_York", now: [2024, 11, 15, 12], key: "2024-11",
    from: "2024-11-01T04:00:00.000Z", to: "2024-12-01T05:00:00.000Z", hours: 721,
  },
];

for (const scenario of cases) {
  test(`V4 월별 사용량 구간은 ${scenario.name}의 실제 달력 경계를 따른다`, () => {
    const script = `
      import { recentMonthPeriods } from ${JSON.stringify(moduleUrl)};
      const now = new Date(...${JSON.stringify(scenario.now)}).getTime();
      console.log(JSON.stringify({ now, periods: recentMonthPeriods(now, 2) }));
    `;
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types", "--input-type=module", "--eval", script,
    ], { env: { TZ: scenario.zone }, encoding: "utf8", timeout: 10_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const { now, periods } = JSON.parse(child.stdout);
    assert.equal(periods.length, 2);
    const [completed, current] = periods;
    assert.equal(completed.key, scenario.key);
    assert.equal(new Date(completed.from).toISOString(), scenario.from);
    assert.equal(new Date(completed.to).toISOString(), scenario.to);
    assert.equal((completed.to - completed.from) / 3_600_000, scenario.hours);
    assert.equal(current.from, completed.to, "월 사이에 빈 시간이나 겹침이 없다");
    assert.equal(current.to, now, "이번 달은 아직 오지 않은 날을 세지 않는다");
  });
}
