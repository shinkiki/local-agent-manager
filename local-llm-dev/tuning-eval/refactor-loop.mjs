// 코드 리팩토링 측정. 모델 하나를 인자로 받는다.
//
//   node local-llm-dev/tuning-eval/refactor-loop.mjs qwen3.5-gpu-128k:latest
//   node local-llm-dev/tuning-eval/refactor-loop.mjs gpt-oss-cpu-low:latest
//
// **두 모델을 동시에 돌리지 않는다** — 서로를 메모리에서 내쫓아 측정이 망가진다.
//
// LEG 탐침과 다른 점: 여기는 **턴을 이어 돌리고 도구 호출을 실제로 실행한다.** 리팩토링은
// 한 턴짜리 일이 아니라 읽고 고치고 확인하는 고리라서, 한 턴만 보면 "읽기만 함"이 전부
// 실패로 찍힌다. 채점도 모델의 말이 아니라 샌드박스 파일의 부수효과로 한다.
//
// 샌드박스는 OS 임시 폴더 아래에만 만든다. 저장소 파일은 건드리지 않는다.
// REPEATS 로 시행 수를, ONLY_TASK 로 과제를, VERBOSE=1 로 턴별 진행을, KEEP=1 로
// 샌드박스 보존을 고른다.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASKS,
  toolsFor,
  scoreRun,
  promptFor,
  layout,
  runTool,
  unstartedNudge,
  isUnstartedTurn,
  MAX_UNSTARTED_RETRIES,
} from "./refactor-tasks.mjs";

const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const REPEATS = Number(process.env.REPEATS ?? 3);
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 8);
// 배포 실행기의 재시도 상한을 그대로 쓴다. `NO_NUDGE=1` 은 이 경로 없이 재는 비교용
// 스위치다(2026-09-28 코드 리팩토링 8회차의 고치기 전 표본이 그 값이다).
const MAX_NUDGES = process.env.NO_NUDGE ? 0 : Number(process.env.MAX_NUDGES ?? MAX_UNSTARTED_RETRIES);
const ONLY = process.env.ONLY_TASK;
const model = process.argv[2];
if (!model) {
  console.error("모델 이름을 인자로 준다");
  process.exit(2);
}

