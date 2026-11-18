import assert from "node:assert/strict";
import test from "node:test";
import {
  isServerDraftValid, sameServer, serverDraftOf, toSaveServerRequest,
} from "./sshServerDraft.ts";

const defaults = { allowed: ["git status", "uptime"], denied: ["rm -rf"] };
const saved = {
  id: "srv-test", name: "Build", fingerprint: "SHA256:test",
  host: "build.example.com", port: 2222, user: "deploy", agentEnabled: true,
  allowedCommands: ["git status", "uptime"], deniedCommands: ["rm -rf"],
  fileTransferEnabled: true, transferRoot: "/srv/build", terminalEnabled: true,
  unrestrictedCommands: false, projectGitEnabled: true, updatedAt: 1,
};
const keys = [{ fingerprint: saved.fingerprint }];

test("C9-9 새 서버 기본값과 저장본 편집은 서로의 키·명령 정책을 섞지 않는다", () => {
  const fresh = serverDraftOf(null, defaults, "SHA256:new");
  assert.equal(fresh.port, "22");
  assert.equal(fresh.fingerprint, "SHA256:new");
  assert.equal(fresh.allowed, "git status\nuptime");
  assert.equal(fresh.denied, "rm -rf");
  for (const field of ["agentEnabled", "fileTransferEnabled", "terminalEnabled", "unrestrictedCommands", "projectGitEnabled"]) {
    assert.equal(fresh[field], false, field);
  }
  const empty = serverDraftOf(null, null);
  assert.equal(empty.fingerprint, "");
  assert.equal(empty.allowed, "");
  assert.equal(empty.denied, "");
  const edit = serverDraftOf(saved, { allowed: ["different"], denied: [] }, "SHA256:other");
  assert.equal(edit.port, "2222");
  assert.equal(edit.fingerprint, saved.fingerprint);
  assert.equal(edit.allowed, "git status\nuptime");
  assert.equal(edit.denied, "rm -rf");
  assert.deepEqual(toSaveServerRequest(saved.id, edit), {
    ...Object.fromEntries(Object.entries(saved).filter(([key]) => key !== "updatedAt")),
  });
});

test("C9-13 변경 감지는 공백·중복 명령을 정규화하고 모든 입력 변경을 감지한다", () => {
  const draft = serverDraftOf(saved, null);
  assert.equal(sameServer(draft, saved), true);
  assert.equal(sameServer({
    ...draft, name: " Build ", host: " build.example.com ", port: " 2222 ",
    user: " deploy ", transferRoot: " /srv/build ",
    allowed: " git status\n\nuptime\ngit status ", denied: "\nrm -rf\nrm -rf\n",
  }, saved), true);
  const changes = {
    name: "Other", host: "other.example.com", port: "22", user: "other",
    fingerprint: "SHA256:other", agentEnabled: false, allowed: "uptime",
    denied: "rm", fileTransferEnabled: false, transferRoot: "/other",
    terminalEnabled: false, unrestrictedCommands: true, projectGitEnabled: false,
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.equal(sameServer({ ...draft, [field]: value }, saved), false, field);
  }
});

test("C9-9 편집 입력은 필수 항목·키·포트·이름 한도와 전송 폴더를 확인한다", () => {
  const draft = serverDraftOf(saved, null);
  assert.equal(isServerDraftValid(draft, keys), true);
  assert.equal(isServerDraftValid({ ...draft, port: "" }, keys), true);
  assert.equal(isServerDraftValid({ ...draft, name: "가".repeat(80) }, keys), true);
  for (const change of [
    { host: " " }, { user: "" }, { fingerprint: "missing" },
    { port: "0" }, { port: "65536" }, { port: "22x" },
    { name: "가".repeat(81) }, { transferRoot: " " },
  ]) {
    assert.equal(isServerDraftValid({ ...draft, ...change }, keys), false, JSON.stringify(change));
  }
  assert.equal(isServerDraftValid(draft, []), false);
  assert.equal(isServerDraftValid({ ...draft, fileTransferEnabled: false, transferRoot: "" }, keys), true);
});

test("C9·C16-10 저장 요청은 종속 권한만 에이전트 사용에 묶고 사용자 Git 권한은 보존한다", () => {
  for (const agentEnabled of [false, true]) {
    for (let mask = 0; mask < 16; mask += 1) {
      const draft = {
        ...serverDraftOf(saved, null), agentEnabled,
        fileTransferEnabled: Boolean(mask & 1), terminalEnabled: Boolean(mask & 2),
        unrestrictedCommands: Boolean(mask & 4), projectGitEnabled: Boolean(mask & 8),
        name: " Build ", host: " build.example.com ", user: " deploy ",
        port: " ", transferRoot: " /srv/build ",
        allowed: " git status\n\ngit status\nuptime ", denied: " rm -rf\nrm -rf ",
      };
      const request = toSaveServerRequest(null, draft);
      assert.equal(request.id, null);
      assert.equal(request.name, "Build");
      assert.equal(request.host, saved.host);
      assert.equal(request.user, saved.user);
      assert.equal(request.port, null);
      assert.equal(request.transferRoot, "/srv/build");
      assert.equal(request.fingerprint, saved.fingerprint);
      assert.deepEqual(request.allowedCommands, ["git status", "uptime"]);
      assert.deepEqual(request.deniedCommands, ["rm -rf"]);
      assert.equal(request.agentEnabled, agentEnabled);
      for (const field of ["fileTransferEnabled", "terminalEnabled", "unrestrictedCommands"]) {
        assert.equal(request[field], agentEnabled ? draft[field] : false, field);
      }
      assert.equal(request.projectGitEnabled, draft.projectGitEnabled);
    }
  }
});
