import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C5-4/C5-6 V4: 전송만 가로채 실제 지침 API가 덮어쓰기 선택과 원본 지문을 보존하는지 본다.
const transportUrl = `data:text/javascript,${encodeURIComponent(`
  export const calls = [];
  let response;
  export function setResponse(value) { response = value; }
  export function call(command, args) {
    calls.push({ command, args });
    return response;
  }
`)}`;
const transport = await import(transportUrl);
const clientUrl = new URL("./ipcInstructions.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === clientUrl) {
      if (specifier === "./ipcTransport") return { url: transportUrl, shortCircuit: true };
      if (specifier === "./ipcDeletion") {
        return nextResolve(new URL("./ipcDeletion.ts", import.meta.url).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
let instructions;
try {
  instructions = await import(clientUrl);
} finally {
  hooks.deregister();
}

test("C5-4 V4: 지침 배포는 대상과 공급자, 명시하거나 생략한 덮어쓰기 선택을 보존한다", async () => {
  const requests = [{ key: "team-policy", providers: ["codex"] }];
  for (const [scope, projectPath] of [["personal", null], ["project", "/projects/지침 작업"]]) {
    for (const overwrite of [undefined, "fail", "replace"]) {
      requests.push({
        key: "team-policy", scope, projectPath, providers: ["claude", "codex", "antigravity"],
        ...(overwrite === undefined ? {} : { overwrite }),
      });
    }
  }
  for (const request of requests) {
    const expected = structuredClone(request);
    const receipt = { key: request.key, sourceDigest: "published-digest", results: [] };
    transport.calls.length = 0;
    transport.setResponse(Promise.resolve(receipt));

    assert.equal(await instructions.publishProjectInstruction(request), receipt);
    assert.deepEqual(structuredClone(transport.calls), [{
      command: "publish_project_instruction", args: { request: expected },
    }]);
    assert.deepEqual(request, expected);
  }
});

test("C5-4/C5-6 V4: 지침 편집은 읽었던 원본 지문과 공급자별 변경을 그대로 전달한다", async () => {
  for (const request of [
    {
      key: "team-policy", name: "공통 지침", description: "편집한 설명",
      files: [{ provider: "codex", content: "# 지침\n@docs/rules.md\n" }, { provider: "claude", content: "" }],
      deletes: ["antigravity"], expectedDigest: "digest-read-before-edit",
    },
    { key: "team-policy", files: [], expectedDigest: "metadata-only-digest", name: "새 이름" },
    { key: "team-policy", files: [], expectedDigest: "unchanged-metadata-digest", name: null, description: null },
  ]) {
    const expected = structuredClone(request);
    const receipt = { key: request.key, sourceDigest: "updated-digest", results: [] };
    transport.calls.length = 0;
    transport.setResponse(Promise.resolve(receipt));

    assert.equal(await instructions.updateProjectInstruction(request), receipt);
    assert.deepEqual(structuredClone(transport.calls), [{
      command: "update_project_instruction", args: { request: expected },
    }]);
    assert.deepEqual(request, expected);
  }
});

test("C5-4/C5-6 V4: 배포 충돌·오래된 지문 거절은 강제 덮어쓰기나 재시도로 바꾸지 않는다", async () => {
  for (const [method, command, request] of [
    ["publishProjectInstruction", "publish_project_instruction", {
      key: "team-policy", scope: "project", projectPath: "/projects/example", providers: ["codex"], overwrite: "fail",
    }],
    ["updateProjectInstruction", "update_project_instruction", {
      key: "team-policy", files: [{ provider: "codex", content: "edited" }], expectedDigest: "stale-digest",
    }],
  ]) {
    const expected = structuredClone(request);
    const rejected = new Error("지침 충돌: 새로고침이 필요합니다");
    transport.calls.length = 0;
    transport.setResponse(Promise.reject(rejected));

    await assert.rejects(instructions[method](request), (error) => error === rejected);
    assert.deepEqual(structuredClone(transport.calls), [{ command, args: { request: expected } }]);
    assert.deepEqual(request, expected);
  }
});
