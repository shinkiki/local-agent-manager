import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { classifyShell, extract, labelTurn } from "../../local-llm-dev/finetune/export-aia-routing.mjs";

// M11 11.2: 티어 규칙은 "무엇을 만졌나" 로 가른다. 조회는 3티어가 직접, 변경은 1티어에 넘긴다.
test("셸 명령은 읽기만 하는 것과 바꾸는 것을 가른다", () => {
  assert.equal(classifyShell("git log --oneline -5"), "direct");
  assert.equal(classifyShell("nvidia-smi --query-gpu=utilization.gpu --format=csv"), "direct");
  assert.equal(classifyShell("git commit -m '고침'"), "delegate");
  assert.equal(classifyShell("cargo test --workspace"), "delegate");
  // 읽기로 시작해도 결과를 파일로 흘리면 바꾸는 명령이다.
  assert.equal(classifyShell("cat a.txt > b.txt"), "delegate");
  assert.equal(classifyShell(""), "delegate");
});

test("한 턴에 변경이 하나라도 섞이면 위임이다", () => {
  assert.equal(labelTurn([{ name: "mcp__aia_system__system_read" }]), "direct");
  assert.equal(labelTurn([{ name: "Read" }, { name: "Grep" }]), "direct");
  assert.equal(labelTurn([{ name: "Read" }, { name: "Edit" }]), "delegate");
  assert.equal(labelTurn([{ name: "Bash", command: "ls -al" }]), "direct");
  assert.equal(labelTurn([{ name: "Bash", command: "npm run check" }]), "delegate");
  assert.equal(labelTurn([]), null, "도구를 안 쓴 턴은 라벨이 없다");
});

/** 전사 한 줄을 만든다. */
const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const assistant = (blocks) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
const call = (name, input = {}) => ({ type: "tool_use", name, input });

test("전사에서 (요청, 직전 응답, 라벨) 을 뽑는다", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "routing-")), "t.jsonl");
  fs.writeFileSync(file, [
    user("세션 목록 보여줘"),
    assistant([{ type: "text", text: "목록을 봅니다." }, call("mcp__aia_system__system_read", { operation: "list_sessions" })]),
    // 도구 결과만 담긴 user 줄은 새 요청이 아니다.
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    assistant([{ type: "text", text: "세 건입니다. 어느 쪽으로 할까요?" }]),
    user("진행"),
    assistant([call("Edit", { file_path: "a.rs" })]),
    user("A 와 B 중 어느 게 나은지 알려줘"),
    assistant([{ type: "text", text: "둘 다 됩니다. 어느 쪽을 쓸지 정해 주세요." }]),
  ].join("\n") + "\n", "utf8");

  const items = extract(file);
  assert.deepEqual(items.map((i) => i.label), ["direct", "delegate", "human"]);
  assert.deepEqual(items[0].operations, ["list_sessions"]);
  assert.equal(items[1].request, "진행");
  assert.match(items[1].prior, /어느 쪽으로 할까요/, "짧은 요청은 직전 응답이 있어야 뜻이 선다");
  assert.equal(items[0].source, "t");
});

test("그림만 붙인 요청과 도구 없이 답만 한 턴은 뺀다", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "routing-")), "t.jsonl");
  fs.writeFileSync(file, [
    user("[Image: shot.png]"),
    assistant([call("Read", { file_path: "a.rs" })]),
    user("고마워"),
    assistant([{ type: "text", text: "천만에요." }]),
  ].join("\n") + "\n", "utf8");
  assert.deepEqual(extract(file), []);
});
