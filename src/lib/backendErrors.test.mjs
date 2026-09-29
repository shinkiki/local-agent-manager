import assert from "node:assert/strict";
import test from "node:test";
import {
  backendError,
  backendErrorCodeFrom,
  backendErrorMessage,
  BackendCodedError,
  setBackendErrorLocale,
} from "./backendErrors.ts";

test("코드와 파라미터를 응답 본문에서 꺼낸다", () => {
  assert.deepEqual(
    backendErrorCodeFrom({ error: "세션 폴더를 찾을 수 없습니다: f1", code: "SESSION_FOLDER_NOT_FOUND_BY_ID", params: { id: "f1" } }),
    { code: "SESSION_FOLDER_NOT_FOUND_BY_ID", params: { id: "f1" } },
  );
});

test("코드가 없는 본문은 null이라 백엔드 문장을 그대로 쓴다", () => {
  assert.equal(backendErrorCodeFrom({ error: "잘못된 입력입니다" }), null);
  assert.equal(backendErrorCodeFrom(null), null);
  assert.equal(backendErrorCodeFrom({ code: 7 }), null);
});

test("문자열이 아닌 파라미터는 버린다", () => {
  assert.deepEqual(backendErrorCodeFrom({ code: "X_Y", params: { max: 5, id: "f1" } }).params, { id: "f1" });
});

test("한국어는 백엔드 문장을 그대로 쓴다", () => {
  const detail = { code: "SESSION_FOLDER_NAME_REQUIRED", params: {} };
  assert.equal(backendErrorMessage("ko", "폴더 이름을 입력하세요", detail), "폴더 이름을 입력하세요");
});

test("영어는 코드로 자기 문구를 고르고 파라미터를 끼운다", () => {
  assert.equal(
    backendErrorMessage("en", "폴더는 5단계까지만 중첩할 수 있습니다", { code: "SESSION_FOLDER_DEPTH_EXCEEDED", params: { max: "5" } }),
    "Folders can be nested up to 5 levels.",
  );
});

test("제3언어는 아직 영어 정본으로 떨어진다", () => {
  assert.equal(
    backendErrorMessage("ja", "폴더 이름을 입력하세요", { code: "SESSION_FOLDER_NAME_REQUIRED", params: {} }),
    "Enter a folder name.",
  );
});

test("모르는 코드는 백엔드 문장으로 떨어진다", () => {
  assert.equal(backendErrorMessage("en", "알 수 없는 실패", { code: "NOT_IN_TABLE", params: {} }), "알 수 없는 실패");
});

test("값이 없는 자리는 지우지 않고 그대로 둔다", () => {
  assert.equal(
    backendErrorMessage("en", "원문", { code: "SESSION_FOLDER_DEPTH_EXCEEDED", params: {} }),
    "Folders can be nested up to {max} levels.",
  );
});

test("던질 오류는 현재 언어로 문구를 정하고 코드를 남긴다", () => {
  setBackendErrorLocale("en");
  const error = backendError(
    { error: "폴더 이름을 입력하세요", code: "SESSION_FOLDER_NAME_REQUIRED" },
    "폴더 이름을 입력하세요",
  );
  assert.ok(error instanceof BackendCodedError);
  assert.equal(error.message, "Enter a folder name.");
  assert.equal(error.code, "SESSION_FOLDER_NAME_REQUIRED");
  setBackendErrorLocale("ko");
  assert.equal(backendError({ error: "폴더 이름을 입력하세요", code: "SESSION_FOLDER_NAME_REQUIRED" }, "폴더 이름을 입력하세요").message, "폴더 이름을 입력하세요");
});

test("코드가 없으면 평범한 오류다", () => {
  const error = backendError({ error: "잘못된 입력입니다" }, "잘못된 입력입니다");
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof BackendCodedError));
});
