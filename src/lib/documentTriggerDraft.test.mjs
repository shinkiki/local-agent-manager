import assert from "node:assert/strict";
import test from "node:test";

import { validateDocumentTriggerDraft } from "./documentTriggerDraft.ts";

/** 검사기는 로케일을 읽지 않고 손잡이를 받는다. 테스트는 한국어 쪽을 그대로 돌려준다. */
const text = (ko) => ko;

test("trigger draft validation is action-specific", () => {
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "",
    changeKinds: [],
    actionKind: null,
  }, text), [
    "트리거 이름을 입력하세요.",
    "감지할 변경 종류를 하나 이상 선택하세요.",
    "실행할 액션을 선택하세요.",
  ]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "문서 검토",
    changeKinds: ["modify"],
    actionKind: "startChat",
    prompt: "  ",
  }, text), ["새 채팅 요청 내용을 입력하세요."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "보고서 생성",
    changeKinds: ["create"],
    actionKind: "runSchedule",
    actionTargetId: "schedule-1",
  }, text), []);
});

test("skill run requires a selected skill whose current digest can be pinned", () => {
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: "변경 파일을 검토해줘",
  }, text), ["적용할 스킬을 선택하세요."]);
  // 목록에서 사라진 스킬은 지문이 없다. 승인값을 고정할 수 없으므로 저장을 막는다.
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: "변경 파일을 검토해줘",
    skillId: "removed-skill",
    skillContentDigest: null,
  }, text), ["선택한 스킬의 현재 내용을 공통 원본에서 확인할 수 없어 승인값으로 고정할 수 없습니다."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: "변경 파일을 검토해줘",
    skillId: "review-skill",
    skillContentDigest: "sha256:abc",
  }, text), []);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: " ",
    fullAccessMode: true,
  }, text), [
    "새 채팅 요청 내용을 입력하세요.",
    "적용할 스킬을 선택하세요.",
    "전체 접근 자동 실행 안내를 확인하세요.",
  ]);
});

test("chat-shaped triggers gate full access and workflows need a readable version", () => {
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "전체 접근 채팅",
    rootId: "root-1",
    changeKinds: ["created"],
    actionKind: "startChat",
    prompt: "정리해줘",
    fullAccessMode: true,
  }, text), ["전체 접근 자동 실행 안내를 확인하세요."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "전체 접근 채팅",
    rootId: "root-1",
    changeKinds: ["created"],
    actionKind: "startChat",
    prompt: "정리해줘",
    fullAccessMode: true,
    fullAccessAcknowledged: true,
  }, text), []);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "워크플로 실행",
    rootId: "root-1",
    changeKinds: ["created"],
    actionKind: "executeWorkflow",
    actionTargetId: "workflow-1",
    workflowApprovedVersion: 0,
  }, text), ["승인할 워크플로 버전을 확인할 수 없습니다."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "폴더 미선택",
    rootId: "  ",
    changeKinds: ["created"],
    actionKind: "runSchedule",
    actionTargetId: "schedule-1",
  }, text), ["감시할 등록 폴더를 선택하세요."]);
});
