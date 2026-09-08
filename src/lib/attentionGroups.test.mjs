import assert from "node:assert/strict";
import test from "node:test";
import { attentionFolderSummary, groupAttentionItems } from "./attentionGroups.ts";

function item(overrides) {
  return {
    id: "item-1",
    chatId: "chat-1",
    source: "codex",
    providerSessionId: null,
    cwd: "/Users/example/agent-manager-tauri",
    resuming: false,
    unattended: false,
    profile: "standard",
    origin: null,
    kind: "completed",
    title: "에이전트 작업 완료",
    detail: null,
    approvalId: null,
    preview: null,
    createdAt: 0,
    read: false,
    ...overrides,
  };
}

const schedule = (id, overrides) => item({
  id,
  chatId: id,
  origin: { kind: "schedule", scheduleId: "schedule-1", runId: id, consumerId: "schedule-1" },
  ...overrides,
});

test("한 대화가 턴마다 남긴 알림은 한 묶음이 된다", () => {
  const groups = groupAttentionItems([
    item({ id: "turn:chat-1:2", createdAt: 2 }),
    item({ id: "turn:chat-1:1", createdAt: 1 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "chat");
  assert.equal(groups[0].items.length, 2);
  // 대표는 가장 새로운 항목이라 접힌 줄의 시각이 목록의 시각과 같다.
  assert.equal(groups[0].lead.id, "turn:chat-1:2");
});

test("대화가 달라도 같은 반복 요청 회차면 한 묶음이 된다", () => {
  const groups = groupAttentionItems([schedule("run-2"), schedule("run-1")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "schedule");
  assert.equal(groups[0].items.length, 2);
});

test("워크플로 병렬 회차는 실행 id가 갈라져도 소비자 id로 묶인다", () => {
  // 사용량 페이싱이 한 회차를 여러 갈래로 띄우면 실행 id는 갈래마다 다르다.
  const lane = (id, folder) => item({
    id,
    chatId: id,
    cwd: `/Users/example/agent-manager-tauri/.rounds/${folder}`,
    origin: {
      kind: "workflow",
      workflowId: "wf-refactor",
      executionId: `execution-${id}`,
      scheduleId: "schedule-9",
      runId: id,
      consumerId: "schedule-9",
    },
  });
  const groups = groupAttentionItems([lane("a", "wt-F01"), lane("b", "wt-F02"), lane("c", "wt-F03")]);
  assert.equal(groups.length, 1);
  // 반복 요청이 돌린 워크플로라 이름은 반복 요청 쪽을 따르고, 갈래는 작업 경로가 알린다.
  assert.equal(groups[0].reason, "schedule");
  assert.equal(groups[0].items.length, 3);
  assert.deepEqual(groups[0].folders, ["wt-F01", "wt-F02", "wt-F03"]);
});

test("종류·공급자가 다르면 같은 회차라도 나뉜다", () => {
  const groups = groupAttentionItems([
    schedule("run-3", { kind: "running" }),
    schedule("run-2"),
    schedule("run-1", { source: "claude" }),
  ]);
  assert.deepEqual(groups.map((group) => group.items.length), [1, 1, 1]);
});

test("승인 대기가 든 묶음은 통째로 지울 수 없고 언제나 읽지 않은 상태다", () => {
  const groups = groupAttentionItems([
    schedule("run-2", { kind: "approval", read: true }),
    schedule("run-1", { kind: "approval", read: true }),
  ]);
  assert.equal(groups[0].dismissable, false);
  assert.equal(groups[0].unreadCount, 2);
});

test("읽은 건이 섞이면 안읽음만 따로 센다", () => {
  const groups = groupAttentionItems([schedule("run-2"), schedule("run-1", { read: true })]);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].unreadCount, 1);
});

test("계정 자동전환은 대화가 없어 공급자별로 묶인다", () => {
  const groups = groupAttentionItems([
    item({ id: "switch-2", chatId: "", cwd: "", kind: "accountSwitch", detail: "A → B" }),
    item({ id: "switch-1", chatId: "", cwd: "", kind: "accountSwitch", detail: "B → C" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "account");
  assert.deepEqual(groups[0].folders, []);
});

test("묶음은 가장 새로운 구성원이 있던 자리에 서서 시간 순서를 지킨다", () => {
  const groups = groupAttentionItems([
    item({ id: "other", chatId: "chat-2", createdAt: 3 }),
    schedule("run-2", { createdAt: 2 }),
    item({ id: "old", chatId: "chat-3", createdAt: 1 }),
    schedule("run-1", { createdAt: 0 }),
  ]);
  assert.deepEqual(groups.map((group) => group.lead.id), ["other", "run-2", "old"]);
});

test("작업 경로 요약은 두 곳까지만 이름을 적는다", () => {
  assert.equal(attentionFolderSummary([]), "");
  assert.equal(attentionFolderSummary(["wt-F01", "wt-F02"]), "wt-F01, wt-F02");
  assert.equal(attentionFolderSummary(["wt-F01", "wt-F02", "wt-F03", "wt-F04"]), "wt-F01, wt-F02 외 2곳");
  // 꼬리는 UI 언어별 문장을 호출부가 준다. 수와 단위가 한 문장으로 붙어 나와야 한다.
  assert.equal(
    attentionFolderSummary(["wt-F01", "wt-F02", "wt-F03", "wt-F04"], (count) => `and ${count} more`),
    "wt-F01, wt-F02 and 2 more",
  );
  assert.equal(attentionFolderSummary(["wt-F01", "wt-F02"], () => "unused"), "wt-F01, wt-F02");
});

test("반복 요청 없이 돌린 워크플로는 워크플로 id로 묶인다", () => {
  const step = (id) => item({
    id,
    chatId: id,
    origin: { kind: "workflow", workflowId: "wf-1", executionId: `execution-${id}`, consumerId: "wf-1" },
  });
  const groups = groupAttentionItems([step("a"), step("b")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "workflow");
});
