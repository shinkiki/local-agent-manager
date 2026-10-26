import type { ProviderId } from "../types";

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
