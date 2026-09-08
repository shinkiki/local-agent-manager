import assert from "node:assert/strict";
import test from "node:test";
import { sessionTranscriptImagePath } from "./sessionImage.ts";

test("이미지 경로는 공급자·세션·오프셋·포인터를 그대로 담는다", () => {
  assert.equal(
    sessionTranscriptImagePath("claude", "c22d72c9-c3ad-41db-9567-8ae84c3c266f", {
      sourceOffset: 4096,
      sourcePointer: "/message/content/0",
    }),
    "/api/session-image/claude/c22d72c9-c3ad-41db-9567-8ae84c3c266f/4096/%2Fmessage%2Fcontent%2F0",
  );
});

test("JSON 포인터의 슬래시는 한 경로 조각으로 인코딩된다", () => {
  const path = sessionTranscriptImagePath("codex", "session", {
    sourceOffset: 0,
    sourcePointer: "/payload/output/1",
  });
  assert.equal(path.split("/").length, 7);
  assert.ok(path.endsWith("/0/%2Fpayload%2Foutput%2F1"));
});

test("오프셋은 음수·소수 없이 정수로 정규화된다", () => {
  const pointer = { sourceOffset: -12.7, sourcePointer: "/message/content/0" };
  assert.ok(sessionTranscriptImagePath("claude", "session", pointer).includes("/session/0/"));
  assert.ok(
    sessionTranscriptImagePath("claude", "session", { ...pointer, sourceOffset: 12.7 })
      .includes("/session/12/"),
  );
});
