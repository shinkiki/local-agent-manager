// 계획 탐침 추적본(.tuning/*trace*.jsonl)에서 **깨끗하게 통과한** 계획 궤적만 골라 SFT 학습
// 데이터(JSONL, OpenAI 대화 형식 + tools)로 낸다.
//
//   node local-llm-dev/finetune/export-sft.mjs .tuning/*trace*.jsonl > local-llm-dev/finetune/data/sft.jsonl
//   MAX_PER_TASK=60 node local-llm-dev/finetune/export-sft.mjs ...      # 과제별 상한(기본 60)
//   INCLUDE_REASONING=1 ...                                              # 사고 기록도 학습(기본 제외)
//
// 무엇을 가르치나: 계획 프로토콜뿐이다 — 요청을 읽고 add_step 을 도구 하나씩 부르고, 다 적으면
// finish_plan, 도구가 필요 없으면 answer_now, 못 하면 cannot_do. 도구 이름은 시스템 글의 색인에서
// 읽는 것이지 외워야 할 사실이 아니다. 그래서 시스템 글은 **지금 계약**의 색인으로 다시 만든다 —
// 옛 색인을 굽지 않는다(스킬 5절: 프롬프트가 도구 표면을 주장하지 않는다).
//
// 추적본에는 assistant 턴만 남아 있다. 도구 결과(영수증·되묻기)는 계약의 continuations 로
// 결정적으로 다시 만들 수 있으므로, 되묻기·이름 오류·되돌림이 없는(nudges=badNames=mismatches=
// repairs=0) 궤적만 낸다 — 그 밖의 궤적은 도구 결과를 복원할 수 없다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.join(here, "../plan-eval/fixtures/planning-contract.json");

/** 계약과 과제 정의를 읽는다. 시험이 다른 계약을 끼울 수 있게 인자로 받는다. */
export function loadContract(file = contractPath) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 탐침이 계획 턴에 연 도구 목록. guard 변형과 같다 — draftSchemas + invalid. */
export function planningTools(contract) {
  const tools = (contract.draftSchemas ?? contract.schemas).map((s) => ({ type: "function", function: { ...s, name: "plan_" + s.name } }));
  tools.unshift({ type: "function", function: { name: "invalid", description: "Do not use", parameters: { type: "object", properties: { tool: { type: "string" }, error: { type: "string" } }, required: ["tool", "error"] } } });
  return tools;
}

/** 궤적 하나가 학습에 쓸 만한지. 통과했고 되묻기·오류·되돌림이 없어야 도구 결과를 복원할 수 있다. */
export function isClean(record) {
  return Boolean(record.ok) && record.variant === "guard" && !record.nudges && !record.badNames && !record.mismatches && !record.repairs && Array.isArray(record.trace) && record.trace.length > 0;
}

/**
 * 궤적을 대화로 복원한다. 실패하면 null — 예컨대 add_step 인자가 JSON 이 아니거나, 마지막이
 * 종료 도구가 아니거나, 도구 호출이 한 턴에 둘 이상이면 프로토콜 밖이라 가르치지 않는다.
 */
export function toConversation(record, contract, { includeReasoning = false, requestPrefix = "" } = {}) {
  const index = contract.index;
  const system = contract.systemPrompt.replace("<INDEX>", index);
  const request = requestPrefix + record.prompt;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: contract.prompt.replace("<REQUEST>", request) },
  ];
  let steps = 0;
  let ended = null;
  for (const turn of record.trace) {
    if (turn.role !== "assistant") return null;
    const calls = turn.tool_calls ?? [];
    if (calls.length !== 1) return null;
    const call = calls[0];
    const name = call.function?.name ?? "";
    let args;
    try { args = JSON.parse(call.function?.arguments || "{}"); } catch { return null; }
    const assistant = { role: "assistant", content: "", tool_calls: [{ id: call.id ?? `call_${messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    if (includeReasoning && typeof turn.reasoning === "string" && turn.reasoning.trim()) assistant.reasoning_content = turn.reasoning.trim();
    messages.push(assistant);
    if (name === "plan_add_step") {
      steps++;
      const receipt = contract.continuations[steps]?.receipt;
      if (!receipt) return null;
      messages.push({ role: "tool", tool_call_id: assistant.tool_calls[0].id, content: JSON.stringify(receipt, null, 2) });
    } else if (name === "plan_finish_plan" || name === "plan_answer_now" || name === "plan_cannot_do") {
      ended = name;
      break;
    } else {
      return null;
    }
  }
  if (!ended) return null;
  if (ended === "plan_finish_plan" && steps === 0) return null;
  return { messages, tools: planningTools(contract), meta: { model: record.model, task: record.task, marker: record.marker, ended, steps } };
}

/** 과제별 상한으로 균형을 맞춘다. 거절 과제가 많으면 모델이 거절부터 배운다. */
export function balance(items, maxPerTask) {
  const seen = new Set();
  const perTask = new Map();
  const out = [];
  for (const item of items) {
    if (seen.has(item.meta.marker)) continue;
    seen.add(item.meta.marker);
    const count = perTask.get(item.meta.task) ?? 0;
    if (count >= maxPerTask) continue;
    perTask.set(item.meta.task, count + 1);
    out.push(item);
  }
  return out;
}

export function exportSft(files, { contract = loadContract(), maxPerTask = 60, includeReasoning = false, tasks = null } = {}) {
  // 과제 문장은 탐침 정의에 있다. 기록에는 task id 만 남으므로 여기서 다시 붙인다.
  const taskPrompts = tasks ?? loadTaskPrompts();
  const items = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!isClean(record)) continue;
      const prompt = taskPrompts[record.task];
      if (!prompt) continue;
      const conversation = toConversation({ ...record, prompt }, contract, { includeReasoning, requestPrefix: "" });
      if (conversation) items.push(conversation);
    }
  }
  return balance(items, maxPerTask);
}

/** 탐침의 과제 정의에서 id → 문장. index-loop 가 내보내는 TASKS 를 그대로 쓴다. */
async function loadTaskPromptsAsync() {
  const mod = await import(path.join(here, "../plan-eval/index-loop.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  return Object.fromEntries((mod.TASKS ?? []).map((t) => [t.id, t.prompt]));
}
let cachedTasks = null;
function loadTaskPrompts() {
  if (!cachedTasks) throw new Error("과제 문장을 먼저 읽어야 한다(main 이 한다)");
  return cachedTasks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("추적본 파일을 인자로 준다"); process.exit(2); }
  cachedTasks = await loadTaskPromptsAsync();
  const items = exportSft(files, { maxPerTask: Number(process.env.MAX_PER_TASK ?? 60), includeReasoning: Boolean(process.env.INCLUDE_REASONING), tasks: cachedTasks });
  const byTask = {};
  for (const item of items) byTask[item.meta.task] = (byTask[item.meta.task] ?? 0) + 1;
  console.error(`표본 ${items.length}건`, byTask);
  for (const item of items) process.stdout.write(JSON.stringify({ messages: item.messages, tools: item.tools, meta: item.meta }) + "\n");
}
