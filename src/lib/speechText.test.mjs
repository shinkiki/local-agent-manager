import assert from "node:assert/strict";
import test from "node:test";
import { speechTextFromMarkdown, splitSpeechText } from "./speechText.ts";

test("speech output strips markdown controls and is split into bounded chunks", () => {
  const plain = speechTextFromMarkdown("## 결과\n- **완료** [문서](https://example.com)\n```txt\n코드\n```");
  assert.equal(plain, "결과 완료 문서 코드");
  const chunks = splitSpeechText("첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.", 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
  assert.equal(chunks.join(" "), "첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.");
});

test("chunk boundaries prefer a late sentence end and fall back to spaces", () => {
  assert.deepEqual(splitSpeechText("", 10), []);
  // 문장 끝이 상한의 45%보다 앞이면 조각이 너무 짧아지므로 따르지 않고 마지막 공백에서 끊는다.
  assert.deepEqual(splitSpeechText("ab. cdefgh ijklmnop", 12), ["ab. cdefgh", "ijklmnop"]);
  // 문장 끝이 충분히 뒤면 종결 부호까지 담아 끊는다.
  assert.deepEqual(splitSpeechText("abcdefgh. ijklmnop", 12), ["abcdefgh.", "ijklmnop"]);
  // 공백도 종결 부호도 없는 덩이는 상한에서 그대로 자른다.
  assert.deepEqual(splitSpeechText("abcdefghijklmno", 10), ["abcdefghij", "klmno"]);
});
