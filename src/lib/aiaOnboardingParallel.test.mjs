import assert from "node:assert/strict";
import test from "node:test";

import { PARALLEL_FIELD_KEYS, parallelFields } from "./aiaOnboardingParallel.ts";

// W6-8: 앱이 덧붙이는 병렬 칸의 도움말도 팩 문구처럼 그대로 화면에 그려지므로,
// 내부 칸 키(`projectPath`)를 문구에 끼우면 사용자 화면에 키 이름이 그대로 뜬다.
test("병렬 칸 도움말은 내부 칸 키를 화면 문구에 노출하지 않는다", () => {
  const fields = parallelFields();
  const pool = fields.find((field) => field.key === PARALLEL_FIELD_KEYS.pool);
  assert.ok(pool?.help);
  assert.match(pool.help.ko, /^프로젝트 폴더 아래의 상대 경로/);
  for (const field of fields) {
    for (const text of [field.help?.ko, field.help?.en, field.label.ko, field.label.en]) {
      if (text) assert.doesNotMatch(text, /projectPath|\$\{/);
    }
  }
});
