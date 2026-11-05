import assert from "node:assert/strict";
import test from "node:test";
import { setRuntimeLocale } from "./i18nRuntime.ts";
import { validateScheduleWorkflowDraft } from "./scheduleWorkflow.ts";

const field = (type, required = true, values = null) => ({ type, required, values, description: null });

const workflow = (overrides = {}) => ({
  id: "wf-usage",
  displayName: "사용량 점검",
  description: null,
  version: 3,
  risk: "readOnly",
  computedRisk: "readOnly",
  requiredOperations: [],
  inputSchema: { provider: field("enum", true, ["codex", "claude"]) },
  compatible: true,
  contractDigest: null,
  hardToRecoverEffects: [],
  lastExecution: null,
  ...overrides,
});

/**
 * 저장 전 검사가 돌려주는 문장은 호출부가 `" "` 로 이어 붙여 오류 배너에 넣으므로, 정적 대응표가
 * 문장 하나는 옮겨도 이어 붙인 줄은 통째로 맞지 않는다. 같은 파일의 카드 표기처럼 이 문장도
 * 화면 언어로 나와야 영어 화면에 한국어 오류만 남지 않는다.
 */
test("the draft problems follow the screen language like the card description does", () => {
  setRuntimeLocale("en", {});
  try {
    assert.deepEqual(validateScheduleWorkflowDraft({ workflow: null, inputs: {} }), [
      "Select the workflow to run.",
    ]);
    assert.deepEqual(validateScheduleWorkflowDraft({ workflow: workflow(), inputs: {} }), [
      "Required inputs are empty: provider",
    ]);
    // 이름이 둘이면 분리자까지 영어 쪽 틀에 고정된다.
    assert.deepEqual(validateScheduleWorkflowDraft({
      workflow: workflow({ inputSchema: { provider: field("enum"), cwd: field("string") } }),
      inputs: {},
    }), ["Required inputs are empty: provider, cwd"]);
    const problems = validateScheduleWorkflowDraft({
      workflow: workflow({ compatible: false, version: null }),
      inputs: { provider: "codex" },
    });
    assert.deepEqual(problems, [
      "The approved workflow version could not be read.",
      "This workflow is not compatible with the current catalog. AIA has to register it again.",
    ]);
    for (const problem of problems) assert.doesNotMatch(problem, /[가-힣]/);
  } finally {
    setRuntimeLocale("ko", {});
  }
  // 한국어 화면의 문장은 예전 그대로다.
  assert.deepEqual(validateScheduleWorkflowDraft({ workflow: null, inputs: {} }), ["실행할 워크플로를 선택하세요."]);
});
