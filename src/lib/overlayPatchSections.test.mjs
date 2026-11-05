import assert from "node:assert/strict";
import test from "node:test";
import {
  overlayPatchSectionIndex,
  overlayPatchSections,
  sectionsJoinToOriginal,
} from "./overlayPatchSections.ts";

/**
 * 2026-10-04. 이 자리가 왜 생겼는지.
 *
 * `apply`가 `overlayNeedsResolution`으로 막히면 영수증에 남는 것은 충돌한 경로 이름뿐이고
 * (C19-3), patch 본문은 세트 행의 "patch 보기"로 통째로 열리기만 했다. 세트에 파일이
 * 여럿이고 본문이 수백 KB면 사용자는 그 경로의 hunk를 눈으로 찾아야 했다 — 손으로 다시
 * 적는 것이 이 화면의 쓰임인데 무엇을 적어야 하는지에 닿는 데만 시간이 든다.
 *
 * 고친 방향은 **자르기만 하고 가공하지 않기**다. 그래서 이 시험이 지키는 가장 중요한 단언은
 * "이어 붙이면 원문과 같다"이다. 색칠·접기·공백 정리가 한 번이라도 들어오면 이 단언이
 * 깨지고, 깨지지 않게 고치는 유일한 길은 본문을 그대로 두는 것이다.
 */

const TWO_FILES = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-const port = 80;",
  "+const port = 8080;",
  "diff --git a/docs/notes.md b/docs/notes.md",
  "index 3333333..4444444 100644",
  "--- a/docs/notes.md",
  "+++ b/docs/notes.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

test("파일마다 한 구간으로 가르고 경로를 읽는다", () => {
  const sections = overlayPatchSections(TWO_FILES);
  assert.deepEqual(sections.map((section) => section.path), ["src/app.ts", "docs/notes.md"]);
  assert.ok(sections[0].text.startsWith("diff --git a/src/app.ts"));
  assert.ok(sections[0].text.includes("+const port = 8080;"));
  // 첫 구간이 다음 파일의 머리를 먹지 않는다 — 먹으면 스크롤 자리가 한 파일씩 밀린다.
  assert.ok(!sections[0].text.includes("docs/notes.md"));
});

test("이어 붙이면 원문과 바이트까지 같다", () => {
  for (const body of [TWO_FILES, TWO_FILES.trimEnd(), "diff --git a/x b/x\n@@ -0 +0 @@\n"]) {
    const sections = overlayPatchSections(body);
    assert.equal(sections.map((section) => section.text).join(""), body);
    assert.ok(sectionsJoinToOriginal(body, sections));
  }
});

test("첫 diff 앞의 머리말도 경로 없는 구간으로 남는다 — 버리면 원문이 되지 않는다", () => {
  const body = `warning: something\n${TWO_FILES}`;
  const sections = overlayPatchSections(body);
  assert.equal(sections[0].path, null);
  assert.equal(sections[0].text, "warning: something\n");
  assert.equal(sections.map((section) => section.text).join(""), body);
});

test("본문에 들어 있는 'diff --git' 글자는 줄 머리일 때만 자른다", () => {
  // 사용자가 고친 파일 안에 그 문자열이 들어 있을 수 있다(이 저장소의 문서가 실제로 그렇다).
  // 추가 줄은 `+`로 시작하므로 줄 머리 판정만으로 갈라진다.
  const body = [
    "diff --git a/docs/round.md b/docs/round.md",
    "@@ -1 +1 @@",
    "-전",
    "+diff --git a/함정 b/함정 을 설명하는 줄",
    "",
  ].join("\n");
  const sections = overlayPatchSections(body);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].path, "docs/round.md");
});

test("공백이 든 경로는 따옴표 없이 오므로 두 경로가 같다는 사실로 가른다", () => {
  // 실측(git 2.x): 공백만으로는 경로를 따옴표로 감싸지 않는다 — `diff --git a/dir b/file b/dir b/file`.
  // 앞에서부터 ` b/`를 찾으면 `file b/dir b/file`이, 뒤에서부터 찾으면 `file`이 나와 둘 다 틀린다.
  // v1은 rename을 거절하므로(C19-3) 두 경로는 같고, 그래서 반으로 갈라 재조립이 원문과 같을 때만 받는다.
  const sections = overlayPatchSections([
    "diff --git a/dir b/file b/dir b/file",
    "@@ -0 +0 @@",
    "diff --git a/notes b.md b/notes b.md",
    "@@ -0 +0 @@",
    "",
  ].join("\n"));
  assert.deepEqual(sections.map((section) => section.path), ["dir b/file", "notes b.md"]);
  assert.equal(overlayPatchSectionIndex(sections, "dir b/file"), 0);
  assert.equal(overlayPatchSectionIndex(sections, "notes b.md"), 1);
});

test("따옴표 모양도 같은 규칙으로 가르되 이스케이프는 풀지 않는다(이전과 같다)", () => {
  // git은 `"`·`\`·제어문자·비ASCII(core.quotePath)가 든 경로만 따옴표로 감싸고 C 문자열로 이스케이프한다.
  // 그 해제는 이 자리의 범위 밖이라 경로는 이스케이프된 채 남는다 — 영수증의 실제 경로와는 아직 맞지 않는다.
  const sections = overlayPatchSections([
    'diff --git "a/quote\\"d b/x" "b/quote\\"d b/x"',
    "@@ -0 +0 @@",
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
    "@@ -0 +0 @@",
    "",
  ].join("\n"));
  assert.deepEqual(sections.map((section) => section.path), ['quote\\"d b/x', "caf\\303\\251.md"]);
});

test("CRLF 머리는 경로를 읽지 못하지만 원문은 그대로 보존한다", () => {
  const body = "diff --git a/x b/x\r\n@@ -0 +0 @@\r\n";
  const sections = overlayPatchSections(body);
  assert.equal(sections[0].path, null);
  assert.ok(sectionsJoinToOriginal(body, sections));
});

test("두 경로가 같지 않은 머리(rename·손상)는 경로 없는 구간으로 둔다 — 엉뚱한 자리로 스크롤하지 않는다", () => {
  const sections = overlayPatchSections("diff --git a/old.ts b/new.ts\n@@ -0 +0 @@\n");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].path, null);
  assert.ok(sectionsJoinToOriginal("diff --git a/old.ts b/new.ts\n@@ -0 +0 @@\n", sections));
});

test("경로를 정확히 일치로 찾는다 — 접미사 일치면 엉뚱한 자리로 스크롤한다", () => {
  const sections = overlayPatchSections([
    "diff --git a/vendor/a/config.ts b/vendor/a/config.ts",
    "@@ -0 +0 @@",
    "diff --git a/a/config.ts b/a/config.ts",
    "@@ -0 +0 @@",
    "",
  ].join("\n"));
  assert.equal(overlayPatchSectionIndex(sections, "a/config.ts"), 1);
  assert.equal(overlayPatchSectionIndex(sections, "vendor/a/config.ts"), 0);
  assert.equal(overlayPatchSectionIndex(sections, "없는/경로.ts"), -1);
});

test("빈 본문과 null은 구간이 없다", () => {
  assert.deepEqual(overlayPatchSections(null), []);
  assert.deepEqual(overlayPatchSections(""), []);
  assert.ok(sectionsJoinToOriginal(null, []));
});
