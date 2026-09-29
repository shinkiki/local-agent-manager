import type { SessionMeta, SessionMetaPatch } from "../types";
import { textCharacters } from "./boundedText.ts";
import { uniqueInOrder } from "./sequence.ts";

const MAX_TEXT_LENGTH = 20_000;

/**
 * 백엔드 `clean_optional`과 같은 규칙. 공백만 남으면 값을 지운 것으로 본다.
 *
 * 자르기는 코드 포인트 단위다 — 백엔드가 `chars().take(20_000)`으로 자르므로, `slice`
 * (UTF-16 코드 단위)로 자르면 낙관 갱신이 서버가 저장할 값보다 일찍 자르고 경계에서
 * 서로게이트 쌍을 갈라 반쪽 글자를 화면에 올린다.
 */
function cleanOptional(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = textCharacters(value.trim()).slice(0, MAX_TEXT_LENGTH).join("");
  return cleaned.length > 0 ? cleaned : null;
}

type PatchKey = keyof SessionMetaPatch;

/**
 * 패치 항목 하나를 화면에 먼저 올릴 값으로 다듬는 규칙. `null`은 "이 항목은 낙관 갱신
 * 대상이 아니다"라는 뜻이라, 빠뜨린 항목과 일부러 두고 온 항목이 표에서 갈린다.
 */
type PatchRule<Key extends PatchKey> =
  | ((value: Exclude<SessionMetaPatch[Key], undefined>) => SessionMeta[Key])
  | null;

/**
 * 패치 항목마다 무엇을 할지 적는 표. 패치의 키를 모두 요구하므로, `SessionMetaPatch`에
 * 항목이 하나 늘면 여기서 컴파일이 멈춘다.
 *
 * 항목이 세 모양으로 나뉘어 있었다 — 불리언 둘은 `if (patch.X !== undefined)` 두 줄을
 * 손으로 적고, 문자열 셋은 자기들끼리 이름 목록과 전용 적용 함수를 따로 두고, 폴더는
 * 다시 손으로 적은 한 줄이었다. 셋은 모두 "값이 왔으면 다듬어 넣는다"는 한 문장인데
 * 모양이 달라, 항목이 하나 늘 때 어느 모양에 얹어야 하는지가 정해져 있지 않았고 아무
 * 모양에도 얹지 않아도 컴파일은 그대로 통과했다. 실제로 읽던 자리(`bookmarks`)가 그렇게
 * 빠진 채로 돌고 있었는데, 화면에는 아무 표시가 남지 않아 저장 응답이 올 때까지
 * 목록이 옛 값으로 보이는 것으로만 드러났다.
 */
const PATCH_RULES: { [Key in PatchKey]: PatchRule<Key> } = {
  favorite: (value) => value,
  hidden: (value) => value,
  note: cleanOptional,
  customTitle: cleanOptional,
  pinnedAccountId: cleanOptional,
  folderIds: uniqueInOrder,
  // 읽던 자리는 지금도 낙관 갱신하지 않는다. 목록을 통째로 교체하는 편집이라 서버가
  // 돌려준 목록을 그대로 받는 쪽이 화면과 저장본을 어긋나게 하지 않는다. 바꾸려면 여기
  // 한 줄을 규칙으로 채우면 되고, 그때까지 이 자리가 "빠뜨린 것이 아니다"를 말한다.
  bookmarks: null,
};

/**
 * 서버 왕복을 기다리지 않고 화면에 먼저 올릴 메타데이터를 만든다. 백엔드
 * `update_session_meta`와 같은 규칙이라, 응답이 오면 같은 값이 그대로 겹친다.
 *
 * 폴더 ID 존재 검증과 계정 고정 검증은 서버만 할 수 있다. 낙관 갱신은 통과를 가정하고,
 * 거절되면 호출한 쪽이 이전 값으로 되돌린다.
 */
export function optimisticSessionMeta(current: SessionMeta, patch: SessionMetaPatch): SessionMeta {
  const next: SessionMeta = { ...current };
  for (const key of Object.keys(PATCH_RULES) as PatchKey[]) {
    // 키마다 값과 규칙의 짝이 맞는다는 것은 키를 변수로 든 조회 식만으로는 좁혀지지
    // 않는다. 그 한 걸음만 여기서 단언하고, 짝이 맞는지는 위 표가 보증한다.
    const rule = PATCH_RULES[key] as ((value: unknown) => unknown) | null;
    const value = patch[key];
    if (rule === null || value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = rule(value);
  }
  return next;
}
