import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";

// V4: 첨부 초안의 업로드·해제가 "올린 대화"를 기억하는지 본다. 컴포넌트 파일은 JSX 라
// strip-types 로는 읽을 수 없어 typescript 로 그 파일만 변환하고, 서버에 닿는 lib/chat 과
// 화면 전용 미리보기 모듈은 대역으로 바꾼다. 나머지 import(react, lucide-react)는 실제다.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const component = new URL("../components/ChatAttachments.tsx", import.meta.url).href;
const calls = { upload: [], remove: [] };
const chatModule = `data:text/javascript,${encodeURIComponent(`
export const uploadChatInputFile = (...args) => globalThis.__chatAttachmentDraftsProbe.upload(...args);
export const removeChatInputFile = (...args) => globalThis.__chatAttachmentDraftsProbe.remove(...args);
export const directChatInputFileUrl = () => null;
export const readChatInputFile = async () => null;
`)}`;
const previewModule = `data:text/javascript,${encodeURIComponent(`
export const AttachmentZoomButton = () => null;
export const ChatAttachmentPreviewModal = () => null;
export const attachmentTitle = () => "";
export const formatFileSize = String;
export const loadAttachmentObjectUrl = () => () => {};
export const uploadedPreviewTarget = () => null;
`)}`;
globalThis.__chatAttachmentDraftsProbe = {
  upload: async (chatId, file) => {
    calls.upload.push([chatId, file.name]);
    return { id: `uploaded-${calls.upload.length}`, name: file.name, kind: "file", sizeBytes: file.size };
  },
  remove: async (...args) => {
    calls.remove.push(args);
  },
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === component && specifier === "../lib/chat") return { url: chatModule, shortCircuit: true };
    if (context.parentURL === component && specifier === "./ChatAttachmentPreview") return { url: previewModule, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== component) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return { format: "module", shortCircuit: true, source };
  },
});
let drafts;
try {
  drafts = await import(component);
} finally {
  hooks.deregister();
}
const { releaseAttachmentDraftUpload, uploadAttachmentDrafts } = drafts;

function localDraft(key = "draft-1") {
  return { key, file: new File(["note"], `${key}.txt`), uploaded: null, ownedUpload: true, chatId: null };
}

test("V4: 업로드한 초안은 진행 중·결과 모두 올린 대화 id 를 기억한다", async () => {
  calls.upload.length = 0;
  let progress = [];
  const uploaded = await uploadAttachmentDrafts("owner-chat", [localDraft()], (value) => { progress = value; });
  assert.deepEqual(calls.upload, [["owner-chat", "draft-1.txt"]]);
  assert.equal(uploaded[0].chatId, "owner-chat");
  assert.equal(uploaded[0].uploaded?.id, "uploaded-1");
  assert.equal(progress[0].chatId, "owner-chat");
});

test("V4: 이미 올라간 초안은 다시 올리지 않고 원래 대화 id 를 지킨다", async () => {
  calls.upload.length = 0;
  const already = { ...localDraft("done"), uploaded: { id: "kept", name: "done.txt", kind: "file", sizeBytes: 4 }, chatId: "first-chat" };
  const uploaded = await uploadAttachmentDrafts("second-chat", [already], () => {});
  assert.deepEqual(calls.upload, []);
  assert.equal(uploaded[0].chatId, "first-chat");
});

test("V4: 대화가 바뀐 뒤 빼는 초안은 올린 대화에서 지운다", () => {
  calls.remove.length = 0;
  releaseAttachmentDraftUpload(
    { ...localDraft(), uploaded: { id: "uploaded-1", name: "a", kind: "file", sizeBytes: 4 }, chatId: "owner-chat" },
    "other-chat",
  );
  assert.deepEqual(calls.remove, [["owner-chat", "uploaded-1"]]);
});

test("V4: 올린 대화를 모르는 초안은 호출자가 준 현재 대화로 지운다", () => {
  calls.remove.length = 0;
  releaseAttachmentDraftUpload(
    { ...localDraft(), uploaded: { id: "uploaded-2", name: "a", kind: "file", sizeBytes: 4 }, chatId: null },
    "current-chat",
  );
  assert.deepEqual(calls.remove, [["current-chat", "uploaded-2"]]);
});

test("V4: 남이 올린 파일이나 대화 없는 초안은 아무것도 지우지 않는다", () => {
  calls.remove.length = 0;
  releaseAttachmentDraftUpload({ ...localDraft(), uploaded: { id: "x", name: "a", kind: "file", sizeBytes: 1 }, ownedUpload: false, chatId: "c" }, "c");
  releaseAttachmentDraftUpload({ ...localDraft(), uploaded: { id: "y", name: "a", kind: "file", sizeBytes: 1 }, chatId: null }, null);
  releaseAttachmentDraftUpload(localDraft(), "c");
  assert.deepEqual(calls.remove, []);
});
