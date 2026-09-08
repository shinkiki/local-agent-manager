import assert from "node:assert/strict";
import test from "node:test";

import {
  collectChatSkillUsages,
  collectTranscriptSkillUsages,
  isSkillUsageBlock,
  isSkillUsageEntry,
  matchSkillLibraryEntry,
  parseInjectedSkillBody,
  skillUsageNamePreview,
} from "./skillUsage.ts";

test("라이브 채팅의 Skill 도구 호출에서 이름·지시·상태를 뽑는다", () => {
  const usages = collectChatSkillUsages([
    { type: "message", id: "m1", role: "assistant", kind: "reasoning", text: "생각" },
    {
      type: "tool",
      id: "toolu_1",
      name: "Skill",
      status: "completed",
      detail: '{"skill": "claude-api", "args": "모델별 가격 확인"}',
      output: "Launching skill: claude-api",
    },
  ]);
  assert.equal(usages.length, 1);
  assert.deepEqual(
    { name: usages[0].name, args: usages[0].args, status: usages[0].status, detection: usages[0].detection },
    { name: "claude-api", args: "모델별 가격 확인", status: "completed", detection: "tool" },
  );
});

test("인자 스트리밍이 끝나기 전에도 부분 JSON에서 이름을 알려 준다", () => {
  const usages = collectChatSkillUsages([
    { type: "tool", id: "toolu_2", name: "Skill", status: "running", detail: '{"skill": "dataviz", "args": "차트', output: "" },
  ]);
  assert.equal(usages[0].name, "dataviz");
  assert.equal(usages[0].status, "running");
});

test("전용 도구가 없는 공급자는 SKILL.md를 직접 읽은 경로로 찾는다", () => {
  const usages = collectChatSkillUsages([
    { type: "tool", id: "exec-1", name: "shell", status: "completed", detail: '{"command": "cat /Users/me/.codex/skills/kbfps-hrm/SKILL.md"}', output: "" },
  ]);
  assert.equal(usages.length, 1);
  assert.deepEqual({ name: usages[0].name, detection: usages[0].detection }, { name: "kbfps-hrm", detection: "path" });
});

test("스킬 디렉터리를 가리키지 않는 SKILL.md 언급은 사용 스킬이 아니다", () => {
  const usages = collectChatSkillUsages([
    { type: "tool", id: "exec-2", name: "shell", status: "completed", detail: '{"command": "rg -n SKILL.md src"}', output: "" },
  ]);
  assert.equal(usages.length, 0);
});

test("같은 스킬이 도구 호출·경로 양쪽에서 잡히면 한 항목으로 모은다", () => {
  const usages = collectChatSkillUsages([
    { type: "tool", id: "exec-3", name: "shell", status: "completed", detail: '{"command": "cat ~/.claude/skills/split-commit/SKILL.md"}', output: "" },
    { type: "tool", id: "toolu_3", name: "Skill", status: "completed", detail: '{"skill": "split-commit", "args": "기능별 커밋"}', output: "" },
  ]);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].detection, "tool");
  assert.equal(usages[0].args, "기능별 커밋");
});

test("트랜스크립트는 실행 블록과 주입된 SKILL.md를 한 항목으로 합친다", () => {
  const usages = collectTranscriptSkillUsages([
    {
      index: 4,
      role: "assistant",
      timestamp: 1,
      model: null,
      typeLabel: null,
      usage: null,
      blocks: [{ kind: "tool_use", name: "Skill", inputJson: '{"skill": "kbfps-hrm", "args": "QA 1건"}' }],
    },
    {
      index: 5,
      role: "user",
      timestamp: 2,
      model: null,
      typeLabel: null,
      usage: null,
      blocks: [{ kind: "tool_result", text: "Launching skill: kbfps-hrm", isError: false }],
    },
    {
      index: 6,
      role: "meta",
      timestamp: 3,
      model: null,
      typeLabel: "사용 스킬 · kbfps-hrm",
      usage: null,
      blocks: [{
        kind: "context",
        label: "사용 스킬 · kbfps-hrm",
        text: "Base directory for this skill: /Users/me/.claude/skills/kbfps-hrm\n\n# QA 회차\n\n본문",
      }],
    },
  ]);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].name, "kbfps-hrm");
  assert.equal(usages[0].args, "QA 1건");
  assert.equal(usages[0].directory, "/Users/me/.claude/skills/kbfps-hrm");
  assert.match(usages[0].body, /^# QA 회차/);
});

test("주입 레코드만 남은 세션도 사용 스킬로 보여준다", () => {
  const usages = collectTranscriptSkillUsages([
    {
      index: 9,
      role: "meta",
      timestamp: 1,
      model: null,
      typeLabel: "사용 스킬 · dataviz",
      usage: null,
      blocks: [{ kind: "context", label: "사용 스킬 · dataviz", text: "Base directory for this skill: /skills/dataviz\n본문" }],
    },
  ]);
  assert.deepEqual(usages.map((usage) => usage.name), ["dataviz"]);
});

test("사용 스킬 카드가 대신 보여주는 블록만 작업 로그에서 빠진다", () => {
  assert.equal(isSkillUsageBlock({ kind: "tool_use", name: "Skill", inputJson: "{}" }), true);
  assert.equal(isSkillUsageBlock({ kind: "tool_result", text: "Launching skill: dataviz", isError: false }), true);
  assert.equal(isSkillUsageBlock({ kind: "tool_use", name: "Bash", inputJson: "{}" }), false);
  // SKILL.md를 직접 읽은 셸 명령은 그 자체로 도구 실행이므로 로그에 남는다.
  assert.equal(isSkillUsageBlock({ kind: "tool_use", name: "shell", inputJson: '{"command": "cat ~/.codex/skills/a/SKILL.md"}' }), false);
  assert.equal(isSkillUsageEntry({ type: "tool", id: "t", name: "skill" }), true);
  assert.equal(isSkillUsageEntry({ type: "tool", id: "t", name: "Read" }), false);
});

test("주입 본문은 기준 디렉터리 줄과 본문으로 나뉜다", () => {
  assert.deepEqual(parseInjectedSkillBody("Base directory for this skill: /a/b\n\n# 제목"), {
    directory: "/a/b",
    body: "# 제목",
  });
  assert.deepEqual(parseInjectedSkillBody("# 제목"), { directory: "", body: "# 제목" });
});

test("스킬 목록 조회는 플러그인·디렉터리 접두를 떼고 맞춘다", () => {
  const entries = [
    { key: "dataviz", name: "dataviz", directoryName: "dataviz" },
    { key: "deploy", name: "Deploy", directoryName: "deploy" },
  ];
  assert.equal(matchSkillLibraryEntry(entries, "plugin:dataviz")?.key, "dataviz");
  assert.equal(matchSkillLibraryEntry(entries, "apps/web:deploy")?.key, "deploy");
  assert.equal(matchSkillLibraryEntry(entries, "unknown"), null);
});

test("카드 머리의 이름 미리보기는 중복을 지우고 개수로 줄인다", () => {
  const usage = (name) => ({ id: name, name, args: "", status: "completed", directory: "", body: "", detection: "tool" });
  assert.equal(skillUsageNamePreview([usage("a"), usage("a"), usage("b")]), "a, b");
  assert.equal(skillUsageNamePreview([usage("a"), usage("b"), usage("c"), usage("d")]), "a, b, c 외 1개");
});
