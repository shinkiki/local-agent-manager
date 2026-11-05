import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAiaSuggestions } from "./aiaSuggestions.ts";
import { NOW, catalog, definition, evaluation, schedulerSnapshot } from "./aiaSuggestionFixtures.mjs";

// 반복 요청 실패 제안(`scheduleRunFailed`)은 무엇을 실패로 볼지, 어느 창까지 볼지, 상한에 걸리면
// 무엇을 버릴지를 스스로 정한다. 지금까지는 다른 종류와 함께 "하나는 나온다"만 확인돼 있어,
// 창·상한·동점 규칙이 바뀌어도 어떤 시험도 실패하지 않았다.

const HOUR = 60 * 60 * 1000;

function run(id, overrides = {}) {
  return { id, scheduleId: "schedule", status: "failed", scheduledFor: NOW - HOUR, startedAt: null, finishedAt: null, recoveryError: null, ...overrides };
}

function failureTargets(runs, parameters = {}, schedules = [{ id: "schedule", name: "Daily report" }]) {
  return evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("scheduleRunFailed", { parameters })),
    scheduler: schedulerSnapshot(false, runs, schedules),
  }));
}

test("실패·건너뜀·복구 오류만 제안하고 완료·취소된 실행은 내지 않는다", () => {
  const suggestions = failureTargets([
    run("failed"),
    run("skipped", { status: "skipped" }),
    run("recovered", { status: "completed", recoveryError: "restore failed" }),
    run("ok", { status: "completed" }),
    run("cancelled", { status: "cancelled" }),
  ]);
  assert.deepEqual(suggestions.map((item) => item.targetId).sort(), ["failed", "recovered", "skipped"]);
  const recovered = suggestions.find((item) => item.targetId === "recovered");
  assert.equal(recovered.stateKey, "completed:recovery-error");
  assert.equal(recovered.metadata.scheduleName, "Daily report");
});

test("lookbackHours 창 밖의 실행은(경계는 포함) 내지 않고, 시각은 끝난 때·시작한 때·예정 시각 순으로 읽는다", () => {
  const suggestions = failureTargets([
    run("old-scheduled", { scheduledFor: NOW - 3 * HOUR }),
    run("recent-finish", { scheduledFor: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, finishedAt: NOW - HOUR }),
    run("recent-start", { scheduledFor: NOW - 3 * HOUR, startedAt: NOW - HOUR }),
    run("edge", { scheduledFor: NOW - 2 * HOUR }),
  ], { lookbackHours: 2 });
  assert.deepEqual(suggestions.map((item) => item.targetId).sort(), ["edge", "recent-finish", "recent-start"]);
});

test("maxResults 상한에 걸리면 가장 최근 실행을 남기고, 같은 시각이면 id 사전순으로 남긴다", () => {
  const suggestions = failureTargets([
    run("c-oldest", { scheduledFor: NOW - 3 * HOUR }),
    run("b-tied", { scheduledFor: NOW - 2 * HOUR }),
    run("a-tied", { scheduledFor: NOW - 2 * HOUR }),
    run("d-newest", { scheduledFor: NOW - HOUR }),
  ], { maxResults: 2 });
  assert.deepEqual(suggestions.map((item) => item.targetId).sort(), ["a-tied", "d-newest"]);
});

test("반복 요청이 목록에 없으면 이름 대신 id를 적는다", () => {
  const [suggestion] = failureTargets([run("orphan", { scheduleId: "gone" })], {}, []);
  assert.equal(suggestion.metadata.scheduleName, "gone");
});
