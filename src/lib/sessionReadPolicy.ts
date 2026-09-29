import type {
  SessionReadOrigin,
  SessionReadPolicy,
  SessionReadSettings,
} from "../types";
import { uniqueInOrder } from "./sequence.ts";
import { clampSessionReadCounts, defaultSessionReadCounts } from "./sessionReadLimits.ts";
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
  SESSION_READ_PERIOD_INVERTED_TEXT,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
  sessionReadPeriodInverted,
  sessionReadRecentDaysField,
  type SessionReadRecentDaysField,
} from "./sessionReadPeriod.ts";
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
    ...defaultSessionReadCounts(),
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

/**
 * 두 정책이 같은 값인지. 표에 적은 값을 하나씩 견주고, 다른 값이 처음 나오면 거기서 끝낸다.
 *
 * 양쪽을 통째로 JSON 문자열로 만들어 그 문자열을 견주고 있었다. 직렬화는 비교가 부탁한
 * 일이 아니라 비교를 대신 시키려고 거쳐 가던 자리라, 그 우회가 규칙을 두 군데로 흘렸다 —
 * 표가 값 사본을 만들어야 했고(배열을 그 자리에서 펴 두지 않으면 문자열이 달라질 여지를
 * 남긴다), 값의 뜻이 아니라 `JSON.stringify`가 무엇을 어떻게 적는지가 판정을 정했다.
 * 예컨대 `undefined`는 배열 자리에서 `null`로 적히므로 "값이 없다"와 "값이 null이다"가
 * 같은 글자가 되는데, 그것이 이 비교가 고른 규칙인지 직렬화가 고른 규칙인지 식만 보고는
 * 갈리지 않았다. 값끼리 견주면 표에 적은 것이 그대로 판정이고, 사본도 필요 없다.
 */
export function sameSessionReadPolicy(left: SessionReadPolicy, right: SessionReadPolicy): boolean {
  return Object.values(COMPARE_PROJECTIONS)
    .every((project) => sameProjectedValue(project(left), project(right)));
}

/**
 * 표가 내놓는 값은 스칼라 아니면 스칼라 목록 둘 중 하나다. 목록은 길이와 자리별 값으로
 * 보므로 고른 순서가 판정의 일부로 남는다 — 프로젝트·공급자·상태는 사용자가 고른 순서가
 * 그대로 저장되고 요약 문구에도 그 순서로 실리기 때문에, 순서가 다르면 다른 정책이다.
 */
function sameProjectedValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]));
  }
  return Object.is(left, right);
}

/**
 * 비교할 때 값 하나를 무엇으로 펴는지. 정책의 키를 모두 요구하는 표라, 정책에 값이 하나
 * 늘면 여기서 컴파일이 멈춘다.
 *
 * 값 목록을 손으로 적은 배열로 두던 동안에는 정책에 값을 하나 더해도 이 배열이 그대로
 * 통과했고, 그러면 그 값만 비교에서 빠진 채 조용히 돈다 — 사용자가 새 값만 바꾼 정책이
 * 추천값과 같다고 판정돼 `AIA 추천` 표시가 그대로 남는다. 저장 전 다듬기(`clamp`)는
 * 손댈 값만 적으면 되니 이 강제가 필요 없지만, 비교는 빠진 값이 곧 틀린 답이다.
 *
 * 값을 펴기만 하고 사본은 만들지 않는다. 비교는 받은 값을 읽기만 하므로 사본이 판정에
 * 더하는 것이 없고, 저장본 목록이 빈 배열로 떨어지는 자리(`?? []`)만 남기면 된다.
 */
const COMPARE_PROJECTIONS: {
  [Key in keyof SessionReadPolicy]: (policy: SessionReadPolicy) => unknown;
} = {
  enabled: (policy) => policy.enabled,
  projectScope: (policy) => policy.projectScope,
  projects: (policy) => policy.projects ?? [],
  providers: (policy) => policy.providers ?? [],
  period: (policy) => sessionReadPeriodKey(policy.period),
  statuses: (policy) => policy.statuses ?? [],
  detail: (policy) => policy.detail,
  maxSessions: (policy) => policy.maxSessions,
  maxTurnsPerSession: (policy) => policy.maxTurnsPerSession,
  pageSize: (policy) => policy.pageSize,
  includeLinkedFiles: (policy) => policy.includeLinkedFiles,
  redaction: (policy) => policy.redaction,
};

/** 저장 전에 상한을 맞춘다. 서버가 다시 강제하지만, 화면이 넘는 값을 보여 주지 않는다. */
export function clampSessionReadPolicy(policy: SessionReadPolicy): SessionReadPolicy {
  return {
    ...policy,
    ...clampSessionReadCounts(policy),
    projects: policy.projectScope === "selected" ? uniqueInOrder(policy.projects ?? []) : [],
    providers: uniqueInOrder(policy.providers ?? []),
    statuses: uniqueInOrder(policy.statuses ?? []),
    period: clampSessionReadPeriod(policy.period),
  };
}
