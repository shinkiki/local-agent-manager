import assert from "node:assert/strict";
import test from "node:test";
import { filterGitCommits } from "./gitCommitSearch.ts";

const commit = (subject, extra = {}) => ({
  sha: "a".repeat(40),
  shortSha: "aaaaaaa",
  parents: [],
  authorName: "홍길동",
  authorEmail: "hong@example.test",
  authoredAt: 1,
  committerName: "builder",
  committedAt: 1,
  refs: [],
  subject,
  body: "",
  ...extra,
});

test("커밋 검색은 메시지 본문·계정·SHA·ref를 대소문자 없이 찾는다", () => {
  const commits = [
    commit("로그인 개선", { body: "OAuth 오류 처리", refs: ["feature/auth"] }),
    commit("문서 수정", { sha: "b".repeat(40), shortSha: "bbbbbbb", authorName: "Kim", authorEmail: "kim@example.test" }),
  ];

  assert.deepEqual(filterGitCommits(commits, "oauth").map((entry) => entry.subject), ["로그인 개선"]);
  assert.deepEqual(filterGitCommits(commits, "KIM@EXAMPLE").map((entry) => entry.subject), ["문서 수정"]);
  assert.deepEqual(filterGitCommits(commits, "feature/Auth").map((entry) => entry.subject), ["로그인 개선"]);
  assert.deepEqual(filterGitCommits(commits, "bbbbbbb").map((entry) => entry.subject), ["문서 수정"]);
});

test("빈 커밋 검색은 원래 순서를 보존한다", () => {
  const commits = [commit("첫째"), commit("둘째", { sha: "b".repeat(40), shortSha: "bbbbbbb" })];
  assert.deepEqual(filterGitCommits(commits, "  ").map((entry) => entry.subject), ["첫째", "둘째"]);
});
