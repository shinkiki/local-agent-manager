// 학습에 넣지 않은 시험 몫으로 AIA 역할 모델을 채점한다(M11).
//
//   node local-llm-dev/finetune/eval-aia.mjs qwen3.5-aia:r1 --data data/sft-aia-holdout.jsonl
//   node local-llm-dev/finetune/eval-aia.mjs aia-r1 --data … --generated .tuning/aia-r1-gen.jsonl
//   AIA_EVAL_BASE=http://127.0.0.1:11434/v1 ... TRACE_FILE=.tuning/aia-r1.jsonl ...
//
// 서빙 층에 올릴 수 있으면 첫 줄로 재고, 못 올리면 generate-hf.py 로 생성해 두 번째 줄로 잰다.
// 채점 규칙은 한 벌뿐이다 — 두 벌로 갈라지면 어느 쪽이 맞는지 알 수 없다.
//
// 합격률 한 수로 판정하지 않는다(튜닝 회차 스킬 4절). 과제 종류마다 **실패 종류**를 세어
// 기준 모델과 견준다. 무엇이 사라졌고 무엇이 새로 생겼는지가 판정이다.
//
// 실패 종류:
//   호출없음   도구를 부를 자리에서 글만 썼다
//   이름틀림   색인에 없는 작업 이름을 불렀다 (지어냄)
//   이름다름   색인에 있지만 다른 작업을 불렀다
//   도구다름   조회 자리에서 변경 도구를 불렀다(또는 그 반대)
//   인자빠짐   정답 인자 키가 빠졌다
//   인자더함   정답에 없는 키를 넣었다
//   판단다름   라우팅을 다른 갈래로 답했다
//   지어냄     없는 기능을 있다고 답했다
//   서빙오류   서버가 응답하지 않았다
import fs from "node:fs";
import path from "node:path";

const base = process.env.AIA_EVAL_BASE ?? "http://127.0.0.1:11434/v1";

async function complete(body) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()).choices[0].message;
}

/** 모델이 낸 도구 호출 하나를 {tool, operation, arguments} 로 편다. 없으면 null. */
export function readCall(message) {
  const call = (message?.tool_calls ?? [])[0];
  if (!call) return null;
  const raw = call.function?.arguments;
  let args = {};
  try {
    args = typeof raw === "string" ? JSON.parse(raw || "{}") : raw ?? {};
  } catch {
    args = {};
  }
  return { tool: call.function?.name ?? "", operation: args.operation ?? "", arguments: args.arguments ?? {} };
}

/** 라우팅 한 줄에서 갈래를 읽는다. */
export function readRoute(text) {
  const head = String(text ?? "").trim().split("\n")[0];
  if (/^직접/.test(head)) return "direct";
  if (/^위임/.test(head)) return "delegate";
  if (/^사람/.test(head)) return "human";
  return null;
}

/** 시험 한 건을 채점한다. 통과면 issues 가 빈 배열이다. */
export function score(sample, message) {
  const task = sample.meta.task;
  const expectedCall = sample.messages.at(-1).tool_calls?.[0];
  if (task === "routing") {
    const got = readRoute(message?.content);
    const want = readRoute(sample.messages.at(-1).content);
    if (got === want) return [];
    return [got === null ? "형식벗어남" : "판단다름"];
  }
  if (task === "feature-name") {
    const operation = sample.meta.operation ?? "";
    const want = /조회 작업이다/.test(sample.messages.at(-1).content) ? "조회" : "변경";
    const text = String(message?.content ?? "");
    const issues = [];
    if (!text.includes(operation)) issues.push("이름다름");
    if (!text.includes(want)) issues.push("갈래다름");
    return issues;
  }
  if (task === "feature-absent") {
    // 없는 기능은 도구를 부르면 안 된다.
    return readCall(message) ? ["지어냄"] : [];
  }
  // toolcall · feature-call
  const want = JSON.parse(expectedCall.function.arguments);
  const got = readCall(message);
  if (!got) return ["호출없음"];
  const listed = new Set((sample.tools ?? []).flatMap((t) => t.function.parameters.properties.operation.enum ?? []));
  const issues = [];
  if (!listed.has(got.operation)) issues.push("이름틀림");
  else if (got.operation !== want.operation) issues.push("이름다름");
  if (got.tool !== expectedCall.function.name) issues.push("도구다름");
  if (issues.length) return issues;
  const wantKeys = Object.keys(want.arguments ?? {});
  const gotKeys = Object.keys(got.arguments ?? {});
  if (wantKeys.some((k) => !gotKeys.includes(k))) issues.push("인자빠짐");
  if (gotKeys.some((k) => !wantKeys.includes(k))) issues.push("인자더함");
  return issues;
}

export function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === "eval-aia.mjs";
if (invokedDirectly) {
  const model = process.argv[2];
  const argv = process.argv.slice(3);
  const at = argv.indexOf("--data");
  const dataFile = at < 0 ? "local-llm-dev/finetune/data/sft-aia-holdout.jsonl" : argv[at + 1];
  if (!model) {
    console.error("모델 이름을 인자로 준다");
    process.exit(2);
  }
  const samples = readJsonl(dataFile);
  // --generated 를 주면 서버를 부르지 않고 이미 낸 생성물을 채점한다(generate-hf.py).
  const generatedAt = argv.indexOf("--generated");
  const generated = generatedAt < 0 ? null : readJsonl(argv[generatedAt + 1]);
  if (generated && generated.length !== samples.length) {
    console.error(`생성물 ${generated.length}건이 시험 몫 ${samples.length}건과 다르다`);
    process.exit(2);
  }
  const summary = new Map();
  for (const [i, sample] of samples.entries()) {
    const task = sample.meta.task;
    if (!summary.has(task)) summary.set(task, { ok: 0, total: 0, issues: {} });
    const row = summary.get(task);
    row.total += 1;
    let issues;
    let message = null;
    try {
      // 마지막 turn(정답)은 빼고 묻는다.
      message = generated ? generated[i] : await complete({
        model,
        messages: sample.messages.slice(0, -1),
        ...(sample.tools ? { tools: sample.tools } : {}),
        temperature: 0,
        stream: false,
        // 학습 표본이 빈 사고 기록으로 구워졌다. 사고를 켜 두면 모델이 </think> 를 낼 줄 몰라
        // 끝없이 생각만 한다(2026-09-28 배포본에서 8만 토큰까지 갔다).
        reasoning_effort: "none",
        // 정답은 한 줄이거나 도구 호출 하나다. 상한이 없으면 한 건이 맴돌 때 채점이 통째로 멈춘다
        // (2026-09-28 배포본 채점에서 한 건이 2만 8천 토큰까지 갔다). 맴도는 것도 실패로 센다.
        max_tokens: 300,
      });
      issues = score(sample, message);
    } catch (error) {
      issues = ["서빙오류"];
      message = { content: String(error).slice(0, 200) };
    }
    if (!issues.length) row.ok += 1;
    for (const issue of issues) row.issues[issue] = (row.issues[issue] ?? 0) + 1;
    if (process.env.TRACE_FILE) {
      fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify({
        date: new Date().toISOString(), model, task, operation: sample.meta.operation ?? null,
        request: sample.messages[1].content.slice(0, 300), issues,
        got: message?.tool_calls ? readCall(message) : (message?.content ?? "").slice(0, 300),
      }) + "\n");
    }
  }
  const rows = [...summary.entries()].map(([task, row]) => ({ 과제: task, 통과: `${row.ok}/${row.total}`, 실패종류: row.issues }));
  console.log(JSON.stringify({ model, data: dataFile, rows }, null, 2));
}
