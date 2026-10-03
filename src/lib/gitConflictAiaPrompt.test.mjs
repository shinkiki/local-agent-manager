import assert from "node:assert/strict";
import test from "node:test";
import { gitConflictAiaPrompt } from "./gitConflictAiaPrompt.ts";

test("C16 충돌 해결 요청은 프로젝트와 파일을 싣고 파괴적 명령을 금지한다", () => {
  const prompt = gitConflictAiaPrompt({
    projectPath: "/workspace/alpha",
    operation: "rebase",
    conflictedFiles: ["src/a.ts", "README.md"],
    blockedFiles: ["local.txt"],
  });

  assert.match(prompt, /\/workspace\/alpha/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /local\.txt/);
  assert.match(prompt, /reset --hard/);
  assert.doesNotMatch(prompt, /stderr|stdout|원격 URL/);
});
