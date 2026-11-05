import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C5 V4: 지침 열람·라이브러리·링크 파일 조회 IPC 계약 검증.
// 백엔드 project_instructions 핸들러의 인자 봉투 및 응답 보존을 확인한다.
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

test("C5 V4: deployedInstructionRef helper constructs exact envelope without mutation", () => {
  const ref1 = instructions.deployedInstructionRef("personal", null, "claude");
  assert.deepEqual(ref1, { scope: "personal", projectPath: null, provider: "claude" });

  const ref2 = instructions.deployedInstructionRef("project", "/workspace/test-proj", "codex");
  assert.deepEqual(ref2, { scope: "project", projectPath: "/workspace/test-proj", provider: "codex" });
});

test("C5 V4: deployedInstructionLinkedFileRef helper combines ref and link href correctly", () => {
  const linkRef = instructions.deployedInstructionLinkedFileRef(
    "project",
    "/workspace/test-proj",
    "codex",
    "docs/intro.md",
    "rules/style.md",
  );
  assert.deepEqual(linkRef, {
    scope: "project",
    projectPath: "/workspace/test-proj",
    provider: "codex",
    currentPath: "docs/intro.md",
    href: "rules/style.md",
  });
});

test("C5 V4: getProjectInstructionLibrary passes command without args and preserves result", async () => {
  const library = { repositoryPath: "/data/resources", policies: [] };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(library));

  assert.equal(await instructions.getProjectInstructionLibrary(), library);
  assert.deepEqual(structuredClone(transport.calls), [{ command: "get_project_instruction_library", args: undefined }]);
});

test("C5 V4: readProjectInstructionFile passes key and provider directly", async () => {
  const content = { key: "general-rule", provider: "antigravity", content: "# Policy", path: "/path/to/GEMINI.md" };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(content));

  assert.equal(await instructions.readProjectInstructionFile("general-rule", "antigravity"), content);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "read_project_instruction_file", args: { key: "general-rule", provider: "antigravity" } },
  ]);
});

test("C5 V4: getProjectInstructionMigrationPlan passes key and targetPlatform directly", async () => {
  const plan = { key: "style-rule", targetPlatform: "linux", operations: [] };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(plan));

  assert.equal(await instructions.getProjectInstructionMigrationPlan("style-rule", "linux"), plan);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "get_project_instruction_migration_plan", args: { key: "style-rule", targetPlatform: "linux" } },
  ]);
});

test("C5 V4: previewProjectInstructionImport passes request object directly", async () => {
  const previewReq = { sourcePath: "/imported/AGENTS.md", platform: "linux" };
  const previewRes = { key: "imported-rule", files: [] };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(previewRes));

  assert.equal(await instructions.previewProjectInstructionImport(previewReq), previewRes);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "preview_project_instruction_import", args: { request: previewReq } },
  ]);
});

test("C5 V4: readDeployedInstructionFile passes deployedInstructionRef as root args", async () => {
  for (const provider of ["claude", "codex", "antigravity"]) {
    for (const [scope, projectPath] of [["personal", null], ["project", "/workspace/my-app"]]) {
      transport.calls.length = 0;
      const content = { scope, projectPath, provider, content: "# Deployed", path: "/deployed/path" };
      transport.setResponse(Promise.resolve(content));

      assert.equal(await instructions.readDeployedInstructionFile(scope, projectPath, provider), content);
      assert.deepEqual(structuredClone(transport.calls), [
        {
          command: "read_deployed_instruction_file",
          args: { scope, projectPath, provider },
        },
      ]);
    }
  }
});

test("C5 V4: getDeployedInstructionLinkedFile passes deployedInstructionLinkedFileRef inside request", async () => {
  transport.calls.length = 0;
  const linkedFile = { href: "details.md", path: "/abs/details.md", content: "Details" };
  transport.setResponse(Promise.resolve(linkedFile));

  assert.equal(
    await instructions.getDeployedInstructionLinkedFile("project", "/workspace/my-app", "codex", "overview.md", "details.md"),
    linkedFile,
  );
  assert.deepEqual(structuredClone(transport.calls), [
    {
      command: "get_deployed_instruction_linked_file",
      args: {
        request: {
          scope: "project",
          projectPath: "/workspace/my-app",
          provider: "codex",
          currentPath: "overview.md",
          href: "details.md",
        },
      },
    },
  ]);
});

test("C5 V4: read errors are not swallowed or converted to empty results", async () => {
  const rejected = new Error("Failed to read instruction file");
  transport.calls.length = 0;
  transport.setResponse(Promise.reject(rejected));

  await assert.rejects(
    instructions.readDeployedInstructionFile("personal", null, "claude"),
    (err) => err === rejected,
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].command, "read_deployed_instruction_file");
});
