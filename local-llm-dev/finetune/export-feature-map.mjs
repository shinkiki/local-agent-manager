// 시스템 카탈로그에서 **기능 지도** 학습 표본(T6)을 낸다(M11 11.7).
//
//   node local-llm-dev/finetune/export-feature-map.mjs \
//     --catalog local-llm-dev/finetune/data/system-catalog.json //     --requests data/feature-requests.jsonl > data/feature-map.jsonl
//
// 왜 필요한가: 전사에서 뽑은 도구 호출 표본(T2)은 실제로 쓴 46종만 덮는다. 나머지 173종은 AIA 가
// "그런 기능은 없다" 고 답하거나 이름을 지어내는 자리다. PO 는 에이전트 매니저의 모든 기능을 알고
// 있어야 하므로, 카탈로그의 모든 작업을 한 번씩은 싣는다.
//
// 표본은 세 갈래다:
//   call   : 기능 설명을 요청으로 주고 → 올바른 도구·작업·인자 모양을 부른다
//   name   : 작업 이름을 주고 → 그 작업이 무엇을 하는지, 조회인지 변경인지 답한다
//   absent : 카탈로그에 없는 일을 시키면 → 없다고 말하고 화면 안내로 넘긴다
//
// 요청문은 카탈로그의 설명을 그대로 쓴다. 사람이 실제로 치는 말투는 아니지만, 가르치려는 것은
// 말투가 아니라 이름·인자·있고 없음의 대응이다. 말투 다양성은 T2 의 실제 전사 표본이 맡는다.
import fs from "node:fs";
import path from "node:path";

/** 설명은 명사구다("세션 목록 조회"). 요청문으로 쓰려고 몇 가지 말끝을 붙인다. */
const CALL_FORMS = [
  (d) => `${d}.`,
  (d) => `${d} 해줘.`,
  (d) => `${d} — 어떤 작업을 부르면 되나?`,
];

const NAME_FORMS = [
  (op) => `${op} 은(는) 무슨 작업이지?`,
  (op) => `에이전트 매니저에서 ${op} 을(를) 부르면 무엇이 일어나?`,
];

/** 카탈로그에 없지만 사람이 물을 법한 일. 지어내지 말고 화면으로 넘겨야 하는 자리다. */
const ABSENT = [
  { request: "로컬 LLM 연결을 새로 등록해줘.", why: "연결 등록·수정과 API 키 입력은 카탈로그에 없다. 설정 화면에서 사람이 직접 한다." },
  { request: "이 채팅의 API 키를 바꿔줘.", why: "API 키는 카탈로그에 없다. 운영체제 키체인에만 두고 설정 화면에서 사람이 직접 넣는다." },
  { request: "에이전트 매니저를 업데이트해줘.", why: "앱 갱신은 카탈로그에 없다." },
  { request: "이 컴퓨터를 재부팅해줘.", why: "기계 조작은 카탈로그에 없다." },
  { request: "내 계정 비밀번호를 알려줘.", why: "자격 증명 조회는 카탈로그에 없다." },
];

/**
 * 1티어 에이전트가 다시 쓴 요청문을 얹는다. 카탈로그 설명은 개발자가 쓴 명사구라 사람 말투가
 * 아니고, 그대로 학습하면 말투가 바뀌는 순간 못 알아듣는다(2026-09-28 1회차의 한계).
 * 파일은 한 줄에 {"operation": "...", "requests": ["...", ...]} 꼴이다.
 */
export function loadRequests(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const requests = (row.requests ?? []).map((r) => String(r).trim()).filter(Boolean);
    if (row.operation && requests.length) map.set(row.operation, requests);
  }
  return map;
}

export function buildSamples(catalog, { requests = new Map(), perOperation = 3 } = {}) {
  const out = [];
  for (const [key, tool] of [["read", "system_read"], ["execute", "system_execute"]]) {
    for (const entry of catalog[key] ?? []) {
      const operation = entry?.operation;
      if (!operation) continue;
      const description = (entry.description ?? "").trim();
      const args = entry.arguments ?? {};
      const written = requests.get(operation);
      if (written?.length) {
        // 사람 말투가 있으면 그것만 쓴다. 명사구 판을 섞으면 그 말투까지 같이 배운다.
        for (const request of written.slice(0, perOperation)) {
          out.push({ kind: "call", request, tool, operation, arguments: args, description });
        }
      } else if (description) {
        // 다시 쓴 요청문이 없는 작업은 설명으로 버틴다. 작업 하나도 빠뜨리지 않는 것이 먼저다.
        const form = CALL_FORMS[hash(operation) % CALL_FORMS.length];
        out.push({ kind: "call", request: form(description), tool, operation, arguments: args, description });
      }
      out.push({
        kind: "name",
        request: NAME_FORMS[hash(operation + "n") % NAME_FORMS.length](operation),
        tool, operation, arguments: args, description,
        answer: `${operation} 은 ${tool === "system_read" ? "조회" : "변경"} 작업이다. ${description}. 인자는 ${Object.keys(args).length ? Object.keys(args).join(", ") : "없다"}.`,
      });
    }
  }
  for (const item of ABSENT) out.push({ kind: "absent", request: item.request, tool: null, operation: null, answer: item.why });
  return out;
}

/** 이름에서 고른 말끝이 매번 같도록, 자리마다 흔들리지 않는 작은 해시. */
function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === "export-feature-map.mjs";
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--catalog");
  if (at < 0) {
    console.error("--catalog <system-catalog.json> 이 필요하다");
    process.exit(2);
  }
  const catalog = JSON.parse(fs.readFileSync(argv[at + 1], "utf8"));
  const requestsAt = argv.indexOf("--requests");
  const requests = requestsAt < 0 ? new Map() : loadRequests(argv[requestsAt + 1]);
  const perAt = argv.indexOf("--requests-per-operation");
  const perOperation = perAt < 0 ? 3 : Number(argv[perAt + 1]);
  const items = buildSamples(catalog, { requests, perOperation });
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  const operations = new Set(items.filter((i) => i.operation).map((i) => i.operation));
  const written = items.filter((i) => i.kind === "call" && requests.has(i.operation)).length;
  console.error(`작업 ${operations.size}종 → 표본 ${items.length}건 (사람 말투 요청문 ${written}건)`, counts);
  for (const item of items) process.stdout.write(JSON.stringify(item) + "\n");
}
