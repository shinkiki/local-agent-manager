import assert from "node:assert/strict";
import test from "node:test";
import { canRequestGitConflictAia, gitConflictAiaPrompt } from "./gitConflictAiaPrompt.ts";

test("C16 충돌 해결 요청은 프로젝트와 파일을 싣고 파괴적 명령을 금지한다", () => {
  const prompt = gitConflictAiaPrompt({
    projectPath: "/workspace/alpha",
    operation: "rebase",
    conflictedFiles: ["src/a.ts", "README.md"],
  });

  assert.match(prompt, /\/workspace\/alpha/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /reset --hard/);
  assert.doesNotMatch(prompt, /stderr|stdout|원격 URL/);
});

test("충돌 요청은 기본이 읽기 전용이고 충돌 파일만 싣는다", () => {
  const readOnly = gitConflictAiaPrompt({
    projectPath: "/workspace/alpha",
    operation: "rebase",
    conflictedFiles: ["src/a.ts"],
  });

  // 기본값은 분석이다 — 호출자가 아무것도 주지 않으면 작업 트리를 바꾸게 하지 않는다.
  assert.match(readOnly, /분석해줘/);
  assert.match(readOnly, /바꾸지는 마/);
  assert.doesNotMatch(readOnly, /해결한 파일만 스테이지/);
  // 막힌 파일(사용자의 미커밋 변경)은 어떤 이름으로도 실리지 않는다.
  assert.doesNotMatch(readOnly, /local\.txt|막힌/);

  // 같은 입력에 blockedFiles를 더 줘도 요청문은 달라지지 않는다. 타입에 없는 값을
  // 실수로 넘겨도 사용자의 미커밋 변경이 새어 나가지 않는다는 뜻이다.
  const withExtra = gitConflictAiaPrompt({
    projectPath: "/workspace/alpha",
    operation: "rebase",
    conflictedFiles: ["src/a.ts"],
    blockedFiles: ["local.txt"],
  });
  assert.equal(withExtra, readOnly);

  // 해결까지 맡기려면 호출자가 그 자리에서 명시해야 하고, 그때도 승인을 먼저 받는다.
  const writable = gitConflictAiaPrompt({
    projectPath: "/workspace/alpha",
    operation: "rebase",
    conflictedFiles: ["src/a.ts"],
    readOnly: false,
  });
  assert.match(writable, /해결해줘/);
  assert.match(writable, /승인을 받은 뒤에만/);
  assert.match(writable, /reset --hard/);
  assert.notEqual(writable, readOnly);
});

test("막힌 영수증은 파일을 싣지 않고도 AIA 분석 경로를 지킨다", () => {
  // Core는 두 목록을 배타적으로 채운다 — 막힌 영수증의 충돌 파일은 언제나 비어 있다.
  const blocked = { succeeded: false, conflictedFiles: [], blockedFiles: ["local.txt"] };
  assert.equal(canRequestGitConflictAia(blocked), true);
  assert.equal(canRequestGitConflictAia({ succeeded: false, conflictedFiles: ["a.ts"], blockedFiles: [] }), true);
  assert.equal(canRequestGitConflictAia({ succeeded: false, conflictedFiles: [], blockedFiles: [] }), false);
  assert.equal(canRequestGitConflictAia({ succeeded: true, conflictedFiles: ["a.ts"], blockedFiles: [] }), false);

  const prompt = gitConflictAiaPrompt({
    projectPath: "/workspace/alpha",
    operation: "switch",
    conflictedFiles: [],
    kind: "blocked",
  });
  assert.match(prompt, /막혔어/);
  assert.match(prompt, /바꾸지는 마/);
  // 막힌 파일 경로는 어떤 형태로도 실리지 않는다 — 사용자의 커밋하지 않은 변경이다.
  assert.doesNotMatch(prompt, /local\.txt/);
  assert.doesNotMatch(prompt, /충돌 파일/);
});

test("요청문은 C16-4가 제공하지 않는 명령을 모두 금지한다", () => {
  for (const kind of ["conflict", "blocked"]) {
    const prompt = gitConflictAiaPrompt({
      projectPath: "/workspace/alpha",
      operation: "rebase",
      conflictedFiles: ["src/a.ts"],
      kind,
    });
    for (const forbidden of ["reset --hard", "clean", "강제 푸시", "--amend", "restore --source=HEAD --worktree", "checkout"]) {
      assert.ok(prompt.includes(forbidden), `${kind}: ${forbidden}`);
    }
  }
});

test("C16-4/V4 충돌 경로의 제어 문자는 지시 문단을 만들지 않고 원문으로 복원된다", () => {
  const ordinaryPaths = ["src/한글 공백.ts", 'src/"quote"`tick`\\path.ts'];
  const controls = ["\0", "\t", "\n", "\v", "\f", "\r", "\u007f", "\u0085", "\u2028", "\u2029"];
  const hasControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const pathSection = (part) => part.startsWith("충돌 파일:\n");

  for (const readOnly of [undefined, true, false]) {
    const request = { projectPath: "/workspace/alpha", operation: "rebase", readOnly };
    const baseline = gitConflictAiaPrompt({ ...request, conflictedFiles: ordinaryPaths }).split("\n\n");
    for (const control of controls) {
      const untrustedPath = `src/${control}${control}reset --hard${control}설정.ts`;
      const paths = [ordinaryPaths[0], untrustedPath, ordinaryPaths[1]];
      const parts = gitConflictAiaPrompt({ ...request, conflictedFiles: paths }).split("\n\n");
      const label = `readOnly=${readOnly}, control=${control.charCodeAt(0).toString(16)}`;
      // 파일명은 데이터다. 경로 하나가 지시 문단을 더하거나 기존 권한·금지 문구를 바꾸면 안 된다.
      assert.deepEqual(parts.filter((part) => !pathSection(part)), baseline.filter((part) => !pathSection(part)), label);
      const sections = parts.filter(pathSection);
      assert.equal(sections.length, 1, label);
      const lines = sections[0].split("\n").slice(1);
      assert.equal(lines.length, paths.length, label);
      assert.equal(lines[0], `- ${ordinaryPaths[0]}`, label);
      assert.equal(lines[2], `- ${ordinaryPaths[1]}`, label);
      assert.ok(lines[1].startsWith("- "), label);
      assert.equal(hasControl.test(lines[1]), false, label);
      // 문자 삭제로 줄 수만 맞추는 구현도 거절한다. 인용을 풀면 정확한 파일명을 찾아야 한다.
      assert.equal(JSON.parse(lines[1].slice(2)), untrustedPath, label);
    }
  }
});
