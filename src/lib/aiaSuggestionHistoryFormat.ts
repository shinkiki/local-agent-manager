/**
 * 제안 숨김 기록의 저장 형식 — 이력이 어떤 칸으로 이루어지고, 그 칸들이 저장 문자열과
 * 메모리 사이를 어떻게 오가는가(빈 이력·되읽기·직렬화·복제).
 *
 * 이 형식은 `aiaSuggestionHistory.ts`에 숨김 정책(무엇을 어느 갈래로 보고, 언제 다시
 * 보여주는가)과 함께 있었다. 두 관심사는 자라는 축이 다르다 — 칸은 저장 형식을 바꿀 때만
 * 늘고, 갈래와 재무장 조건은 제안 종류가 늘 때마다 손본다. 한 파일에 있는 동안 칸 하나를
 * 더하려면 갈래별 재무장 규칙 백여 줄을 지나쳐 읽어야 했고, 반대로 재무장 조건 한 줄을
 * 고치려 해도 슬롯 표와 되읽기 검증 사이에서 그 자리를 찾아야 했다.
 *
 * 의존 방향은 한쪽뿐이다 — 이 모듈은 갈래도 재무장도 모르고, 정책 쪽이 여기서 이력의
 * 모양과 복제를 가져다 쓴다. 기존 호출부가 경로를 바꾸지 않도록 정책 모듈이 이 선언들을
 * 그대로 다시 내보낸다.
 */
import {
  numericRecord,
  parsePersisted,
  requiredNumbers,
  uniqueStrings,
  validatedRecord,
} from "./aiaPrimitives.ts";

export interface ProjectDismissal {
  dismissedAt: number;
  unfiledBaseline: number;
  rearmDelta: number;
  resolved: boolean;
}

export interface IncidentDismissal {
  dismissedAt: number;
  resolved: boolean;
  afterResolved: boolean;
  cooldownMinutes: number;
}

export interface AiaSuggestionHistory {
  schemaVersion: 1;
  dismissed: Record<string, number>;
  incidentDismissals: Record<string, IncidentDismissal>;
  projectDismissals: Record<string, ProjectDismissal>;
  featureTips: string[];
}

/** 이력이 담는 저장 슬롯들. 스키마 판은 슬롯이 아니라 저장 형식 자체의 것이라 뺀다. */
type HistorySlots = Omit<AiaSuggestionHistory, "schemaVersion">;

/**
 * 슬롯 하나가 스스로 아는 것 — 빈 값은 무엇이고, 저장본에서 어떻게 되읽고, 저장할 때
 * 어떤 모양으로 적고, 복제할 때 어떻게 새로 뜨는가.
 *
 * 네 가지가 슬롯마다 흩어져, 빈 이력·되읽기·직렬화·복제 네 함수가 같은 네 줄을 각자
 * 열거하고 있었다. 슬롯을 하나 더할 때 그중 복제를 빠뜨려도 형식 오류가 나지 않는다 —
 * 복제본이 원본과 항목을 공유해, 숨김 판정(`isSuggestionVisible`)과 정리
 * (`resolveStaleDismissals`)가 항목을 그 자리에서 고치는 순간 부르는 쪽의 이력까지
 * 함께 바뀐다. 갈래를 한 줄로 모은 `DISMISSAL_RULES`와 같은 이유로 여기도 한 줄로 둔다.
 */
interface HistorySlot<T> {
  empty(): T;
  parse(value: unknown): T;
  /** 저장 문자열에 담을 모양. 뜻을 바꾸지 않는 차이(키 순서·중복)를 여기서 없앤다. */
  serialize(value: T): unknown;
  clone(value: T): T;
}

/** 항목이 객체인 숨김 레코드 슬롯. 저장은 있는 그대로 하고, 복제는 항목까지 새로 뜬다. */
function dismissalSlot<T extends object>(
  read: (entry: Record<string, unknown>) => T | null,
): HistorySlot<Record<string, T>> {
  return {
    empty: () => ({}),
    parse: (value) => validatedRecord<T>(value, read),
    serialize: (value) => value,
    clone: clonedEntries,
  };
}

function readIncidentDismissal(entry: Record<string, unknown>): IncidentDismissal | null {
  const numbers = requiredNumbers(entry, ["dismissedAt", "cooldownMinutes"]);
  if (numbers === null) return null;
  return {
    dismissedAt: numbers.dismissedAt,
    resolved: entry.resolved === true,
    afterResolved: entry.afterResolved === true,
    cooldownMinutes: Math.max(0, numbers.cooldownMinutes),
  };
}

