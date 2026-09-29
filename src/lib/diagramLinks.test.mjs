import assert from "node:assert/strict";
import test from "node:test";
import { diagramLinkAction } from "./diagramLinks.ts";

test("http(s) 주소는 앱이 외부로 연다", () => {
  assert.deepEqual(diagramLinkAction("https://example.com/a"), { kind: "external", href: "https://example.com/a" });
  assert.deepEqual(diagramLinkAction("  http://example.com  "), { kind: "external", href: "http://example.com" });
});

test("로컬 파일 경로는 앱 안에서 연다", () => {
  assert.deepEqual(diagramLinkAction("./docs/plan.md"), { kind: "local", href: "./docs/plan.md" });
  assert.deepEqual(diagramLinkAction("/Users/me/note.md"), { kind: "local", href: "/Users/me/note.md" });
  assert.deepEqual(diagramLinkAction("plan.md"), { kind: "local", href: "plan.md" });
});

// 그림 안에서 무엇이 열리는지 예측할 수 없는 주소는 문서 링크로는 되더라도 여기서는 막는다.
test("스크립트·프로토콜 상대·그밖의 스킴은 막는다", () => {
  for (const raw of ["javascript:alert(1)", "JavaScript:alert(1)", "//evil.example.com", "mailto:a@b.c", "#section", "data:text/html,x", "", "   ", null, undefined]) {
    assert.deepEqual(diagramLinkAction(raw), { kind: "blocked" }, `${String(raw)}는 막혀야 한다`);
  }
});
