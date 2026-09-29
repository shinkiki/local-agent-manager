import assert from "node:assert/strict";
import test from "node:test";
import { markdownAngleToken } from "./markdownAngle.ts";

test("아는 HTML 표기만 걷어내고 부등호는 글자로 남긴다", () => {
  assert.deepEqual(markdownAngleToken("<br>"), { kind: "break" });
  assert.deepEqual(markdownAngleToken("<br />"), { kind: "break" });
  assert.deepEqual(markdownAngleToken("<b>"), { kind: "markup" });
  assert.deepEqual(markdownAngleToken("</details>"), { kind: "markup" });
  assert.deepEqual(markdownAngleToken('<img src="a.png" />'), { kind: "markup" });
  assert.deepEqual(markdownAngleToken("<https://example.com>"), {
    kind: "autolink",
    href: "https://example.com",
  });
  // 모르는 태그는 숨기지 않는다. 무엇이 지워졌는지 화면만 보고 알 수 없기 때문이다.
  assert.equal(markdownAngleToken("<oai-mem-citation>"), null);
  assert.equal(markdownAngleToken("<3"), null);
});
