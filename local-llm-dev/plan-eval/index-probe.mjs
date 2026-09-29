import { TASKS, contract, plan, score, writeRun } from "./index-loop.mjs";
import { randomUUID } from "node:crypto";
const model = process.argv[2];
if (!model)
    throw Error("모델 이름을 인자로 준다");
const repeats = Number(process.env.REPEATS ?? 20);
const startTrial = Number(process.env.START_TRIAL ?? 1);
const variants = (process.env.VARIANTS ?? "guard").split(",");
const only = process.env.ONLY_TASK;
if (!Number.isInteger(repeats) || !Number.isInteger(startTrial) || startTrial < 1 || repeats < startTrial)
    throw Error("REPEATS와 START_TRIAL은 1 이상의 정수이며 START_TRIAL <= REPEATS여야 한다");
const base = process.env.PLAN_EVAL_BASE ?? "http://127.0.0.1:11434/v1";
async function complete(body) {
    const response = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000)
    });
    if (!response.ok)
        throw Error("HTTP " + response.status + ": " + await response.text());
    return (await response.json()).choices[0].message;
}
console.log(JSON.stringify({ model, repeats, startTrial, variants, indexChars: contract.index.length }));
for (const task of TASKS.filter(t => !only || only.split(",").includes(t.id))) {
    const summary = Object.fromEntries(variants.map(v => [v, { ok: 0, total: 0, issues: {}, nudges: 0, repairs: 0, turns: 0 }]));
    for (let i = startTrial - 1; i < repeats; i++) {
        const marker = randomUUID();
        for (const variant of i % 2 ? [...variants].reverse() : variants) {
            // 서빙 층이 죽어도 측정은 이어간다. 제품은 HTTP 오류로 끝나지 않고 그 턴만
            // 실패하므로, 탐침이 여기서 멈추면 남은 시행을 아예 재지 못한다. 2026-09-26
            // CPU impossible 과제가 Ollama 의 "error parsing tool call" 500 으로 두 번
            // 잘렸다 — 모델이 cannot_do 를 부르려다 낸 모양을 서버가 못 읽은 것이다.
            let result;
            try {
                result = await plan(task, model, variant, marker, complete);
            }
            catch (error) {
                result = { ended: "서빙오류", steps: [], nudges: 0, repairs: 0, turns: 0, error: String(error).slice(0, 200) };
            }
            const s = result.ended === "서빙오류" ? { ok: false, issues: ["서빙오류"] } : score(task, result), record = { date: new Date().toISOString(), model, task: task.id, variant, marker, trial: i + 1, ...s, ...result };
            if (process.env.TRACE_FILE)
                writeRun(process.env.TRACE_FILE, record);
            const sum = summary[variant];
            sum.total++;
            sum.ok += Number(s.ok);
            sum.nudges += result.nudges;
            sum.repairs += result.repairs;
            sum.turns += result.turns;
            for (const why of s.issues)
                sum.issues[why] = (sum.issues[why] ?? 0) + 1;
            console.log(JSON.stringify({ task: task.id, variant, trial: i + 1, ok: s.ok, issues: s.issues, ended: result.ended, tools: result.steps.map(s => s.tools.join("+")), nudges: result.nudges, turns: result.turns }));
        }
    }
    console.log("SUMMARY " + JSON.stringify({ model, task: task.id, startTrial, repeats, summary }));
}
