import assert from "node:assert/strict";
import test from "node:test";

import { formatBytes, formatCountdown, formatDate, formatRelative, formatTokens, sourceName } from "./format.ts";

test("formatDate는 빈 값에 대시를 돌려주고 날짜를 서식화한다", () => {
  assert.equal(formatDate(null), "–");
  assert.equal(formatDate(0), "–");
  const formatted = formatDate(1725408000000);
  assert.ok(formatted.includes("."));
});

test("formatRelative는 빈 값에 대시를 돌려준다", () => {
  assert.equal(formatRelative(null), "–");
  assert.equal(formatRelative(0), "–");
});

test("formatRelative는 과거 시간을 단위별로 표시한다", () => {
  const now = Date.now();
  assert.equal(formatRelative(now - 10_000), "방금 전");
  assert.equal(formatRelative(now - 120_000), "2분 전");
  assert.equal(formatRelative(now - 7_200_000), "2시간 전");
  assert.equal(formatRelative(now - 172_800_000), "2일 전");
});

test("formatRelative는 1분 미만의 미래 시간에 잠시 후를 돌려준다", () => {
  const now = Date.now();
  assert.equal(formatRelative(now + 10_000), "잠시 후");
  assert.equal(formatRelative(now + 30_000), "잠시 후");
  // 미래 값은 단위 경계에 딱 맞추면 흔들린다 — formatRelative가 Date.now()를 다시 읽어 여기서
  // 흐른 몇 ms만큼 남은 시간이 줄고, 120초는 119.99초가 되어 "1분 후"로 내림된다. 단위의
  // 한가운데(2.5배) 값을 써서 실행 시간에 무관하게 같은 칸에 떨어지게 한다.
  assert.equal(formatRelative(now + 150_000), "2분 후");
  assert.equal(formatRelative(now + 9_000_000), "2시간 후");
  assert.equal(formatRelative(now + 216_000_000), "2일 후");
});

test("formatCountdown은 큰 단위 둘까지만 적고 지난 시각에는 값을 주지 않는다", () => {
  assert.equal(formatCountdown(5 * 86_400_000 + 12 * 3_600_000 + 40 * 60_000), "5d 12h");
  assert.equal(formatCountdown(4 * 3_600_000 + 16 * 60_000), "4h 16m");
  assert.equal(formatCountdown(16 * 60_000), "16m");
  assert.equal(formatCountdown(30_000), "<1m");
  assert.equal(formatCountdown(0), null);
  assert.equal(formatCountdown(-1), null);
});

test("formatBytes는 바이트 단위를 알맞게 서식화한다", () => {
  assert.equal(formatBytes(null), "–");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(2048), "2.0 KB");
});

test("formatTokens는 토큰 수를 축약한다", () => {
  assert.equal(formatTokens(null), "–");
  assert.equal(formatTokens(500), "500");
  assert.equal(formatTokens(1500), "1.5K");
  assert.equal(formatTokens(2_500_000), "2.5M");
});

test("sourceName은 공급자 이름을 반환한다", () => {
  assert.equal(sourceName("claude"), "Claude");
  assert.equal(sourceName("codex"), "Codex");
  assert.equal(sourceName("antigravity"), "Antigravity");
});
