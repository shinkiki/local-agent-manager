import type {
  SessionReadOrigin,
  SessionReadPolicy,
  SessionReadSettings,
} from "../types";
import { uniqueInOrder } from "./sequence.ts";
import { clampSessionReadCount, SESSION_READ_DEFAULTS } from "./sessionReadLimits.ts";
import { clampSessionReadPeriod, sessionReadPeriodKey } from "./sessionReadPeriod.ts";

/**
 * 세션 참조 정책 한 벌의 모양 — 기본값, 저장본 읽기, 출처 판정, 비교, 저장 전 다듬기.
 *
 * 화면과 테스트가 세션 참조를 다룰 때 무엇을 어디서 가져오는지 한 자리에서 정하려고, 문구
 * 표(`sessionReadLabels.ts`)와 기간 어휘(`sessionReadPeriod.ts`), 숫자 규칙
 * (`sessionReadLimits.ts`)을 여기서 다시 내보낸다. 넷이 한 파일에 있던 동안에는 문구를
 * 하나 고치러 들어와도 자르기 규칙과 선택지 표를 함께 스크롤해야 했다.
 */

export {
  SESSION_READ_LIMITS,
} from "./sessionReadLimits.ts";
export {
  SESSION_READ_PERIOD_CHOICES,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
} from "./sessionReadPeriod.ts";
export type { SessionReadPeriodChoice } from "./sessionReadPeriod.ts";
export {
  describeSessionReadPolicy,
  sessionReadDetailLabel,
  sessionReadOriginLabel,
  sessionReadProviderLabel,
  sessionStatusLabel,
} from "./sessionReadLabels.ts";

export function defaultSessionReadPolicy(): SessionReadPolicy {
  return {
    enabled: false,
    projectScope: "scheduleCwd",
    projects: [],
    providers: [],
    period: { kind: "reportPeriod" },
    statuses: [],
    detail: "summary",
    maxSessions: SESSION_READ_DEFAULTS.maxSessions,
    maxTurnsPerSession: SESSION_READ_DEFAULTS.maxTurnsPerSession,
    pageSize: SESSION_READ_DEFAULTS.pageSize,
    includeLinkedFiles: false,
    redaction: "credentials",
  };
}

/**
 * 서버가 준 설정을 편집 가능한 형태로 채운다. 세션 참조를 모르던 저장본(null)도 여기서
 * 비활성 기본값이 되어, 화면이 값 없음과 꺼짐을 따로 다루지 않는다.
 */
export function sessionReadSettingsOrDefault(
  settings: SessionReadSettings | null | undefined,
): SessionReadSettings {
  if (!settings) return { policy: defaultSessionReadPolicy(), origin: "manual", aiaRecommendation: null };
  return {
    policy: { ...defaultSessionReadPolicy(), ...settings.policy },
    origin: settings.origin ?? "manual",
    aiaRecommendation: settings.aiaRecommendation ?? null,
  };
}

/**
 * 편집한 정책의 출처. 서버가 최종 판정하지만, 저장 전에도 화면이 같은 규칙으로 보여 줘야
 * 사용자가 `AIA 추천값 다시 적용`의 결과를 미리 알 수 있다.
 */
export function sessionReadOriginFor(
  policy: SessionReadPolicy,
  recommendation: SessionReadPolicy | null | undefined,
): SessionReadOrigin {
  return recommendation && sameSessionReadPolicy(policy, recommendation) ? "aia" : "manual";
}

export function sameSessionReadPolicy(left: SessionReadPolicy, right: SessionReadPolicy): boolean {
  return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
}

/** 비교는 키 순서에 흔들리지 않아야 한다. 값 의미는 그대로 두고 순서만 고정한다. */
function normalizeForCompare(policy: SessionReadPolicy): unknown[] {
  return [
    policy.enabled,
    policy.projectScope,
    [...(policy.projects ?? [])],
    [...(policy.providers ?? [])],
    sessionReadPeriodKey(policy.period),
    [...(policy.statuses ?? [])],
    policy.detail,
    policy.maxSessions,
    policy.maxTurnsPerSession,
    policy.pageSize,
    policy.includeLinkedFiles,
    policy.redaction,
  ];
}

/** 저장 전에 상한을 맞춘다. 서버가 다시 강제하지만, 화면이 넘는 값을 보여 주지 않는다. */
export function clampSessionReadPolicy(policy: SessionReadPolicy): SessionReadPolicy {
  return {
    ...policy,
    maxSessions: clampSessionReadCount(policy.maxSessions, "maxSessions"),
    maxTurnsPerSession: clampSessionReadCount(policy.maxTurnsPerSession, "maxTurnsPerSession"),
    pageSize: clampSessionReadCount(policy.pageSize, "pageSize"),
    projects: policy.projectScope === "selected" ? uniqueInOrder(policy.projects ?? []) : [],
    providers: uniqueInOrder(policy.providers ?? []),
    statuses: uniqueInOrder(policy.statuses ?? []),
    period: clampSessionReadPeriod(policy.period),
  };
}
