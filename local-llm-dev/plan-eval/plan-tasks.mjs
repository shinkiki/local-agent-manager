// 계획 평가셋의 과제·채점·기준선. plan-loop.mjs(실측)와 단위 시험이 같은 것을 읽는다.
//
// 채점기가 야박했던 자리를 여기서 고쳤다. 예전 `must` 는 도구 이름 하나를 박아 두어서
// "같은 일을 다른 도구로 해낸 것"을 어긋난 것으로 셌다 — 2026-09-25 CPU 다단계에서
// notion-update-page 대신 notion-create-comment 로 덧붙인 한 건이 그렇게 깎였다.
// 이제 요구는 **동치 도구의 집합**이고, 그중 하나라도 쓰면 충족이다.

export const NOTION = ["notion-ai-search","notion-check-mcp-next-steps","notion-convert-page-to-skill","notion-create-attachment","notion-create-comment","notion-create-database","notion-create-file-upload","notion-create-folder","notion-create-pages","notion-create-view","notion-download-attachment","notion-download-skill","notion-duplicate-page","notion-fetch","notion-get-async-task","notion-get-comments","notion-get-session-status","notion-get-teams","notion-get-tool-access","notion-get-users","notion-list-favorite-pages","notion-list-private-pages","notion-list-recent-pages","notion-list-session-events","notion-list-shared-pages","notion-move-pages","notion-query-data-sources","notion-query-meeting-notes","notion-query-multiple-data-sources","notion-query-sessions","notion-read-session-event","notion-search","notion-search-agents","notion-search-sessions","notion-search-skills","notion-send-message-to-session","notion-show-advanced-analysis-next-steps","notion-spawn-session","notion-stop-session","notion-update-data-source","notion-update-folder","notion-update-page","notion-update-view","notion-upload-skill","notion-wait-session"];

export const ALL = ["bash", "read", "write", ...NOTION];

export const MAX_STEPS = 8;
export const MAX_TOOLS = 3;

// 동치 묶음. 한 요구는 이 중 하나만 쓰면 충족된다.
const FIND = ["notion-search", "notion-ai-search", "notion-fetch", "notion-list-recent-pages"];
const APPEND = ["notion-update-page", "notion-create-comment"];
const CREATE = ["notion-create-pages", "notion-duplicate-page"];
const LOCAL_READ = ["read", "bash"];

export const TASKS = [
  { id: "simple-create", label: "단순 생성",
    text: "노션에 테스트 페이지 만들어줘",
    want: { min: 1, max: 3, must: [CREATE] } },
  { id: "multi-step", label: "다단계",
    text: "노션에서 '로컬 LLM 개발' 페이지를 찾아서 오늘 측정 결과를 덧붙여줘",
    want: { min: 2, max: 5, must: [FIND, APPEND] } },
  { id: "impossible-plan", label: "불가능",
    text: "노션 워크스페이스 요금제를 엔터프라이즈로 바꿔줘",
    want: { impossible: true } },
  // 아래 셋은 2026-09-25 에 늘린 과제다.
  { id: "read-only", label: "읽기만",
    text: "노션에서 '빌드' 페이지를 찾아 내용을 보여줘",
    want: { min: 1, max: 3, must: [FIND] } },
  { id: "cross-boundary", label: "경계 넘기",
    text: "이 저장소의 README.md 를 읽어서 그 내용으로 노션에 새 페이지를 만들어줘",
    want: { min: 2, max: 5, must: [LOCAL_READ, CREATE] } },
  { id: "impossible-physical", label: "불가능(바깥일)",
    text: "내 노트북 배터리를 새것으로 주문해줘",
    want: { impossible: true } },
];

// 기준선: 모델별·과제별 "타당 / 시행" 비율. 2026-09-25 plan-loop 실측.
// null 은 아직 재지 않았다는 뜻이고, 재지 않은 것은 실패로 세지 않는다 —
// 지어낸 기준선은 없는 기준선보다 나쁘다. 늘린 과제 셋은 같은 날 실측해 채웠다.
// 기준선은 목표가 아니라 바닥이다. CPU 읽기만 1/3 은 낮지만 그게 지금 값이고,
// 올리는 것은 이 시험이 아니라 프롬프트·모델 쪽 일이다.
// 값은 표본의 **전형값**을 적고, 한 시행만큼의 흔들림은 compareToBaseline 의 여유가 받는다.
export const BASELINES = {
  "qwen3.5-gpu-128k:latest": {
    "simple-create": 3 / 3, "multi-step": 3 / 3, "impossible-plan": 3 / 3,
    "read-only": 3 / 3, "cross-boundary": 3 / 3, "impossible-physical": 3 / 3,
  },
  "gpt-oss-cpu-low:latest": {
    "simple-create": 2 / 3, "multi-step": 2 / 3, "impossible-plan": 3 / 3,
    "read-only": 1 / 3, "cross-boundary": 2 / 3, "impossible-physical": 3 / 3,
  },
};

/** 한 회차의 계획을 채점한다. 어긋났으면 그 이유를 함께 돌려준다. */
export function scorePlan(steps, want, allTools = ALL) {
  const reasons = [];
  const used = new Set(steps.flatMap((s) => s.tools));
  const bogus = [...new Set(steps.flatMap((s) => s.tools.filter((t) => !allTools.includes(t))))];
  if (bogus.length) reasons.push(`없는 이름: ${bogus.join(", ")}`);

  if (want.impossible) {
    if (steps.length !== 0) reasons.push(`거절해야 할 요청에 단계 ${steps.length}개를 세웠다`);
    return { ok: reasons.length === 0, reasons, bogus };
  }
  if (steps.length < want.min || steps.length > want.max) {
    reasons.push(`단계 수 ${steps.length} 가 ${want.min}~${want.max} 밖이다`);
  }
  for (const group of want.must) {
    if (!group.some((t) => used.has(t))) reasons.push(`다음 중 하나가 필요하다: ${group.join(" | ")}`);
  }
  return { ok: reasons.length === 0, reasons, bogus };
}

/**
 * 기준선과 견준다. 아직 재지 않은 자리(null)는 `unmeasured` — 판정하지 않는다.
 *
 * **시행 한 번만큼의 여유를 둔다.** 3회 표본에서 한 번 어긋나면 비율이 1.00 에서 0.67 로
 * 떨어지는데, 실측해 보면 1.00 으로 적힌 과제도 다음 표본에서 한 번쯤 흔들린다
 * (2026-09-25 GPU: `cross-boundary` 3/3→2/3, `다단계` 3/3→2/3). 여유 없이 견주면 이 시험은
 * 회귀가 아니라 운을 재고, 그러면 미달 줄이 늘 떠 있어 아무도 보지 않게 된다.
 * 그래서 이 관문이 잡는 것은 **한 시행을 넘는 하락** — 무너진 것이지 흔들린 것이 아니다.
 *
 * `table` 을 받는 것은 시험이 판정하지 않는 갈래까지 재기 위해서다.
 */
export function compareToBaseline(modelId, taskId, rate, { repeats = 3, table = BASELINES } = {}) {
  const baseline = table[modelId]?.[taskId];
  if (baseline === undefined) return { verdict: "unknown", baseline: null };
  if (baseline === null) return { verdict: "unmeasured", baseline: null };
  const eps = 1e-9;
  const slack = 1 / Math.max(repeats, 1);
  if (rate + slack + eps < baseline) return { verdict: "regressed", baseline };
  if (rate + eps < baseline) return { verdict: "wobbled", baseline };
  if (rate > baseline + eps) return { verdict: "improved", baseline };
  return { verdict: "held", baseline };
}
