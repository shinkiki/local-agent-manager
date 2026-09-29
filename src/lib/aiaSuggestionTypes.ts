/**
 * AIA 제안 카탈로그·제안·평가 입출력의 타입 선언.
 *
 * 이 선언들은 평가 본문(`aiaSuggestions.ts`)에 함께 있었고, 규칙 평가
 * (`aiaSuggestionRules.ts`)와 프로젝트 정리(`aiaProjectCleanup.ts`)는 그 파일에서
 * 타입만 되가져왔다. 평가 본문이 두 모듈을 런타임으로 불러 쓰므로 모듈 참조가
 * 양방향으로 걸렸고(타입만 오가니 런타임 순환은 없었지만), 종류가 하나 늘 때
 * "선언은 위쪽 파일, 구현은 아래쪽 파일"을 오가며 고쳐야 했다.
 *
 * 선언만 여기로 내려 참조를 한 방향으로 돌린다 — 구현 세 모듈이 모두 이 파일을
 * 바라보고, 이 파일은 아무 구현도 바라보지 않는다. 기존 호출부는 그대로
 * `aiaSuggestions.ts`에서 가져다 쓴다(그쪽이 이 선언들을 다시 내보낸다).
 */
import type {
  AccountSnapshot,
  ChatAttentionSnapshot,
  ManagerSnapshot,
  SchedulerSnapshot,
  SystemAutomationSnapshot,
} from "../types";
import type { SuggestionMetadata } from "./aiaSuggestionOrder.ts";
import type { AiaSkillChange } from "./aiaSkillChanges.ts";
import type { AiaSuggestionHistory } from "./aiaSuggestionHistory.ts";

export type AiaSuggestionKind =
  | "providerCliMissing"
  | "accountAuthError"
  /** 폐기된 종류. 이미 배포된 팩이 담고 있어도 제안으로 만들지 않는다. */
  | "accountUsageThreshold"
  | "accountAutoSwitchMissing"
  | "schedulerPaused"
  | "scheduleRunFailed"
  | "translationFailed"
  | "projectSessionCleanup"
  | "interruptedSessionReminder"
  | "skillContentChanged"
  | "featureTip";

export interface AiaSuggestionDefinition {
  id: string;
  kind: AiaSuggestionKind;
  enabled: boolean;
  severity: string;
  priority: number;
  titleTemplate: string;
  detailTemplate: string;
  promptTemplate: string;
  parameters?: Record<string, unknown>;
  rearm?: Record<string, unknown>;
}

export interface AiaSuggestionPack {
  schemaVersion?: number;
  packId: string;
  version?: string;
  displayName: string;
  source?: string;
  skillKey?: string | null;
  suggestions: AiaSuggestionDefinition[];
}

export type AiaSuggestionPackSource = "bundled" | "commonSkill" | "lastKnownGood" | string;

export interface AiaSuggestionEffectivePack {
  source: AiaSuggestionPackSource;
  skillKey: string | null;
  pack: AiaSuggestionPack;
}

export interface AiaSuggestionCatalogIssue {
  skillKey: string;
  message: string;
  usingLastKnownGood: boolean;
}

export interface AiaSuggestionCatalogDefinition {
  packId: string;
  packDisplayName: string;
  skillKey: string | null;
  definition: AiaSuggestionDefinition;
}

export interface AiaSuggestionBundledSkillTemplate {
  key: string;
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
  installed: boolean;
}

export interface AiaSuggestionCatalog {
  contentDigest: string;
  packs: AiaSuggestionEffectivePack[];
  definitions: AiaSuggestionCatalogDefinition[];
  issues: AiaSuggestionCatalogIssue[];
  bundledSkill: AiaSuggestionBundledSkillTemplate;
  /** 테스트·이전 호출자가 쓰던 콘텐츠 지문 별칭. */
  fingerprint?: string;
}

export interface AiaSuggestionFlatCatalog {
  packs: AiaSuggestionPack[];
  fingerprint?: string;
}

export interface AiaSuggestion {
  id: string;
  definitionId: string;
  fingerprint: string;
  kind: AiaSuggestionKind;
  severity: string;
  priority: number;
  title: string;
  detail: string;
  prompt: string;
  packId: string;
  packDisplayName: string;
  source: string;
  skillKey: string | null;
  targetId: string;
  stateKey: string;
  metadata: SuggestionMetadata;
}

export interface AiaSuggestionEvaluationInput {
  catalog: AiaSuggestionCatalog | AiaSuggestionFlatCatalog | AiaSuggestionPack[];
  manager: ManagerSnapshot;
  accounts: AccountSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  automation: SystemAutomationSnapshot | null;
  attention: ChatAttentionSnapshot;
  now: number;
  history?: AiaSuggestionHistory | null;
  /** 감지된 스킬 내용 변경. 즉시 트리거는 이 목록만 보고 검토 제안을 만든다. */
  skillChanges?: AiaSkillChange[] | null;
}

export interface AiaSuggestionEvaluation {
  suggestions: AiaSuggestion[];
  allCandidates: AiaSuggestion[];
  history: AiaSuggestionHistory;
}

