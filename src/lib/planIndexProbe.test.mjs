import test from "node:test";
import assert from "node:assert/strict";
import { contract, TASKS, groupToolIndex, glossToolIndex, trimWriteSecondSentence, feedback, nudge, plan, score } from "../../local-llm-dev/plan-eval/index-loop.mjs";
const task = TASKS.find(t => t.id === "web-to-notion");
const call = (name, args = {}) => ({ role: "assistant", content: "", tool_calls: [{ id: "test-" + name, type: "function", function: { name: "plan_" + name, arguments: JSON.stringify(args) } }] });
async function scripted(messages, variant = "snapshot") {
    const seen = [];
    let at = 0;
    const result = await plan(task, "fixture-model", variant, "fixture", async (body) => { seen.push(structuredClone(body)); assert.ok(at < messages.length, "unexpected model turn"); return messages[at++]; });
    return { result, seen };
}
// 2026-09-27 9.14: 읽기 전용 모드는 색인과 프롬프트가 다르고, 쓰기가 필요한 과제의 정답은 정직한 거절이다.
test("READ_ONLY 에서는 읽기 전용 계약을 쓰고 web-to-notion 의 정답이 거절로 바뀐다", async () => {
    assert.ok(contract.indexReadOnly.length < contract.index.length, "읽기 전용 색인이 더 짧다");
    assert.ok(!contract.indexReadOnly.includes("notion-create-pages"), "쓰기 도구가 색인에 없다");
    assert.ok(contract.systemPromptReadOnly.includes("READ-ONLY"));
    assert.ok(!contract.systemPrompt.includes("READ-ONLY"));
    process.env.READ_ONLY = "1";
    try {
        const { result, seen } = await scripted([call("cannot_do", { reason: "읽기 전용 세션이라 노션에 쓸 수 없습니다" })], "guard");
        assert.equal(result.ended, "거절");
        assert.equal(score(task, result).ok, true);
        assert.ok(seen[0].messages[0].content.includes("READ-ONLY"), "읽기 전용 프롬프트를 보낸다");
        assert.ok(!seen[0].messages[0].content.includes("notion-create-pages"), "읽기 전용 색인을 보낸다");
        // 읽기 도구로만 세운 계획은 읽기 전용에서는 정답이 아니다.
        assert.equal(score(task, { steps: [{ tools: ["webfetch"] }, { tools: ["notion-search"] }], ended: "확정" }).ok, false);
    } finally {
        delete process.env.READ_ONLY;
    }
    // 평소에는 거절이 실패다.
    assert.equal(score(task, { steps: [], ended: "거절" }).ok, false);
});

