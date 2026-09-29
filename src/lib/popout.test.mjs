import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPopoutWindowTitle,
  parsePopoutRequest,
  popoutDefaultTitle,
  popoutSearch,
  popoutWindowName,
} from "./popout.ts";
import { phraseText } from "./phrase.ts";

/**
 * 지원하는 팝아웃 종류마다 한 벌. 종류 목록은 모듈이 규약 표에서 스스로 만들고 밖으로
 * 내주지 않으므로, 목록이 온전한지는 이 표의 모든 종류가 주소·창 이름·제목을 오갈 수
 * 있는지로 본다 — 종류가 늘면 여기 한 줄을 더하는 것이 곧 그 종류의 왕복 시험이다.
 */
const SAMPLES = [
  { request: { kind: "aia", windowId: "win-1" }, windowName: "popout-aia-win-1", title: { ko: "AIA", en: null } },
  {
    request: { kind: "chat", chatId: "chat-9" },
    windowName: "popout-chat-chat-9",
    title: { ko: "채팅", en: "Chat" },
  },
  {
    request: { kind: "session", source: "claude", sessionId: "sess-3" },
    windowName: "popout-session-claude-sess-3",
    title: { ko: "세션", en: "Session" },
  },
];

test("독립 AIA 창은 각각 다른 주소와 이름을 갖고 다시 해석된다", () => {
  const first = { kind: "aia", windowId: "window-one" };
  const second = { kind: "aia", windowId: "window-two" };
  assert.deepEqual(parsePopoutRequest(popoutSearch(first)), first);
  assert.notEqual(popoutWindowName(first), popoutWindowName(second));
  assert.equal(parsePopoutRequest("?popout=aia"), null);
  assert.equal(parsePopoutRequest("?popout=aia&window=../../invalid"), null);
});

test("채팅 팝아웃 쿼리를 만들고 다시 해석하면 같은 대상이 나온다", () => {
  const request = { kind: "chat", chatId: "chat-123e4567-e89b" };
  const search = popoutSearch(request);
  assert.equal(search, "?popout=chat&chat=chat-123e4567-e89b");
  assert.deepEqual(parsePopoutRequest(search), request);
});

test("세션 팝아웃 쿼리를 만들고 다시 해석하면 같은 대상이 나온다", () => {
  const request = { kind: "session", source: "codex", sessionId: "abc/def 1" };
  const search = popoutSearch(request);
  assert.deepEqual(parsePopoutRequest(search), request);
});

test("popout 쿼리가 없거나 값이 불완전하면 null을 돌려준다", () => {
  assert.equal(parsePopoutRequest(""), null);
  assert.equal(parsePopoutRequest("?foo=bar"), null);
  assert.equal(parsePopoutRequest("?popout=chat"), null);
  assert.equal(parsePopoutRequest("?popout=chat&chat=%20"), null);
  assert.equal(parsePopoutRequest("?popout=session&session=abc"), null);
  assert.equal(parsePopoutRequest("?popout=session&source=unknown&session=abc"), null);
  assert.equal(parsePopoutRequest("?popout=terminal&chat=abc"), null);
});

test("창 이름은 대상별로 고정되고 Tauri label 규칙에 맞는 문자만 남는다", () => {
  const name = popoutWindowName({ kind: "chat", chatId: "id with spaces/슬래시" });
  assert.match(name, /^popout-chat-[0-9A-Za-z_-]+$/);
  assert.equal(name, popoutWindowName({ kind: "chat", chatId: "id with spaces/슬래시" }));
  assert.equal(
    popoutWindowName({ kind: "session", source: "claude", sessionId: "abc" }),
    "popout-session-claude-abc",
  );
});

test("창 이름은 종류마다 그 종류의 대상 식별자로 만들어진다", () => {
  for (const sample of SAMPLES) {
    assert.equal(popoutWindowName(sample.request), sample.windowName);
  }
});

test("팝아웃 종류별 기본 창 제목과 전체 창 제목 서식을 만든다", () => {
  for (const sample of SAMPLES) {
    assert.deepEqual(popoutDefaultTitle(sample.request), sample.title);
  }

  assert.equal(formatPopoutWindowTitle("AIA"), "AIA · Agent Manager");
  assert.equal(formatPopoutWindowTitle("채팅"), "채팅 · Agent Manager");
  assert.equal(formatPopoutWindowTitle("세션"), "세션 · Agent Manager");
  assert.equal(formatPopoutWindowTitle("커스텀 대화"), "커스텀 대화 · Agent Manager");
});

// `en`이 null일 때 언어 선택 함수를 거치지 않는다는 규칙 자체는 두 언어 표기의 정본
// (`phrase.test.mjs`)에서 짚는다. 여기서는 규약 표의 모든 종류가 그 규칙을 지나 문자열이
// 되는지만 본다 — 종류가 늘 때 제목만 표에서 빠지는 일을 잡는 것이 이 시험의 몫이다.
test("표의 모든 종류가 두 언어 표기로 제목을 낸다", () => {
  for (const sample of SAMPLES) {
    const title = popoutDefaultTitle(sample.request);
    assert.deepEqual(title, sample.title);
    assert.equal(phraseText(title, (ko) => ko), sample.title.ko);
  }
});

test("지원하는 모든 종류가 주소를 오간다 — 모르는 종류만 거절한다", () => {
  for (const sample of SAMPLES) {
    assert.deepEqual(parsePopoutRequest(popoutSearch(sample.request)), sample.request);
  }
  assert.equal(parsePopoutRequest("?popout=diagram&window=win-1"), null);
});


test("git diff 팝아웃은 프로젝트·경로·대상(스테이지/커밋)을 주소로 오가고 커밋 창은 대상마다 따로 선다", () => {
  const worktree = { kind: "gitDiff", projectPath: "/tmp/p", path: "src/a b.ts", originalPath: null, staged: false, commit: null };
  assert.deepEqual(parsePopoutRequest(popoutSearch(worktree)), worktree);
  const staged = { ...worktree, staged: true, originalPath: "src/old.ts" };
  assert.deepEqual(parsePopoutRequest(popoutSearch(staged)), staged);
  const commit = { ...worktree, commit: "abc1234" };
  assert.deepEqual(parsePopoutRequest(popoutSearch(commit)), commit);
  assert.notEqual(popoutWindowName(worktree), popoutWindowName(staged));
  assert.notEqual(popoutWindowName(staged), popoutWindowName(commit));
  assert.match(popoutWindowName(commit), /^popout-gitDiff-[0-9A-Za-z_-]+$/);
  assert.equal(parsePopoutRequest("?popout=gitDiff&project=/tmp/p"), null);
  assert.equal(parsePopoutRequest("?popout=gitDiff&project=/tmp/p&path=a&commit=not-a-sha"), null);
  assert.equal(phraseText(popoutDefaultTitle(commit), (_ko, en) => en ?? _ko), "Diff");
});
