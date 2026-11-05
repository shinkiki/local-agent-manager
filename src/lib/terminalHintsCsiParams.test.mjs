import assert from "node:assert/strict";
import test from "node:test";
import { extractTerminalHints, stripAnsi } from "./terminalHints.ts";

// CSI 매개변수 바이트는 ECMA-48의 0x30–0x3F 전체다. 숫자·`;`·`?`만 걷으면 콜론 색이나
// 키보드 모드 시퀀스가 남아, 주소 한가운데 걸린 ESC에서 주소가 잘린다.
test("strips CSI sequences whose parameters use : < = >", () => {
  assert.equal(stripAnsi("a\x1b[38:2:255:0:0mb\x1b[>1uc\x1b[<ud\x1b[=5he"), "abcde");
});

test("keeps an address whole when a colon-parameter colour sits inside it", () => {
  const hints = extractTerminalHints("open https://auth.example.com/\x1b[38:5:4mdevice?x=1\x1b[0m now\r\n");
  assert.deepEqual(hints.links, ["https://auth.example.com/device?x=1"]);
});
