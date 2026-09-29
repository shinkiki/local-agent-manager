import assert from "node:assert/strict";
import test from "node:test";
import {
  isSkillToolName,
  launchedSkillName,
  parseInjectedSkillBody,
  parseSkillInvocation,
  skillContextLabelName,
  skillPathNames,
} from "./skillUsageParse.ts";

/**
 * 대화 원문에서 "스킬을 썼다"를 읽어 내는 문법의 경계. 합치기(`skillUsage`) 쪽은 이미
 * 시험이 있지만, 문자열 하나를 조각으로 가르는 이 자리는 주입 레코드 둘 말고는 직접
 * 붙잡힌 적이 없었다. 여기서 틀리면 실행한 적 없는 스킬이 사용 스킬 카드에 오르거나,
 * 실제로 실행한 스킬이 카드에서 빠진다.
 */

test("도구 이름 판정은 앞뒤 공백과 대소문자를 무시하되 다른 이름은 받지 않는다", () => {
  assert.equal(isSkillToolName("skill"), true);
  assert.equal(isSkillToolName("  Skill "), true);
  assert.equal(isSkillToolName("SKILL"), true);
  assert.equal(isSkillToolName("skills"), false);
  assert.equal(isSkillToolName("Bash"), false);
  assert.equal(isSkillToolName(undefined), false);
});

test("온전한 도구 인자에서 이름과 지시를 읽는다", () => {
  assert.deepEqual(
    parseSkillInvocation('{"skill":"dataviz","args":"막대 그래프"}'),
    { name: "dataviz", args: "막대 그래프" },
  );
  assert.deepEqual(parseSkillInvocation('  {"skill":" dataviz "}  '), { name: "dataviz", args: "" });
  assert.deepEqual(parseSkillInvocation(""), { name: "", args: "" });
  assert.deepEqual(parseSkillInvocation("   "), { name: "", args: "" });
});

test("문자열이 아닌 값은 이름으로 쓰지 않는다 — 카드에 자리표시자가 오르지 않게", () => {
  assert.deepEqual(parseSkillInvocation('{"skill":123,"args":null}'), { name: "", args: "" });
  assert.deepEqual(parseSkillInvocation('{"skill":{"name":"x"}}'), { name: "", args: "" });
});

test("스트리밍이 끊긴 부분 JSON에서도 이름은 알려 준다", () => {
  // 인자가 끝나기 전에 끊긴 조각. JSON.parse는 실패하고 되짚기가 이름을 건진다.
  assert.equal(parseSkillInvocation('{"skill":"dataviz","args":"막대').name, "dataviz");
  // 이름 자체가 끊겼으면 건질 것이 없다.
  assert.equal(parseSkillInvocation('{"skill":"data').name, "");
});

test("온전한 JSON에서는 지시에 섞인 skill 글자가 이름이 되지 않는다", () => {
  // 본문에 '"skill": "가짜"'를 품은 지시. 되짚기만 있었다면 가짜가 이름이 됐다.
  const detail = JSON.stringify({ args: '문서에 "skill": "가짜" 라고 적혀 있다' });
  assert.equal(parseSkillInvocation(detail).name, "");
});

test("확인 문장은 첫 줄까지만 이름으로 보고, 빈 이름은 못 얻은 것과 같다", () => {
  assert.equal(launchedSkillName("Launching skill: dataviz"), "dataviz");
  assert.equal(launchedSkillName("\n  Launching skill: dataviz\n본문"), "dataviz");
  assert.equal(launchedSkillName("Launching skill: "), null);
  assert.equal(launchedSkillName("Launching skill:"), null);
  assert.equal(launchedSkillName("스킬을 실행합니다: dataviz"), null);
  assert.equal(launchedSkillName(undefined), null);
});

test("주입 레코드는 앞머리가 있을 때만 디렉터리를 가른다", () => {
  assert.deepEqual(
    parseInjectedSkillBody("Base directory for this skill: /a/b\n\n# 제목"),
    { directory: "/a/b", body: "# 제목" },
  );
  // 앞머리만 있고 본문이 없는 레코드.
  assert.deepEqual(
    parseInjectedSkillBody("Base directory for this skill: /a/b"),
    { directory: "/a/b", body: "" },
  );
  assert.deepEqual(parseInjectedSkillBody("# 제목"), { directory: "", body: "# 제목" });
});

test("라벨의 빈 이름은 null과 구분된다 — 레코드는 있었으나 붙일 이름이 없다는 뜻", () => {
  assert.equal(skillContextLabelName("사용 스킬 · dataviz"), "dataviz");
  assert.equal(skillContextLabelName("사용 스킬 · "), "");
  assert.equal(skillContextLabelName("사용 스킬 · dataviz\n둘째 줄"), "dataviz");
  assert.equal(skillContextLabelName("도구 결과"), null);
});

test("도구 인자 안의 SKILL.md 경로에서 스킬 이름을 읽는다 — 구분자는 둘 다", () => {
  assert.deepEqual(skillPathNames("cat ~/.claude/skills/dataviz/SKILL.md"), ["dataviz"]);
  // Windows 경로는 역슬래시로 온다. 이스케이프로 먹히지 않게 원문 그대로 적는다.
  assert.deepEqual(skillPathNames(String.raw`type C:\repo\skills\qa-round\SKILL.md`), ["qa-round"]);
  // 같은 이름이 여러 번 나와도 한 번만. 서로 다른 이름은 나온 차례대로.
  assert.deepEqual(
    skillPathNames("skills/a/SKILL.md skills/b/SKILL.md skills/a/SKILL.md"),
    ["a", "b"],
  );
  assert.deepEqual(skillPathNames("아무 경로도 없는 인자"), []);
});

/**
 * 실행하지 않은 자리표시자가 사용 스킬 카드에 오르지 않게 하는 경계. 이름 자리는 실제
 * 디렉터리 이름의 글자만 받으므로, 저장소를 훑는 글롭도 경로를 조립하는 템플릿 문자열도
 * 스킬 실행으로 보이지 않는다.
 */
test("글롭과 템플릿 문자열은 스킬 실행으로 잡지 않는다", () => {
  assert.deepEqual(skillPathNames("grep -r skills/*/SKILL.md"), []);
  assert.deepEqual(skillPathNames("const p = `skills/${name}/SKILL.md`"), []);
  assert.deepEqual(skillPathNames("skills/<이름>/SKILL.md"), []);
  // 이름이 하이픈이나 점으로 시작하는 자리도 디렉터리 이름이 아니다.
  assert.deepEqual(skillPathNames("skills/-tmp/SKILL.md"), []);
  assert.deepEqual(skillPathNames("skills/.hidden/SKILL.md"), []);
});
