import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C5-9/C5-10 V4: 도우미 시험만으로는 실제 지침 삭제 요청의 대상과 봉투를 검증할 수 없다.
// 전송만 가로채고 지침 API와 사용자 확인 조립 함수는 함께 실행한다.
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

test("C5-9/C5-10 V4: 배포 삭제는 확인한 범위·프로젝트·공급자를 그대로 전송한다", async () => {
  for (const provider of ["claude", "codex", "antigravity"]) {
    for (const [scope, projectPath] of [["personal", null], ["project", "/projects/지침 작업"]]) {
      transport.calls.length = 0;
      const receipt = { items: [] };
      transport.setResponse(Promise.resolve(receipt));

      assert.equal(await instructions.deleteProjectInstructionDeployment(scope, projectPath, provider), receipt);
      assert.deepEqual(structuredClone(transport.calls), [{
        command: "delete_project_instruction_deployment",
        args: { request: { scope, projectPath, provider, deletedBy: "user", confirm: true } },
      }]);
    }
  }
});

test("C5-9/C5-10 V4: 공통 삭제와 보관취소는 각 명령에 원본 키와 사용자 확인을 전송한다", async () => {
  for (const [method, command] of [
    ["deleteSharedProjectInstruction", "delete_shared_project_instruction"],
    ["unarchiveSharedProjectInstruction", "unarchive_shared_project_instruction"],
  ]) {
    transport.calls.length = 0;
    const receipt = { items: [] };
    transport.setResponse(Promise.resolve(receipt));

    assert.equal(await instructions[method]("example-policy"), receipt);
    assert.deepEqual(structuredClone(transport.calls), [{
      command,
      args: { request: { key: "example-policy", deletedBy: "user", confirm: true } },
    }]);
  }
});

test("C5-9 V4: 지침 삭제 거절은 재시도나 다른 삭제로 바꾸지 않고 호출자에게 전달한다", async () => {
  for (const [method, args, command] of [
    ["deleteProjectInstructionDeployment", ["project", "/projects/example", "codex"], "delete_project_instruction_deployment"],
    ["deleteSharedProjectInstruction", ["example-policy"], "delete_shared_project_instruction"],
    ["unarchiveSharedProjectInstruction", ["example-policy"], "unarchive_shared_project_instruction"],
  ]) {
    transport.calls.length = 0;
    const rejected = new Error("배포 지침 삭제 거절");
    transport.setResponse(Promise.reject(rejected));

    await assert.rejects(instructions[method](...args), (error) => error === rejected);
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].command, command);
  }
});
