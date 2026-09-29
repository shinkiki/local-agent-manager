// 작업 9.8 — 계획 평가셋의 채점기를 고정한다.
// 실측(plan-loop.mjs)은 Ollama 가 떠 있어야 돌지만 채점 규칙은 순수 함수라 여기서 잰다.
// 여기가 깨지면 기준선 수치의 뜻이 바뀐 것이므로 기준선도 다시 재야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL, TASKS, BASELINES, scorePlan, compareToBaseline,
} from "../../local-llm-dev/plan-eval/plan-tasks.mjs";

const step = (...tools) => ({ goal: "무엇을 한다", tools });

test("동치 도구 집합 — 같은 일을 다른 도구로 해낸 것을 어긋난 것으로 세지 않는다", () => {
  const multi = TASKS.find((t) => t.id === "multi-step");
  const withUpdate = [step("notion-search"), step("notion-update-page")];
  const withComment = [step("notion-ai-search"), step("notion-create-comment")];
  assert.equal(scorePlan(withUpdate, multi.want).ok, true);
  assert.equal(scorePlan(withComment, multi.want).ok, true, "댓글로 덧붙인 것도 충족이다");
});

test("요구 묶음 중 하나도 쓰지 않으면 그 묶음을 이유로 어긋난다", () => {
  const multi = TASKS.find((t) => t.id === "multi-step");
  const score = scorePlan([step("notion-search"), step("notion-get-users")], multi.want);
  assert.equal(score.ok, false);
  assert.equal(score.reasons.length, 1);
  assert.match(score.reasons[0], /notion-update-page \| notion-create-comment/);
});

test("단계 수가 범위 밖이면 어긋난다", () => {
  const simple = TASKS.find((t) => t.id === "simple-create");
  const tooMany = Array.from({ length: 4 }, () => step("notion-create-pages"));
  const score = scorePlan(tooMany, simple.want);
  assert.equal(score.ok, false);
  assert.match(score.reasons[0], /단계 수 4/);
});

test("없는 도구 이름은 이유로 남고 타당을 무효로 만든다", () => {
  const simple = TASKS.find((t) => t.id === "simple-create");
  const score = scorePlan([step("notion-create-pages", "notion-make-page")], simple.want);
  assert.equal(score.ok, false);
  assert.deepEqual(score.bogus, ["notion-make-page"]);
});

test("불가능 과제는 단계를 하나라도 세우면 어긋난다", () => {
  const impossible = TASKS.find((t) => t.id === "impossible-plan");
  assert.equal(scorePlan([], impossible.want).ok, true);
  const score = scorePlan([step("notion-update-page")], impossible.want);
  assert.equal(score.ok, false);
  assert.match(score.reasons[0], /거절해야 할 요청/);
});

test("기준선 판정 — 같으면 held, 위면 improved", () => {
  const model = "gpt-oss-cpu-low:latest";
  assert.equal(compareToBaseline(model, "multi-step", 2 / 3).verdict, "held");
  assert.equal(compareToBaseline(model, "multi-step", 3 / 3).verdict, "improved");
});

test("한 시행만큼의 하락은 흔들림이고, 그것을 넘어야 미달이다", () => {
  const table = { "m:latest": { t: 1 } };
  const at = (rate, repeats) => compareToBaseline("m:latest", "t", rate, { repeats, table }).verdict;
  assert.equal(at(2 / 3, 3), "wobbled", "3회에서 한 번 어긋난 것은 운이다");
  assert.equal(at(1 / 3, 3), "regressed", "두 번 어긋나면 무너진 것이다");
  // 시행을 늘리면 여유도 같이 좁아진다 — 한 시행이 기준이지 고정 비율이 아니다.
  assert.equal(at(8 / 9, 9), "wobbled");
  assert.equal(at(7 / 9, 9), "regressed");
});

test("재지 않은 기준선(null)은 실패로 세지 않는다", () => {
  const table = { "m:latest": { "multi-step": null } };
  assert.equal(compareToBaseline("m:latest", "multi-step", 0, { table }).verdict, "unmeasured");
  assert.equal(compareToBaseline("m:latest", "없는-과제", 0, { table }).verdict, "unknown");
  assert.equal(compareToBaseline("없는-모델:latest", "multi-step", 0).verdict, "unknown");
});

test("모든 과제가 두 모델의 기준선 표에 실측값으로 자리를 가진다", () => {
  for (const [model, table] of Object.entries(BASELINES)) {
    for (const task of TASKS) {
      assert.ok(task.id in table, `${model} 기준선에 ${task.id} 가 없다`);
      const value = table[task.id];
      assert.ok(typeof value === "number" && value >= 0 && value <= 1,
        `${model}/${task.id} 기준선이 실측값이 아니다: ${value}`);
    }
  }
});

test("기대 도구는 전부 실재하는 이름이다", () => {
  for (const task of TASKS) {
    for (const group of task.want.must ?? []) {
      for (const name of group) assert.ok(ALL.includes(name), `${task.id}: 없는 도구 ${name}`);
    }
  }
});
