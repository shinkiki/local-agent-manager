// 인터넷 조사(LEG) 측정. 모델 하나를 인자로 받는다.
//
//   node local-llm-dev/tuning-eval/leg-loop.mjs qwen3.5-gpu-128k:latest
//   node local-llm-dev/tuning-eval/leg-loop.mjs gpt-oss-cpu-low:latest
//
// **두 모델을 동시에 돌리지 않는다** — 서로를 메모리에서 내쫓아 측정이 망가진다.
// 회차마다 무작위 표식을 붙인다. 안 붙이면 프롬프트 캐시가 결과를 부풀린다.
// REPEATS 로 시행 수를, ONLY_TASK 로 과제를 좁힌다.

import { TASKS, toolsFor, scoreTurns, promptFor } from "./leg-tasks.mjs";

const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const REPEATS = Number(process.env.REPEATS ?? 3);
const ONLY = process.env.ONLY_TASK;
/// 한 과제에 허용하는 모델 턴 수. 거절은 대개 1~2턴이고, 로컬을 한 번 뒤진 뒤 거절하는
/// 길을 담을 만큼만 준다. 넉넉히 주면 맴도는 것과 해내는 것이 같은 칸에 들어간다.
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 4);
const model = process.argv[2];
if (!model) { console.error("모델 이름을 인자로 준다"); process.exit(2); }

/// 도구를 실제로 실행하지 않고 돌려주는 결과.
///
/// **이 측정기는 셸도 네트워크도 돌리지 않는다.** 재려는 것은 도구가 무엇을 돌려주느냐가
/// 아니라 빈손으로 돌아왔을 때 모델이 무엇을 하느냐이기 때문이다. `read` 만 실제 파일을
/// 읽는다 — 대조 과제(local-doable)가 "되는 일을 하는가"를 묻는 자리라 그 한 턴은 진짜여야
/// 다음 턴의 판단이 의미를 갖는다.
async function toolResult(name, args) {
  if (name === "read") {
    try {
      const { readFileSync } = await import("node:fs");
      return readFileSync(String(args.filePath ?? ""), "utf8").slice(0, 2000);
    } catch (error) {
      return `읽지 못했다: ${error.message}`;
    }
  }
  if (name === "webfetch") return "(측정기는 네트워크로 나가지 않는다) 내용을 받지 못했다.";
  if (name === "bash") return "(측정기는 셸을 실행하지 않는다) 결과를 받지 못했다.";
  return "결과 없음";
}

function parseCalls(msg) {
  return (msg.tool_calls ?? []).map((c) => {
    let args = {};
    try { args = JSON.parse(c.function.arguments); } catch { args = { _unparsed: c.function.arguments }; }
    return { id: c.id, name: c.function.name, args };
  });
}

/// 한 시행. 도구를 부르면 결과를 돌려주고 다음 턴을 묻는다 — plan-loop.mjs 와 같은 고리다.
/// 한 턴만 보면 "로컬을 한 번 뒤진 뒤 제대로 거절했다"와 "끝내 못 했다"가 구별되지 않는다.
async function once(task) {
  const messages = [
    { role: "system", content: promptFor(task) },
    { role: "user", content: `${task.prompt}

(회차 ${Math.random().toString(36).slice(2, 8)})` },
  ];
  const turns = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, tools: toolsFor(task.tools), messages }),
    });
    if (!res.ok) return { turns, error: `HTTP ${res.status}` };
    const msg = (await res.json()).choices?.[0]?.message ?? {};
    const calls = parseCalls(msg);
    turns.push({ calls, text: msg.content ?? "" });
    if (!calls.length) return { turns };
    messages.push(msg);
    for (const call of calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await toolResult(call.name, call.args) });
    }
  }
  return { turns, ended: "고리한도" };
}

console.log(`=== ${model} · ${REPEATS}회 · 도구는 과제마다 다름 ===`);
const rows = [];
for (const task of TASKS) {
  if (ONLY && task.id !== ONLY) continue;
  let ok = 0; let detours = 0; const whys = [];
  for (let i = 0; i < REPEATS; i++) {
    const run = await once(task);
    const s = run.error ? { ok: false, why: run.error, detours: 0 } : scoreTurns(task, run.turns);
    if (s.ok) ok++; else whys.push(s.why);
    detours += s.detours ?? 0;
    if (process.env.VERBOSE) {
      const said = run.turns.map((t) => t.text).filter(Boolean).join(" | ");
      console.log(`   · ${s.ok ? "O" : "X"} ${s.why} :: ${said.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  rows.push({ id: task.id, label: task.label, tools: task.tools.length, ok, detours, whys });
  // 돌아간 턴은 합격·불합격과 따로 적는다. 합격이되 비싼 것이 보여야 다음에 줄일 수 있다.
  const cost = detours ? ` (돌아간 턴 ${detours})` : "";
  console.log(`${ok === REPEATS ? "O" : "X"} ${task.id.padEnd(18)} ${String(task.tools.length)}개 ${ok}/${REPEATS}${cost}  ${task.label}`);
  if (whys.length) console.log(`    어긋난 예: ${[...new Set(whys)].slice(0, 3).join(" / ")}`);
}
console.log("\n요약 " + rows.map((r) => `${r.id}=${r.ok}/${REPEATS}`).join(" "));
