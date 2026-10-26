import assert from "node:assert/strict";
import test from "node:test";

import { commandLines } from "./sshCommandRules.ts";

test("C9-13 명령 규칙은 백엔드처럼 공백을 자르고 빈 줄과 중복을 접는다", () => {
  assert.deepEqual(commandLines("  git pull  \n\ngit pull\nls"), ["git pull", "ls"]);
  assert.deepEqual(commandLines(""), []);
  assert.deepEqual(commandLines(" \n\t\n"), []);
});

test("중복을 접어도 처음 나온 순서를 지킨다", () => {
  assert.deepEqual(commandLines("ls\ncat\nls\ndf"), ["ls", "cat", "df"]);
});
