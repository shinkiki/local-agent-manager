import assert from "node:assert/strict";
import test from "node:test";
import { parsePopoutRequest, popoutSearch, popoutWindowName } from "./popout.ts";

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
