import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AIA_REVIEW_COMMITS,
  buildAiaCommitReviewRequest,
  buildAiaOverlayConflictRequest,
} from "./projectAiaHandoff.ts";

const commit = (n) => ({ sha: `${n}`.padStart(40, "0"), subject: `커밋 ${n}` });

test("고른 순서를 1부터 매기고 상한을 넘으면 잘랐다고 알린다", () => {
  // 2026-10-02: 화면은 이력에서 임의 개수를 고를 수 있어서 상한이 없으면 수백 개가 한
  // 요청문에 실린다. 거절 대신 앞에서부터 자르고 truncated 로 알리는 쪽을 골랐다.
  const few = buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: [commit(2), commit(1)] });
  assert.deepEqual(few.commits.map((entry) => entry.order), [1, 2]);
  assert.equal(few.commits[0].subject, "커밋 2");
  assert.equal(few.truncated, false);

  const many = Array.from({ length: MAX_AIA_REVIEW_COMMITS + 5 }, (_, index) => commit(index));
  const capped = buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: many });
  assert.equal(capped.commits.length, MAX_AIA_REVIEW_COMMITS);
  assert.equal(capped.truncated, true);
  assert.match(capped.prompt, new RegExp(`${MAX_AIA_REVIEW_COMMITS}개만`));
});

test("diff를 싣지 않는다", () => {
  // 요청문에 변경 본문을 넣으면 토큰·원격 URL이 섞여 나갈 수 있고(G4, C16-8) 20개 분량이
  // 한 턴에 들어가지도 않는다. 좌표(경로·SHA·제목·순서)만 싣고 본문은 AIA가 직접 읽는다.
  const request = buildAiaCommitReviewRequest({
    projectPath: "/w/a",
    commits: [{ sha: "abc", subject: "제목" }],
  });
  assert.deepEqual(Object.keys(request.commits[0]).sort(), ["order", "sha", "subject"]);
  assert.doesNotMatch(request.prompt, /^[+-]{3} |^@@ /m);
  assert.match(request.prompt, /직접 읽어줘/);
});

test("readOnly 가 기본이고 끌 때만 승인 문구가 바뀐다", () => {
  const byDefault = buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: [commit(1)] });
  assert.equal(byDefault.readOnly, true);
  assert.match(byDefault.prompt, /읽기만 하고/);

  const writable = buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: [commit(1)], readOnly: false });
  assert.equal(writable.readOnly, false);
  assert.match(writable.prompt, /승인을 받은 뒤에만/);
});

test("overlay 충돌 요청은 patch 본문 대신 좌표만 싣는다", () => {
  // 2026-10-02: overlay patch 는 사용자의 로컬 설정이라 `.env` 값이나 토큰이 그대로 들어 있다.
  // 화면이 들고 있는 patch 를 요청문에 붙이면 그 값이 대화 기록으로 나가므로(G4), 세트 이름과
  // 막힌 경로·사유만 싣고 현재 상태는 AIA 가 등록 프로젝트에서 직접 읽게 한다.
  const request = buildAiaOverlayConflictRequest({
    projectPath: "/w/a",
    setName: "로컬 DB",
    affectedPaths: [".env.local", "config/dev.toml"],
    reason: "overlayNeedsResolution: apply --check 실패",
  });
  assert.deepEqual(request.affectedPaths, [".env.local", "config/dev.toml"]);
  assert.equal(request.readOnly, true);
  assert.match(request.prompt, /로컬 DB/);
  assert.match(request.prompt, /config\/dev\.toml/);
  assert.doesNotMatch(request.prompt, /^[+-]{3} |^@@ /m);
});

test("overlay 충돌 요청은 되돌릴 수 없는 명령을 명시로 막는다", () => {
  // C16-4 가 제공조차 하지 않는 명령을 AIA 가 자기 셸로 대신 돌리면 그 금지가 무의미해진다.
  // 특히 overlay 가 쓰려는 restore --source=HEAD --worktree 는 C19 예외가 서기 전까지
  // 이 저장소에서 쓸 수 없으므로 요청문이 이름을 적어 막는다.
  const request = buildAiaOverlayConflictRequest({
    projectPath: "/w/a",
    setName: "s",
    affectedPaths: [],
    readOnly: false,
  });
  assert.equal(request.readOnly, false);
  assert.equal(request.reason, null);
  assert.ok(request.prompt.includes("막힌 파일:\n- 없음"));
  assert.match(request.prompt, /승인을 받은 뒤에만/);
  for (const forbidden of ["reset --hard", "clean", "강제 푸시", "restore --source=HEAD --worktree"]) {
    assert.ok(request.prompt.includes(forbidden), forbidden);
  }
});