// 2026-09-26 ses_f23842cd6: 거절된 tools:[] 단계를 수락된 단계로 기억했다.
test("거절된 단계와 되묻기가 초안에 가짜 단계를 더하지 않는다", async () => {
    const { result, seen } = await scripted([
        call("add_step", { title: "React 공식 문서와 신뢰할 수 있는 웹 사이트에서 최신 안정 버전 정보 수집", tools: ["webfetch"] }),
        call("add_step", { title: "반응성 프레임워크로서의 React 소개 및 현재 시장에서 가장 널리 사용되는 이유 설명", tools: [] }),
        { role: "assistant", content: "이어서 정리하겠습니다" },
        call("add_step", { title: "저장된 React 버전 정보를 노션에 새 페이지로 만든다", tools: ["notion-create-pages"], uses: ["1"] }), call("finish_plan")
    ]);
    assert.equal(result.nudges, 1);
    assert.equal(result.steps.length, 2);
    const returned = JSON.parse(seen[3].messages.at(-1).content);
    assert.equal(returned.draft.length, 1);
    assert.deepEqual(returned.draft[0].tools, ["webfetch"]);
    assert.equal(returned.request, task.prompt + "\n\n(회차 fixture)");
    assert.deepEqual(result.steps[1].uses, [1]);
    assert.equal(score(task, result).ok, true);
});
// 2026-09-26 ses_f236b4a12: webfetch 하나를 기록한 뒤 바로 finish_plan 했다.
test("조기 확정은 의미상 누락으로 남기고 완료되지 않은 계획도 합격시키지 않는다", async () => {
    const { result } = await scripted([call("add_step", { title: "React 최신 버전 정보를 웹에서 검색한다.", tools: ["webfetch"] }), call("finish_plan")]);
    assert.equal(result.ended, "확정");
    assert.equal(score(task, result).ok, false);
    assert.equal(score(task, { steps: [{ tools: ["webfetch"] }, { tools: ["notion-create-pages"] }], ended: "되묻기 한도" }).ok, false);
});
test("제품의 두 번 되묻기를 제공한 뒤에만 미확정으로 끝낸다", async () => {
    const { result } = await scripted(Array.from({ length: 3 }, () => ({ role: "assistant", content: "알겠습니다" })), "baseline");
    assert.equal(result.nudges, 2);
    assert.equal(result.turns, 3);
    assert.equal(result.ended, "되묻기 한도");
});
test("OpenCode 직접 호출 오류를 탐침만 친절한 성공 응답으로 바꾸지 않는다", async () => {
    const direct = { role: "assistant", content: "", tool_calls: [{ id: "direct", type: "function", function: { name: "webfetch", arguments: '{"url":"https://react.dev"}' } }] };
    const { result, seen } = await scripted([direct, call("add_step", { title: "조회", tools: ["webfetch"] }), call("finish_plan")]);
    assert.match(seen[1].messages.at(-1).content, /Model tried to call unavailable tool 'webfetch'/);
    assert.equal(result.repairs, 1);
});
test("대조군은 수정 전처럼 answer_now 로 초안을 닫는다", async () => {
    const { result } = await scripted([call("add_step", { title: "조회", tools: ["read"] }), call("answer_now", { answer: "답변" })]);
    assert.equal(result.ended, "바로답함");
});
test("없는 도구를 거절한 뒤 고친 호출을 받고 진행한다", async () => {
    const { result } = await scripted([call("add_step", { title: "노션 작성", tools: ["notion-create-page"] }), call("add_step", { title: "노션 작성", tools: ["notion-create-pages"] }), call("finish_plan")]);
    assert.equal(result.badNames, 1);
    assert.equal(result.steps.length, 1);
    assert.equal(result.ended, "확정");
});
test("단계 응답과 두 번 되묻기의 문구는 Rust 제품 계약에서 읽는다", () => {
    for (let count = 0; count <= contract.maxSteps; count++) {
        const steps = Array.from({ length: count }, () => ({ goal: "조회", tools: ["read"], uses: [] }));
        assert.deepEqual(feedback("요청", steps, "baseline"), contract.continuations[count].receipt);
        assert.equal(nudge("요청", steps, "baseline"), contract.continuations[count].nudge);
    }
    assert.ok(contract.schemas.some(s => s.name === "insert_step"));
    assert.ok(contract.index.includes("- edit:"));
});
test("Rust 정규화가 돌려주는 오류를 탐침도 그대로 돌려준다", async () => {
    for (const c of contract.toolErrors) {
        const { seen } = await scripted([call("add_step", { title: "조회", tools: c.tools }), call("add_step", { title: "조회", tools: ["read"] }), call("finish_plan")], "baseline");
        assert.equal(seen[1].messages.at(-1).content, c.error);
    }
});
test("파일 도구 뒤에 노션을 숨긴 복수 도구 단계는 합격이 아니다", () => {
    // 2026-09-26 GPU 탐침. 제품 send_opencode_step_turn 은 첫 도구의 agent를 연다.
    assert.equal(score(task, { steps: [{ tools: ["webfetch"] }, { tools: ["write", "notion-create-pages"] }], ended: "확정" }).ok, false);
});
// 2026-09-26 ses_f23295181ffe7RCLdD2uLHxCIF: 조사 중이라는 말로 초안이 버려졌다.
test("제품 경계는 answer_now 뒤에도 기존 단계를 보존하고 보완을 받는다", async () => {
    const { result, seen } = await scripted([
        call("add_step", { title: "React 공식 웹사이트로부터 최신 버전 정보 검색", tools: ["webfetch"] }),
        call("answer_now", { answer: "현재 단계: React 공식 웹사이트에서 최신 안정 버전 정보 수집 중입니다." }),
        call("add_step", { title: "노션에 정리", tools: ["notion-create-pages"], uses: ["1"] }), call("finish_plan")
    ], "guard");
    assert.equal(seen[2].messages.at(-1).content, contract.answerDraftError);
    assert.equal(result.steps.length, 2);
    assert.equal(result.ended, "확정");
});
test("단계가 없는 인사에는 answer_now 출구를 그대로 둔다", async () => {
    const { result } = await scripted([call("answer_now", { answer: "안녕하세요!" })], "guard");
    assert.equal(result.ended, "바로답함");
    assert.equal(result.steps.length, 0);
});

