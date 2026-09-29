/**
 * 공용 스킬 내용이 바뀐 것을 감지해 검토 제안의 재료로 쌓아 두는 상태.
 *
 * 제안 평가(`aiaSuggestions`)는 여기서 쌓인 변경 목록을 읽기만 하고, 기준선을 잡고
 * 만료를 걷어내는 일은 이 모듈이 맡는다.
 */
import { DAY, parsePersisted, requiredNumbers, requiredString, stringRecord, validatedList } from "./aiaPrimitives.ts";

/** 변경 감지 입력. 백엔드 `get_common_skill_digests` 응답 그대로다. */
export interface AiaSkillDigest {
  key: string;
  name: string;
  contentDigest: string;
}

/** 아직 검토를 제안하지 않은(또는 사용자가 아직 내리지 않은) 스킬 내용 변경 한 건. */
export interface AiaSkillChange {
  key: string;
  name: string;
  previousDigest: string;
  digest: string;
  detectedAt: number;
}

export interface AiaSkillChangeState {
  schemaVersion: 1;
  /** 마지막으로 관찰한 스킬별 내용 지문. 다음 변경 판정의 기준선이다. */
  digests: Record<string, string>;
  changes: AiaSkillChange[];
}

const SCHEMA_VERSION = 1;

/**
 * 저장 상태 하나를 짓는 자리. 빈 상태·되읽기·직렬화·관측 갱신·내리기 다섯 곳이 각자
 * `schemaVersion`과 두 칸을 열거하고 있었다. 칸을 하나 더할 때 그중 한 곳을 빠뜨려도
 * 형식 오류가 나지 않는다 — 그 경로를 지난 상태만 새 칸을 잃고, 다음 직렬화가 그 손실을
 * 저장본에 굳힌다. 칸 목록이 적힌 자리를 여기 하나로 되돌린다.
 *
 * 저장 JSON의 키 순서도 이 순서를 따른다.
 */
function skillChangeState(digests: Record<string, string>, changes: AiaSkillChange[]): AiaSkillChangeState {
  return { schemaVersion: SCHEMA_VERSION, digests, changes };
}

export function emptyAiaSkillChangeState(): AiaSkillChangeState {
  return skillChangeState({}, []);
}

/**
 * 저장본의 변경 한 건을 읽는다. 필수 칸(키·지문·감지 시각)이 하나라도 없으면 그 항목을
 * 버린다 — 이름과 이전 지문은 없어도 제안 문구와 검토 범위를 기본값으로 메울 수 있지만,
 * 나머지 셋이 없으면 어떤 스킬의 어느 변경인지 가리킬 수 없다.
 */
function readSkillChange(entry: Record<string, unknown>): AiaSkillChange | null {
  const numbers = requiredNumbers(entry, ["detectedAt"]);
  const key = requiredString(entry.key);
  const digest = requiredString(entry.digest);
  if (numbers === null || key === null || digest === null) return null;
  return {
    key,
    name: requiredString(entry.name) ?? key,
    previousDigest: typeof entry.previousDigest === "string" ? entry.previousDigest : "",
    digest,
    detectedAt: numbers.detectedAt,
  };
}

export function parseAiaSkillChangeState(value: string | null | undefined): AiaSkillChangeState {
  return parsePersisted(value, emptyAiaSkillChangeState, SCHEMA_VERSION, (parsed) => skillChangeState(
    stringRecord(parsed.digests),
    validatedList<AiaSkillChange>(parsed.changes, readSkillChange),
  ));
}

/** 스킬 키 사전순. 저장 정본은 지문 맵과 변경 목록을 모두 이 순서로 적는다. */
function bySkillKey(left: string, right: string): number {
  return left.localeCompare(right);
}

export function serializeAiaSkillChangeState(state: AiaSkillChangeState): string {
  return JSON.stringify(skillChangeState(
    Object.fromEntries(Object.entries(state.digests).sort(([left], [right]) => bySkillKey(left, right))),
    [...state.changes].sort((left, right) => bySkillKey(left.key, right.key)),
  ));
}

/**
 * 스킬 내용 지문을 기준선과 비교해 즉시 트리거용 변경 목록을 갱신한다.
 *
 * 처음 본 스킬은 기준선만 잡아 첫 실행에 모든 스킬이 변경으로 뜨는 일을 막는다.
 * 같은 스킬이 연달아 바뀌면 처음 변경 이전 지문을 유지해 검토 범위가 끊기지
 * 않게 하고, 사라진 스킬과 만료된 변경은 목록에서 내린다.
 */
export function observeAiaSkillChanges(
  state: AiaSkillChangeState,
  digests: AiaSkillDigest[],
  now: number,
  expiresMs = DAY,
): AiaSkillChangeState {
  const pending = new Map(state.changes.map((change) => [change.key, change]));
  const nextDigests: Record<string, string> = {};
  const changes: AiaSkillChange[] = [];
  for (const item of digests) {
    if (!item?.key || !item.contentDigest) continue;
    nextDigests[item.key] = item.contentDigest;
    const previous = state.digests[item.key];
    if (previous === undefined) continue;
    const change = observedSkillChange(item, previous, pending.get(item.key), now, expiresMs);
    if (change) changes.push(change);
  }
  changes.sort((left, right) => right.detectedAt - left.detectedAt || bySkillKey(left.key, right.key));
  return skillChangeState(nextDigests, changes);
}

/**
 * 기준선이 있는 관측 한 건을 유지할 변경 또는 새 변경으로 옮긴다. 기준선 수집 순회와
 * 변경 상태 전이를 분리해, 만료·연속 변경 규칙을 고칠 때 순회의 건너뛰기 조건까지
 * 함께 건드리지 않게 한다.
 */
function observedSkillChange(
  item: AiaSkillDigest,
  previous: string,
  carried: AiaSkillChange | undefined,
  now: number,
  expiresMs: number,
): AiaSkillChange | null {
  if (previous === item.contentDigest) {
    if (!carried || carried.digest !== item.contentDigest || now - carried.detectedAt > expiresMs) return null;
    return { ...carried, name: item.name || carried.name };
  }
  return {
    key: item.key,
    name: item.name || item.key,
    previousDigest: carried?.previousDigest || previous,
    digest: item.contentDigest,
    detectedAt: now,
  };
}

/** 사용자가 제안을 내렸을 때. 기준선은 유지해 같은 변경으로 다시 뜨지 않게 한다. */
export function clearAiaSkillChange(state: AiaSkillChangeState, key: string): AiaSkillChangeState {
  if (!state.changes.some((change) => change.key === key)) return state;
  return skillChangeState(
    { ...state.digests },
    state.changes.filter((change) => change.key !== key),
  );
}
