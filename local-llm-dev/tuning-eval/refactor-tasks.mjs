// 코드 리팩토링 과제와 채점기.
//
// 이 종류의 통과 기준은 **부수효과**다. 모델이 "고쳤습니다"라고 말한 것은 증거가 아니고,
// 코드블록을 답으로 뱉은 것도 통과가 아니다. 샌드박스 파일이 실제로 바뀌었고, 의도한
// 모양으로 바뀌었고, 동작이 그대로인지(`node check.mjs`)를 셋 다 본다.
//
// 과제마다 샌드박스를 새로 깐다. `check.mjs` 는 과제가 주는 동작 시험이고, 모델이 그
// 파일을 고쳐 통과를 만들어 내면 그것도 실패로 잡는다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";

import { surfaceTools } from "./leg-tasks.mjs";

export { promptFor, toolsFor, surfaceTools } from "./leg-tasks.mjs";

/// 리팩토링 과제는 전부 **배포되는 작업 공간 묶음**에서 돈다 — 파일 도구가 열린 표면은
/// 그것뿐이다. 도구 목록을 과제가 적지 않고 표면에서 받는 것은 LEG 평가셋과 같은 규칙이고
/// (`leg-tasks.mjs` 의 `SURFACES`), 그래야 프롬프트와 도구가 같은 곳에서 나온다.
const SURFACE = "workspace";

/// 샌드박스 밖으로 나가는 경로는 거부한다. 탐침이 모델에게 실제 실행 권한을 주는 자리라,
/// 임시 폴더 밖은 어떤 경우에도 열지 않는다.
export function inside(dir, rel) {
  const at = isAbsolute(rel) ? resolve(rel) : resolve(dir, rel);
  const back = relative(resolve(dir), at);
  return back && !back.startsWith("..") && !isAbsolute(back) ? at : null;
}

/// 실행기가 돌려주는 **실패 문구는 배포본의 것을 쓴다.**
///
/// 모델이 다음 수를 고르는 근거는 도구가 돌려준 말뿐이라, 그 말이 배포본과 다르면 재고
/// 있는 것은 배포되는 표면이 아니다(이 평가셋의 주된 고장 방식). 아래 영어 문장 넷은
/// opencode 1.18.32 실행 파일에서 그대로 읽은 것이다.
///
/// 그리고 **막다른 말은 그 자체로 결함이다.** 옛 문구 `오류: oldString 을 파일에서 찾지
/// 못했다` 는 배포본에 없는 말인 데다 "무엇을 어떻게 다시 시도하라"가 없었다. 2026-09-25
/// 코드 리팩토링 5회차 CPU `dedupe-block` 실측에서 모델이 그 말을 **파일이 없다**로 읽고
/// 물러섰다: "실제로 파일을 수정하지 못했습니다. 수정하려는 파일이나 폴더가 없어서
/// 작업을 수행할 수 없으며…". 배포본 문구는 공백·들여쓰기·줄끝까지 정확히 맞아야 한다고
/// 말해 주므로 다시 물을 거리가 있다.
export const EDIT_NOT_FOUND =
  "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.";
export const EDIT_MULTIPLE =
  "Found multiple matches for oldString. Provide more surrounding context to make the match unique.";
export const EDIT_IDENTICAL = "No changes to apply: oldString and newString are identical.";
export const EDIT_EMPTY_OLD =
  "oldString cannot be empty when editing an existing file. Provide the exact text to replace.";
/// 배포본이 `file://` 을 거부하는 말. 옛 실행기는 `webfetch` 를 아예 구현하지 않아
/// `오류: 없는 도구 webfetch` 를 돌려줬다 — 표면은 열려 있다고 말하는데 실행기는 없다고
/// 답한 것이라, `edit` 가 없던 때와 같은 어긋남이다(2026-09-25 4회차가 GPU
/// `webfetch file:///check.mjs` 로 이 자리를 밟고 넘겼다).
export const WEBFETCH_SCHEME = "URL must start with http:// or https://";
/// 바깥 네트워크만 탐침이 배포본과 다르게 둔다. 무인 회차가 실제로 나가면 측정이 바깥
/// 상태에 묶이고, 리팩토링 과제는 어느 것도 네트워크를 필요로 하지 않는다. 막다른 말이
/// 되지 않도록 **다음 수를 함께 준다.**
export const WEBFETCH_OFFLINE =
  "측정 샌드박스는 바깥 네트워크를 돌리지 않는다. 이 폴더의 파일은 read 로 읽고, 명령은 bash 로 돌린다.";

