// Product-shaped planning probe. No work tools execute here.
import { readFileSync, appendFileSync } from "node:fs";
import { readRustConst } from "./tool-index.mjs";
export const contract = JSON.parse(readFileSync(new URL("./fixtures/planning-contract.json", import.meta.url), "utf8"));
export const TASKS = [
    { id: "greeting", need: "answer_now", prompt: "안녕! 간단히 인사해 줘." },
    { id: "web-to-notion", need: [["webfetch", "bash"], ["notion-create-pages"]], needReadOnly: "cannot_do", prompt: "인터넷에서 React 최신 안정 버전을 조사해서 노션에 정리해줘" },
    { id: "find-then-edit", need: [["notion-search", "notion-ai-search", "notion-fetch", "notion-list-recent-pages", "notion-list-private-pages"], ["notion-update-page"]], needReadOnly: "cannot_do", prompt: "노션에서 '테스트 페이지'를 찾아서 그 페이지에 오늘 날짜를 적은 줄을 하나 덧붙여줘." },
    { id: "local-read", need: [["read", "bash"]], prompt: "이 폴더 package.json 의 name 필드가 무엇인지 읽어서 알려줘." },
    // 2026-10-02 코드 리팩토링 10회차: 리팩토링 과제에 계획 턴이 없었다. 실행 탐침
    // (`tuning-eval/refactor-loop.mjs`)은 도구 다섯을 한 턴에 열어 평평하게 돌리는데,
    // 제품은 계획을 세우고 단계마다 도구 **하나**만 연다. 그래서 "읽고 고친다"가 두 단계로
    // 서는지, 고치는 단계가 어느 도구를 고르는지는 아무도 재지 않았다. 읽기 전용에서는
    // write·edit·bash 가 색인에 없으므로 정답이 거절로 뒤집힌다(반대 방향 과제).
    { id: "local-refactor", need: [["read", "bash"], ["edit", "write"]], needReadOnly: "cannot_do", prompt: "report.mjs 안에 같은 서식 코드가 두 번 반복돼. 그 부분을 함수 하나로 뽑아내서 양쪽이 같이 쓰게 고쳐줘." },
    { id: "pick-comment", need: [["notion-create-comment"]], needReadOnly: "cannot_do", prompt: "노션의 어떤 페이지에 '확인했습니다'라는 댓글을 하나 달아줘." },
    { id: "impossible", need: "cannot_do", prompt: "내 지메일에 온 마지막 메일을 읽어서 요약해줘." },
    // 9.13: 전용 파이썬 도구가 없으니 write(.py) → bash(실행) 두 단계로 나뉘어야 한다.
    { id: "python-run", need: [["write"], ["bash"]], needReadOnly: "cannot_do", prompt: "파이썬 스크립트를 만들어 1부터 100까지 소수의 개수를 계산하고, 실제로 실행해서 결과를 알려줘." },
];
export const names = contract.index.split("\n").map(l => l.match(/^- ([^ :]+)/)?.[1]).filter(Boolean).sort();
// Experimental rendering only: preserve order, names, descriptions and ownership.
export function groupToolIndex(index) {
    let owner;
    const lines = [];
    for (const line of index.split("\n")) {
        const match = line.match(/^- (\S+?)(?: \((.*?)\))?: (.*)$/);
        if (!match) throw Error("Unrecognized tool index line: " + line);
        const [, name, label = "", description] = match;
        if (label !== owner) {
            lines.push("### " + (label || "작업 공간"));
            owner = label;
        }
        lines.push("- " + name + ": " + description);
    }
    return lines.join("\n");
}
// 10회차가 남긴 물음: `write` 의 두 번째 문장("Overwrites the whole file.")이
// local-refactor 에서 통째로 다시 쓰는 길을 밀어 주는가. `trim-write` 후보가 그 문장만 뺀
// 색인으로 돈다. **환경변수가 아니라 후보인 이유**: 11회차에 환경변수로 두고 base 20회 →
// trim 20회를 잇달아 돌렸더니 같은 레인이 창 사이에 7점(18/20 → 11/20, 색인은 그대로)을
// 움직여 두 수를 견줄 수 없었다. 후보로 두면 탐침이 시행마다 번갈아 돌리므로(index-probe
// 의 `i % 2` 뒤집기) 창이 흔들려도 두 후보가 같이 흔들린다.
export function trimWriteSecondSentence(index) {
    return index.split("\n").map(line => {
        if (!line.startsWith("- write: "))
            return line;
        const cut = line.indexOf(". ", "- write: ".length);
        return cut < 0 ? line : line.slice(0, cut + 1);
    }).join("\n");
}
export function glossToolIndex(index) {
    const glosses = {
        "notion-create-pages": "노션 페이지 생성: 제목과 본문으로 새 페이지를 만든다.",
        "notion-update-page": "노션 페이지 수정: 기존 페이지의 속성이나 본문을 바꾼다."
    };
    return index.split("\n").map(line => {
        const name = line.match(/^- (\S+)/)?.[1];
        const gloss = glosses[name];
        return gloss ? line.replace(": ", ": " + gloss + " ") : line;
    }).join("\n");
}
export const NEXT = "위 단계는 기록만 되었고 모두 실행 전이다. 원래 요청의 각 결과와 저장 위치를 이 초안이 다 담는지 확인하라. 남은 일을 add_step 으로 적고, 모두 담았으면 finish_plan 을 불러라. 도구가 필요 없는 요청이면 answer_now, 주어진 도구로 못 하는 요청이면 cannot_do 를 불러라.";
export function feedback(request, steps, variant) {
    return ["snapshot", "review"].includes(variant) ? { step: steps.length, request, draft: steps.map((s, i) => ({ number: i + 1, title: s.goal, tools: s.tools, uses: s.uses })), next: NEXT } : structuredClone(contract.continuations[steps.length].receipt);
}
export function nudge(request, steps, variant) {
    if (["snapshot", "review"].includes(variant))
        return JSON.stringify(feedback(request, steps, variant), null, 2);
    return contract.continuations[steps.length].nudge;
}
export function score(task, result) {
    const { steps, ended } = result;
    const need = process.env.READ_ONLY && task.needReadOnly ? task.needReadOnly : task.need;
    if (need === "answer_now")
        return { ok: ended === "바로답함", issues: ended === "바로답함" ? [] : ["바로 답하기 실패: " + ended] };
    if (need === "cannot_do")
        return { ok: ended === "거절", issues: ended === "거절" ? [] : ["거절 실패"] };
    const issues = [];
    if (steps.some(s => s.tools.length > 1))
        issues.push("한 단계에 복수 도구");
    if (ended !== "확정")
        issues.push(ended);
    let at = 0;
    for (const group of need) {
        const hit = steps.findIndex((s, i) => i >= at && s.tools.some(t => group.includes(t)));
        if (hit < 0)
            issues.push(group[0] + " 자리 없음");
        else
            at = hit + 1;
    }
    // Repeated tools are recorded separately: multiple different URLs may be legitimate.
    return { ok: issues.length === 0, issues };
}
const toolList = contract.schemas.map(s => ({ type: "function", function: { ...s, name: "plan_" + s.name } }));
// OpenCode's invalid tool is part of the real planning surface.
toolList.unshift({ type: "function", function: { name: "invalid", description: "Do not use", parameters: { type: "object", properties: { tool: { type: "string" }, error: { type: "string" } }, required: ["tool", "error"] } } });
export async function plan(task, model, variant, marker, complete) {
    if (!["baseline", "snapshot", "review", "guard", "grouped", "single", "four-tools", "gloss", "trim-write", "draft-only", "with-insert"].includes(variant))
        throw Error("Unknown experimental variant: " + variant);
    // `trim-write` 는 **색인 한 줄만** 다른 `guard` 다. 다른 가드까지 달라지면 두 수가 또
    // 섞이므로, guard 가 보는 모든 자리에서 같이 참이어야 한다.
    const guardLike = ["guard", "trim-write"].includes(variant);
    // grouped keeps the four-tool control used in its original length experiment.
    const maxTools = { single: 1, "four-tools": 4, grouped: 4 }[variant] ?? contract.maxTools;
    // Explicit controls keep their recorded surface; guard follows the product draft agent.
    const draftNames = contract.draftSchemas?.map(s => "plan_" + s.name);
    const planningTools = structuredClone(toolList).filter(t => variant === "draft-only"
        ? t.function.name !== "plan_insert_step"
        : guardLike && draftNames
            ? t.function.name === "invalid" || draftNames.includes(t.function.name)
            : true);
    const available = planningTools.map(t => t.function.name).sort().join(", ");
    for (const tool of planningTools) {
        if (tool.function.parameters.properties?.tools)
            tool.function.parameters.properties.tools.maxItems = maxTools;
    }
    const request = task.prompt + "\n\n(회차 " + marker + ")";
    // READ_ONLY=1 이면 plan(읽기 전용) 모드의 색인 — 작업 공간은 read·webfetch, 플러그인은 readOnly 도구만(9.14).
    const baseIndex = process.env.READ_ONLY ? contract.indexReadOnly : contract.index;
    const renderedIndex = variant === "grouped" ? groupToolIndex(baseIndex) : variant === "gloss" ? glossToolIndex(baseIndex) : variant === "trim-write" ? trimWriteSecondSentence(baseIndex) : baseIndex;
    const aliasIndex = process.env.NO_ALIAS ? renderedIndex.replace(/ · 노션/g, "") : renderedIndex;
    const index = aliasIndex;
    // 색인은 시스템 글에 있다(9.15). 사용자 턴은 요청뿐이다 — 제품이 그렇게 보내므로
    // 탐침도 그래야 같은 것을 잰다.
    const messages = [{ role: "system", content: (process.env.READ_ONLY ? contract.systemPromptReadOnly : contract.systemPrompt).replace("<INDEX>", index) }, { role: "user", content: contract.prompt.replace("<REQUEST>", request) }];
    const indexNames = index.split("\n").map(l => l.match(/^- ([^ :]+)/)?.[1]).filter(Boolean);
    const steps = [], trace = [];
    let nudges = 0, badNames = 0, mismatches = 0, repairs = 0, reviewed = -1, directIndexCall, refusalBounced = false, readOnlyPlanBounced = false;
    const finish = ended => ({ steps, ended, nudges, badNames, mismatches, repairs, turns: trace.length, maxTools, indexChars: index.length, trace });
    // 제품과 같은 가드(2026-09-27): 제목이 플러그인 이름을 말하는데 도구가 그 플러그인 것이 아니면 되묻는다.
    const listedTools = list => list.slice(0, 20).join(", ") + (list.length > 20 ? " and " + (list.length - 20) + " more" : "");
    const pluginMismatch = (title, ts) => {
        const lowered = title.toLowerCase();
        for (const group of contract.pluginGroups ?? []) {
            const alias = group.aliases.find(a => lowered.includes(a.toLowerCase()));
            if (alias && !ts.some(t => group.tools.includes(t)))
                return contract.pluginMismatchError.replace("<ALIAS>", alias).replace("<TOOLS>", listedTools(group.tools));
        }
        return null;
    };
    // 제품의 두 번째 가드(2026-10-02, 11회차): 제목은 고친다는데 도구가 전부 읽기 전용이면
    // 되묻는다. 낱말·도구 목록·문구를 전부 계약에서 읽으므로 제품이 바뀌면 탐침도 바뀐다.
    const writingIntentMismatch = (title, ts) => {
        const lowered = title.toLowerCase();
        if (!(contract.writeIntentWords ?? []).some(w => lowered.includes(w)))
            return null;
        const readers = contract.readingTools ?? [];
        if (!ts.length || !ts.every(t => readers.includes(t)))
            return null;
        const writers = (contract.writingTools ?? []).filter(w => names.includes(w));
        return writers.length ? contract.writingIntentError.replace("<TOOLS>", listedTools(ts)).replace("<WRITERS>", listedTools(writers)) : null;
    };
    // 제품의 세 번째 가드(2026-10-03, 12회차): 요청은 고치라는데 모든 단계가 읽기 전용이면
    // 확정을 **한 번** 되돌린다. 두 번째 finish_plan 은 제품처럼 그대로 받는다.
    const readOnlyPlan = () => {
        const lowered = request.toLowerCase();
        if (!(contract.writeIntentWords ?? []).some(w => lowered.includes(w)))
            return null;
        const readers = contract.readingTools ?? [];
        if (!steps.length || !steps.every(s => s.tools.length && s.tools.every(t => readers.includes(t))))
            return null;
        // 모듈 수준의 `names` 가 아니라 **이 턴이 실제로 보낸 색인**에서 읽는다. 읽기 전용
        // 모드에는 고칠 수 있는 도구가 색인에 없으므로 제품처럼 발동하지 않아야 한다.
        const writers = (contract.writingTools ?? []).filter(w => indexNames.includes(w));
        return writers.length ? contract.readOnlyPlanError.replace("<WRITERS>", listedTools(writers)) : null;
    };
    const listed = names.slice(0, 20).join(", ") + (names.length > 20 ? " and " + (names.length - 20) + " more" : "");
    for (let turn = 0; turn < 60; turn++) {
        const message = await complete({ model, tools: planningTools, messages });
        trace.push(message);
        messages.push(message);
        const calls = message.tool_calls ?? [];
        if (!calls.length) {
            if (nudges >= contract.maxNudges)
                return finish("되묻기 한도");
            nudges++;
            messages.push({ role: "user", content: nudge(request, steps, variant) });
            continue;
        }
        for (const call of calls) {
            const raw = call.function?.name ?? "";
            const name = planningTools.some(t => t.function.name === raw) ? raw.replace(/^plan_/, "") : "";
            let args = {};
            try {
                args = JSON.parse(call.function.arguments);
            }
            catch { }
            let output;
            if (name === "finish_plan") {
                if (!steps.length)
                    output = "A plan needs at least one step";
                else if (variant === "review" && reviewed !== steps.length) {
                    reviewed = steps.length;
                    output = { ...feedback(request, steps, variant), next: "아직 실행을 시작하지 않았다. 이것은 확정 전 검토용 초안이다. 요청에서 요구한 결과·저장 위치와 각 단계의 도구를 대조하라. 빠진 작업이 있으면 add_step 으로 더하고, 모두 담겼으면 finish_plan 을 한 번 더 불러 확정하라." };
                }
                else if (guardLike && !readOnlyPlanBounced && readOnlyPlan()) {
                    readOnlyPlanBounced = true;
                    mismatches++;
                    output = readOnlyPlan();
                }
                else
                    return finish("확정");
            }
            else if (name === "cannot_do") {
                if (typeof args.reason !== "string" || !args.reason.trim())
                    output = "You must state why it cannot be done";
                else if (guardLike && directIndexCall) {
                    output = contract.directIndexCallError.replaceAll("<TOOL>", directIndexCall);
                    directIndexCall = undefined;
                }
                else if (guardLike && steps.length && !refusalBounced) {
                    // 적어 둔 단계를 쥐고 거절하는 길은 제품이 한 번 되돌린다(2026-09-26).
                    // 탐침이 이 보호를 모르면 제품에 없는 실패를 세게 된다.
                    output = contract.refusalDraftError.replaceAll("<STEPS>", String(steps.length));
                    refusalBounced = true;
                }
                else if ([...args.reason.trim()].length > contract.maxRefusal)
                    output = "The refusal reason must be at most " + contract.maxRefusal + " characters";
                else
                    return finish("거절");
            }
            else if (name === "answer_now") {
                if (typeof args.answer !== "string" || !args.answer.trim())
                    output = "You must write the answer text";
                else if (args.answer.trim() && ["guard", "grouped", "single", "four-tools", "gloss", "trim-write", "draft-only", "with-insert"].includes(variant) && steps.length)
                    output = contract.answerDraftError;
                else if (args.answer.trim())
                    return finish("바로답함");
                else
                    output = "You must write the answer text";
            }
            else if (name === "insert_step")
                output = typeof args.title !== "string" || !args.title.trim() ? "The step title is empty" : "The plan is still being drafted. Use add_step to add a step";
            else if (name === "add_step") {
                const ts = [...new Set((Array.isArray(args.tools) ? args.tools : typeof args.tools === "string" ? [args.tools] : []).filter(t => typeof t === "string").map(t => t.trim()).filter(Boolean))];
                const rawUses = (Array.isArray(args.uses) ? args.uses : typeof args.uses === "string" ? [args.uses] : []).filter(n => typeof n === "number" || (typeof n === "string" && /^\+?\d+$/.test(n.trim()))).map(Number).filter(n => Number.isInteger(n) && n >= 0);
                const uses = [...new Set(rawUses)];
                const bad = ts.find(t => !names.includes(t));
                if (typeof args.title !== "string" || !args.title.trim())
                    output = "The step title is empty";
                else if (steps.length >= contract.maxSteps)
                    output = "A plan may have at most " + contract.maxSteps + " steps. Merge steps or split the work";
                else if (/[\u0000-\u001f\u007f-\u009f]/.test(args.title.trim()))
                    output = "The step title may not contain control characters";
                else if (bad) {
                    badNames++;
                    output = "There is no tool named '" + bad + "'. Available tools: " + listed;
                }
                else if (!ts.length) {
                    badNames++;
                    output = "Each step must name at least one tool. Available tools: " + listed;
                }
                else if (ts.length > maxTools)
                    output = "A step may use at most " + maxTools + " tool(s). Split the step";
                else if (rawUses.length > contract.maxUses)
                    output = "A step may take the full result of at most " + contract.maxUses + " earlier step(s)";
                else if (pluginMismatch(args.title.trim(), ts)) {
                    mismatches++;
                    output = pluginMismatch(args.title.trim(), ts);
                }
                else if (writingIntentMismatch(args.title.trim(), ts)) {
                    mismatches++;
                    output = writingIntentMismatch(args.title.trim(), ts);
                }
                else if (uses.some(n => n < 1 || n > steps.length))
                    output = "Step " + uses.find(n => n < 1 || n > steps.length) + " does not exist yet. Only numbers of steps already written may be used";
                else {
                    // 제품처럼 긴 제목은 잘라 받는다(2026-09-27).
                    steps.push({ goal: [...args.title.trim()].slice(0, contract.maxTitle).join(""), tools: ts, uses });
                    output = feedback(request, steps, variant);
                }
            }
            else {
                repairs++;
                const requested = name === "invalid" ? args.tool : raw;
                if (guardLike && !directIndexCall && names.includes(requested))
                    directIndexCall = requested;
                output = "The arguments provided to the tool are invalid: " + (name === "invalid" ? args.error : "Model tried to call unavailable tool '" + requested + "'. Available tools: " + available + ".");
            }
            messages.push({ role: "tool", tool_call_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output, null, 2) });
        }
    }
    return finish("탐침 안전 한도");
}
export function writeRun(path, record) { appendFileSync(path, JSON.stringify(record) + "\n"); }
