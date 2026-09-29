// T1(라우팅)·T2(도구 호출)·T6(기능 지도) 표본을 하나의 SFT 학습 파일로 굽는다(M11 11.6).
//
//   node local-llm-dev/finetune/build-aia-sft.mjs \
//     --routing data/routing.jsonl --toolcall data/toolcall.jsonl --feature-map data/feature-map.jsonl \
//     --catalog data/system-catalog.json > data/sft-aia.jsonl
//
// 왜 색인을 잘라 싣나: 카탈로그 219종을 통째로 시스템 글에 넣으면 표본 하나가 3만 토큰이 넘는다.
// 12GB 한 장으로는 학습이 안 되고, 무엇보다 **외우게** 만든다. 실제 실행 때 AIA 는 카탈로그를
// 받아 읽는다. 그래서 표본마다 정답 작업과 헷갈릴 만한 이웃 몇 개만 색인으로 싣고, "색인에서 고른다"
// 는 버릇을 가르친다. 이름 자체의 기억은 기능 지도(T6) 표본이 따로 맡는다.
//
// 라벨 균형: 전사 표본은 위임 쪽으로 기운다(실제로 개발 작업을 많이 시켰다). --max-per-label 로
// 많은 쪽을 잘라 맞춘다. 자르는 순서는 파일 순서 그대로다 — 무작위로 흔들면 재현이 안 된다.
import fs from "node:fs";
import path from "node:path";

const INDEX_SIZE = 10;
// 인자에 실린 긴 글(문서 본문·스킬 파일)은 통째로 가르칠 것이 아니다. 배워야 하는 것은 키 이름과
// 값의 종류지 본문이 아니고, 본문을 실으면 표본 하나가 수천 토큰으로 불어난다.
const MAX_VALUE_CHARS = 200;
// 한 표본의 글자 상한. 이 기계는 2048 토큰을 넘으면 VRAM 이 넘쳐 스텝이 수십 배 느려진다
// (train_lora.py 의 to_bfloat16 주석). 한국어는 대략 두 글자에 한 토큰이라 4,400 자를 상한으로 둔다.
const MAX_SAMPLE_CHARS = 4_400;

const ROUTING_SYSTEM = [
  "너는 Agent Manager 의 조율자(PO)다. 전달하고 기록하고 정리한다.",
  "요청을 받으면 먼저 누가 할 일인지 가른다.",
  "- 직접: 시스템 조회·기록·검색·파일 읽기처럼 네가 바로 끝낼 수 있는 일.",
  "- 위임: 코드 변경·진단·설계·요약처럼 1티어 에이전트에게 넘길 일. 요약조차 네가 쓰지 않는다.",
  "- 사람: 정책·방향을 고르는 일. 선택지와 영향을 적어 사용자에게 묻는다.",
  "한 줄로 답한다: `직접` 또는 `위임: <무엇을>` 또는 `사람: <무엇을>`.",
].join("\n");

const CALL_SYSTEM = [
  "너는 Agent Manager 의 조율자(PO)다. 아래 색인에 있는 작업만 부를 수 있다.",
  "조회는 system_read, 변경은 system_execute 다. 인자는 색인이 적은 키를 그대로 쓴다.",
  "색인에 없는 일은 부르지 말고, 없다고 말하고 화면에서 할 자리를 알려 준다.",
].join("\n");

const FEATURE_SYSTEM = "너는 Agent Manager 의 조율자(PO)다. 이 앱의 기능을 묻는 말에 사실대로 답한다. 없는 기능을 지어내지 않는다.";

export function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** 카탈로그를 작업 이름 → 항목으로 편다. */
export function indexCatalog(catalog) {
  const entries = [];
  for (const [key, tool] of [["read", "system_read"], ["execute", "system_execute"]]) {
    for (const entry of catalog[key] ?? []) {
      if (entry?.operation) entries.push({ operation: entry.operation, tool, description: entry.description ?? "", arguments: entry.arguments ?? {} });
    }
  }
  return entries;
}

/** 이름이 같으면 늘 같은 자리. 표본을 다시 구워도 색인이 흔들리지 않게 한다. */
function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

