import assert from "node:assert/strict";
import test from "node:test";
import { canOpenSshTerminal, sshTerminalTarget } from "./sshTerminalTarget.ts";

const server = Object.freeze({
  id: "test-server", name: "Example", fingerprint: "SHA256:example",
  user: "tester", host: "ssh.example.test", port: 2222,
  agentEnabled: false, allowedCommands: Object.freeze([]), deniedCommands: Object.freeze([]),
  fileTransferEnabled: false, transferRoot: "", terminalEnabled: false,
  unrestrictedCommands: false, updatedAt: 0,
});
const key = Object.freeze({
  fileName: "id_example.pub", path: "/isolated/.ssh/id_example.pub",
  algorithm: "ssh-ed25519", fingerprint: server.fingerprint,
  comment: null, hasPrivateKey: true, note: null, passphraseSaved: false,
});
const destination = "tester@ssh.example.test:2222";

test("C9-19/V4 missing keys block both SSH windows and retain the server destination", () => {
  assert.deepEqual(sshTerminalTarget(server, null), {
    blockedReason: "이 서버가 쓰는 키가 ~/.ssh에 없습니다. 서버를 수정해 다른 키를 고르세요.",
    destination,
  });
  assert.equal(canOpenSshTerminal(server, null), false);
});

test("C9-19/C9-20 a public key without its private key blocks both windows", () => {
  const publicOnly = Object.freeze({ ...key, hasPrivateKey: false });
  assert.deepEqual(sshTerminalTarget(server, publicOnly), {
    blockedReason: "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다.",
    destination,
  });
  assert.equal(canOpenSshTerminal(server, publicOnly), false);
});

test("C9-19 direct user terminals remain available independently of agent permissions", () => {
  assert.deepEqual(sshTerminalTarget(server, key), { blockedReason: null, destination });
  assert.equal(canOpenSshTerminal(server, key), true);
  const enabled = { ...server, agentEnabled: true, terminalEnabled: true, fileTransferEnabled: true };
  assert.deepEqual(sshTerminalTarget(enabled, key), sshTerminalTarget(server, key));
  assert.equal(canOpenSshTerminal(enabled, key), true);
});

test("V4 blocked reasons use the supplied translator for each distinct failure", () => {
  const english = (_ko, en) => en;
  assert.equal(sshTerminalTarget(server, null, english).blockedReason,
    "The key this server uses is not in ~/.ssh. Edit the server and choose another key.");
  assert.equal(sshTerminalTarget(server, { ...key, hasPrivateKey: false }, english).blockedReason,
    "Cannot connect with this key because no private key with the same name exists.");
});

test("V4 a usable key does not translate or invent a blocked reason", () => {
  assert.deepEqual(sshTerminalTarget(server, key, () => { throw new Error("unexpected translation"); }), {
    blockedReason: null, destination,
  });
});

test("C9-19 a shared key never substitutes another server's identity or port", () => {
  const other = { ...server, id: "other-server", user: "deploy", host: "other.example.test", port: 2200 };
  assert.equal(sshTerminalTarget(other, key).destination, "deploy@other.example.test:2200");
  assert.equal(sshTerminalTarget(server, key).destination, destination);
});

test("V4 presentation leaves caller-owned server and key metadata unchanged", () => {
  const before = JSON.stringify({ server, key });
  sshTerminalTarget(server, key);
  sshTerminalTarget(server, null);
  canOpenSshTerminal(server, key);
  assert.equal(JSON.stringify({ server, key }), before);
});
