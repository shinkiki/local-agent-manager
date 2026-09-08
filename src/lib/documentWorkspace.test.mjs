import assert from "node:assert/strict";
import test from "node:test";

import {
  documentEntriesForParent,
  documentFileName,
  mergeDocumentEntries,
  mergeDocumentEntryPage,
  validateDocumentTriggerDraft,
} from "./documentWorkspace.ts";

function entry(relativePath, overrides = {}) {
  const parts = relativePath.split("/");
  return {
    name: parts.at(-1),
    relativePath,
    parentPath: parts.slice(0, -1).join("/"),
    sizeBytes: 10,
    modifiedAt: 1,
    isDirectory: false,
    previewKind: "text",
    ...overrides,
  };
}

test("folder pages append in server order and replace duplicate metadata", () => {
  let cache = new Map();
  cache = mergeDocumentEntryPage(cache, "", {
    entries: [entry("alpha.txt"), entry("nested", { isDirectory: true, previewKind: null })],
    nextCursor: "page-2",
    total: 3,
  }, false);
  cache = mergeDocumentEntryPage(cache, "", {
    entries: [entry("alpha.txt", { sizeBytes: 99 }), entry("omega.bin", { previewKind: "binary" })],
    nextCursor: null,
    total: 3,
  }, true);

  const entries = documentEntriesForParent(cache, "");
  assert.deepEqual(entries.map((item) => item.relativePath), ["alpha.txt", "nested", "omega.bin"]);
  assert.equal(entries[0].sizeBytes, 99);
  assert.equal(cache.get("").nextCursor, null);
});

test("loading a first page replaces stale folder children", () => {
  const previous = new Map([["docs", {
    entries: [entry("docs/old.md", { previewKind: "markdown" })],
    nextCursor: null,
    total: 1,
    loaded: true,
  }]]);
  const next = mergeDocumentEntryPage(previous, "docs", {
    entries: [entry("docs/new.md", { previewKind: "markdown" })],
    nextCursor: null,
    total: 1,
  }, false);

  assert.deepEqual(documentEntriesForParent(next, "docs").map((item) => item.name), ["new.md"]);
  assert.deepEqual(documentEntriesForParent(previous, "docs").map((item) => item.name), ["old.md"]);
});

test("flat search page merging removes duplicate paths", () => {
  const merged = mergeDocumentEntries(
    [entry("docs/report.md", { previewKind: "markdown", sizeBytes: 5 })],
    [entry("docs/report.md", { previewKind: "markdown", sizeBytes: 8 }), entry("src/main.rs")],
  );
  assert.deepEqual(merged.map((item) => item.relativePath), ["docs/report.md", "src/main.rs"]);
  assert.equal(merged[0].sizeBytes, 8);
});

test("file names preserve extensions and normalize separators", () => {
  assert.equal(documentFileName("docs/Guide.MD"), "Guide.MD");
  assert.equal(documentFileName("src\\main.rs"), "main.rs");
});

test("trigger draft validation is action-specific", () => {
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "",
    changeKinds: [],
    actionKind: null,
  }), [
    "트리거 이름을 입력하세요.",
    "감지할 변경 종류를 하나 이상 선택하세요.",
    "실행할 액션을 선택하세요.",
  ]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "문서 검토",
    changeKinds: ["modify"],
    actionKind: "startChat",
    prompt: "  ",
  }), ["새 채팅 요청 내용을 입력하세요."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "보고서 생성",
    changeKinds: ["create"],
    actionKind: "runSchedule",
    actionTargetId: "schedule-1",
  }), []);
});

test("skill run requires a selected skill whose current digest can be pinned", () => {
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: "변경 파일을 검토해줘",
  }), ["적용할 스킬을 선택하세요."]);
  // 목록에서 사라진 스킬은 지문이 없다. 승인값을 고정할 수 없으므로 저장을 막는다.
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: "변경 파일을 검토해줘",
    skillId: "removed-skill",
    skillContentDigest: null,
  }), ["선택한 스킬의 현재 내용을 공통 원본에서 확인할 수 없어 승인값으로 고정할 수 없습니다."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "스킬 검토",
    rootId: "root-1",
    changeKinds: ["modify"],
    actionKind: "runSkill",
    prompt: "변경 파일을 검토해줘",
    skillId: "review-skill",
    skillContentDigest: "sha256:abc",
  }), []);
});

test("chat-shaped triggers gate full access and workflows need a readable version", () => {
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "전체 접근 채팅",
    rootId: "root-1",
    changeKinds: ["created"],
    actionKind: "startChat",
    prompt: "정리해줘",
    fullAccessMode: true,
  }), ["전체 접근 자동 실행 안내를 확인하세요."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "전체 접근 채팅",
    rootId: "root-1",
    changeKinds: ["created"],
    actionKind: "startChat",
    prompt: "정리해줘",
    fullAccessMode: true,
    fullAccessAcknowledged: true,
  }), []);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "워크플로 실행",
    rootId: "root-1",
    changeKinds: ["created"],
    actionKind: "executeWorkflow",
    actionTargetId: "workflow-1",
    workflowApprovedVersion: 0,
  }), ["승인할 워크플로 버전을 확인할 수 없습니다."]);
  assert.deepEqual(validateDocumentTriggerDraft({
    name: "폴더 미선택",
    rootId: "  ",
    changeKinds: ["created"],
    actionKind: "runSchedule",
    actionTargetId: "schedule-1",
  }), ["감시할 문서 폴더를 선택하세요."]);
});
