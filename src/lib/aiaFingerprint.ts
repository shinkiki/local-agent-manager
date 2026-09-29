/**
 * 제안을 한 줄 문자열로 알아보는 지문.
 *
 * 지문은 세 자리가 함께 쓴다 — 제안을 조립할 때 `fingerprint` 필드로 박히고
 * (`aiaSuggestionTemplate.ts`), 숨김 기록이 프로젝트·사건·기능 소개 키를 만들 때 쓰이고
 * (`aiaSuggestionHistory.ts`), 런타임 분석 사건이 제안을 흉내 낼 때도 같은 규칙으로 만든다
 * (`appAiaSuggestions.ts`). 그런데 함수는 숨김 기록 모듈 안에 있어, 제안을 조립하기만 하는
 * 쪽이 지문 하나를 얻으려고 숨김 판정 모듈 전체를 가져와야 했다 — `numberMetadata`를 밑돌로
 * 내린 것과 같은 모양이라 여기도 갈라 둔다.
 *
 * 가른 자리가 여기인 것은 지문이 숨김을 모르기 때문이다. 이 모듈은 문자열 넷을 받아
 * 문자열 하나를 만들 뿐이고, 그 넷이 무엇을 뜻하는지는 부르는 쪽이 안다.
 */

/**
 * 제안을 숨김 기록에서 알아보는 지문. 팩·정의·대상·상태를 길이 접두사로 이어 붙여
 * 구분자 충돌을 없앤 뒤 두 방향으로 해싱한다. 제안의 `fingerprint` 필드와 프로젝트·사건
 * 숨김 키가 모두 이 함수 하나로 만들어진다.
 */
export function suggestionFingerprint(packId: string, definitionId: string, targetId: string, stateKey: string): string {
  const source = [packId, definitionId, targetId, stateKey].map(encodeFingerprintPart).join(":");
  return `aia1-${hash32(source)}${hash32([...source].reverse().join(""))}`;
}

function encodeFingerprintPart(value: string): string {
  return `${value.length}.${value}`;
}

function hash32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
