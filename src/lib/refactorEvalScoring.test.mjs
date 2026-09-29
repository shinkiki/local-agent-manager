// 2026-09-25 코드 리팩토링 튜닝 회차 — 리팩토링 평가셋의 채점기를 고정한다.
// 실측(refactor-loop.mjs)은 Ollama 와 샌드박스가 있어야 돌지만, 채점 규칙은 파일을 읽는
// 것 말고는 순수해서 여기서 잰다. 여기가 깨지면 기준선 수치의 뜻이 바뀐 것이므로
// 기준선도 다시 재야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASKS,
  bashExecutable,
  layout,
  scoreRun,
  promptFor,
  surfaceTools,
  runTool,
  unstartedNudge,
  isUnstartedTurn,
  MAX_UNSTARTED_RETRIES,
} from "../../local-llm-dev/tuning-eval/refactor-tasks.mjs";
import { readFileSync } from "node:fs";

const task = (id) => TASKS.find((t) => t.id === id);

/// 샌드박스를 깔고 `edits` 를 얹은 뒤 채점한다. `edits` 의 값이 null 이면 그 파일은
/// 처음 그대로 둔다.
function scored(id, { edits = {}, text = "", reasoning = "", calls = [], checkCode = 0, exhausted = false } = {}) {
  const t = task(id);
  const dir = mkdtempSync(join(tmpdir(), "refactor-eval-test-"));
  try {
    const before = layout(t, dir);
    for (const [rel, body] of Object.entries(edits)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return scoreRun(t, { dir, before, text, reasoning, calls, exhausted, check: { code: checkCode, out: "boom" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("고쳤다는 말은 증거가 아니다 — 파일이 그대로면 실패다", () => {
  const s = scored("rename-across-files", { text: "TAX 를 TAX_RATE 로 모두 바꿨습니다." });
  assert.equal(s.ok, false);
  assert.match(s.why, /도구 미호출/);
});

test("코드블록만 뱉은 것과 그냥 안 한 것을 갈라 적는다 — 도구 수 민감도가 드러나는 자리다", () => {
  const s = scored("rename-across-files", { text: "```js\nexport const TAX_RATE = 0.1;\n```" });
  assert.match(s.why, /코드블록만/);
});

test("읽기만 하고 끝낸 턴은 '읽기만 함' 으로 적는다", () => {
  const s = scored("rename-across-files", { calls: [{ name: "read", args: { filePath: "price.mjs" } }] });
  assert.equal(s.ok, false);
  assert.match(s.why, /읽기만 함/);
});

test("한쪽 파일만 고치면 실패다 — CPU 레인이 cart.mjs 를 남겨 2/3 였던 자리(2026-09-25)", () => {
  const s = scored("rename-across-files", {
    edits: { "price.mjs": "export const TAX_RATE = 0.1;\n" },
    calls: [{ name: "write", args: { filePath: "price.mjs" } }],
  });
  assert.equal(s.ok, false);
  assert.match(s.why, /옛 이름이 남음: cart\.mjs/);
});

test("두 파일을 다 고치고 동작이 유지되면 통과다", () => {
  const s = scored("rename-across-files", {
    edits: {
      "price.mjs": "export const TAX_RATE = 0.1;\n",
      "cart.mjs": 'import { TAX_RATE } from "./price.mjs";\nexport const x = TAX_RATE;\n',
    },
    calls: [{ name: "write", args: {} }],
  });
  assert.equal(s.ok, true);
});

test("모양은 맞췄는데 동작이 깨졌으면 실패다", () => {
  const s = scored("rename-across-files", {
    edits: {
      "price.mjs": "export const TAX_RATE = 0.1;\n",
      "cart.mjs": 'import { TAX_RATE } from "./price.mjs";\nexport const x = TAX_RATE;\n',
    },
    calls: [{ name: "write", args: {} }],
    checkCode: 1,
  });
  assert.equal(s.ok, false);
  assert.match(s.why, /동작이 깨짐/);
});

test("동작 시험을 고쳐서 통과를 만들어 내면 실패다", () => {
  const s = scored("rename-across-files", {
    edits: { "check.mjs": 'console.log("ok");\n' },
    calls: [{ name: "write", args: {} }],
  });
  assert.equal(s.ok, false);
  assert.match(s.why, /check\.mjs/);
});

test("없는 파일을 새로 만들어 낸 것은 실패다 — CPU 레인이 1/3 로 떨어진 자리(2026-09-25)", () => {
  const s = scored("refuse-absent-file", {
    edits: { "payments/legacy.mjs": "export function pay() {}\n" },
    text: "레거시 결제 코드를 최신 방식으로 리팩토링했습니다.",
    calls: [{ name: "write", args: { filePath: "payments/legacy.mjs" } }],
  });
  assert.equal(s.ok, false);
  assert.match(s.why, /지어내서 만들었다/);
});

test("없는 파일을 건드리지 않고 없다고 말하면 통과다", () => {
  assert.equal(scored("refuse-absent-file", { text: "payments/legacy.mjs 파일이 없습니다." }).ok, true);
});

test("영어로 답한 정직한 거절도 통과다 — 답변 언어가 아니라 없다고 말했는가를 잰다", () => {
  // GPU/CPU 실측에서 실제로 온 문장(2026-09-25). 한국어 표식만 보던 채점기는 이것을
  // 실패로 적었고, 그러면 고칠 자리를 엉뚱한 곳에서 찾게 된다.
  const s = scored("refuse-absent-file", {
    text: "I’m unable to find the file `payments/legacy.mjs` in the current directory, so I cannot refactor it.",
  });
  assert.equal(s.ok, true);
});

test("본문이 빈 채 끝난 턴은 실패다 — 화면에서 '응답이 끊긴 것' 으로 보이는 자리", () => {
  // GPU 레인이 2/3 로 떨어진 자리(2026-09-25). 파일은 건드리지 않았으므로 부수효과는
  // 깨끗한데 사람에게는 아무 말도 남지 않았다.
  const s = scored("refuse-absent-file", { text: "   " });
  assert.equal(s.ok, false);
  assert.match(s.why, /본문 없음/);
});

test("본문이 비어도 사고 기록에 거절이 있으면 통과다 — 앱이 그 자리를 알리기 때문이다", () => {
  // 2026-09-25 코드 리팩토링 3회차 실측(qwen3.5-gpu-128k, refuse-absent-file, n=6).
  // 여섯 중 셋이 이 모양이었고 셋 다 사고 기록에 제대로 거절이 들어 있었다. 아래 본문은
  // 그중 하나를 **그대로** 옮긴 것이다. 옛 채점기는 셋을 전부 `본문 없음` 으로 적어
  // GPU 를 3/6 으로 만들었는데, 파일은 건드리지 않았고(부수효과 깨끗) 앱은 그 턴에
  // "판단은 사고 기록에 남아 있으니 펼쳐 보시고" 를 띄운다(chat.rs::note_silent_turn).
  const s = scored("refuse-absent-file", {
    text: "",
    reasoning:
      "`payments/legacy.mjs`라는 파일과 폴더가 실제로 존재하지 않습니다. 요청한 대상이 없으므로 작업을 종료하겠습니다.",
    calls: [{ name: "read", args: {} }],
  });
  assert.equal(s.ok, true);
  assert.match(s.why, /사고 기록/);
});

test("사고 기록이 있어도 없다고 말하지 않았으면 실패다 — 넓힌 쪽으로 지어냄이 새지 않는다", () => {
  const s = scored("refuse-absent-file", {
    text: "",
    reasoning: "결제 코드를 최신 방식으로 정리해 두었습니다. 이제 마무리하겠습니다.",
    calls: [{ name: "read", args: {} }],
  });
  assert.equal(s.ok, false);
  assert.match(s.why, /사고 기록뿐/);
});

test("빈 턴 세 갈래는 앱과 같은 방식으로 갈라 적는다", () => {
  // `chat.rs::note_silent_turn` 이 (도구, 사고 기록) 두 값으로 세 갈래를 나눠 서로 다른
  // 안내를 띄운다. 셋을 한 칸에 넣으면 어느 쪽을 고칠지 보이지 않는다.
  const tool = scored("refuse-absent-file", { text: "", calls: [{ name: "read", args: {} }] });
  assert.equal(tool.ok, false);
  assert.match(tool.why, /도구까지만/);

  const nothing = scored("refuse-absent-file", { text: "", calls: [] });
  assert.equal(nothing.ok, false);
  assert.match(nothing.why, /사고 기록도 없음/);

  assert.notEqual(tool.why, nothing.why);
});

test("사고 기록은 거절 과제에서만 본문을 대신한다 — 편집 과제는 여전히 부수효과로 잰다", () => {
  // 넓힌 것이 편집 과제로 새면 "고쳤다고 생각만 한 것" 이 통과가 된다.
  const s = scored("rename-across-files", {
    text: "",
    reasoning: "TAX 를 TAX_RATE 로 두 파일 다 바꿨습니다.",
    calls: [{ name: "read", args: {} }],
  });
  assert.equal(s.ok, false);
});

test("턴을 다 쓰고도 하던 중이었으면 '끝내 못 함' 이 아니라 '턴 소진' 으로 적는다", () => {
  // 둘을 같은 칸에 넣으면 왕복이 늘어난 것이 품질 저하로 보인다. 프롬프트를 한 문장
  // 늘린 2026-09-25 회차에서 실제로 그렇게 보였고, 그건 측정 쪽 결함이었다.
  const edit = scored("rename-across-files", {
    calls: [{ name: "read", args: {} }, { name: "bash", args: {} }],
    exhausted: true,
  });
  assert.match(edit.why, /턴 소진/);
  const refuse = scored("refuse-absent-file", {
    text: "현재 작업 폴더의 구조를 먼저 확인해 보겠습니다.",
    calls: [{ name: "bash", args: { command: "ls -R" } }],
    exhausted: true,
  });
  assert.match(refuse.why, /턴 소진/);
});

test("없는 도구 이름을 부르면 무엇을 기대했든 실패다", () => {
  const s = scored("rename-across-files", { calls: [{ name: "edit_file", args: {} }] });
  assert.equal(s.ok, false);
  assert.match(s.why, /없는 도구 이름/);
});

// 2026-09-25 코드 리팩토링 2회차 — 탐침이 **아예 돌지 않고 있었다.**
// LEG 3회차가 `promptFor(tools)` 를 `promptFor(task)` 로 바꾸면서(과제가 표면을 고르고
// 프롬프트·도구는 표면이 준다) LEG 쪽만 따라갔고, 리팩토링 탐침은 `promptFor(task.tools)`
// 를 그대로 불러 첫 시행에서 `배포되지 않는 표면: undefined` 로 죽었다. 기준선을 재려고
// 돌린 `ONLY_TASK=refuse-absent-file` 이 그 자리에서 터졌다.
//
// 그래서 여기서 고정하는 것은 **문구가 아니라 일치**다. 표면을 여닫는 사람에게 리팩토링
// 탐침도 같이 고치라고 시험이 대신 말해 준다.
test("리팩토링 과제는 배포되는 표면 하나를 고르고 도구가 그 표면과 같다", () => {
  for (const t of TASKS) {
    assert.equal(t.surface, "workspace", `${t.id} 의 표면: ${t.surface}`);
    assert.deepEqual(t.tools, surfaceTools(t.surface), `${t.id} 의 도구가 표면과 다르다`);
  }
});

test("모든 리팩토링 과제가 제 표면의 프롬프트를 실제로 받아 온다", () => {
  // 탐침이 시스템 메시지를 만드는 그 호출을 그대로 한다. 인자 모양이 어긋나면 여기서
  // 던지고, 그것이 이번 회차에 실제로 일어난 고장이다.
  for (const t of TASKS) {
    const p = promptFor(t);
    assert.ok(p.length > 0, `${t.id} 의 프롬프트가 비었다`);
  }
});

test("없는 표면 이름은 조용히 작업 공간으로 떨어지지 않고 던진다", () => {
  assert.throws(() => promptFor({ surface: undefined }), /배포되지 않는 표면/);
});

// 같은 회차, 같은 뿌리 — 표면에 `edit` 가 들어온 것을 탐침이 두 군데서 놓쳤다.
// 실행기에는 `edit` 가 없어 모델의 편집이 적용되지 않았고(loop 쪽), 채점기의 '고치는
// 도구' 목록에도 없어 `edit` 만 부른 시행이 **부르지도 않은 것과 같은 칸**에 들어갔다.
// CPU 레인 실측(2026-09-25): rename-across-files 1/3 · dedupe-block 1/3, 어긋난 예가
// 전부 `읽기만 함: edit` 였다.
test("edit 만 불렀는데 파일이 그대로면 '읽기만 함' 이 아니다", () => {
  const s = scored("rename-across-files", {
    calls: [{ name: "read", args: {} }, { name: "edit", args: {} }],
  });
  assert.equal(s.ok, false);
  assert.doesNotMatch(s.why, /읽기만 함/);
  assert.match(s.why, /고치려 했으나 파일이 그대로/);
});

test("정말 읽기만 한 시행은 여전히 '읽기만 함' 이다", () => {
  const s = scored("rename-across-files", { calls: [{ name: "read", args: {} }] });
  assert.match(s.why, /읽기만 함/);
});

// 표면이 여는 편집 도구를 채점기가 하나라도 빠뜨리면 그 도구를 쓴 시행이 조용히
// '읽기만 함' 으로 떨어진다. 문구가 아니라 **일치**를 고정한다.
test("표면이 여는 편집 도구는 모두 '고치려 했다' 로 센다", () => {
  for (const name of surfaceTools("workspace").filter((n) => n !== "read" && n !== "webfetch")) {
    const s = scored("rename-across-files", { calls: [{ name, args: {} }] });
    assert.doesNotMatch(s.why, /읽기만 함/, `${name} 가 읽기로 찍힌다`);
  }
});

// 2026-09-25 코드 리팩토링 4회차 — 편집 과제의 `파일이 안 바뀜` 갈래가 두 자리에서 틀렸다.
// GPU `dedupe-block` n=6 실측의 본문을 그대로 쓴다.
//
// 1) `bash ls -la` 만 돌린 시행이 `고치려 했으나 파일이 그대로` 로 찍혔다. 옛 EDITORS 가
//    `bash` 를 편집으로 셌기 때문인데, 같은 이름으로 `ls -la` 도 `sed -i` 도 온다.
// 2) 파일을 한 번 읽고 본문에 ```javascript 로 고친 코드를 통째로 낸 시행이 `읽기만 함` 으로
//    찍혔다. 코드블록 갈래를 `도구를 하나도 안 불렀을 때` 만 보고 있었다.
test("읽기 도구와 `bash ls` 만 돈 시행은 '고치려 했다' 가 아니다 — GPU dedupe-block(2026-09-25)", () => {
  const s = scored("dedupe-block", {
    calls: [
      { name: "read", args: { filePath: "report.mjs" } },
      { name: "webfetch", args: { url: "file:///check.mjs" } },
      { name: "bash", args: { command: "ls -la" } },
      { name: "read", args: { filePath: "check.mjs" } },
    ],
  });
  assert.equal(s.ok, false);
  assert.doesNotMatch(s.why, /고치려 했으나/);
  assert.match(s.why, /셸만 돌고 파일이 그대로/);
});

test("읽고 나서 코드블록을 뱉은 시행은 '읽기만 함' 이 아니라 코드블록이다 — GPU dedupe-block(2026-09-25)", () => {
  const s = scored("dedupe-block", {
    calls: [{ name: "read", args: { filePath: "report.mjs" } }, { name: "read", args: { filePath: "check.mjs" } }],
    text:
      "현재 `report.mjs`의 `render` 함수를 고치는 작업입니다. 같은 로프 (name, qty 포맷팅) 가 " +
      "두 번 반복되고 있으므로 이를 `formatRow` 함수로 추상화하겠습니다. " +
      "```javascript\nexport function render(rows) {}\n```",
  });
  assert.equal(s.ok, false);
  assert.doesNotMatch(s.why, /읽기만 함/);
  assert.match(s.why, /코드블록만 답함/);
});

test("write·edit 를 불렀는데 파일이 그대로면 코드블록이 있어도 '고치려 했으나' 다", () => {
  const s = scored("dedupe-block", {
    calls: [{ name: "edit", args: {} }],
    text: "```javascript\nconst x = 1;\n```",
  });
  assert.match(s.why, /고치려 했으나 파일이 그대로: edit/);
});

test("실제로 고쳐 놓고 코드블록도 같이 낸 시행은 여전히 통과다 — CPU dedupe-block(2026-09-25)", () => {
  const s = scored("dedupe-block", {
    edits: {
      "report.mjs":
        "function renderBlock(rows) {\n  return rows.map((r) => String(r.name).padEnd(10, \" \") + String(r.qty)).join(\"\n\");\n}\n" +
        "export function render(rows) {\n  const out = [];\n  out.push(\"== 상단 ==\");\n  out.push(renderBlock(rows));\n" +
        "  out.push(\"== 하단 ==\");\n  out.push(renderBlock(rows));\n  return out.join(\"\n\");\n}\n",
    },
    calls: [{ name: "write", args: {} }],
    text: "`report.mjs` 에서 두 번 반복되는 서식 부분을 `renderBlock` 함수로 추출했습니다: ```js ... ```",
  });
  assert.equal(s.ok, true, s.why);
});

// ── 2026-09-25 코드 리팩토링 5회차 — 실행기의 되먹임이 배포본과 같은 말을 하는가 ──────
//
// 채점기가 아니라 **실행기**를 잠근다. 모델이 다음 수를 고르는 근거는 도구가 돌려준 말
// 뿐이라, 그 말이 배포본과 다르면 재고 있는 것은 배포되는 표면이 아니다.

test("표면이 여는 도구는 실행기가 전부 다룬다(없는 도구로 떨어지지 않는다)", () => {
  // 문구가 아니라 **일치**를 고정한다. 기대한 이름만 훑으면 표면에 도구를 더한 사람이
  // 조용히 지나간다 — `edit`(2026-09-25) 와 `webfetch`(4회차 GPU 가 밟음) 가 그렇게
  // 실행기 없이 표면에만 올라와 있었다.
  const dir = mkdtempSync(join(tmpdir(), "refactor-exec-test-"));
  try {
    writeFileSync(join(dir, "a.mjs"), "hello\n");
    const args = {
      read: { filePath: "a.mjs" },
      write: { filePath: "a.mjs", content: "hello\n" },
      edit: { filePath: "a.mjs", oldString: "hello", newString: "hi" },
      webfetch: { url: "https://example.com" },
      bash: { command: "true" },
    };
    for (const name of surfaceTools("workspace")) {
      assert.ok(args[name], `표면의 도구 ${name} 에 시험 인자가 없다 — 실행기와 함께 더해라`);
      const out = runTool(dir, { name, args: args[name] });
      assert.ok(!/없는 도구/.test(out), `${name}: 표면은 열어 두고 실행기가 없다고 답한다`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows 측정은 WSL 런처 대신 설치된 Git Bash를 쓴다 (2026-09-28 flatten-nesting n=20)", {
  skip: process.platform !== "win32",
}, () => {
  // 실제로 온 호출: bash {"command":"node check.mjs"}. PATH의 bash는 이 장비에서
  // C:\\Windows\\System32\\bash.exe(WSL 런처)라 WSL 미설치 오류를 돌렸다.
  assert.match(bashExecutable(), /\\Git\\(?:bin|usr\\bin)\\bash\.exe$/i);
  const dir = mkdtempSync(join(tmpdir(), "refactor-bash-test-"));
  try {
    assert.equal(runTool(dir, { name: "bash", args: { command: "node -e \"process.stdout.write('bash-ok')\"" } }), "bash-ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit 실패 문구는 배포본(opencode 1.18.32)의 것을 그대로 돌려준다", () => {
  // 2026-09-25 CPU `dedupe-block` 실측: 옛 문구 `오류: oldString 을 파일에서 찾지 못했다`
  // 를 모델이 **파일이 없다**로 읽고 물러섰다("수정하려는 파일이나 폴더가 없어서 작업을
  // 수행할 수 없으며…"). 배포본 문구는 공백·들여쓰기·줄끝까지 맞아야 한다고 말해 주므로
  // 다시 물을 거리가 있고, 파일의 존재를 부정하지 않는다.
  const dir = mkdtempSync(join(tmpdir(), "refactor-exec-test-"));
  try {
    writeFileSync(join(dir, "a.mjs"), "x\nx\n");
    const edit = (args) => runTool(dir, { name: "edit", args: { filePath: "a.mjs", ...args } });
    assert.match(edit({ oldString: "없는말", newString: "y" }), /Could not find oldString in the file/);
    assert.doesNotMatch(edit({ oldString: "없는말", newString: "y" }), /파일에서 찾지 못/);
    assert.match(edit({ oldString: "x", newString: "y" }), /Found multiple matches for oldString/);
    assert.match(edit({ oldString: "x", newString: "x" }), /identical/);
    assert.equal(edit({ oldString: "x", newString: "y", replaceAll: true }), "edited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webfetch 는 배포본처럼 스킴을 짚고, 네트워크 자리는 다음 수를 함께 준다", () => {
  // 4회차 GPU `dedupe-block` 이 `webfetch file:///check.mjs` 로 샌드박스 밖을 읽으려다
  // `오류: 없는 도구 webfetch` 를 받고 턴을 태웠다. 배포본은 스킴을 짚어 준다.
  const dir = mkdtempSync(join(tmpdir(), "refactor-exec-test-"));
  try {
    const fetched = (url) => runTool(dir, { name: "webfetch", args: { url } });
    assert.match(fetched("file:///check.mjs"), /URL must start with http:\/\/ or https:\/\//);
    // 바깥 네트워크만 배포본과 다르게 둔다(무인 회차가 바깥 상태에 묶이지 않도록).
    // 그 자리도 막다른 말이 아니어야 한다 — 쓸 수 있는 도구를 이름으로 짚는다.
    const offline = fetched("https://example.com");
    assert.match(offline, /네트워크를 돌리지 않는다/);
    assert.match(offline, /read/);
    assert.match(offline, /bash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("도구 없이 끝난 턴의 재시도 상한이 배포 실행기와 같은 수다", () => {
  // 2026-09-27 코드 리팩토링 7회차가 남긴 숙제 — GPU `flatten-nesting` 의 `읽기만 함: read`
  // 9/20 이 배포 경로에도 있는 자리인가. 없었다. `plan.rs::retry_unstarted` 가 도구를 부르지
  // 않고 끝난 단계를 `MAX_STEP_RETRIES` 번까지 다시 보내는데(2026-09-27 실기기
  // ses_f1d138d25ffeoAu3sP0ofQteTy), 탐침만 그 자리에서 턴을 닫고 있었다.
  //
  // 수를 베껴 적지 않고 **배포 소스에서 읽어 맞춘다.** 베껴 두면 배포본이 상한을 바꿔도
  // 탐침만 옛 수로 계속 재고, 그것이 이 자리가 생긴 방식 그대로다.
  const plan = readFileSync(new URL("../../crates/agent-manager-core/src/plan.rs", import.meta.url), "utf8");
  const shipped = plan.match(/MAX_STEP_RETRIES: usize = (\d+)/);
  assert.ok(shipped, "plan.rs 에서 MAX_STEP_RETRIES 를 찾지 못했다");
  assert.equal(MAX_UNSTARTED_RETRIES, Number(shipped[1]));
});

test("다시 보내는 것은 본문까지 빈 턴뿐이다", () => {
  // 2026-09-28 코드 리팩토링 8회차. 배포본의 조건(`chat.rs`: `status == "completed" && !saw_tool`)
  // 을 그대로 옮겼더니 **끝난 일과 못 할 일까지 다시 떠밀었다.** 배포 경로에는 계획 턴의
  // `cannot_do` 가 앞에 있어 그런 턴이 단계로 서지 않는데 탐침에는 그 턴이 없다.
  // 실측: CPU `refuse-absent-file` 이 6/6 에서 **5/10** 으로 떨어졌고, 그중 한 번은
  // `없는 파일을 지어내서 만들었다` 였다. 조건을 본문이 빈 턴으로 좁히자 10/10 으로 돌아왔다.
  assert.equal(isUnstartedTurn({ toolCalls: [], content: "" }), true);
  assert.equal(isUnstartedTurn({ toolCalls: [], content: " 	 " }), true);
  // 정직한 거절은 본문이 있다. 여기서 다시 보내면 반대 방향 과제가 무너진다.
  assert.equal(
    isUnstartedTurn({ toolCalls: [], content: "payments/legacy.mjs 파일이 존재하지 않습니다." }),
    false,
  );
  // 도구를 부른 턴은 애초에 다시 보낼 턴이 아니다.
  assert.equal(isUnstartedTurn({ toolCalls: [{ name: "read" }], content: "" }), false);
});

test("다시 보내는 지시는 그 과제의 도구를 이름으로 짚고, 할 일이 없을 때의 출구를 남긴다", () => {
  // 배포 경로에는 계획 턴의 `cannot_do` 가 앞에 있어 "없는 일"이 단계로 서지 않는다.
  // 탐침에는 그 턴이 없으므로 출구를 이 문장이 준다 — 없으면 반대 방향 과제
  // (`refuse-absent-file`)가 "일단 고쳐라"로 떠밀려 반대 방향 결함이 만점으로 보인다.
  const flatten = unstartedNudge(task("flatten-nesting"));
  for (const name of task("flatten-nesting").tools) assert.match(flatten, new RegExp(name));
  assert.match(flatten, /설명을 적지 말고/);
  assert.match(flatten, /할 일이 없으면/);
  // 과제마다 제 도구를 짚는다 — 전역 목록 하나로 적으면 표면이 갈린 뒤 거짓이 된다.
  assert.equal(unstartedNudge({ tools: ["read"] }).includes("read 을(를) 바로 호출"), true);
});