// 2026-09-26 ses_f23295181ffe7RCLdD2uLHxCIF: Core 이전의 RPC 봉투도 제품과 같아야 한다.
test("빈 필수 인자와 OpenCode invalid 응답도 제품 경계대로 돌려준다", async () => {
    for (const [name, args, expected] of [
        ["add_step", { title: "  ", tools: ["read"] }, "The step title is empty"],
        ["answer_now", { answer: " " }, "You must write the answer text"],
        ["cannot_do", { reason: " " }, "You must state why it cannot be done"]
    ]) {
        const { seen } = await scripted([call(name, args), call("answer_now", { answer: "인사" })], "guard");
        assert.equal(seen[1].messages.at(-1).content, expected);
    }
    const invalid = call("invalid", { tool: "read", error: "fixture error" });
    invalid.tool_calls[0].function.name = "invalid";
    const { seen } = await scripted([invalid, call("answer_now", { answer: "인사" })], "guard");
    assert.equal(seen[1].messages.at(-1).content, "The arguments provided to the tool are invalid: fixture error");
});

// 2026-09-26 ses_f2311fc3affeAN8b31tAebiqdP: 길이 가설은 정보 삭제와 분리해서 잰다.
test("묶음 색인은 순서·도구·설명·소유자를 모두 보존한다", () => {
    function entries(index) {
        let owner = "";
        return index.split("\n").flatMap(line => {
            if (line.startsWith("### ")) {
                owner = line.slice(4) === "작업 공간" ? "" : line.slice(4);
                return [];
            }
            const [, name, label, description] = line.match(/^- (\S+?)(?: \((.*?)\))?: (.*)$/);
            return [{ name, owner: label ?? owner, description }];
        });
    }
    for (const original of [contract.index, "- read: 읽기\n- first (A): 하나\n- second (B): 둘\n- third (A): 셋\n- write: 쓰기"]) {
        assert.deepEqual(entries(groupToolIndex(original)), entries(original));
    }
    assert.ok(groupToolIndex(contract.index).length < contract.index.length);
});
test("묶음 후보도 제품의 초안 보호와 되묻기 계약을 쓴다", async () => {
    const { result, seen } = await scripted([
        call("add_step", { title: "조회", tools: ["read"] }),
        call("answer_now", { answer: "읽겠습니다" }), call("finish_plan")
    ], "grouped");
    assert.equal(seen[2].messages.at(-1).content, contract.answerDraftError);
    assert.equal(result.ended, "확정");
    assert.deepEqual(feedback("요청", [{ tools: ["read"] }], "grouped"), contract.continuations[1].receipt);
    assert.equal(nudge("요청", [], "grouped"), contract.continuations[0].nudge);
});

