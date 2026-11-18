import assert from "node:assert/strict";
import test from "node:test";
import { workflowScheduleInput } from "./scheduleWorkflowInput.ts";
import { workflowInputEntries } from "./scheduleWorkflowInputs.ts";

const envelope = Object.freeze({
  mode: "workspace",
  approvalMode: "never",
  recurrence: Object.freeze({ frequency: "weekly", interval: 1, hour: 9, minute: 30, weekday: 2, cron: null, timezone: "Asia/Seoul" }),
  resumeFailurePolicy: "pause",
  enabled: false,
  activeFrom: "2026-11-01T00:00:00Z",
  activeUntil: "2026-12-01T00:00:00Z",
});
const workflow = Object.freeze({ id: "wf-a", displayName: "점검 회차", version: 7 });
const draft = (overrides = {}) => ({
  name: "",
  source: "codex",
  workflow,
  schema: [],
  inputs: {},
  saved: null,
  ...overrides,
});

test("V4: 워크플로 저장 입력은 주기·권한·활성 창을 보존하고 채팅 전용 값은 비운다", () => {
  assert.deepEqual(workflowScheduleInput(envelope, draft()), {
    ...envelope,
    name: "점검 회차",
    prompt: "",
    source: "codex",
    accountId: "",
    useActiveAccount: false,
    cwd: "",
    model: null,
    reasoningEffort: null,
    sessionStrategy: "newChat",
    providerSessionId: null,
    sessionReference: null,
    workflow: { workflowId: "wf-a", approvedVersion: 7, arguments: {}, pacing: null },
  });
});

test("V4: 이름은 공백을 제거하고 빈 이름은 표시 이름과 식별자 순으로 채운다", () => {
  assert.equal(workflowScheduleInput(envelope, draft({ name: "  내 회차  " })).name, "내 회차");
  assert.equal(workflowScheduleInput(envelope, draft({ name: " \t " })).name, "점검 회차");
  assert.equal(workflowScheduleInput(envelope, draft({ workflow: { ...workflow, displayName: "" } })).name, "wf-a");
});

test("V4: 현재 승인 버전과 선언한 입력 타입을 저장하고 선택 입력의 빈 값은 생략한다", () => {
  const selected = { ...workflow, inputSchema: {
    project: { type: "string", required: true },
    count: { type: "number", required: false },
    notify: { type: "boolean", required: false },
    note: { type: "string", required: false },
  } };
  const input = workflowScheduleInput(envelope, draft({
    workflow: selected,
    schema: workflowInputEntries(selected),
    inputs: { project: "/workspace/sample", count: "3", notify: "false", note: "" },
    saved: { workflowId: "wf-a", approvedVersion: 2, arguments: { count: 99 } },
  }));
  assert.deepEqual(input.workflow, {
    workflowId: "wf-a", approvedVersion: 7,
    arguments: { project: "/workspace/sample", count: 3, notify: false }, pacing: null,
  });
  for (const version of [null, undefined]) {
    assert.equal(workflowScheduleInput(envelope, draft({ workflow: { ...workflow, version } })).workflow.approvedVersion, 0);
  }
});

test("V4: 같은 워크플로의 병렬 설정만 보존하고 새 선택에 이전 설정을 옮기지 않는다", () => {
  const pacing = Object.freeze({ maxRuns: 3 });
  for (const [saved, expected] of [
    [null, null],
    [{ workflowId: "wf-a", pacing }, pacing],
    [{ workflowId: "wf-a", pacing: null }, null],
    [{ workflowId: "wf-a" }, null],
    [{ workflowId: "wf-other", pacing }, null],
  ]) {
    assert.deepEqual(workflowScheduleInput(envelope, draft({ saved })).workflow.pacing, expected);
  }
});

test("V4: 저장 입력을 만들 때 동결한 폼과 저장본을 바꾸지 않는다", () => {
  const saved = Object.freeze({ workflowId: "wf-a", approvedVersion: 2, pacing: Object.freeze({ maxRuns: 4 }) });
  const form = Object.freeze(draft({ saved, inputs: Object.freeze({}), schema: Object.freeze([]) }));
  const before = structuredClone({ envelope, form });
  workflowScheduleInput(envelope, form);
  assert.deepEqual({ envelope, form }, before);
});
