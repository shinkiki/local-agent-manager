import assert from "node:assert/strict";
import test from "node:test";

import { gitPushAuthBlocked, gitRemoteAuthHint, gitRemoteAuthRows } from "./gitRemoteAuth.ts";

const text = (ko) => ko;
const remote = (auth) => ({
  name: "origin",
  url: "https://github.com/o/r.git",
  auth: { transport: "https", host: "github.com", tokenSecret: null, ...auth },
});

test("C16-11 인증 수단이 하나도 없을 때만 push를 막는다", () => {
  assert.equal(gitPushAuthBlocked(remote({ method: "none" })), true);
  for (const method of ["token", "sshKey", "credentialHelper", "urlCredential", "sshDefault", "notNeeded", "unknown"]) {
    assert.equal(gitPushAuthBlocked(remote({ method })), false, method);
  }
  assert.equal(gitPushAuthBlocked(undefined), false);
});

test("C16-11 막을 때의 안내는 지정할 호스트와 설정 자리를 적는다", () => {
  const hint = gitRemoteAuthHint(remote({ method: "none" }), text);
  assert.match(hint, /github\.com/);
  assert.match(hint, /톱니바퀴/);
  assert.equal(gitRemoteAuthHint(remote({ method: "token", tokenSecret: "GITHUB_TOKEN" }), text), null);
  assert.equal(gitRemoteAuthHint(undefined, text), null);
});

test("C16-11 평문 HTTP 원격에는 토큰을 싣지 않는다고 알린다", () => {
  const hint = gitRemoteAuthHint(remote({ method: "none", transport: "http", host: "intranet" }), text);
  assert.match(hint, /평문 HTTP/);
});

test("C16-11 설정 카드는 HTTPS 호스트와 이미 고른 지정을 합쳐 보인다", () => {
  const remotes = [
    remote({ method: "token", tokenSecret: "GH_ORG" }),
    { name: "fork", url: "https://github.com/me/r.git", auth: { transport: "https", host: "github.com", method: "token", tokenSecret: "GH_ORG" } },
    { name: "mirror", url: "https://git.example.com/r.git", auth: { transport: "https", host: "git.example.com", method: "credentialHelper", tokenSecret: null } },
    { name: "plain", url: "http://intranet/r.git", auth: { transport: "http", host: "intranet", method: "none", tokenSecret: null } },
    { name: "ssh", url: "git@github.com:o/r.git", auth: { transport: "ssh", host: "github.com", method: "sshDefault", tokenSecret: null } },
    // 가져오기는 HTTPS, push는 SSH(`pushurl`)인 원격도 가져오기 호스트가 줄로 선다.
    { name: "split", url: "https://gitlab.com/o/r.git", auth: { transport: "ssh", host: "gitlab.com", method: "sshDefault", tokenSecret: null, fetchHost: "gitlab.com" } },
  ];
  const tokens = [
    { host: "github.com", secretName: "GH_ORG", username: "x-access-token", updatedAt: 1, secretExists: true },
    { host: "gone.example.com", secretName: "OLD", username: "x-access-token", updatedAt: 1, secretExists: false },
  ];
  const rows = gitRemoteAuthRows(remotes, tokens);
  assert.deepEqual(rows.map((row) => row.host), ["git.example.com", "github.com", "gitlab.com", "gone.example.com"]);
  assert.deepEqual(rows[1].remotes, ["origin", "fork"]);
  assert.equal(rows[1].binding.secretName, "GH_ORG");
  assert.equal(rows[0].otherMethod, "credentialHelper");
  assert.equal(rows[0].binding, null);
  assert.deepEqual(rows[2].remotes, ["split"]);
  // 원격이 사라진 지정도 지울 수 있게 남는다.
  assert.deepEqual(rows[3].remotes, []);
  assert.equal(rows[3].binding.secretExists, false);
});