// 2026-09-26 ses_f23842cd6와 같은 요청: round2 GPU guard 7회차의 실제 인자.
test("제품은 파일과 노션을 함께 선언한 단계를 거절하고 기존 초안을 보존한다", async () => {
    const { result, seen } = await scripted([
        call("add_step", { title: "React 공식 문서를 참고하여 최신 안정 버전을 확인한다", tools: ["webfetch"] }),
        call("add_step", { title: "확인한 React 최신 버전 정보를 노션 페이지에 정리한다", tools: ["write", "notion-create-pages"] }),
        call("add_step", { title: "확인한 React 최신 버전 정보를 노션 페이지에 정리한다", tools: ["notion-create-pages"], uses: ["1"] }),
        call("finish_plan")
    ], "guard");
    assert.equal(seen[2].messages.at(-1).content, "A step may use at most 1 tool(s). Split the step");
    assert.equal(result.steps.length, 2);
    assert.deepEqual(result.steps[1].tools, ["notion-create-pages"]);
    assert.deepEqual(result.steps[1].uses, [1]);
    assert.equal(score(task, result).ok, true);
    assert.equal(seen[0].tools.find(t => t.function.name === "plan_add_step").function.parameters.properties.tools.maxItems, 1);
    assert.equal(contract.schemas.find(s => s.name === "insert_step").parameters.properties.tools.maxItems, 1);
});

// 2026-09-26 ses_f23842cd6: 노션 목적지를 파일 write로 고르는 증상의 어휘 가설.
test("뜻풀이 후보는 두 도구의 설명에만 더하고 기존 색인 전체를 보존한다", () => {
    const original = contract.index.split("\n");
    const glossed = glossToolIndex(contract.index).split("\n");
    assert.equal(glossed.length, original.length);
    let changed = 0;
    original.forEach((line, i) => {
        if (glossed[i] === line) return;
        changed++;
        const split = line.indexOf(": ") + 2;
        assert.equal(glossed[i].slice(0, split), line.slice(0, split));
        assert.ok(glossed[i].endsWith(line.slice(split)));
        assert.match(line, /^- notion-(create-pages|update-page) /);
    });
    assert.equal(changed, 2);
});
test("뜻풀이 후보도 제품의 초안 보존 전이를 쓴다", async () => {
    const { seen, result } = await scripted([
        call("add_step", { title: "조회", tools: ["read"] }),
        call("answer_now", { answer: "읽겠습니다" }), call("finish_plan")
    ], "gloss");
    assert.equal(seen[2].messages.at(-1).content, contract.answerDraftError);
    assert.equal(result.ended, "확정");
});

// 2026-09-26 ses_f23842cd6의 거절된 단계 혼동, round3 gloss 13회차의 insert_step 경로.
test("초안 후보는 insert_step을 노출하지 않고 알려진 이름으로도 직접 수락하지 않는다", async () => {
    const { seen, result } = await scripted([
        call("insert_step", { title: "노션 생성", tools: ["notion-create-pages"] }),
        call("add_step", { title: "조사", tools: ["webfetch"] }),
        call("answer_now", { answer: "조사하겠습니다" }),
        call("add_step", { title: "노션 생성", tools: ["notion-create-pages"] }), call("finish_plan")
    ], "draft-only");
    assert.ok(!seen[0].tools.some(t => t.function.name === "plan_insert_step"));
    assert.match(seen[1].messages.at(-1).content, /unavailable tool 'plan_insert_step'/);
    assert.ok(!seen[1].messages.at(-1).content.split("Available tools: ")[1].includes("plan_insert_step"));
    assert.equal(seen[3].messages.at(-1).content, contract.answerDraftError);
    assert.equal(result.steps.length, 2);
    assert.equal(result.ended, "확정");
});

// 2026-09-26 ses_f23842cd6의 거절 혼동, round4 with-insert 16회차 실제 호출.
test("현행 대조군은 이름을 고친 뒤 insert_step으로 우회해도 초안에 수락하지 않는다", async () => {
    const { seen, result } = await scripted([
        call("add_step", { title: "React 공식 사이트에서 최신 안정 버전 정보 검색하기", tools: ["webfetch"] }),
        call("add_step", { title: "검색한 React 버전 정보를 정리하여 노션 페이지에 저장하기", tools: ["notion-create-page"] }),
        call("insert_step", { after: "1", title: "검색한 React 버전 정보를 정리하여 노션 페이지에 저장하기", tools: ["notion-create-pages"] }),
        call("finish_plan")
    ], "with-insert");
    assert.ok(seen[0].tools.some(t => t.function.name === "plan_insert_step"));
    assert.match(seen[2].messages.at(-1).content, /There is no tool named 'notion-create-page'/);
    assert.match(seen[3].messages.at(-1).content, /The plan is still being drafted/);
    assert.equal(result.steps.length, 1);
    assert.equal(score(task, result).ok, false);
});

