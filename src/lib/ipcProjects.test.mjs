import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C16/C19 V4: 프로젝트 파일(F1~F3)·Git 형상관리(B1~B7)·Overlay(O1~O16) IPC 래퍼의 계약 검증.
// 실제 프로젝트 API를 호출하고 전송(call) 인자와 명령 이름을 가로채 Rust 백엔드 계약과 비교한다.
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
const clientUrl = new URL("./ipcProjects.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === clientUrl) {
      if (specifier === "./ipcTransport") return { url: transportUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let projects;
try {
  projects = await import(clientUrl);
} finally {
  hooks.deregister();
}

test("C16 V4: getProjectGitOverview 및 getProjectGitStatus는 projectPath와 worktreePath 인자를 보존한다", async () => {
  const overview = { repository: null, unavailableReason: "not a git repo" };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(overview));

  assert.equal(await projects.getProjectGitOverview("/repo/path"), overview);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "get_project_git_overview", args: { request: { projectPath: "/repo/path" } } },
  ]);

  const status = { clean: true, branch: "main", ahead: 0, behind: 0, files: [] };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(status));

  assert.equal(await projects.getProjectGitStatus("/repo/path", "/repo/wt"), status);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "get_project_git_status", args: { request: { projectPath: "/repo/path", worktreePath: "/repo/wt" } } },
  ]);
});

test("C16-11/B3 V4: 브랜치 팔로우 및 Git 원격 토큰 설정 명령은 전송 계약을 보존한다", async () => {
  const follows = { projectPath: "/repo/path", branches: ["main", "feature/a"] };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(follows));

  assert.equal(await projects.listProjectBranchFollows("/repo/path"), follows);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "list_project_branch_follows", args: { request: { projectPath: "/repo/path" } } },
  ]);

  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(follows));
  const followReq = { projectPath: "/repo/path", branch: "feature/b", follow: true };
  assert.equal(await projects.setProjectBranchFollow(followReq), follows);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "set_project_branch_follow", args: { request: followReq } },
  ]);

  const tokens = { projectPath: "/repo/path", remotes: [] };
  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(tokens));

  assert.equal(await projects.listProjectGitRemoteTokens("/repo/path"), tokens);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "list_project_git_remote_tokens", args: { request: { projectPath: "/repo/path" } } },
  ]);

  transport.calls.length = 0;
  transport.setResponse(Promise.resolve(tokens));
  const tokenReq = { projectPath: "/repo/path", host: "github.com", secretName: "gh-token" };
  assert.equal(await projects.setProjectGitRemoteToken(tokenReq), tokens);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "set_project_git_remote_token", args: { request: tokenReq } },
  ]);
});

test("C19 V4: Overlay 스냅샷·적용·검사 명령은 전송 실패를 임의 가공 없이 전달한다", async () => {
  const rejected = new Error("Overlay conflict detected");
  transport.calls.length = 0;
  transport.setResponse(Promise.reject(rejected));

  const applyReq = { projectPath: "/repo/path", setId: "set-1" };
  await assert.rejects(projects.applyProjectOverlay(applyReq), (err) => err === rejected);
  assert.deepEqual(structuredClone(transport.calls), [
    { command: "apply_project_overlay", args: { request: applyReq } },
  ]);
});
