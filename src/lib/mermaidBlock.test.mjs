import assert from "node:assert/strict";
import test from "node:test";
import { mermaidSource } from "./mermaidBlock.ts";

/** 모듈 안의 원문 상한과 같은 값. 씨앗이 상한을 실제로 넘는지 이 자리에서 확인한다. */
const MAX_MERMAID_CHARACTERS = 20_000;

test("mermaid 펜스는 코드를 그대로 넘긴다", () => {
  assert.equal(mermaidSource("mermaid", "sequenceDiagram\n  A->>B: 안녕"), "sequenceDiagram\n  A->>B: 안녕");
  // 정보 문자열에 값이 더 붙어도 언어가 mermaid면 코드가 이미 온전한 원문이다.
  assert.equal(mermaidSource("mermaid theme=dark", "flowchart LR\n  A --> B"), "flowchart LR\n  A --> B");
});

test("종류를 정보 문자열에 적은 펜스는 머리줄을 되돌려 붙인다", () => {
  assert.equal(mermaidSource("flowchart LR", "A --> B"), "flowchart LR\nA --> B");
  assert.equal(mermaidSource("sequenceDiagram", "A->>B: 안녕"), "sequenceDiagram\nA->>B: 안녕");
  // 대소문자는 표기마다 다르게 오므로 판별에서만 무시하고, 되돌려 붙일 때는 적힌 그대로 쓴다.
  assert.equal(mermaidSource("StateDiagram-v2", "[*] --> 대기"), "StateDiagram-v2\n[*] --> 대기");
});

test("다이어그램이 아닌 펜스와 빈 펜스는 그리지 않는다", () => {
  assert.equal(mermaidSource("ts", "const a = 1;"), null);
  assert.equal(mermaidSource("", "그냥 코드"), null);
  assert.equal(mermaidSource("aia-command", "명령"), null);
  assert.equal(mermaidSource("mermaid", "   \n  "), null);
});

test("상한을 넘는 원문은 코드 상자로 남긴다", () => {
  const long = `sequenceDiagram\n${"  A->>B: 긴 줄\n".repeat(3000)}`;
  assert.ok(long.length > MAX_MERMAID_CHARACTERS);
  assert.equal(mermaidSource("mermaid", long), null);
});

// 실제 답변에서 온 회귀: 시퀀스 메시지의 `\n`이 글자 그대로 남아 "Base64 디코딩\n앞 16byte=IV"가
// 한 줄에 역슬래시까지 붙어 나왔다. 흐름도에서는 같은 표기가 줄바꿈이 되므로, 두 경로가
// 모두 받는 `<br/>`로 모은다.
test("리터럴 개행 표기를 br로 모은다", () => {
  assert.equal(
    mermaidSource("mermaid", "sequenceDiagram\n    WAS->>WAS: Base64 디코딩\\n앞 16byte=IV"),
    "sequenceDiagram\n    WAS->>WAS: Base64 디코딩<br/>앞 16byte=IV",
  );
  assert.equal(
    mermaidSource("flowchart LR", '  A["첫 줄\\n둘째 줄"] --> B'),
    'flowchart LR\nA["첫 줄<br/>둘째 줄"] --> B',
  );
  // 이미 br로 적은 원문은 그대로다.
  assert.equal(mermaidSource("mermaid", "flowchart LR\n  A[\"가<br/>나\"]"), "flowchart LR\n  A[\"가<br/>나\"]");
});

// 설정 지시문 안쪽은 JSON이라 치환하면 값이 깨진다.
test("지시문 안의 역슬래시는 건드리지 않는다", () => {
  const source = [
    '%%{init: {"themeCSS": "a\\nb"}}%%',
    "flowchart LR",
    '  A["첫\\n둘"] --> B',
    '%%{wrap: {"label": "c\\nd"}}%%',
    '  B --> C["셋\\n넷"]',
  ].join("\n");
  const result = mermaidSource("mermaid", source);
  assert.ok(result.includes('"themeCSS": "a\\nb"'), "지시문은 원문 그대로여야 한다");
  assert.ok(result.includes('"label": "c\\nd"'), "여러 지시문을 각각 원문대로 둬야 한다");
  assert.ok(result.includes('A["첫<br/>둘"]'), "라벨은 치환돼야 한다");
  assert.ok(result.includes('C["셋<br/>넷"]'), "마지막 지시문 뒤 라벨도 치환돼야 한다");
});
