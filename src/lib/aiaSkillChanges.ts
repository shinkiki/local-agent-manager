/**
 * 공용 스킬 내용이 바뀐 것을 감지해 검토 제안의 재료로 쌓아 두는 상태.
 *
 * 제안 평가(`aiaSuggestions`)는 여기서 쌓인 변경 목록을 읽기만 하고, 기준선을 잡고
 * 만료를 걷어내는 일은 이 모듈이 맡는다.
 */
import { DAY, finiteNumber, parsePersisted, stringRecord, validatedList } from "./aiaPrimitives.ts";

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

export function emptyAiaSkillChangeState(): AiaSkillChangeState {
  return { schemaVersion: 1, digests: {}, changes: [] };
}

export function parseAiaSkillChangeState(value: string | null | undefined): AiaSkillChangeState {
  return parsePersisted(value, emptyAiaSkillChangeState, 1, (parsed) => ({
    schemaVersion: 1,
    digests: stringRecord(parsed.digests),
    changes: validatedList<AiaSkillChange>(parsed.changes, (entry) => {
      const detectedAt = finiteNumber(entry.detectedAt);
      if (detectedAt === null) return null;
      if (typeof entry.key !== "string" || !entry.key) return null;
      if (typeof entry.digest !== "string" || !entry.digest) return null;
      return {
        key: entry.key,
        name: typeof entry.name === "string" && entry.name ? entry.name : entry.key,
        previousDigest: typeof entry.previousDigest === "string" ? entry.previousDigest : "",
        digest: entry.digest,
        detectedAt,
      };
    }),
  }));
}

export function serializeAiaSkillChangeState(state: AiaSkillChangeState): string {
  return JSON.stringify({
    schemaVersion: 1,
    digests: Object.fromEntries(Object.entries(state.digests).sort(([left], [right]) => left.localeCompare(right))),
    changes: [...state.changes].sort((left, right) => left.key.localeCompare(right.key)),
  });
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
    const carried = pending.get(item.key);
    if (previous === item.contentDigest) {
      if (carried && carried.digest === item.contentDigest && now - carried.detectedAt <= expiresMs) {
        changes.push({ ...carried, name: item.name || carried.name });
      }
      continue;
    }
    changes.push({
      key: item.key,
      name: item.name || item.key,
      previousDigest: carried?.previousDigest || previous,
      digest: item.contentDigest,
      detectedAt: now,
    });
  }
  changes.sort((left, right) => right.detectedAt - left.detectedAt || left.key.localeCompare(right.key));
  return { schemaVersion: 1, digests: nextDigests, changes };
}

/** 사용자가 제안을 내렸을 때. 기준선은 유지해 같은 변경으로 다시 뜨지 않게 한다. */
export function clearAiaSkillChange(state: AiaSkillChangeState, key: string): AiaSkillChangeState {
  if (!state.changes.some((change) => change.key === key)) return state;
  return {
    schemaVersion: 1,
    digests: { ...state.digests },
    changes: state.changes.filter((change) => change.key !== key),
  };
}
