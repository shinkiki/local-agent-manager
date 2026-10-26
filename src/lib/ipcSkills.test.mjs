import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// V4: 공용 확인 조립 함수의 시험만으로는 실제 스킬 요청에 보호 정보가 실리는지 모른다.
// 전송만 가로채고 ipcSkills와 ipcDeletion은 실제 모듈을 함께 실행한다.
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
const clientUrl = new URL("./ipcSkills.ts", import.meta.url).href;
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
let skills;
try {
  skills = await import(clientUrl);
} finally {
  hooks.deregister();
}

test("C3-11 V4: 스킬 삭제·보관취소는 확인한 대상과 사용자 표시를 전송한다", async () => {
  for (const [method, command, target] of [
    ["deleteSkill", "delete_skill", { id: "installed-skill" }],
    ["deleteSharedSkill", "delete_shared_skill", { key: "shared-skill" }],
    ["unarchiveSharedSkill", "unarchive_shared_skill", { key: "archived-skill" }],
  ]) {
    transport.calls.length = 0;
    const receipt = { items: [] };
    transport.setResponse(Promise.resolve(receipt));
    assert.equal(await skills[method](Object.values(target)[0]), receipt);
    assert.deepEqual(structuredClone(transport.calls), [{
      command,
      args: { request: { ...target, deletedBy: "user", confirm: true } },
    }]);
  }
});

test("C3-10 V4: 스킬 배포는 명시적 선택이 있을 때만 덮어쓰기를 요청한다", async () => {
  for (const overwrite of [undefined, "fail", "replace"]) {
    transport.calls.length = 0;
    transport.setResponse(Promise.resolve({ results: [] }));
    const request = {
      key: "example",
      providers: ["codex"],
      location: { scope: "project", projectPath: "/projects/example" },
      ...(overwrite === undefined ? {} : { overwrite }),
    };
    const before = structuredClone(request);
    await skills.publishCommonSkill(request);
    // 사용자 선택과 프로젝트 범위를 바꾸거나, 선택 없이 replace를 추가하면 안 된다.
    assert.equal(transport.calls.length, 1);
    const [sent] = transport.calls;
    assert.equal(sent.command, "publish_common_skill");
    // 생략과 fail은 Core의 같은 안전한 기본값으로 본다.
    assert.deepEqual(
      { ...sent.args.request, overwrite: sent.args.request.overwrite ?? "fail" },
      { ...before, overwrite: overwrite ?? "fail" },
    );
    assert.deepEqual(request, before);
  }
});

test("V4: 스킬 편집은 변경분과 원본 지문을 보존하고 거절을 그대로 전달한다", async () => {
  transport.calls.length = 0;
  const request = {
    key: "example",
    files: [{ path: "SKILL.md", content: "updated" }],
    deletes: ["old.txt"],
    expectedDigest: "previous-source-digest",
  };
  const before = structuredClone(request);
  const rejected = new Error("원본 지문 불일치");
  transport.setResponse(Promise.reject(rejected));
  await assert.rejects(skills.updateCommonSkill(request), (error) => error === rejected);
  assert.deepEqual(structuredClone(transport.calls), [{ command: "update_common_skill", args: { request: before } }]);
  assert.deepEqual(request, before);
});

test("C3-11 V4: 설치본 채택은 사용자 표시를 남기고 삭제 요청으로 바꾸지 않는다", async () => {
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve({}));
  await skills.syncSkillFromInstall("installed-skill");
  assert.deepEqual(structuredClone(transport.calls), [{
    command: "sync_skill_from_install",
    args: { request: { skillId: "installed-skill", deletedBy: "user" } },
  }]);
});
