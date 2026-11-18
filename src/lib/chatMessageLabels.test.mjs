import assert from "node:assert/strict";
import test from "node:test";

import { chatMessageRoleLabel } from "./chatMessageLabels.ts";
import { setRuntimeLocale } from "./i18nRuntime.ts";

test("한국어 화면에서는 역할별 이름표를 한국어로 짓는다", () => {
  setRuntimeLocale("ko", {});
  assert.equal(chatMessageRoleLabel("assistant", "message"), "에이전트");
  assert.equal(chatMessageRoleLabel("user", "message"), "사용자");
  assert.equal(chatMessageRoleLabel("system", "message"), "시스템");
  assert.equal(chatMessageRoleLabel("assistant", "reasoning"), "진행 상황");
});

test("영어 화면에서는 메뉴 이름이 아니라 단수 역할 이름을 쓴다", () => {
  setRuntimeLocale("en", {});
  try {
    assert.equal(chatMessageRoleLabel("assistant", "message"), "Agent");
    assert.equal(chatMessageRoleLabel("user", "message"), "User");
    assert.equal(chatMessageRoleLabel("system", "message"), "System");
    assert.equal(chatMessageRoleLabel("user", "reasoning"), "Progress");
  } finally {
    setRuntimeLocale("ko", {});
  }
});

test("진행 상황은 역할보다 앞서고, 모르는 역할은 에이전트로 본다", () => {
  setRuntimeLocale("ko", {});
  assert.equal(chatMessageRoleLabel("system", "reasoning"), "진행 상황");
  assert.equal(chatMessageRoleLabel("tool", "message"), "에이전트");
});

test("제3 언어는 번역 대응표를 먼저 보고, 없으면 영어 짝으로 돌아간다", () => {
  setRuntimeLocale("ja", { "사용자": "ユーザー" });
  try {
    assert.equal(chatMessageRoleLabel("user", "message"), "ユーザー");
    assert.equal(chatMessageRoleLabel("assistant", "message"), "Agent");
  } finally {
    setRuntimeLocale("ko", {});
  }
});