/**
 * 정답 작업과 이웃 몇 개를 골라 색인을 만든다. 이웃은 이름 앞머리가 같은 것(get_·set_·list_ 뒤의
 * 첫 낱말)을 먼저 넣는다 — 실제로 헷갈리는 자리가 거기다. 모자라면 해시 순서로 채운다.
 */
export function pickIndex(entries, operation, size = INDEX_SIZE) {
  const answer = entries.find((e) => e.operation === operation);
  if (!answer) return null;
  const stem = operation.replace(/^(get|set|list|create|update|delete|read)_/, "").split("_")[0];
  const others = entries.filter((e) => e.operation !== operation);
  const near = others.filter((e) => e.operation.includes(stem));
  const rest = others.filter((e) => !e.operation.includes(stem)).sort((a, b) => hash(a.operation + operation) - hash(b.operation + operation));
  const picked = [...near.slice(0, size - 1), ...rest].slice(0, size - 1);
  // 정답 자리도 이름으로 정한다. 늘 첫 줄이면 자리만 외운다.
  const all = [...picked, answer].sort((a, b) => hash(a.operation) - hash(b.operation));
  return all;
}

export function indexText(entries) {
  return entries.map((e) => `- ${e.operation} (${e.tool}): ${e.description}. 인자: ${Object.keys(e.arguments).length ? JSON.stringify(e.arguments) : "{}"}`).join("\n");
}

/** 색인에 오른 작업만 부를 수 있는 도구 두 벌. */
export function toolsFor(entries) {
  const names = (tool) => entries.filter((e) => e.tool === tool).map((e) => e.operation);
  return ["system_read", "system_execute"].filter((tool) => names(tool).length).map((tool) => ({
    type: "function",
    function: {
      name: tool,
      description: tool === "system_read" ? "Agent Manager 조회 작업을 실행한다." : "Agent Manager 변경 작업을 실행한다. 사용자가 요청한 범위에서만 쓴다.",
      parameters: {
        type: "object",
        properties: { operation: { type: "string", enum: names(tool) }, arguments: { type: "object" } },
        // arguments 도 필수다. 선택으로 두면 서빙 층이 그 칸을 덜 강조해 모델이 건너뛴다 —
        // 3회차 배포본이 작업 이름만 내고 인자를 비운 자리가 여기였다(2026-09-28). 학습 렌더링은
        // 스키마 전체를 풀어 써서 티가 안 났고, Ollama 렌더링에서만 드러났다. 인자가 없는 작업은
        // 빈 객체를 내면 되므로 필수로 둬도 모순이 없다.
        required: ["operation", "arguments"],
      },
    },
  }));
}