function readProjectDismissal(entry: Record<string, unknown>): ProjectDismissal | null {
  const numbers = requiredNumbers(entry, ["dismissedAt", "unfiledBaseline", "rearmDelta"]);
  if (numbers === null) return null;
  return {
    dismissedAt: numbers.dismissedAt,
    unfiledBaseline: numbers.unfiledBaseline,
    rearmDelta: Math.max(1, numbers.rearmDelta),
    resolved: entry.resolved === true,
  };
}

/**
 * 슬롯 한 벌. 매핑 타입이 양쪽을 다 막는다 — 이력에 칸을 더하면 여기 줄이 없어 컴파일이
 * 멈추고, 이력에 없는 칸을 여기 적어도 멈춘다.
 */
const HISTORY_SLOTS: { [Key in keyof HistorySlots]: HistorySlot<HistorySlots[Key]> } = {
  dismissed: {
    empty: () => ({}),
    parse: numericRecord,
    serialize: numericRecord,
    clone: (value) => ({ ...value }),
  },
  incidentDismissals: dismissalSlot<IncidentDismissal>(readIncidentDismissal),
  projectDismissals: dismissalSlot<ProjectDismissal>(readProjectDismissal),
  featureTips: {
    empty: () => [],
    parse: uniqueStrings,
    serialize: (value) => [...new Set(value)].sort(),
    clone: (value) => [...value],
  },
};

/** 표에 선 순서 그대로. 저장 JSON의 키 순서도 이 순서를 따른다. */
const HISTORY_SLOT_KEYS = Object.keys(HISTORY_SLOTS) as Array<keyof HistorySlots>;

/**
 * 슬롯을 칸의 타입에서 풀어 낸 모양. 표가 칸마다 타입을 이미 맞춰 두었고, 순회하는 쪽은
 * 어느 칸의 값인지 모른 채 같은 슬롯에서 꺼낸 값을 그 슬롯에 도로 넘길 뿐이다.
 */
function historySlot(key: keyof HistorySlots): HistorySlot<unknown> {
  return HISTORY_SLOTS[key] as HistorySlot<unknown>;
}

/**
 * 슬롯마다 값을 얻어 이력 하나를 짓는다. 빈 이력·되읽기·복제가 이 한 벌을 지나므로
 * 슬롯 목록이 적힌 자리는 표 하나뿐이다.
 */
function buildHistory(read: (slot: HistorySlot<unknown>, key: keyof HistorySlots) => unknown): AiaSuggestionHistory {
  const slots: Record<string, unknown> = {};
  for (const key of HISTORY_SLOT_KEYS) slots[key] = read(historySlot(key), key);
  return { schemaVersion: 1, ...(slots as HistorySlots) };
}

export function emptyAiaSuggestionHistory(): AiaSuggestionHistory {
  return buildHistory((slot) => slot.empty());
}

export function parseAiaSuggestionHistory(value: string | null | undefined): AiaSuggestionHistory {
  return parsePersisted(value, emptyAiaSuggestionHistory, 1, (parsed) => (
    buildHistory((slot, key) => slot.parse(parsed[key]))
  ));
}

export function serializeAiaSuggestionHistory(history: AiaSuggestionHistory): string {
  const stored: Record<string, unknown> = { schemaVersion: 1 };
  for (const key of HISTORY_SLOT_KEYS) stored[key] = historySlot(key).serialize(history[key]);
  return JSON.stringify(stored);
}

export function cloneAiaSuggestionHistory(history: AiaSuggestionHistory): AiaSuggestionHistory {
  return buildHistory((slot, key) => slot.clone(history[key]));
}

/**
 * 항목까지 새로 뜬 레코드 복제. 숨김 판정(`isSuggestionVisible`)과 정리
 * (`resolveStaleDismissals`)가 항목을 그 자리에서 고치므로, 복제가 항목을 공유하면
 * 원본 이력까지 함께 바뀐다. 저장된 이력이 없을 수 있는 자리도 있어 빈 레코드로 받는다.
 */
function clonedEntries<T extends object>(record: Record<string, T> | undefined): Record<string, T> {
  const cloned: Record<string, T> = {};
  for (const [key, value] of Object.entries(record ?? {})) cloned[key] = { ...value };
  return cloned;
}