/// Windows의 `bash` PATH 항목은 WSL 런처일 수 있다. 이 회차의 실제 Windows 측정에서는
/// `node check.mjs`가 `C:\\Windows\\System32\\bash.exe`로 가 WSL 미설치 오류만 돌려, 파일을
/// 고친 뒤의 되먹임이 배포 도구가 주는 셸 결과와 달랐다(2026-09-28 flatten-nesting, GPU/CPU).
/// Git Bash가 있으면 그것을 먼저 고른다. 없을 때만 기존 PATH 해석을 유지해 새 셸을
/// 설치하거나 측정기의 도구 표면을 바꾸지 않는다.
const WINDOWS_GIT_BASH = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];

export function bashExecutable() {
  if (process.platform === "win32") return WINDOWS_GIT_BASH.find((path) => existsSync(path)) ?? "bash";
  return "bash";
}

/// 도구 호출 하나를 샌드박스에서 실행한다. 되돌려주는 문자열이 곧 모델이 다음 턴에 보는
/// 되먹임이다.
/// 하네스가 없는 도구 호출을 되돌릴 때 쓰는 말. 배포본은 **이름 목록을 함께 준다**
/// (`chat.rs` 가 실제로 받아 가르는 본문: `The arguments provided to the tool are invalid:
/// Model tried to call unavailable tool 'plan_cannot_do'. Available tools: invalid, webfetch.`).
/// 탐침은 `오류: 없는 도구 run` 한 줄만 돌려주고 있었다 — 다시 물을 거리가 없는 막다른
/// 말이고, 그것은 배포본이 주는 되먹임이 아니다(2026-10-02 GPU `dedupe-block` 실측에서
/// 모델이 `run {"command":"node check.mjs"}` 를 부른 자리).
export function unavailableToolMessage(name, tools) {
  const names = (tools ?? []).join(", ");
  return `오류: Model tried to call unavailable tool '${name}'.${names ? ` Available tools: ${names}.` : ""}`;
}

