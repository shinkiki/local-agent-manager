import assert from "node:assert/strict";
import test from "node:test";
import { pluginRemoteNotice } from "./pluginRemoteNotice.ts";

test("호스트 화면에는 안내 띠를 띄우지 않는다", () => {
  assert.equal(pluginRemoteNotice({ hostScreen: true }), "none");
});

test("호스트 화면이 아니면 콜백 주소 붙여넣기를 안내한다 — 막히는 인증 방식은 없다", () => {
  // 헤드리스 기동도 호스트 화면이 아니라는 점에서 원격 화면과 같다(H04).
  assert.equal(pluginRemoteNotice({ hostScreen: false }), "paste");
});