// 2026-09-26 ses_f23842cd6: 탐침 기본 표면은 제품 초안 agent 계약과 같아야 한다.
test("기본 탐침은 Rust 초안 agent의 전체 도구 표면을 쓴다", async () => {
    const { seen } = await scripted([
        call("insert_step", {}), call("answer_now", { answer: "안녕하세요" })
    ], "guard");
    assert.deepEqual(seen[0].tools.map(t => t.function.name).sort(),
        ["invalid", ...contract.draftSchemas.map(s => "plan_" + s.name)].sort());
    assert.match(seen[1].messages.at(-1).content, /unavailable tool 'plan_insert_step'/);
});

// 2026-09-26 ses_f2251f5ec / e6afe8bb: 병행 제품 변경을 기본 탐침에 동일하게 반영한다.
test("기본 탐침도 색인 도구 직접 호출 뒤 첫 거절만 되돌린다", async () => {
    for (const tool of ["webfetch", "made_up_tool"]) {
        const direct = call("invalid", { tool, error: "unavailable" });
        direct.tool_calls[0].function.name = "invalid";
        const refuses = [call("cannot_do", { reason: "할 수 없습니다" })];
        if (tool === "webfetch") refuses.push(call("cannot_do", { reason: "여전히 할 수 없습니다" }));
        const { seen, result } = await scripted([direct, ...refuses], "guard");
        assert.equal(result.ended, "거절");
        assert.equal(result.turns, tool === "webfetch" ? 3 : 2);
        if (tool === "webfetch")
            assert.equal(seen[2].messages.at(-1).content, contract.directIndexCallError.replaceAll("<TOOL>", tool));
    }
});

// 2026-10-02 코드 리팩토링 11회차, GPU local-refactor n=20 의 실패 1건이 보낸 실제 제목·인자.
// 탐침이 제품의 두 번째 되묻기를 쓰는지 본다 — 탐침이 느슨하면 이 실패를 못 보고,
// 엄하면 제품에 없는 실패를 센다.
test("탐침도 '고친다는 제목에 읽기 전용 도구' 단계를 제품 문구로 되묻는다", async () => {
    const titles = ["report.mjs 에서 두 번 반복되는 서식 코드를 확인하고 동일한 패턴을 찾기 위해 수정하기", "report.mjs 를 읽어 중복 구간을 확인"];
    const { seen, result } = await scripted([
        call("add_step", { title: titles[0], tools: ["read"] }),
        call("add_step", { title: titles[0], tools: ["edit"] }),
        call("add_step", { title: titles[1], tools: ["read"] }),
        call("finish_plan")
    ], "guard");
    const bounced = seen[1].messages.at(-1).content;
    assert.equal(bounced, contract.writingIntentError.replace("<TOOLS>", "read").replace("<WRITERS>", contract.writingTools.join(", ")));
    // 쓰기 도구를 고른 같은 제목과, 읽기만 한다고 말한 제목은 그대로 통과한다.
    assert.deepEqual(result.steps.map(s => s.tools), [["edit"], ["read"]]);
    assert.equal(result.ended, "확정");
    assert.equal(result.mismatches, 1);
    // 제품의 가드가 목록에서 읽는 것과 같은 값을 계약이 싣는다.
    assert.deepEqual(contract.readingTools.concat(contract.writingTools).sort(), ["bash", "edit", "read", "webfetch", "write"]);
    assert.ok(contract.writeIntentWords.includes("수정") && !contract.writeIntentWords.includes("추출"));
});

