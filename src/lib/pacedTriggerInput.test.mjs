import assert from "node:assert/strict";
import test from "node:test";

import { buildPacedRecurrence, buildPacedTriggerInput } from "./pacedTriggerInput.ts";

const draft = { frequency: "daily", interval: "5", hour: "9", minute: "0", weekday: 1, cron: "0 9 * * 1-5" };
const workflow = {
  id: "round-a",
  displayName: "회차 A",
  version: 3,
  inputSchema: { project: { type: "string", required: true }, lanes: { type: "number" } },
};

function build(overrides = {}) {
  return buildPacedTriggerInput({
    selected: workflow,
    name: "",
    inputs: { project: "/srv/a", lanes: "" },
    paced: true,
    maxRuns: 2,
    recurrence: buildPacedRecurrence({ ...draft, timezone: "Asia/Seoul" }),
    enabled: false,
    ...overrides,
  });
}

test("범위 밖·빈 주기 초안은 유효 범위로 눌러 저장한다", () => {
  const recurrence = buildPacedRecurrence({ ...draft, interval: "", hour: "25", minute: "-3", timezone: "UTC" });
  assert.equal(recurrence.interval, 1);
  assert.equal(recurrence.hour, 23);
  assert.equal(recurrence.minute, 0);
});

test("cron 식은 cron 주기일 때만 저장한다", () => {
  assert.equal(buildPacedRecurrence({ ...draft, timezone: "UTC" }).cron, null);
  assert.equal(buildPacedRecurrence({ ...draft, frequency: "cron", timezone: "UTC" }).cron, "0 9 * * 1-5");
});

test("이름이 비면 워크플로 표시 이름, 그것도 없으면 id 로 채운다", () => {
  assert.equal(build({ name: "  " }).name, "회차 A");
  assert.equal(build({ selected: { ...workflow, displayName: "" } }).name, "round-a");
  assert.equal(build({ name: " 내 회차 " }).name, "내 회차");
});

test("새 회차는 기본값으로, 기존 회차는 저장본의 활성 창·공급자·권한을 지우지 않고 다시 보낸다", () => {
  const fresh = build();
  assert.equal(fresh.source, "claude");
  assert.equal(fresh.mode, "workspace");
  assert.equal(fresh.approvalMode, "never");
  assert.equal(fresh.resumeFailurePolicy, "retryThenNewChat");
  assert.equal(fresh.activeFrom, null);
  assert.equal(fresh.activeUntil, null);

  const schedule = {
    source: "codex",
    mode: "plan",
    approvalMode: "onRequest",
    resumeFailurePolicy: "newChat",
    activeFrom: "2026-11-01",
    activeUntil: "2026-11-30",
  };
  const kept = build({ schedule });
  assert.equal(kept.source, "codex");
  assert.equal(kept.mode, "plan");
  assert.equal(kept.approvalMode, "onRequest");
  assert.equal(kept.resumeFailurePolicy, "newChat");
  assert.equal(kept.activeFrom, "2026-11-01");
  assert.equal(kept.activeUntil, "2026-11-30");
});

test("워크플로 묶음은 승인 버전을 고정하고, 페이싱이 아니면 병렬 설정을 싣지 않는다", () => {
  const input = build();
  assert.deepEqual(input.workflow, {
    workflowId: "round-a",
    approvedVersion: 3,
    arguments: { project: "/srv/a" },
    pacing: { maxRuns: 2 },
  });
  assert.equal(build({ paced: false }).workflow.pacing, null);
  assert.equal(build({ selected: { ...workflow, version: undefined } }).workflow.approvedVersion, 0);
});

test("채팅 전용 칸은 고정값으로 비워 보내고 주기·활성은 그대로 싣는다", () => {
  const input = build({ enabled: true });
  assert.equal(input.enabled, true);
  assert.equal(input.recurrence.weekday, 1);
  assert.equal(input.recurrence.timezone, "Asia/Seoul");
  assert.deepEqual(
    [input.prompt, input.accountId, input.useActiveAccount, input.cwd, input.model, input.reasoningEffort,
      input.sessionStrategy, input.providerSessionId, input.sessionReference],
    ["", "", false, "", null, null, "newChat", null, null],
  );
});
