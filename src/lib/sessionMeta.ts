import type { SessionMeta, SessionMetaPatch } from "../types";
import { uniqueInOrder } from "./sequence.ts";

const MAX_TEXT_LENGTH = 20_000;

/** 백엔드 `clean_optional`과 같은 규칙. 공백만 남으면 값을 지운 것으로 본다. */
function cleanOptional(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.trim().slice(0, MAX_TEXT_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 서버 왕복을 기다리지 않고 화면에 먼저 올릴 메타데이터를 만든다. 백엔드
 * `update_session_meta`와 같은 규칙이라, 응답이 오면 같은 값이 그대로 겹친다.
 *
 * 폴더 ID 존재 검증과 계정 고정 검증은 서버만 할 수 있다. 낙관 갱신은 통과를 가정하고,
 * 거절되면 호출한 쪽이 이전 값으로 되돌린다.
 */
export function optimisticSessionMeta(current: SessionMeta, patch: SessionMetaPatch): SessionMeta {
  const next = { ...current };
  if (patch.favorite !== undefined) next.favorite = patch.favorite;
  if (patch.hidden !== undefined) next.hidden = patch.hidden;
  if (patch.note !== undefined) next.note = cleanOptional(patch.note);
  if (patch.customTitle !== undefined) next.customTitle = cleanOptional(patch.customTitle);
  if (patch.folderIds !== undefined) next.folderIds = uniqueInOrder(patch.folderIds);
  if (patch.pinnedAccountId !== undefined) next.pinnedAccountId = cleanOptional(patch.pinnedAccountId);
  return next;
}
