import assert from "node:assert/strict";
import test from "node:test";

import { parseSshPort } from "./sshPort.ts";

test("SSH 포트는 숫자만으로 된 1~65535만 받는다", () => {
  assert.equal(parseSshPort("22"), 22);
  assert.equal(parseSshPort(" 2222 "), 2222);
  assert.equal(parseSshPort("65535"), 65535);
  assert.equal(parseSshPort(""), null);
  assert.equal(parseSshPort("   "), null);
});

test("뒤에 글자가 붙거나 숫자가 아닌 포트는 다른 포트로 접히지 않고 무효가 된다", () => {
  assert.equal(parseSshPort("2222x"), undefined);
  assert.equal(parseSshPort("abc"), undefined);
  assert.equal(parseSshPort("1e3"), undefined);
  assert.equal(parseSshPort("22.5"), undefined);
  assert.equal(parseSshPort("-22"), undefined);
  assert.equal(parseSshPort("0"), undefined);
  assert.equal(parseSshPort("65536"), undefined);
  assert.equal(parseSshPort("123456"), undefined);
});
