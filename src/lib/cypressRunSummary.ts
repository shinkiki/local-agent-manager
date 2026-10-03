import type { CypressRunState, CypressRunStatus, CypressRunTest } from "../types";
import { cleanPathInput } from "./crossPlatformPath.ts";

import { runtimeText } from "./i18nRuntime.ts";
// 실행 한 건을 사람이 읽는 모양으로 바꾸는 규칙 — 상태별 요약 문구, 실패 테스트 평탄화,
// 산출물 경로의 표시 이름. 작업공간 안의 파일을 어디까지 만질 수 있는지(cypressWorkspace.ts)와
// 바뀌는 이유가 다르다. 실행 상태 갈래가 늘거나 요약 문구를 손볼 때 경로 검증 규칙을 함께
// 읽을 이유가 없고, 반대로 편집 금지 폴더를 고칠 때 요약 표를 지나칠 이유도 없다.

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return runtimeText(`${seconds.toFixed(seconds < 10 ? 1 : 0)}초`, `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`);
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest > 0 ? runtimeText(`${minutes}분 ${rest}초`, `${minutes}m ${rest}s`) : runtimeText(`${minutes}분`, `${minutes}m`);
}

/**
 * 실행 상태별 요약 낱말과 그 뒤에 올 수 있는 꼬리. 여러 갈래가 저마다 대상 이름 접두와
 * ` · ` 이음을 따로 들고 있어, 한 갈래의 문구를 고치면 나머지가 조용히 어긋났다(통과·
 * 실패는 같은 낱말 판정을 한 갈래 안에서 두 번 적고 있었다). 낱말은 이 표에서만 정하고
 * 접두와 이음은 아래 한 곳에서만 붙인다.
 *
 * `tail`은 낱말 뒤에 무엇이 올 수 있는지다. `message`는 실패 사유, `summary`는 집계와
 * 소요 시간이며 둘 다 해당 값이 없으면 낱말에서 끝난다. `none`은 언제나 낱말로 끝난다.
 */
const RUN_STATE_SUMMARY: Record<CypressRunState, { word: string; tail: "none" | "message" | "summary" }> = {
  running: { word: "실행 중", tail: "none" },
  timedOut: { word: "시간 초과", tail: "message" },
  error: { word: "실행 오류", tail: "message" },
  passed: { word: "통과", tail: "summary" },
  failed: { word: "실패", tail: "summary" },
  closed: { word: "닫힘", tail: "none" },
};

type RunSummaryTail = (typeof RUN_STATE_SUMMARY)[CypressRunState]["tail"];

/** 상태 낱말 뒤에 붙을 오류 또는 실행 집계를 조립한다. 해당 정보가 없으면 빈 배열. */
function cypressRunTailParts(status: CypressRunStatus, tail: RunSummaryTail): string[] {
  if (tail === "message") return status.message ? [status.message] : [];
  if (tail !== "summary" || !status.summary) return [];

  const { passed, failed, pending, durationMs } = status.summary;
  return [
    `통과 ${passed} · 실패 ${failed} · 보류 ${pending}`,
    formatDuration(durationMs),
  ];
}

/**
 * 실행 결과를 패널 한 줄에 보일 요약 문구로 만든다. 런처를 띄운 수동 실행은 스펙을 런처
 * 안에서 고르므로 대상 이름이 비어 있다 — 그대로 두면 "전체 스펙 실행 중"으로 읽혀, 열어만
 * 둔 런처가 스펙을 모두 돌리고 있는 것처럼 보인다.
 */
export function summarizeCypressRun(status: CypressRunStatus): string {
  const { word, tail } = RUN_STATE_SUMMARY[status.state];
  const target = status.mode === "open" ? "런처" : status.spec ?? "전체 스펙";
  return [`${target} ${word}`, ...cypressRunTailParts(status, tail)].join(" · ");
}

/** 실패한 테스트만 스펙 경로와 함께 평탄하게 뽑는다. */
export function failedCypressTests(status: CypressRunStatus): { spec: string; test: CypressRunTest }[] {
  return status.summary?.specs.flatMap(({ spec, tests }) =>
    tests
      .filter((test) => test.state === "failed")
      .map((test) => ({ spec, test }))) ?? [];
}

/**
 * 산출물 경로에서 화면에 보일 짧은 이름을 뽑는다. 실제 경로는
 * `artifacts/runs/<32자리 잡 ID>/screenshots/a.png`처럼 잡 ID가 경로의 절반을 차지해, 그대로
 * 적으면 줄을 넘겨 패널 밖으로 밀려났다. 잡 ID까지는 같은 실행 안에서 모두 같으니 접두를
 * 떼고 그 뒤만 보인다. 뗄 접두가 없으면 경로를 그대로 돌려준다.
 */
export function cypressArtifactLabel(path: string): string {
  const match = /^artifacts\/runs\/[^/]+\/(.+)$/.exec(cleanPathInput(path));
  return match ? match[1] : path;
}
