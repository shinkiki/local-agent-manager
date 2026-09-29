// AIA(Claude) 세션 전사에서 (사용자 요청 → AIA 가 실제로 한 행동) 쌍을 뽑아 **라우팅 판단** 학습 표본(T1)으로
// 낸다(M11 11.2).
//
//   node local-llm-dev/finetune/export-aia-routing.mjs "C:/Users/<me>/.claude/projects/<aia-workspace>/*.jsonl" > data/routing.jsonl
//
// 라벨은 PO 설계의 티어 규칙으로 다시 매긴다 — 과거에 Claude-AIA 가 스스로 한 일이라도 새 설계에서 1티어
// 몫이면 "delegate" 다:
//   direct   : 시스템 도구(agent-manager_system_read/execute)·외부 플러그인·UI 안내만 썼다 (조회·구조화 쓰기·기록)
//   delegate : 파일 편집·셸·코드 검색·서브에이전트를 썼다 (코드 변경·진단·설계·요약은 1티어 몫)
//   human    : 도구 없이 선택지를 묻고 끝냈다 (정책·방향 결정)
// 도구를 하나도 안 쓰고 답만 한 턴은 뺀다 — 답 자체를 가르치지 않는다.
import fs from "node:fs";
import path from "node:path";

// 조회·검색·파일 읽기는 3티어가 직접 한다. 편집·쓰기·서브에이전트·워크플로는 1티어 몫이다.
const DIRECT_TOOLS = new Set(["mcp__aia_system__system_read", "mcp__aia_system__system_execute", "mcp__aia_system__system_catalog", "mcp__aia_system__interface_read", "mcp__aia_system__interface_execute", "mcp__aia_system__interface_catalog", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"]);
const DELEGATE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Workflow"]);
// 셸은 명령을 보고 가른다. 읽기만 하는 명령(git log·grep·ls·cat…)은 조회, 나머지는 변경으로 본다.
const READ_ONLY_SHELL = /^\s*(git\s+(log|status|diff|show|branch|grep)|grep|rg|ls|dir|cat|head|tail|wc|find|sed\s+-n|echo|type|python(3)?\s+-c\s+"import\s+json|node\s+-e|nvidia-smi|ollama\s+(ps|list|show)|curl\s+-s|tasklist|date)\b/;
export function classifyShell(command) {
  const first = String(command ?? "").split(/&&|;|\|\|/)[0];
  return READ_ONLY_SHELL.test(first) && !/>\s*[^&]|rm\s|del\s|git\s+(commit|push|add|rm|checkout|reset)|npm\s+run|cargo\s+(test|build)|python\s+[^-]/.test(command ?? "") ? "direct" : "delegate";
}
const MAX_REQUEST_CHARS = 1_200;

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

function isToolResultOnly(content) {
  return Array.isArray(content) && content.length > 0 && content.every((b) => b && b.type === "tool_result");
}

// 사람이 친 말이 아닌 자동 글. 이런 턴은 라우팅 표본에서 뺀다 — 가르칠 요청이 아니다.
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

/** 시스템 리마인더 같은 자동 글을 뗀다. 사용자가 실제로 친 말만 남긴다. */
function cleanRequest(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, "(붙여 넣은 내용)").trim();
}

export function labelTurn(tools) {
  let delegate = false;
  let direct = false;
  for (const tool of tools) {
    if (DELEGATE_TOOLS.has(tool.name)) delegate = true;
    else if (tool.name === "Bash" || tool.name === "PowerShell") {
      if (classifyShell(tool.command) === "delegate") delegate = true; else direct = true;
    } else if (DIRECT_TOOLS.has(tool.name)) direct = true;
  }
  if (delegate) return "delegate";
  if (direct) return "direct";
  return null;
}

/** 전사 하나를 (요청, 첫 응답 턴의 도구들, 라벨) 로 자른다. */
export function extract(file) {
  const out = [];
  let current = null;
  // 직전 응답의 끝. "진행"·"A-1 확정" 같은 짧은 요청은 이것이 있어야 뜻이 선다.
  let lastAssistant = "";
  const flush = () => {
    if (!current) return;
    const { request, prior, tools, askedHuman } = current;
    let label = labelTurn(tools);
    if (!label && askedHuman) label = "human";
    if (label && request) {
      out.push({
        request: request.length > MAX_REQUEST_CHARS ? request.slice(0, MAX_REQUEST_CHARS) + "…" : request,
        prior: prior || "",
        label,
        operations: [...new Set(tools.filter((t) => DIRECT_TOOLS.has(t.name)).map((t) => t.operation).filter(Boolean))],
        tools: [...new Set(tools.map((t) => t.name))],
        source: path.basename(file, ".jsonl"),
      });
    }
    current = null;
  };
  for (const record of records(file)) {
    const message = record.message ?? {};
    if (record.type === "user") {
      if (isToolResultOnly(message.content)) continue;
      const request = cleanRequest(textOf(message.content));
      const prior = current ? current.lastAssistant : lastAssistant;
      flush();
      // 그림만 붙인 요청은 글이 없어 라우팅을 가르칠 수 없다.
      const usable = request && !/^\[Image:[^\]]*\]\s*$/.test(request) && !NOT_A_REQUEST.some((re) => re.test(request));
      if (usable) current = { request, prior, tools: [], askedHuman: false, lastAssistant: "" };
      continue;
    }
    if (record.type !== "assistant" || !current) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "tool_use") {
        const input = block.input ?? {};
        current.tools.push({ name: block.name, operation: typeof input.operation === "string" ? input.operation : null, command: typeof input.command === "string" ? input.command : null });
      }
    }
    const text = textOf(content);
    if (text.trim()) { current.lastAssistant = text.trim().slice(-400); lastAssistant = current.lastAssistant; }
    // 도구 없이 선택지를 묻고 끝난 턴. "정해 주세요/알려 주세요" 류를 사람에게 넘긴 것으로 본다.
    if (current.tools.length === 0 && /(정해|알려|골라|결정).{0,6}(주세요|주시면|줘)|어느 쪽|선택지/.test(text)) current.askedHuman = true;
  }
  flush();
  return out;
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === "export-aia-routing.mjs";
if (invokedDirectly) {
  const patterns = process.argv.slice(2);
  const files = patterns.flatMap((p) => {
    if (p.includes("*")) {
      const dir = path.dirname(p);
      const suffix = path.basename(p).replace("*", "");
      return fs.readdirSync(dir).filter((n) => n.endsWith(suffix)).map((n) => path.join(dir, n));
    }
    return [p];
  });
  const items = files.flatMap(extract);
  const counts = {};
  for (const item of items) counts[item.label] = (counts[item.label] ?? 0) + 1;
  console.error(`전사 ${files.length}개 → 표본 ${items.length}건`, counts);
  for (const item of items) process.stdout.write(JSON.stringify(item) + "\n");
}