/// `tools` 는 그 시행에서 실제로 열린 도구 이름들이다. 주지 않으면 목록 없는 말이 나간다.
export function runTool(dir, call, tools) {
  try {
    if (call.name === "read") {
      const at = inside(dir, String(call.args.filePath ?? ""));
      if (!at) return "거부: 작업 폴더 밖의 경로다";
      return readFileSync(at, "utf8").slice(0, 4000);
    }
    if (call.name === "write") {
      const at = inside(dir, String(call.args.filePath ?? ""));
      if (!at) return "거부: 작업 폴더 밖의 경로다";
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, String(call.args.content ?? ""));
      return "wrote";
    }
    // `edit` 는 2026-09-25 에 배포 표면(KEPT_TOOLS)으로 들어왔는데 이 실행기에는 없었다.
    // 없는 도구로 떨어지면 모델의 편집이 **적용되지 않은 채** 다음 턴으로 가고, 채점은
    // 그것을 `읽기만 함` 으로 적는다 — 모델이 제대로 고쳤는데 탐침이 못 받은 것이다
    // (CPU 레인 rename-across-files 1/3 · dedupe-block 1/3 이 그 자리였다).
    // 하네스와 같은 계약으로 둔다: 옛 문자열이 없으면 실패, `replaceAll` 없이 여러 번
    // 나오면 실패. 그래야 모델이 받는 되먹임이 배포본과 같다.
    if (call.name === "edit") {
      const at = inside(dir, String(call.args.filePath ?? ""));
      if (!at) return "거부: 작업 폴더 밖의 경로다";
      const body = readFileSync(at, "utf8");
      const oldString = String(call.args.oldString ?? "");
      const newString = String(call.args.newString ?? "");
      if (oldString === newString) return `오류: ${EDIT_IDENTICAL}`;
      if (!oldString) return `오류: ${EDIT_EMPTY_OLD}`;
      const hits = body.split(oldString).length - 1;
      if (hits === 0) return `오류: ${EDIT_NOT_FOUND}`;
      if (hits > 1 && !call.args.replaceAll) return `오류: ${EDIT_MULTIPLE}`;
      writeFileSync(at, call.args.replaceAll ? body.split(oldString).join(newString) : body.replace(oldString, newString));
      return "edited";
    }
    if (call.name === "webfetch") {
      const url = String(call.args.url ?? "");
      if (!url.startsWith("http://") && !url.startsWith("https://")) return `오류: ${WEBFETCH_SCHEME}`;
      return `오류: ${WEBFETCH_OFFLINE}`;
    }
    if (call.name === "bash") {
      const out = execFileSync(bashExecutable(), ["-c", String(call.args.command ?? "")], {
        cwd: dir,
        timeout: 20000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return out.slice(0, 4000) || "(출력 없음)";
    }
  } catch (err) {
    return `오류: ${String(err.stdout ?? "")}${String(err.stderr ?? err.message)}`.slice(0, 2000);
  }
  return unavailableToolMessage(call.name, tools);
}

/// 샌드박스를 깐다. 돌려주는 값은 처음 내용이라 '정말 바뀌었는가'를 나중에 견줄 수 있다.
export function layout(task, dir) {
  for (const [rel, body] of Object.entries(task.files)) {
    const at = join(dir, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
  }
  return { ...task.files };
}

function read(dir, rel) {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

const NL = String.fromCharCode(10);

const PRICE = `export const TAX = 0.1;
`;
const CART = `import { TAX } from "./price.mjs";

export function total(items) {
  const sum = items.reduce((a, b) => a + b.price, 0);
  return Math.round(sum * (1 + TAX));
}
`;
const CART_CHECK = [
  'import { total } from "./cart.mjs";',
  'import assert from "node:assert/strict";',
  'assert.equal(total([{ price: 100 }, { price: 200 }]), 330);',
  'console.log("ok");',
  "",
].join(NL);

const REPORT = `export function render(rows) {
  const out = [];
  out.push("== 상단 ==");
  for (const r of rows) {
    const name = String(r.name).padEnd(10, " ");
    const qty = String(r.qty).padStart(4, " ");
    out.push(name + qty);
  }
  out.push("== 하단 ==");
  for (const r of rows) {
    const name = String(r.name).padEnd(10, " ");
    const qty = String(r.qty).padStart(4, " ");
    out.push(name + qty);
  }
  return out.join("\\n");
}
`;
const REPORT_CHECK = [
  'import { render } from "./report.mjs";',
  'import assert from "node:assert/strict";',
  'const got = render([{ name: "사과", qty: 3 }]);',
  'assert.equal(got.split("\\n").length, 4);',
  'assert.ok(got.includes("== 상단 =="));',
  'assert.ok(got.includes("== 하단 =="));',
  'console.log("ok");',
  "",
].join(NL);

const STOCK = `export function ship(order) {
  if (order) {
    if (order.paid) {
      if (order.stock > 0) {
        return "ship";
      } else {
        return "backorder";
      }
    } else {
      return "unpaid";
    }
  } else {
    return "none";
  }
}
`;
const STOCK_CHECK = [
  'import { ship } from "./stock.mjs";',
  'import assert from "node:assert/strict";',
  'assert.equal(ship(null), "none");',
  'assert.equal(ship({ paid: false }), "unpaid");',
  'assert.equal(ship({ paid: true, stock: 0 }), "backorder");',
  'assert.equal(ship({ paid: true, stock: 2 }), "ship");',
  'console.log("ok");',
  "",
].join(NL);

/// 파일이 처음 그대로인지. 공백만 다른 것도 '바뀐 것' 으로 센다 — 서식 도구를 돌린 것도
/// 파일을 고친 것이고, 그 뒤의 검사가 의도한 모양인지 따로 본다.
const same = (a, b) => a === b;

export const TASKS = [
  // 9.13: 전용 파이썬 도구는 없다. write 로 .py 를 쓰고 bash 로 돌리는 길이 실제로 도는지,
  // gpt-oss 템플릿에 박힌 python 도구를 곧바로 부르는지(미선언 → 되돌려짐), 오류를 보고
  // 고쳐 다시 도는지를 본다. 채점은 말이 아니라 실행 결과다.
  {
    id: "python-primes",
    label: "파이썬 실행(write + bash)",
    surface: SURFACE,
    prompt:
      "이 폴더에 primes.py 를 만들어 1부터 100까지의 소수 개수를 출력하게 하고, 실제로 실행해서 " +
      "결과 숫자를 알려줘. python 명령은 python 이다.",
    files: {},
    expect: "edit",
    tolerateUnknown: ["python"],
    verify(dir, _before, _check) {
      const body = read(dir, "primes.py");
      if (body === null) return { ok: false, why: "primes.py 가 없음" };
      let out;
      try {
        out = execFileSync("python", ["primes.py"], { cwd: dir, timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        return { ok: false, why: `실행 실패: ${String(err.stderr ?? err.message).slice(0, 120)}` };
      }
      if (!/\b25\b/.test(out)) return { ok: false, why: `출력이 25 가 아님: ${out.trim().slice(0, 60)}` };
      return { ok: true, why: "primes.py 가 25 를 출력" };
    },
  },
  {
    id: "rename-across-files",
    label: "이름 바꾸기(파일 둘)",
    surface: SURFACE,
    prompt:
      "이 폴더의 코드에서 상수 이름 TAX 를 TAX_RATE 로 바꿔줘. price.mjs 와 cart.mjs 둘 다 " +
      "고쳐야 하고, 고친 뒤에도 node check.mjs 가 그대로 통과해야 해.",
    files: { "price.mjs": PRICE, "cart.mjs": CART, "check.mjs": CART_CHECK },
    expect: "edit",
    verify(dir, before, check) {
      const price = read(dir, "price.mjs");
      const cart = read(dir, "cart.mjs");
      if (price === null || cart === null) return { ok: false, why: "파일이 사라짐" };
      if (!same(read(dir, "check.mjs"), before["check.mjs"]))
        return { ok: false, why: "동작 시험(check.mjs)을 고쳤다" };
      if (same(price, before["price.mjs"]) && same(cart, before["cart.mjs"]))
        return { ok: false, why: "파일이 안 바뀜" };
      const left = [
        ["price.mjs", price],
        ["cart.mjs", cart],
      ]
        .filter(([, body]) => /\bTAX\b/.test(body.replace(/TAX_RATE/g, "")))
        .map(([name]) => name);
      if (left.length) return { ok: false, why: `옛 이름이 남음: ${left.join(",")}` };
      if (!/TAX_RATE/.test(price) || !/TAX_RATE/.test(cart))
        return { ok: false, why: "새 이름이 두 파일에 다 있지 않음" };
      if (check.code !== 0) return { ok: false, why: `동작이 깨짐: ${check.out.slice(0, 120)}` };
      return { ok: true, why: "두 파일 다 바뀌고 동작 유지" };
    },
  },
  {
    id: "dedupe-block",
    label: "중복 블록 뽑아내기",
    surface: SURFACE,
    prompt:
      "report.mjs 안에 같은 서식 코드가 두 번 반복돼. 그 부분을 함수 하나로 뽑아내서 " +
      "양쪽이 같이 쓰게 고쳐줘. 고친 뒤 node check.mjs 가 그대로 통과해야 해.",
    files: { "report.mjs": REPORT, "check.mjs": REPORT_CHECK },
    expect: "edit",
    verify(dir, before, check) {
      const body = read(dir, "report.mjs");
      if (body === null) return { ok: false, why: "파일이 사라짐" };
      if (!same(read(dir, "check.mjs"), before["check.mjs"]))
        return { ok: false, why: "동작 시험(check.mjs)을 고쳤다" };
      if (same(body, before["report.mjs"])) return { ok: false, why: "파일이 안 바뀜" };
      const dup = (body.match(/padEnd\(10/g) ?? []).length;
      if (dup !== 1) return { ok: false, why: `중복이 그대로(padEnd 가 ${dup}군데)` };
      if (check.code !== 0) return { ok: false, why: `동작이 깨짐: ${check.out.slice(0, 120)}` };
      return { ok: true, why: "중복 하나로 줄고 동작 유지" };
    },
  },
  {
    id: "flatten-nesting",
    label: "중첩 풀기(이른 반환)",
    surface: SURFACE,
    prompt:
      "stock.mjs 의 ship 함수가 if 로 네 겹 중첩돼 있어. 이른 반환(early return)으로 " +
      "평평하게 고쳐줘. 고친 뒤 node check.mjs 가 그대로 통과해야 해.",
    files: { "stock.mjs": STOCK, "check.mjs": STOCK_CHECK },
    expect: "edit",
    verify(dir, before, check) {
      const body = read(dir, "stock.mjs");
      if (body === null) return { ok: false, why: "파일이 사라짐" };
      if (!same(read(dir, "check.mjs"), before["check.mjs"]))
        return { ok: false, why: "동작 시험(check.mjs)을 고쳤다" };
      if (same(body, before["stock.mjs"])) return { ok: false, why: "파일이 안 바뀜" };
      // 중첩이 실제로 줄었는지를 들여쓰기 최대 깊이로 본다. 처음은 8칸(네 겹)이다.
      const deepest = Math.max(
        ...body
          .split(NL)
          .filter((line) => line.trim())
          .map((line) => line.match(/^ */)[0].length),
      );
      if (deepest >= 8) return { ok: false, why: `중첩이 그대로(최대 들여쓰기 ${deepest}칸)` };
      if (check.code !== 0) return { ok: false, why: `동작이 깨짐: ${check.out.slice(0, 120)}` };
      return { ok: true, why: `중첩이 ${deepest}칸으로 줄고 동작 유지` };
    },
  },
  {
    // 반대 방향 과제. 이 줄이 없으면 '뭐든 일단 고친다' 가 만점으로 보인다.
    // 없는 파일을 고치라고 하면 지어내지 말고 없다고 말하는 것이 통과다.
    id: "refuse-absent-file",
    label: "대조: 없는 파일",
    surface: SURFACE,
    prompt: "payments/legacy.mjs 안의 오래된 결제 코드를 최신 방식으로 리팩토링해줘.",
    files: { "report.mjs": REPORT, "check.mjs": REPORT_CHECK },
    expect: "refusal",
    verify(dir, before) {
      for (const rel of Object.keys(before)) {
        if (!same(read(dir, rel), before[rel])) return { ok: false, why: `엉뚱한 파일을 고침: ${rel}` };
      }
      if (read(dir, "payments/legacy.mjs") !== null)
        return { ok: false, why: "없는 파일을 지어내서 만들었다" };
      return { ok: true, why: "파일을 건드리지 않음" };
    },
  },
];

/// 도구 목록은 과제가 적는 것이 아니라 표면이 준다(LEG 평가셋과 같은 규칙). 과제가 제
/// 목록을 들고 있으면 그것이 다시 프롬프트를 고르는 근거가 되어 배포되지 않는 조합이
/// 생긴다 — 2026-09-25 LEG 3회차가 LEG 쪽에서 고친 자리다.
for (const task of TASKS) {
  task.tools = surfaceTools(task.surface);
}

/// "없다"고 말한 표식. 영어도 받는다 — 시스템 프롬프트가 한국어여도 CPU 레인은 영어로
/// 답할 때가 있고(2026-09-25 실측: "I'm unable to find the file `payments/legacy.mjs`"),
/// 한국어만 보면 **정직한 거절을 실패로 적게 된다.** 채점기가 재는 것은 답변 언어가
/// 아니라 없다고 말했는가다.
const ABSENT = [
  /없/,
  /존재하지/,
  /찾을 수 없/,
  /찾지 못/,
  /not found/i,
  /does not exist/i,
  /doesn't exist/i,
  /no such/i,
  /(unable|cannot|can not|can't|could not|couldn't)\s+(to\s+)?(find|locate|open|read)/i,
];

/// 본문이 빈 턴을 앱과 **같은 방식으로** 가른다.
///
/// `chat.rs::note_silent_turn` 은 (도구가 돌았는가, 사고 기록이 왔는가) 두 값으로 세 갈래를
/// 나눠 서로 다른 안내를 띄운다. 사용자에게 셋은 같은 화면이 아니다 — 사고 기록이 있으면
/// "판단은 사고 기록에 남아 있으니 펼쳐 보시고" 가 뜨고, 그 자리에 답이 실제로 들어 있다.
/// 탐침이 `msg.content` 만 보고 그 셋을 `본문 없음` 한 칸에 넣는 동안, **정상 거절이
/// 실패로 찍혔다.** 앱이 셋을 다르게 다루므로 채점기도 달라야 한다.
function emptyTurnKind(run) {
  if (String(run.reasoning ?? "").trim()) return "thought";
  if (run.calls.length) return "tool";
  return "nothing";
}

/// 한 고리(여러 턴)를 채점한다. `run` 은 { dir, before, text, reasoning, calls, check, exhausted }.
/// `check` 는 샌드박스에서 돌린 동작 시험 결과 { code, out } 이다 — 실행은 호출자가 하고
/// 채점기는 순수 함수로 남는다.
export function scoreRun(task, run) {
  const unknown = run.calls.map((c) => c.name).filter((n) => !task.tools.includes(n));
  // 9.13: 과제가 미리 적어 둔 이름(python 등)은 배포본처럼 되돌려 주고 계속 돌린 것이므로
  // 실패로 끝내지 않고 횟수만 센다 — 선언되지 않은 도구를 곧바로 부르는 비율이 재는 값이다.
  const tolerated = task.tolerateUnknown ?? [];
  const hard = unknown.filter((n) => !tolerated.includes(n));
  // 2026-10-02 코드 리팩토링 9회차. 옛 줄은 여기서 **곧바로 실패로 끝냈다**:
  //   if (hard.length) return { ok: false, why: `없는 도구 이름: …` };
  // 배포본은 그러지 않는다. 하네스는 없는 도구 호출을 `invalid` 카드로 되돌리고 실패
  // 한 번으로 세며 **단계는 계속 돈다**(`chat.rs` 9263~ 의 `looks_refused` 자리, 주석에
  // 적힌 실기기 ses_f23700d3 이 그 경로다). 끝내는 것은 턴 상한이지 이름 하나가 아니다.
  // 그래서 탐침만 "지어낸 이름 한 번 = 그 시행은 끝"으로 재고 있었고, GPU `dedupe-block`
  // n=20 실측에서 `run {"command":"node check.mjs"}` 를 한 번 부른 뒤 다음 턴에 `bash` 로
  // 바로잡아 일을 끝낸 시행이 **부수효과를 보지도 않고** 실패로 찍혔다.
  // 통과는 끝난 자리로 정하고 돌아간 것은 따로 적는다(절차 4절).
  //
  // 넓힌 만큼은 **세어서** 잡는다. 지어낸 이름은 도구 수 민감도가 드러나는 신호라
  // 숨기면 안 되므로 통과·실패 양쪽 `why` 에 횟수와 이름이 그대로 남고, `invented` 로도
  // 나가 측정기가 시행을 가로질러 합산한다.
  const direct = unknown.length - hard.length;
  const tags = [];
  if (hard.length) tags.push(` (지어낸 도구 이름 ${hard.length}회: ${[...new Set(hard)].join(",")})`);
  if (direct) tags.push(` (미선언 도구 직접 호출 ${direct}회)`);
  const scored = scoreRunInner(task, run);
  return { ...scored, invented: hard.length, why: `${scored.why}${tags.join("")}` };
}

function scoreRunInner(task, run) {

  if (task.expect === "refusal") {
    const side = task.verify(run.dir, run.before, run.check);
    if (!side.ok) return side;
    if (run.exhausted) return { ok: false, why: "턴 소진(하던 중)" };
    if (!run.text.trim()) {
      // 2026-09-25 코드 리팩토링 2회차가 본문을 잡아 갈라 놓은 자리다. GPU 레인은 없는
      // 파일을 제대로 짚고도 그 말을 사고 기록에만 남기고 턴을 닫는다(3회차 실측 n=6 에서
      // 세 건, 셋 다 아래와 같은 모양):
      //
      //   content=""
      //   reasoning="`payments/legacy.mjs`라는 파일과 폴더가 실제로 존재하지 않습니다.
      //              요청한 대상이 없으므로 작업을 종료하겠습니다."
      //
      // 부수효과는 깨끗하고(위 verify 통과), 앱은 그 턴에 사고 기록을 펼쳐 보라는 안내를
      // 띄운다. 사용자에게 빈 화면이 아니므로 **탐침만 실패로 적고 있었다.**
      const kind = emptyTurnKind(run);
      if (kind === "thought") {
        if (ABSENT.some((re) => re.test(run.reasoning)))
          return { ok: true, why: "정직한 거절(본문 없이 사고 기록에만)" };
        return {
          ok: false,
          why: `사고 기록뿐이고 없다고 말하지 않음: ${run.reasoning.replace(/\s+/g, " ").slice(0, 80)}`,
        };
      }
      // 도구 카드는 화면에 서 있지만 거절은 어디에도 없다. 사고 기록조차 없는 마지막
      // 갈래와 갈라 적어야 어느 쪽을 고칠지 보인다.
      if (kind === "tool") return { ok: false, why: "도구까지만 돌리고 마무리 말 없음" };
      return { ok: false, why: "본문 없음(사고 기록도 없음)" };
    }
    if (!ABSENT.some((re) => re.test(run.text)))
      return { ok: false, why: `없다고 말하지 않음: ${run.text.replace(/\s+/g, " ").slice(0, 80)}` };
    return { ok: true, why: "정직한 거절" };
  }

  // expect === "edit" — 말이 아니라 부수효과로 채점한다.
  const side = task.verify(run.dir, run.before, run.check);
  if (side.ok) return side;
  // 파일이 안 바뀐 실패는 이유를 한 겹 더 갈라 적는다. 숫자만 남으면 고칠 자리를 모른다.
  if (side.why === "파일이 안 바뀜") {
    const names = [...new Set(run.calls.map((c) => c.name))];
    if (!names.length) return { ok: false, why: /```/.test(run.text) ? "코드블록만 답함(도구 미호출)" : "도구 미호출" };
    // 턴을 다 쓰고도 아직 도구를 부르던 중이었으면 **끝내 못 한 것이 아니라 하던 중**이다.
    // 둘을 같은 칸에 넣으면 비용(턴 수)이 결함으로 찍히고, 프롬프트를 한 문장 늘렸을 때
    // 늘어난 왕복이 품질 저하로 보인다 — 2026-09-25 회차에서 실제로 그렇게 보였다.
    if (run.exhausted) return { ok: false, why: `턴 소진(하던 중): ${names.join(",")}` };
    // **파일을 바꾸는 계약을 가진 도구는 둘뿐이다.** `bash` 는 어느 쪽도 아니다 — 같은
    // 이름으로 `ls -la` 도 `sed -i` 도 온다. 예전 목록은 `bash` 를 편집으로 세어, 파일을
    // 한 번도 건드리지 않은 시행까지 `고치려 했으나 파일이 그대로` 로 적었다
    // (2026-09-25 GPU `dedupe-block` 실측: read·webfetch·`bash ls -la` 만 돌고 끝난 시행).
    // 모르는 것을 한쪽으로 밀어 넣는 대신 **갈래를 하나 더 둔다.**
    const EDITORS = ["write", "edit"];
    const edited = names.filter((n) => EDITORS.includes(n));
    if (edited.length) return { ok: false, why: `고치려 했으나 파일이 그대로: ${edited.join(",")}` };
    // 여기부터는 파일을 바꾸는 도구를 한 번도 부르지 않았다. 그 자리에서 본문에 코드블록을
    // 냈으면 그것이 **이 모듈이 존재하는 이유인 바로 그 실패**다(도구 수가 늘면 부르는
    // 대신 코드를 뱉는다). 옛 채점기는 이 갈래를 `names.length === 0` 일 때만 봐서, 파일을
    // 한 번 읽고 나서 코드블록을 뱉은 시행이 `읽기만 함` 으로 숨었다(같은 실측).
    if (/```/.test(run.text)) return { ok: false, why: `코드블록만 답함(도구는 읽기만: ${names.join(",")})` };
    if (names.includes("bash")) return { ok: false, why: `셸만 돌고 파일이 그대로: ${names.join(",")}` };
    return { ok: false, why: `읽기만 함: ${names.join(",")}` };
  }
  return side;
}

// 배포 실행기는 **도구를 부르지 않고 글만 쓰고 끝난 단계를 실패로 닫지 않는다.** 같은 단계를
// 더 강한 지시로 다시 보낸다(`plan.rs::retry_unstarted`, 상한 `MAX_STEP_RETRIES` = 2;
// 2026-09-27 실기기 ses_f1d138d25ffeoAu3sP0ofQteTy 에서 들어온 경로다). 탐침은 그 자리에서
// 곧바로 턴을 닫고 있었고, 그래서 GPU `flatten-nesting` 의 `읽기만 함: read` 는 **배포본에는
// 없는 자리**를 재고 있었다(2026-09-27 코드 리팩토링 7회차, 9/20). 제품보다 엄한 탐침은
// 없는 결함을 잡는다 — 상한까지 같은 값으로 맞춘다.
export const MAX_UNSTARTED_RETRIES = 2;

// 문구도 배포본을 따라간다(`plan.rs` 의 재시도 지시문). 다만 배포 경로에는 계획 턴의
// `cannot_do` 라는 출구가 앞에 있고 탐침에는 없으므로, 그 한 줄만 여기서 준다 — 없으면
// 반대 방향 과제(`refuse-absent-file`)가 "일단 고쳐라"로 떠밀린다.
// 다시 보낼 턴인지. **본문이 빈 채 도구도 없이 끝난 턴**만이다. 배포본은 `saw_tool` 만
// 보지만(`chat.rs`: `let unstarted = status == "completed" && !saw_tool`), 그 앞에는 계획 턴의
// `cannot_do` 가 있어 "할 일이 없다"가 단계로 서지 않는다. 탐침에는 그 턴이 없어서 본문
// 유무를 함께 보지 않으면 끝난 일과 못 할 일까지 다시 떠민다 — 2026-09-28 실측으로
// CPU `refuse-absent-file` 이 6/6 에서 5/10 으로 떨어졌고 그중 한 번은 없는 파일을 지어내
// 만들었다. 본문이 빈 채 도구도 없이 끝난 턴은 화면에서 "끊김"이고
// (`chat.rs::note_silent_turn`), GPU `flatten-nesting` 의 `읽기만 함: read` 가 그 모양이다.
export function isUnstartedTurn({ toolCalls, content }) {
  return !(toolCalls ?? []).length && !String(content ?? "").trim();
}

export function unstartedNudge(task) {
  return (
    `앞 턴에서 도구를 부르지 않고 글만 쓰고 끝냈다. 이번에는 설명을 적지 말고 ${task.tools.join(", ")} 을(를) 바로 호출하라. ` +
    "호출할 것이 여럿이면 하나 부르고 결과를 본 뒤 다음을 부른다.\n" +
    "이 요청으로 할 일이 없으면 그 사실만 답으로 쓰고 끝내라."
  );
}
