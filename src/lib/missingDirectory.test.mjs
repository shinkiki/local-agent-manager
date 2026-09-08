import assert from "node:assert/strict";
import test from "node:test";
import {
  MISSING_DIRECTORY_PREFIX,
  missingDirectoryPath,
  missingDirectoryPrompt,
} from "./missingDirectory.ts";

test("없는 폴더 실패에서 경로를 뽑는다", () => {
  assert.equal(
    missingDirectoryPath(`${MISSING_DIRECTORY_PREFIX}/Users/example/Projects/project-management`),
    "/Users/example/Projects/project-management",
  );
});

test("호출자가 앞에 자기 문장을 붙여도 경로만 읽는다", () => {
  assert.equal(
    missingDirectoryPath(`채팅을 시작하지 못했습니다: ${MISSING_DIRECTORY_PREFIX}/repos/alpha`),
    "/repos/alpha",
  );
});

test("접두사 뒤 첫 줄만 경로로 본다", () => {
  assert.equal(
    missingDirectoryPath(`${MISSING_DIRECTORY_PREFIX}/repos/alpha\n다시 시도하세요`),
    "/repos/alpha",
  );
});

test("다른 실패는 확인 대화를 띄우지 않는다", () => {
  assert.equal(missingDirectoryPath("폴더가 아닙니다: /repos/alpha/note.md"), null);
  assert.equal(missingDirectoryPath("경로에 접근할 권한이 없습니다: /private/x"), null);
  assert.equal(missingDirectoryPath("이미 등록된 문서 폴더입니다"), null);
  assert.equal(missingDirectoryPath(""), null);
});

test("경로가 비어 있으면 만들 대상이 없으므로 null", () => {
  assert.equal(missingDirectoryPath(MISSING_DIRECTORY_PREFIX), null);
});

test("확인 문구는 만들 경로를 먼저 보여준다", () => {
  const prompt = missingDirectoryPrompt("/repos/alpha");
  assert.ok(prompt.startsWith("/repos/alpha"));
  assert.ok(prompt.includes("새로운 폴더를 만드시겠습니까?"));
});