function checkBehavior(dir, task) {
  if (!task.files["check.mjs"]) return { code: 0, out: "" };
  try {
    const out = execFileSync(process.execPath, ["check.mjs"], {
      cwd: dir,
      timeout: 20000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? err.message}` };
  }
}

async function once(task) {
  const dir = mkdtempSync(join(tmpdir(), "refactor-eval-"));
  const before = layout(task, dir);
  const messages = [
    { role: "system", content: promptFor(task) },
    {
      role: "user",
      // 회차마다 무작위 표식을 붙인다. 안 붙이면 프롬프트 캐시가 결과를 부풀린다.
      content: `${task.prompt}\n\n작업 폴더는 지금 폴더다.\n(회차 ${Math.random().toString(36).slice(2, 8)})`,
    },
  ];
  const calls = [];
  let text = "";
  // 사고 기록. 앱은 본문이 빈 턴을 사고 기록 유무로 갈라 다르게 알리므로
  // (`chat.rs::note_silent_turn`), 탐침도 그 값을 들고 있어야 같은 말을 할 수 있다.
  // 들고 있지 않던 동안 GPU `refuse-absent-file` 의 정상 거절 한 건이 `본문 없음` 으로
  // 찍혔다(2026-09-25 코드 리팩토링 2회차). 필드 이름은 서버마다 갈려 둘 다 받는다.
  let reasoning = "";
  // 턴을 다 쓰고도 아직 도구를 부르던 중이었는지. 끝내 못 한 것과 **아직 하던 중인 것**은
  // 다른 실패라, 이 표식이 없으면 비용(턴 수)이 결함으로 찍힌다.
  let exhausted = false;
  // 도구 없이 끝난 턴을 몇 번 다시 보냈는지. 통과 여부와 따로 적는다 — 비용이지 결함이 아니다.
  let nudges = 0;
  let turns = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    turns = turn + 1;
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, tools: toolsFor(task.tools), messages }),
    });
    if (!res.ok) return { dir, before, calls, text, reasoning, turns, nudges, exhausted, error: `HTTP ${res.status}` };
    const msg = (await res.json()).choices?.[0]?.message ?? {};
    const turnCalls = (msg.tool_calls ?? []).map((c) => {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments);
      } catch {
        args = { _unparsed: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, args };
    });
    text = msg.content ?? "";
    reasoning = msg.reasoning ?? msg.reasoning_content ?? "";
    if (!turnCalls.length) {
      // 배포 실행기와 같은 자리(`plan.rs::retry_unstarted`). 아무것도 시도하지 않은 턴은
      // 판단할 실패가 아니라 아직 돌지 않은 턴이다.
      // 다시 보낼 턴인지는 `isUnstartedTurn` 하나가 정한다(본문이 빈 턴만).
      if (!isUnstartedTurn({ toolCalls: turnCalls, content: text })) break;
      if (nudges >= MAX_NUDGES) break;
      nudges += 1;
      messages.push({ role: "assistant", content: msg.content ?? "" });
      messages.push({ role: "user", content: unstartedNudge(task) });
      if (process.env.VERBOSE) console.log(`     ${turn}> (도구 없이 끝남 → 다시 보냄 ${nudges}/${MAX_NUDGES})`);
      continue;
    }
    exhausted = turn === MAX_TURNS - 1;
    calls.push(...turnCalls);
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    for (const call of turnCalls) {
      // 열린 도구 이름을 함께 준다 — 없는 도구를 불렀을 때 배포본처럼 목록을 돌려주기 위해서다.
      const out = runTool(dir, call, task.tools);
      if (process.env.VERBOSE) console.log(`     ${turn}> ${call.name} ${JSON.stringify(call.args).slice(0, 110)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }
  return { dir, before, calls, text, reasoning, turns, nudges, exhausted };
}

console.log(`=== ${model} · ${REPEATS}회 · 최대 ${MAX_TURNS}턴 · 부수효과 채점 ===`);
const rows = [];
for (const task of TASKS) {
  if (ONLY && task.id !== ONLY) continue;
  let ok = 0;
  const whys = [];
  const turnCounts = [];
  let nudgeTotal = 0;
  // 지어낸 도구 이름은 통과해도 센다 — 도구 수 민감도의 신호라 합격률 뒤에 숨기지 않는다.
  let inventedTotal = 0;
  for (let i = 0; i < REPEATS; i++) {
    const run = await once(task);
    const score = run.error
      ? { ok: false, why: run.error }
      : scoreRun(task, { ...run, check: checkBehavior(run.dir, task) });
    // 돌아간 턴 수는 통과 여부와 따로 적는다 — 비용이지 결함이 아니다.
    turnCounts.push(run.turns ?? 0);
    nudgeTotal += run.nudges ?? 0;
    inventedTotal += score.invented ?? 0;
    if (score.ok) ok++;
    else whys.push(score.why);
    if (process.env.VERBOSE)
      console.log(
        `   · ${score.ok ? "O" : "X"} ${score.why} :: ${String(run.text).replace(/\s+/g, " ").slice(0, 140)}` +
          (String(run.text).trim() ? "" : ` |사고:${String(run.reasoning ?? "").replace(/\s+/g, " ").slice(0, 160)}`),
      );
    if (!process.env.KEEP) rmSync(run.dir, { recursive: true, force: true });
    else console.log(`     샌드박스 남김: ${run.dir}`);
  }
  rows.push({ id: task.id, ok, turns: turnCounts });
  console.log(`${ok === REPEATS ? "O" : "X"} ${task.id.padEnd(20)} ${ok}/${REPEATS}  ${task.label}`);
  console.log(`    턴 ${turnCounts.join("·")} · 다시 보냄 ${nudgeTotal}회 · 지어낸 도구 이름 ${inventedTotal}회`);
  if (whys.length) console.log(`    어긋난 예: ${[...new Set(whys)].slice(0, 3).join(" / ")}`);
}
console.log("\n요약 " + rows.map((r) => `${r.id}=${r.ok}/${REPEATS}`).join(" "));
