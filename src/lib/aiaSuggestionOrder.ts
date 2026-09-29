/**
 * 제안이 실어 나르는 메타데이터와, 제안 목록의 정렬 키.
 *
 * 이 둘은 `aiaPrimitives.ts`에 함께 있었다. 그 파일은 "AIA 모듈이 함께 쓰는 밑돌"을
 * 담는 자리인데, 실제로 담긴 것은 성격이 다른 두 벌이었다 — 저장 문자열을 상태로
 * 되돌리는 검증 도우미(어느 기능에도 매이지 않는다)와, 제안이라는 한 기능의 값
 * 모양·정렬 규칙이다.
 *
 * 섞여 있는 동안 저장 되읽기만 필요한 모듈(`aiaEventBudget.ts`·`aiaSkillChanges.ts`)이
 * 제안 도메인의 타입까지 함께 든 파일을 바라봤다. 밑돌이 한 기능을 알면 그 기능의 값이
 * 늘 때마다 밑돌이 자라고, 밑돌을 읽는 모든 모듈이 그 자람을 함께 진다. 제안의 것은
 * 제안을 아는 모듈만 보도록 여기로 옮긴다.
 *
 * 반대 방향(이 모듈 → 밑돌)만 남는다. 여기서는 숫자 검증 하나만 밑돌에서 가져온다.
 */
import { finiteNumber } from "./aiaPrimitives.ts";

/**
 * 제안 하나가 실어 나르는 메타데이터의 값. 문구 치환에 그대로 쓰이고 정렬·재무장 판정이
 * 숫자로 되읽는 자리라 원시값만 담는다.
 *
 * 같은 유니온이 제안 선언(`aiaSuggestionTypes`)·숨김 판정이 보는 최소 모양
 * (`aiaSuggestionHistory`)·문구 조립 입력(`aiaSuggestionTemplate`) 세 곳에 손으로 다시
 * 적혀 있었다. 세 자리는 같은 값 하나를 가리키는데도 각자 적혀 있어, 담을 수 있는 값을
 * 넓히려면 세 곳을 함께 고쳐야 했고 한 곳을 빠뜨리면 조립은 받아 주는 값이 제안 선언에서
 * 막히는 쪽으로 어긋난다. 이름을 하나 두고 셋이 그것을 본다.
 */
export type SuggestionMetadataValue = string | number | boolean | null;

export type SuggestionMetadata = Record<string, SuggestionMetadataValue>;

/**
 * 메타데이터의 숫자 항목. 숫자가 아니거나 없으면 기본값이다.
 *
 * 숨김 기록 모듈이 이 읽기를 갖고 있어, 정렬 기준을 읽을 뿐인 규칙 모듈과 프로젝트 정리
 * 모듈까지 숨김 판정 모듈을 가져와야 했다. 메타데이터를 숫자로 읽는 일은 숨김과 무관하게
 * 제안을 다루는 모든 자리의 일이므로 정렬 키와 함께 둔다.
 */
export function numberMetadata(carrier: { metadata: SuggestionMetadata }, key: string, fallback: number): number {
  return finiteNumber(carrier.metadata[key]) ?? fallback;
}

/**
 * 제안 정렬이 보는 최소 모양. 정렬 키는 우선순위·id·메타데이터 숫자 항목까지만 읽으므로
 * 제안 선언 전체를 가져오지 않는다(그러면 이 모듈이 선언 모듈을 바라보게 된다).
 */
export interface SuggestionOrderSubject {
  priority: number;
  id: string;
  metadata: SuggestionMetadata;
}

/** 정렬 키 하나. 0은 "이 키로는 갈리지 않는다"는 뜻이고, 다음 키로 넘어간다. */
export type SuggestionOrderKey = (left: SuggestionOrderSubject, right: SuggestionOrderSubject) => number;

/**
 * 키를 앞에서부터 견주고 처음 갈리는 키의 결과를 쓴다.
 *
 * 제안 비교자 셋이 `||`로 이어 붙인 뺄셈 사슬로 적혀 있었고, 그 사슬의 끝 두 칸(우선순위
 * 내림차순 · id 사전순)은 셋 모두에서 같은 문장이었다. 뼈대를 가진 자리는 하나였지만
 * 종류별 비교자는 그 뼈대를 대신하느라 두 칸을 손으로 다시 적었다 — 뼈대의 마지막 갈림을
 * 바꾸면 종류별 비교자는 옛 갈림을 그대로 쥔 채 남고, 둘 다 숫자를 돌려주므로 형식
 * 오류가 나지 않는다. 같은 우선순위끼리의 순서만 종류에 따라 조용히 달라진다.
 *
 * 키를 값으로 두면 비교자가 "무엇을 어떤 차례로 보는가"의 선언이 되고, 공유하는 칸은
 * 이름 하나로 한 번만 존재한다.
 */
export function orderSuggestionsBy(...keys: SuggestionOrderKey[]): SuggestionOrderKey {
  return (left, right) => {
    for (const key of keys) {
      const ordering = key(left, right);
      if (ordering !== 0) return ordering;
    }
    return 0;
  };
}

/** 우선순위가 높은 것부터. */
export const bySuggestionPriority: SuggestionOrderKey = (left, right) => right.priority - left.priority;

/** 마지막 갈림. 같은 목록이 늘 같은 순서로 서도록 id 사전순으로 닫는다. */
export const bySuggestionId: SuggestionOrderKey = (left, right) => left.id.localeCompare(right.id);

/** 메타데이터 숫자 항목이 큰 것부터. 없는 항목은 0으로 본다. */
export function byNumberMetadataDesc(key: string): SuggestionOrderKey {
  return (left, right) => numberMetadata(right, key, 0) - numberMetadata(left, key, 0);
}