/** 긴 문자열 값을 줄인다. 중첩된 객체·배열도 따라 들어간다. */
export function trimValue(value, max = MAX_VALUE_CHARS) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max - 6)}…(줄임)` : value;
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => trimValue(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimValue(v, max)]));
  }
  return value;
}

/** 표본 하나의 글자 수. 길면 학습에서 뺀다. */
export function sampleChars(sample) {
  const messages = sample.messages.map((m) => (m.content ?? "") + JSON.stringify(m.tool_calls ?? "")).join("");
  return messages.length + JSON.stringify(sample.tools ?? "").length;
}

function userText(request, prior) {
  return prior ? `직전에 내가 한 말: ${prior}\n\n요청: ${request}` : `요청: ${request}`;
}

export function routingSample(item) {
  const answer = item.label === "direct" ? "직접"
    : item.label === "human" ? "사람: 어느 쪽으로 갈지 정한다"
      : "위임: 코드·진단·정리를 1티어 에이전트에게 넘긴다";
  return {
    messages: [
      { role: "system", content: ROUTING_SYSTEM },
      { role: "user", content: userText(item.request, item.prior) },
      { role: "assistant", content: answer },
    ],
    meta: { task: "routing", label: item.label, source: item.source },
  };
}

export function callSample(item, entries) {
  const index = pickIndex(entries, item.operation);
  if (!index) return null;
  return {
    messages: [
      { role: "system", content: `${CALL_SYSTEM}\n\n색인:\n${indexText(index)}` },
      { role: "user", content: userText(item.request, item.prior) },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: item.tool, arguments: JSON.stringify({ operation: item.operation, arguments: trimValue(item.arguments ?? {}) }) } }],
      },
    ],
    tools: toolsFor(index),
    meta: { task: item.kind === "call" ? "feature-call" : "toolcall", operation: item.operation, source: item.source ?? "catalog" },
  };
}

export function answerSample(item) {
  return {
    messages: [
      { role: "system", content: FEATURE_SYSTEM },
      { role: "user", content: item.request },
      { role: "assistant", content: item.answer },
    ],
    meta: { task: item.kind === "absent" ? "feature-absent" : "feature-name", operation: item.operation ?? null, source: "catalog" },
  };
}

/**
 * 시험용으로 남길 몫을 가른다. 과제 종류마다 n 번째 표본을 뺀다 — 종류를 섞어 세면 한 종류가
 * 통째로 빠져 그 종류를 재지 못한다. 무작위로 흔들지 않아 같은 데이터면 같은 갈래가 나온다.
 */
export function splitHoldout(samples, every) {
  if (!every || every < 2) return { train: samples, holdout: [] };
  const seen = new Map();
  const train = [];
  const holdout = [];
  for (const sample of samples) {
    const task = sample.meta.task;
    const n = (seen.get(task) ?? 0) + 1;
    seen.set(task, n);
    (n % every === 0 ? holdout : train).push(sample);
  }
  return { train, holdout };
}

/** 라벨마다 상한을 두어 치우침을 줄인다. 자르는 순서는 들어온 순서 그대로다. */
export function capByLabel(items, labelOf, max) {
  if (!max) return items;
  const seen = new Map();
  return items.filter((item) => {
    const key = labelOf(item);
    const count = seen.get(key) ?? 0;
    if (count >= max) return false;
    seen.set(key, count + 1);
    return true;
  });
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === "build-aia-sft.mjs";
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const at = argv.indexOf(name);
    return at < 0 ? fallback : argv[at + 1];
  };
  const catalogFile = flag("--catalog");
  if (!catalogFile) {
    console.error("--catalog <system-catalog.json> 이 필요하다");
    process.exit(2);
  }
  const entries = indexCatalog(JSON.parse(fs.readFileSync(catalogFile, "utf8")));
  const maxPerLabel = Number(flag("--max-per-label", "60"));
  const maxPerOperation = Number(flag("--max-per-operation", "8"));
  const out = [];

  const routingFile = flag("--routing");
  if (routingFile) {
    for (const item of capByLabel(readJsonl(routingFile), (i) => i.label, maxPerLabel)) out.push(routingSample(item));
  }
  const toolcallFile = flag("--toolcall");
  if (toolcallFile) {
    for (const item of capByLabel(readJsonl(toolcallFile), (i) => i.operation, maxPerOperation)) {
      const sample = callSample(item, entries);
      if (sample) out.push(sample);
    }
  }
  const featureFile = flag("--feature-map");
  if (featureFile) {
    for (const item of readJsonl(featureFile)) {
      const sample = item.kind === "call" ? callSample(item, entries) : answerSample(item);
      if (sample) out.push(sample);
    }
  }

  // 상한을 넘는 표본은 뺀다. 잘라 실으면 정답인 도구 호출이 끝에서 잘려 나간다.
  const kept = out.filter((sample) => sampleChars(sample) <= MAX_SAMPLE_CHARS);
  const { train, holdout } = splitHoldout(kept, Number(flag("--holdout-every", "0")));
  const holdoutFile = flag("--holdout-out");
  if (holdoutFile) fs.writeFileSync(holdoutFile, holdout.map((s) => JSON.stringify(s)).join("\n") + (holdout.length ? "\n" : ""), "utf8");
  const counts = {};
  for (const sample of train) counts[sample.meta.task] = (counts[sample.meta.task] ?? 0) + 1;
  console.error(`학습 ${train.length}건 / 남긴 시험 ${holdout.length}건 (길어서 뺀 것 ${out.length - kept.length}건)`, counts);
  for (const sample of train) process.stdout.write(JSON.stringify(sample) + "\n");
}
