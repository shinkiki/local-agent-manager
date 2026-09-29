// AIA 세션 전사에서 (사용자 요청 → 실제로 부른 시스템 MCP 호출) 을 뽑아 **도구 호출 형식** 학습
// 표본(T2)으로 낸다(M11 11.3).
//
//   node local-llm-dev/finetune/export-aia-toolcall.mjs \
//     --catalog local-llm-dev/finetune/data/system-catalog.json \
//     "C:/Users/<me>/.claude/projects/<aia-workspace>/*.jsonl" > data/toolcall.jsonl
//
// 무엇을 가르치나: 요청을 받았을 때 **어느 작업 이름을 고르고 인자를 어떤 모양으로 채우는지**. 로컬
// 모델이 자주 틀리는 자리는 작업 이름(없는 이름을 지어낸다)과 인자 키(카탈로그가 `id` 라고 한 자리에
// `sessionId` 를 쓴다) 두 곳이다. 그래서 표본은 카탈로그의 인자 예시와 실제 호출을 함께 싣는다.
//
// 무엇을 빼나: 카탈로그에 없는 작업, 결과가 오류였던 호출, 사람이 친 말이 아닌 자동 글. 틀린 호출을
// 정답으로 가르치지 않기 위해서다.
import fs from "node:fs";
import path from "node:path";

const READ_TOOL = "mcp__aia_system__system_read";
const EXECUTE_TOOL = "mcp__aia_system__system_execute";
const MAX_REQUEST_CHARS = 1_200;
// 요청이 "계속"·"진행" 한 마디면 어느 작업을 불러야 하는지 그 글에 없다. 전사에서는 앞선 수십
// 턴이 답을 정했지만 표본에는 직전 한 마디밖에 실리지 않는다. 그런 표본은 **가르칠 수도 잴 수도
// 없다** — 학습에 넣으면 아무 요청에나 마지막에 본 작업을 부르는 버릇이 붙고, 시험에 넣으면
// 맞히는 것이 운이다. 2026-09-28 첫 회차에서 504건 중 227건이 이것이었고, 도구 호출 채점이
// 4/20 으로 주저앉은 자리도 대부분 여기였다.
const MIN_REQUEST_CHARS = 20;
const CONTINUATION = /^\s*(계속|진행|ㄱ+|ok|네|응|예|좋아|그래|다시|해줘|반영|적용|시작|확인|고|가자)[.!~\s]*$/i;

/** 요청 한 줄이 "무엇을 부를지"를 스스로 말하고 있는가. */
export function isSelfContained(request) {
  const text = String(request ?? "").trim();
  return text.length >= MIN_REQUEST_CHARS && !CONTINUATION.test(text);
}

const NOT_A_REQUEST = [
  /^<task-notification>/,
  /^<command-name>/,
  /^\[Request interrupted/,
  /^Caveat: The messages below/,
  /^The previous response failed to produce/,
  /^<local-command-stdout>/,
  /^API Error/,
  /^This session is being continued from a previous conversation/,
];

function* records(file) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* 깨진 줄은 건너뛴다 */ }
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

function cleanRequest(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, "(붙여 넣은 내용)").trim();
}

/** 카탈로그를 {작업 이름 → {tool, description, arguments}} 로 편다. */
export function indexCatalog(catalog) {
  const index = new Map();
  for (const [key, tool] of [["read", "system_read"], ["execute", "system_execute"]]) {
    for (const entry of catalog[key] ?? []) {
      if (entry?.operation) index.set(entry.operation, { tool, description: entry.description ?? "", arguments: entry.arguments ?? {} });
    }
  }
  return index;
}

/** 도구 결과 한 덩이가 오류인지 본다. 오류였던 호출은 정답이 아니다. */
export function isFailure(result) {
  const text = typeof result === "string" ? result : Array.isArray(result) ? result.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
  return /^\s*(Error|오류)[:：]|실패:|요청 인자가 올바르지 않습니다|InputValidationError/.test(text);
}

/** 인자 객체의 키 모양만 남긴다(값은 그때그때 다르다). 중첩은 한 겹까지 본다. */
export function shapeOf(value) {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = Array.isArray(v) || (v && typeof v === "object") ? shapeOf(v) : typeof v;
    return out;
  }
  return typeof value;
}

export function extract(file, index) {
  const out = [];
  let request = null;
  let prior = "";
  let lastAssistant = "";
  // 같은 턴에서 부른 호출을 id 로 기억했다가, 뒤따르는 결과가 오류면 버린다.
  const pending = new Map();
  const keep = (id) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    out.push(item);
  };
  for (const record of records(file)) {
    const message = record.message ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (record.type === "user") {
      const results = content.filter((b) => b?.type === "tool_result");
      if (results.length) {
        for (const block of results) {
          if (isFailure(block.content)) pending.delete(block.tool_use_id);
          else keep(block.tool_use_id);
        }
        continue;
      }
      for (const id of [...pending.keys()]) keep(id);
      const text = cleanRequest(textOf(content) || (typeof message.content === "string" ? message.content : ""));
      prior = lastAssistant;
      request = text && !NOT_A_REQUEST.some((re) => re.test(text)) ? text : null;
      continue;
    }
    if (record.type !== "assistant" || !request || !isSelfContained(request)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      if (block.name !== READ_TOOL && block.name !== EXECUTE_TOOL) continue;
      const input = block.input ?? {};
      const entry = index.get(input.operation);
      // 카탈로그에 없는 작업은 지금 계약에서 부를 수 없다.
      if (!entry) continue;
      if (entry.tool !== (block.name === READ_TOOL ? "system_read" : "system_execute")) continue;
      pending.set(block.id, {
        request: request.length > MAX_REQUEST_CHARS ? request.slice(0, MAX_REQUEST_CHARS) + "…" : request,
        prior,
        tool: entry.tool,
        operation: input.operation,
        arguments: input.arguments ?? {},
        argumentShape: shapeOf(input.arguments ?? {}),
        catalogArguments: entry.arguments,
        description: entry.description,
        source: path.basename(file, ".jsonl"),
      });
    }
    const text = textOf(content);
    if (text.trim()) lastAssistant = text.trim().slice(-400);
  }
  return out;
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === "export-aia-toolcall.mjs";
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const catalogAt = argv.indexOf("--catalog");
  if (catalogAt < 0) {
    console.error("--catalog <system-catalog.json> 이 필요하다");
    process.exit(2);
  }
  const index = indexCatalog(JSON.parse(fs.readFileSync(argv[catalogAt + 1], "utf8")));
  const patterns = argv.filter((_, i) => i !== catalogAt && i !== catalogAt + 1);
  const files = patterns.flatMap((p) => {
    if (!p.includes("*")) return [p];
    const dir = path.dirname(p);
    const suffix = path.basename(p).replace("*", "");
    return fs.readdirSync(dir).filter((n) => n.endsWith(suffix)).map((n) => path.join(dir, n));
  });
  const items = files.flatMap((file) => extract(file, index));
  const operations = new Set(items.map((i) => i.operation));
  console.error(`전사 ${files.length}개 → 표본 ${items.length}건, 작업 ${operations.size}종 / 카탈로그 ${index.size}종`);
  for (const item of items) process.stdout.write(JSON.stringify(item) + "\n");
}
