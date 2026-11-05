import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C3-13/C5-9 V4: 복구 대상과 영구 삭제 범위는 서로 바뀌면 안 된다.
// 실제 지침 API를 실행하고 전송만 가로채 Rust의 최상위 {id} 계약과 비교한다.
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

test("C5-9 V4: 휴지통 조회는 변경 명령 없이 목록과 집계를 그대로 전달한다", async () => {
  const overview = { root: "/app-data/instruction-trash", items: [{ id: "trash-one" }], totalBytes: 42 };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(overview));

  assert.equal(await instructions.listInstructionTrash(), overview);
  assert.deepEqual(structuredClone(transport.calls), [{ command: "list_instruction_trash", args: undefined }]);
});

test("C3-13/C5-9 V4: 복구는 선택한 항목과 복구·건너뜀·실패 결과를 보존한다", async () => {
  const id = "trash-selected";
  const receipt = {
    groupId: "group-selected",
    results: ["restored", "skipped", "failed"].map((outcome, index) => ({
      id: `trash-${index}`, key: "team-policy", originalPath: `/projects/example/doc-${index}.md`,
      outcome, message: outcome === "restored" ? null : "대상 위치를 확인해야 합니다",
    })),
  };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(receipt));

  assert.equal(await instructions.restoreInstructionTrash(id), receipt);
  assert.deepEqual(structuredClone(transport.calls), [{ command: "restore_instruction_trash", args: { id } }]);
});

test("C5-9 V4: 영구 삭제는 단건·빈 식별자·전체 비우기를 구분하고 삭제 수를 보존한다", async () => {
  for (const [args, id, removed] of [
    [["trash-selected"], "trash-selected", 1],
    // 빈 식별자는 백엔드가 거절할 값이다. 전체 비우기(null)로 넓혀 보내면 안 된다.
    [[""], "", 0],
    [[], null, 3],
    [[undefined], null, 0],
  ]) {
    transport.calls.length = 0;
    transport.setResponse(Promise.resolve(removed));

    assert.equal(await instructions.purgeInstructionTrash(...args), removed);
    assert.deepEqual(structuredClone(transport.calls), [{ command: "purge_instruction_trash", args: { id } }]);
  }
});

test("C5-9 V4: 휴지통 거절은 재시도나 전체 삭제로 바꾸지 않고 전달한다", async () => {
  for (const [method, args, command, expectedArgs] of [
    ["listInstructionTrash", [], "list_instruction_trash", undefined],
    ["restoreInstructionTrash", ["trash-selected"], "restore_instruction_trash", { id: "trash-selected" }],
    ["purgeInstructionTrash", ["trash-selected"], "purge_instruction_trash", { id: "trash-selected" }],
    ["purgeInstructionTrash", [], "purge_instruction_trash", { id: null }],
  ]) {
    transport.calls.length = 0;
    const rejected = new Error("휴지통 작업을 거절했습니다");
    transport.setResponse(Promise.reject(rejected));

    await assert.rejects(instructions[method](...args), (error) => error === rejected);
    assert.deepEqual(structuredClone(transport.calls), [{ command, args: expectedArgs }]);
  }
});
