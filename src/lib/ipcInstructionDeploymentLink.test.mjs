import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C5-10 V4: 배포 원장의 등록·해제가 실제 지침 API에서 선택한 대상을 보존하는지 본다.
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

const operations = [
  ["attachProjectInstructionDeployment", "attach_project_instruction_deployment"],
  ["detachProjectInstructionDeployment", "detach_project_instruction_deployment"],
];

test("C5-10 V4: 배포 등록·해제는 원본 키·범위·프로젝트·공급자와 응답을 보존한다", async () => {
  for (const [method, command] of operations) {
    for (const provider of ["claude", "codex", "antigravity"]) {
      for (const target of [
        {},
        { scope: null, projectPath: null },
        { scope: "personal", projectPath: null },
        { scope: "project", projectPath: "/projects/지침 작업" },
      ]) {
        const request = Object.freeze({ key: "team-policy", provider, ...target });
        const expected = structuredClone(request);
        const entry = { key: request.key, deployments: [] };
        transport.calls.length = 0;
        transport.setResponse(Promise.resolve(entry));

        assert.equal(await instructions[method](request), entry);
        assert.deepEqual(structuredClone(transport.calls), [{ command, args: { request: expected } }]);
        assert.deepEqual(request, expected);
      }
    }
  }
});

test("C5-10 V4: 등록·해제 거절은 재시도나 반대 작업으로 바꾸지 않고 전달한다", async () => {
  for (const [method, command] of operations) {
    const request = Object.freeze({
      key: "team-policy", scope: "project", projectPath: "/projects/지침 작업", provider: "codex",
    });
    const expected = structuredClone(request);
    const rejected = new Error("지침 배포 등록 변경을 거절했습니다");
    transport.calls.length = 0;
    transport.setResponse(Promise.reject(rejected));

    await assert.rejects(instructions[method](request), (error) => error === rejected);
    assert.deepEqual(structuredClone(transport.calls), [{ command, args: { request: expected } }]);
    assert.deepEqual(request, expected);
  }
});
