import type {
  ProviderId,
  SessionManagementStatus,
  SessionReadDetail,
  SessionReadOrigin,
  SessionReadPolicy,
  SessionReadProjectScope,
} from "../types";
import { sourceName } from "./format.ts";
import { joinSummary } from "./sequence.ts";
import { sessionReadPeriodLabel } from "./sessionReadPeriod.ts";

/**
 * 세션 참조 정책을 사람이 읽는 문구로 바꾸는 규칙. 요약 한 줄은 Rust
 * `session_context::describe_policy`와 같은 규칙을 쓰고, `sessionReadSummaryCases.json`을
 * 양쪽 테스트가 함께 읽어 검증한다.
 */

/**
 * 열거값 하나에 문구 하나를 대응시키는 표. 폴백이 붙은 삼항으로 적으면 열거형에 값이 늘어도
 * 컴파일이 통과해 새 값이 조용히 마지막 문구를 빌려 쓴다. `Record<열거형, string>`은 빠진
 * 키를 컴파일 오류로 세워, 값을 늘린 자리에서 문구도 함께 정하게 만든다.
 */
const PROJECT_SCOPE_LABELS: Record<SessionReadProjectScope, string> = {
  scheduleCwd: "일정 작업 경로",
  selected: "선택 프로젝트",
  allRegistered: "전체 등록 프로젝트",
};

const DETAIL_LABELS: Record<SessionReadDetail, string> = {
  summary: "요약",
  workRationale: "작업 근거",
  limitedTranscript: "제한된 원문",
};

const ORIGIN_LABELS: Record<SessionReadOrigin, string> = {
  aia: "AIA 추천",
  manual: "수동 설정",
};

const STATUS_LABELS: Record<SessionManagementStatus, string> = {
  ready: "입력 대기",
  running: "실행 중",
  waitingApproval: "승인 대기",
  completed: "완료",
  failed: "실패",
  interrupted: "중단",
  stopped: "종료",
  archived: "보관",
  unavailable: "확인 불가",
};

/** 상태 목록이 주어졌을 때 '완료·실패만' 형태의 필터 라벨을 만든다. 없거나 비어 있으면 null이다. */
function statusFilterLabel(statuses: readonly SessionManagementStatus[] | undefined): string | null {
  if (!statuses || statuses.length === 0) return null;
  return `${statuses.map(sessionStatusLabel).join("·")}만`;
}

/**
 * 저장 전과 목록·상세·입력창 칩에서 보여 주는 한 줄 요약.
 * 예: `전체 등록 프로젝트 · Codex/Claude · 지난주 · 작업 근거 · 최대 100개`
 *
 * 기본 다섯 항목과 조건부 조각(상태 필터·연결 파일·민감정보 제거)을 단일 배열로 선언하고
 * 빈 조각은 `joinSummary`가 걷어낸다. 조건마다 `parts.push`를 부르던 동안에는 어떤 순서로
 * 조각이 붙는지 세로로 흩어져 읽기 어려웠다.
 */
export function describeSessionReadPolicy(policy: SessionReadPolicy): string {
  if (!policy.enabled) return "세션 참조 사용 안 함";
  return joinSummary([
    projectScopeLabel(policy),
    providerLabel(policy.providers ?? []),
    sessionReadPeriodLabel(policy.period),
    sessionReadDetailLabel(policy.detail),
    `최대 ${policy.maxSessions}개`,
    statusFilterLabel(policy.statuses),
    policy.includeLinkedFiles && "연결 파일 포함",
    policy.redaction === "strict" && "민감정보 강력 제거",
  ]);
}

function projectScopeLabel(policy: SessionReadPolicy): string {
  if (policy.projectScope === "selected") return `선택 프로젝트 ${(policy.projects ?? []).length}개`;
  return PROJECT_SCOPE_LABELS[policy.projectScope];
}

function providerLabel(providers: readonly ProviderId[]): string {
  if (providers.length === 0) return "전체 공급자";
  return providers.map(sessionReadProviderLabel).join("/");
}

/**
 * 공급자 표시 이름. 화면 어디서나 같은 이름으로 불러야 하므로 `format.ts`의 표 하나만 본다.
 *
 * 같은 세 줄짜리 표가 여기에도 따로 적혀 있었다. 표시 이름이 바뀌는 일은 드물지만 공급자가
 * 하나 늘면 두 표가 모두 컴파일을 멈추고, 그때 두 번째 표를 대충 메우면 세션 참조 요약만
 * 다른 이름을 쓰게 된다 — 대시보드가 좁은 칸 때문에 일부러 다른 짧은 이름을 두는 것과 달리,
 * 여기는 처음부터 정식 이름을 쓰던 자리라 표를 따로 둘 이유가 없다.
 */
export function sessionReadProviderLabel(provider: ProviderId): string {
  return sourceName(provider);
}

export function sessionReadDetailLabel(detail: SessionReadDetail): string {
  return DETAIL_LABELS[detail];
}

export function sessionStatusLabel(status: SessionManagementStatus): string {
  return STATUS_LABELS[status];
}

export function sessionReadOriginLabel(origin: SessionReadOrigin): string {
  return ORIGIN_LABELS[origin];
}
