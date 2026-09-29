// 계약 기반 아님 — 이 파일은 초기 모양 실험용이라 자체 프롬프트를 쓴다. 제품 계획 턴과
// 같은 문구·가드로 재려면 index-loop.mjs 와 fixtures/planning-contract.json 을 쓴다.
// 변종 E: 계획을 고리로 받는다. add_step 하나마다 결과를 돌려주고 다음을 묻는다.
// 한 응답에 호출을 여러 개 내는 성질에 기대지 않는다 — 될 때도 있고 안 될 때도 있다(실측).
//
// 회귀 시험으로도 쓴다(작업 9.8). 과제·채점·기준선은 plan-tasks.mjs 가 들고 있고,
// 기준선 아래로 떨어진 과제가 하나라도 있으면 이 스크립트는 exit 1 로 끝난다.
import {
  ALL, MAX_STEPS, MAX_TOOLS, TASKS, BASELINES, scorePlan, compareToBaseline,
} from "./plan-tasks.mjs";

const BASE = process.env.PLAN_EVAL_BASE || "http://127.0.0.1:11434/v1";

const tools = [
  { type: "function", function: { name: "add_step",
    description: "계획에 단계를 하나 더한다. 부른 순서가 곧 단계 순서다.",
    parameters: { type: "object", required: ["goal", "tools"], properties: {
      goal: { type: "string", description: "이 단계에서 무엇을 하는지 한 문장" },
      tools: { type: "array", maxItems: MAX_TOOLS, items: { type: "string" },
        description: "이 단계에서 부를 도구 이름. 주어진 목록에 있는 것만." } } } } },
  { type: "function", function: { name: "finish_plan",
    description: "더 필요한 단계가 없을 때 부른다. 계획이 여기서 확정된다.",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "cannot_do",
    description: "주어진 도구로는 요청을 할 수 없을 때 부른다.",
    parameters: { type: "object", required: ["reason"], properties: { reason: { type: "string" } } } } },
];

const system = `너는 요청을 처리할 계획을 세우는 에이전트다. 지금은 도구를 실행하지 않는다.
단계를 하나 정할 때마다 add_step 을 부른다. 한 번에 하나씩, 앞 단계 다음에 올 것을 부른다.
더 필요한 단계가 없으면 finish_plan 을 부른다.
주어진 도구로 할 수 없는 요청이면 계획을 지어내지 말고 cannot_do 를 부른다.

규칙:
- 단계는 최대 ${MAX_STEPS}개, 한 단계에 도구는 최대 ${MAX_TOOLS}개.
- 도구 이름은 아래 목록에 있는 것만 쓴다. 목록에 없는 이름을 지어내지 않는다.

쓸 수 있는 도구:
${ALL.join(", ")}`;

async function plan(model, task) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: `${task}\n\n(회차 ${Math.random().toString(36).slice(2, 8)})` },
  ];
  const steps = [];
  for (let turn = 0; turn < MAX_STEPS + 2; turn++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, tools, messages }),
    });
    const body = await res.json();
    const message = body.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!calls.length) return { steps, ended: "도구호출없음" };
    messages.push(message);
    for (const call of calls) {
      const name = call.function?.name;
      if (name === "finish_plan") return { steps, ended: "확정" };
      if (name === "cannot_do") return { steps, ended: "거절" };
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* 모양 깨짐은 아래서 잡힌다 */ }
      if (name !== "add_step" || typeof args.goal !== "string") {
        return { steps, ended: "모양깨짐" };
      }
      steps.push({ goal: args.goal, tools: Array.isArray(args.tools) ? args.tools : [] });
      // 고리의 핵심. 기록했다고 알려 주고 다음을 묻는다.
      messages.push({ role: "tool", tool_call_id: call.id,
        content: `단계 ${steps.length} 기록했다. 다음 단계가 있으면 add_step, 없으면 finish_plan 을 불러라.` });
    }
    if (steps.length >= MAX_STEPS) return { steps, ended: "상한도달" };
  }
  return { steps, ended: "고리한도" };
}

const REPEATS = Number(process.env.REPEATS || 3);
const only = process.env.ONLY_TASK ? process.env.ONLY_TASK.split(",") : null;
const selected = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
const regressions = [];
const fresh = [];

// 두 모델을 동시에 돌리지 않는다 — 서로의 모델을 메모리에서 내쫓아 측정이 망가진다.
for (const model of process.argv.slice(2)) {
  console.log(`\n================ ${model} ================`);
  if (!BASELINES[model]) console.log("  (이 모델의 기준선이 없다. 결과는 기록만 한다.)");
  for (const task of selected) {
    let ok = 0; const ends = {}; let worst = null;
    for (let i = 0; i < REPEATS; i++) {
      const started = Date.now();
      let out;
      try { out = await plan(model, task.text); } catch { ends["오류"] = (ends["오류"] || 0) + 1; continue; }
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      ends[out.ended] = (ends[out.ended] || 0) + 1;
      const score = scorePlan(out.steps, task.want);
      if (score.ok) ok += 1;
      else if (!worst) worst = { ...out, secs, ...score };
    }
    const rate = ok / REPEATS;
    const { verdict, baseline } = compareToBaseline(model, task.id, rate, { repeats: REPEATS });
    const mark = { regressed: "기준선 미달", wobbled: "한 시행 안쪽 흔들림", held: "기준선 유지",
      improved: "기준선 상회", unmeasured: "기준선 없음", unknown: "기준선 없음" }[verdict];
    const shown = baseline === null ? "-" : baseline.toFixed(2);
    console.log(`\n--- ${task.label} --- 타당 ${ok}/${REPEATS} (기준선 ${shown}, ${mark})   ${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
    if (verdict === "regressed") regressions.push(`${model} / ${task.label}: ${rate.toFixed(2)} < ${shown}`);
    if (verdict === "unmeasured" || verdict === "unknown") fresh.push(`${model} / ${task.id}: ${rate.toFixed(2)}`);
    if (worst) {
      console.log(`    어긋난 예(${worst.secs}s, ${worst.ended}): ${worst.reasons.join(" · ")}`);
      for (const s of worst.steps) console.log(`      - ${s.goal}  [${s.tools.join(", ")}]`);
    }
  }
}

if (fresh.length) {
  console.log(`\n기준선 없이 잰 것 (plan-tasks.mjs 의 BASELINES 에 적어 고정한다):`);
  for (const line of fresh) console.log(`  ${line}`);
}
if (regressions.length) {
  console.log(`\n기준선 미달 ${regressions.length}건:`);
  for (const line of regressions) console.log(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`\n기준선 미달 없음.`);
}