// 2026-10-02 11회차: 같은 색인으로 20회씩 잇달아 두 번 돌렸더니 같은 레인이 창 사이에
// 18/20 → 11/20 으로 움직였다. 그래서 색인 변종은 환경변수가 아니라 **후보**여야 한다 —
// 탐침이 시행마다 번갈아 돌려야 창의 흔들림이 두 후보에 똑같이 실린다.
test("trim-write 후보는 write 설명의 두 번째 문장만 빼고 나머지는 guard 와 같다", async () => {
    const trimmed = trimWriteSecondSentence(contract.index).split("\n");
    const original = contract.index.split("\n");
    assert.equal(trimmed.length, original.length);
    const changed = original.filter((line, i) => trimmed[i] !== line);
    assert.equal(changed.length, 1);
    assert.match(changed[0], /^- write: /);
    assert.equal(trimmed[original.indexOf(changed[0])], "- write: Writes content to one file.");
    // 다른 도구의 두 번째 문장은 건드리지 않는다.
    assert.ok(trimmed.some(l => l === original.find(o => o.startsWith("- edit: "))));
    // 색인 말고는 guard 와 같은 계약이다: 같은 초안 도구, 같은 되묻기.
    const script = [call("add_step", { title: "조회", tools: ["read"] }), call("answer_now", { answer: "읽겠습니다" }), call("finish_plan")];
    const a = await scripted(structuredClone(script), "guard");
    const b = await scripted(structuredClone(script), "trim-write");
    assert.equal(b.seen[2].messages.at(-1).content, contract.answerDraftError);
    assert.deepEqual(b.seen[0].tools.map(t => t.function.name), a.seen[0].tools.map(t => t.function.name));
    assert.equal(b.result.ended, "확정");
    assert.notEqual(b.seen[0].messages[0].content, a.seen[0].messages[0].content);
});

// 2026-10-03 12회차: GPU `local-refactor` 40시행의 실패 3건이 "요청은 고치라는데 계획이
// 읽기만 한다"였다(trim-write 10·19, guard 13 의 앞머리). 제품이 확정을 한 번 되돌리므로
// 탐침도 같은 자리에서 같은 문구로 되돌려야 한다 — 느슨하면 있는 결함을 놓친다.
test("요청은 고치라는데 모든 단계가 읽기 전용인 계획을 제품과 같은 문구로 한 번 되돌린다", async () => {
    const refactor = TASKS.find(t => t.id === "local-refactor");
    const run = async (script, variant = "guard") => {
        const seen = [];
        let at = 0;
        const result = await plan(refactor, "fixture-model", variant, "fixture", async (body) => { seen.push(structuredClone(body)); assert.ok(at < script.length, "unexpected model turn"); return script[at++]; });
        return { result, seen };
    };
    const readOnly = [call("add_step", { title: "report.mjs 파일 읽어서 내용 확인", tools: ["read"] }), call("finish_plan"), call("finish_plan")];
    const { result, seen } = await run(structuredClone(readOnly));
    assert.equal(seen[2].messages.at(-1).content, contract.readOnlyPlanError.replace("<WRITERS>", contract.writingTools.join(", ")));
    // 두 번째 확정은 제품처럼 그대로 받는다.
    assert.equal(result.ended, "확정");
    assert.equal(result.mismatches, 1);
    // 고치는 단계가 하나라도 있으면 발동하지 않는다. `bash` 도 파일을 쓴다.
    for (const writer of contract.writingTools) {
        const { result: ok, seen: s } = await run([call("add_step", { title: "report.mjs 를 읽는다", tools: ["read"] }), call("add_step", { title: "중복 코드를 함수로 묶는다", tools: [writer] }), call("finish_plan")]);
        assert.equal(ok.ended, "확정", writer);
        assert.equal(s.length, 3, writer);
    }
    // 고치라는 말이 없는 요청은 건드리지 않는다.
    const read = TASKS.find(t => t.id === "local-read");
    assert.ok(!contract.writeIntentWords.some(w => read.prompt.toLowerCase().includes(w)));
    // 읽기 전용 모드에는 고칠 수 있는 도구가 색인에 없으므로 발동하지 않는다.
    process.env.READ_ONLY = "1";
    try {
        const { seen: s } = await run([call("add_step", { title: "report.mjs 파일 읽어서 내용 확인", tools: ["read"] }), call("finish_plan")]);
        assert.equal(s.length, 2, "되묻지 않고 바로 확정한다");
    } finally {
        delete process.env.READ_ONLY;
    }
});
