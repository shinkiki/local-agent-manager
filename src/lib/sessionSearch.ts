import type { ProviderId, SessionSummary } from "../types";
import { sessionKey } from "./sessionKey.ts";

export interface SessionSearchMatch {
  source: ProviderId;
  id: string;
  /** Ordinal in the complete transcript, not a latest-page byte cursor. */
  index: number | null;
  snippet: string;
}
export interface SessionSearchResponse {
  matches: SessionSearchMatch[];
  checkedSessions: number;
  unavailableSessions: number;
  partialSessions: number;
  /** Sessions not indexed yet in this call; asking again continues indexing. */
  pendingSessions: number;
  /** Records that failed to load this time; retried after a minute. */
  failedSessions: number;
}

/** Literal matching: IP dots, brackets and paths never become regexp syntax. */
export function searchHighlightParts(value: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim().normalize("NFC");
  if (!needle) return [{ text: value, match: false }];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = value.normalize("NFC");
  const re = new RegExp(escaped, "giu");
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const hit of normalized.matchAll(re)) {
    if (hit.index > cursor) parts.push({ text: normalized.slice(cursor, hit.index), match: false });
    parts.push({ text: hit[0], match: true });
    cursor = hit.index + hit[0].length;
  }
  if (cursor < normalized.length) parts.push({ text: normalized.slice(cursor), match: false });
  return parts;
}

/**
 * 백엔드 `session_search::normalize`와 같은 접기: NFC로 맞춘 뒤 글자마다 소문자로 바꾼다.
 * 문자열 단위 `toLowerCase`는 어말 Σ를 ς로 바꿔 글자별로 바꾼 쪽과 어긋난다. ASCII만
 * 있으면 둘이 같으므로 빠른 길로 간다.
 */
export function literalFold(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(value)) return value.toLowerCase();
  return Array.from(value.normalize("NFC"), (character) => character.toLowerCase()).join("");
}

/**
 * 목록 검색 조건. 필터와 '가려졌는지' 판정이 같은 규칙을 쓰도록 한곳에 둔다.
 *
 * 세션 id 말고 채팅 id도 받는다. AIA와 알림은 실행 중인 대화를 채팅 id로 가리키는데,
 * 그 값을 그대로 붙여 넣으면 0건이 나와 "분명 있다고 했는데 검색이 안 된다"가 됐다.
 * 채팅 id는 살아 있는 실행에만 붙으므로, 실행이 끝나면 세션 id로만 찾힌다.
 */
export function matchesSessionQuery(session: SessionSummary, query: string, chatIds: readonly string[], contentMatches?: ReadonlyMap<string, SessionSearchMatch>): boolean {
  if (contentMatches?.has(sessionKey(session.source, session.id))) return true;
  // 비교 규칙은 백엔드 `literal_match`와 같다(칸 구성은 `metadata_matches`에 살아 있는 채팅
  // id를 더한 것). 칸은 이 화면이 원래 보던 것이다.
  const needle = literalFold(query.trim());
  if (!needle) return true;
  return [session.title, session.project, session.cwd, session.id, session.meta.note, ...chatIds]
    .filter((value): value is string => Boolean(value))
    .some((value) => literalFold(value).includes(needle));
}
