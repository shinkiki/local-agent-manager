import assert from "node:assert/strict";
import test from "node:test";
import {
  DESTRUCTIVE_GIT_COMMANDS_BAN,
  MAX_AIA_REVIEW_COMMITS,
  buildAiaCommitReviewRequest,
  buildAiaOverlayConflictRequest,
  resolveAiaReviewSelection,
} from "./projectAiaHandoff.ts";
import { gitConflictAiaPrompt } from "./gitConflictAiaPrompt.ts";

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

test("읽기 요청은 파괴적 git 명령을 명시로 금한다", () => {
  // 점검표 A7. 다중 커밋 요청에는 금지 줄이 아예 없었다 — 커밋 20개를 넘긴 "분석해줘"는
  // 읽기 전용이라고만 적고, AIA가 자기 셸로 `git reset --hard`를 돌리는 것을 말리는 문장이
  // 한 줄도 없었다. C16-4는 그 명령을 제품에 제공하지 않지만 AIA의 셸까지 막지는 못한다.
  // 뜻풀이가 아니라 명령 형태로 적는 이유도 여기 고정한다 — "강제 푸시"만 적힌 금지는
  // `push --force-with-lease`를 남긴다.
  // C16-4가 "never offered"로 적은 집합 전부. 변종을 빠뜨리면 반대쪽 구멍이 나므로
  // clean·force 는 "모든 형태"라는 말이 함께 있는지도 본다.
  const literals = ["reset --hard", "clean -fd", "clean -xdf", "clean 모든 형태",
    "push --force,", "push -f,", "push --force-with-lease",
    // --force* 는 괄호 안이 아니라 독립 항목이어야 push 밖의 force 형태까지 걸린다.
    "명령을 가리지 않고 모든 --force*/-f 형태",
    "commit --amend", "branch -D", "rebase -i", "--autostash",
    "restore --source=HEAD --worktree", "worktree 파일 checkout",
    // 금지의 뜻은 폐기다 — 충돌 해결의 표준 수단까지 막으면 쓰기 허용 문단과 모순된다.
    "checkout --ours/--theirs"];

  // 세 생성기 × 읽기 전용/쓰기 허용 모두에서 같은 줄이 실제 출력에 들어간다.
  // 형제 파일 gitConflictAiaPrompt 도 같은 상수를 써야 한다 — 따로 적어 두었더니
  // 2026-10-11에 한쪽만 넓어져 충돌 배너 경로에 옛 뜻풀이가 남아 있었다.
  const prompts = [
    buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: [commit(1)] }).prompt,
    buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: [commit(1)], readOnly: false }).prompt,
    buildAiaOverlayConflictRequest({ projectPath: "/w/a", setName: "s", affectedPaths: [] }).prompt,
    buildAiaOverlayConflictRequest({ projectPath: "/w/a", setName: "s", affectedPaths: [], readOnly: false }).prompt,
    gitConflictAiaPrompt({ projectPath: "/w/a", operation: "rebase", conflictedFiles: ["a.ts"] }),
    gitConflictAiaPrompt({ projectPath: "/w/a", operation: "pull", conflictedFiles: [], kind: "blocked" }),
    gitConflictAiaPrompt({ projectPath: "/w/a", operation: "rebase", conflictedFiles: ["a.ts"], readOnly: false }),
  ];
  for (const prompt of prompts) {
    for (const literal of literals) assert.ok(prompt.includes(literal), literal);
    // 금지는 요청문의 마지막 문단이다 — 중간에 묻히면 긴 요청에서 읽히지 않는다.
    assert.ok(prompt.endsWith(DESTRUCTIVE_GIT_COMMANDS_BAN));
  }
});

test("이력에서 사라진 선택은 조용히 빠지지 않고 missing 으로 남는다", () => {
  // 2026-10-04 실측한 결함: 이력은 개요가 올 때마다 첫 페이지부터 다시 읽히므로 브랜치를
  // 바꾸면 고른 SHA 가 목록에서 사라진다. 그런데 머리글은 picked.length 를 세고 요청은
  // 살아남은 것만 실어서, "3개 선택"이라 적고 1개만 넘어가거나 버튼이 아무 일도 하지 않았다.
  // 세는 자리와 싣는 자리를 이 함수 하나로 합쳐 둘이 어긋날 수 없게 한 것이 그 수정이다.
  const history = [commit(1), commit(2)];
  const picked = [commit(2).sha, commit(9).sha, commit(1).sha];
  const selection = resolveAiaReviewSelection({ picked, commits: history });
  // 고른 순서가 이력 순서를 이긴다 — 요청문의 order 가 사용자가 고른 순서이기 때문이다.
  assert.deepEqual(selection.commits.map((entry) => entry.sha), [commit(2).sha, commit(1).sha]);
  assert.deepEqual(selection.missing, [commit(9).sha]);

  // 요청에 실리는 수와 머리글이 세는 수는 같은 값에서 나온다.
  const request = buildAiaCommitReviewRequest({ projectPath: "/w/a", commits: selection.commits });
  assert.equal(request.commits.length, selection.commits.length);
  assert.ok(request.prompt.includes("커밋(2개, 고른 순서)"));
  assert.ok(!request.prompt.includes(commit(9).sha));

  // 하나도 남지 않으면 보낼 것이 없다는 사실이 수로 드러나야 한다(화면은 버튼을 끈다).
  const gone = resolveAiaReviewSelection({ picked, commits: [] });
  assert.equal(gone.commits.length, 0);
  assert.equal(gone.missing.length, 3);
});
