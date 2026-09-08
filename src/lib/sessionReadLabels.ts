import type {
  ProviderId,
  SessionManagementStatus,
  SessionReadDetail,
  SessionReadOrigin,
  SessionReadPolicy,
  SessionReadProjectScope,
} from "../types";
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

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
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

/**
 * 저장 전과 목록·상세·입력창 칩에서 보여 주는 한 줄 요약.
 * 예: `전체 등록 프로젝트 · Codex/Claude · 지난주 · 작업 근거 · 최대 100개`
 */
export function describeSessionReadPolicy(policy: SessionReadPolicy): string {
  if (!policy.enabled) return "세션 참조 사용 안 함";
  const parts = [
    projectScopeLabel(policy),
    providerLabel(policy.providers ?? []),
    sessionReadPeriodLabel(policy.period),
    sessionReadDetailLabel(policy.detail),
    `최대 ${policy.maxSessions}개`,
  ];
  const statuses = policy.statuses ?? [];
  if (statuses.length > 0) parts.push(`${statuses.map(sessionStatusLabel).join("·")}만`);
  if (policy.includeLinkedFiles) parts.push("연결 파일 포함");
  if (policy.redaction === "strict") parts.push("민감정보 강력 제거");
  return parts.join(" · ");
}

function projectScopeLabel(policy: SessionReadPolicy): string {
  if (policy.projectScope === "selected") return `선택 프로젝트 ${(policy.projects ?? []).length}개`;
  return PROJECT_SCOPE_LABELS[policy.projectScope];
}

function providerLabel(providers: ProviderId[]): string {
  if (providers.length === 0) return "전체 공급자";
  return providers.map(sessionReadProviderLabel).join("/");
}

export function sessionReadProviderLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
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
