import type { ProviderId, TranscriptItem } from "../types";

/** Exact text checked again against the authoritative transcript by Rust Core. */
export function editableTranscriptText(item: TranscriptItem): string | null {
  if (item.role !== "user" || item.blocks.length === 0 || item.blocks.some((block) => block.kind !== "text")) return null;
  const value = item.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n\n");
  return value.trim() ? value : null;
}

export function supportsMessageEdit(source: ProviderId | null): boolean {
  return source === "codex" || source === "claude";
}

/** Window-local draft and display prefix for a provider-created rewind branch. */
export interface MessageRewindDraft { text: string; history: TranscriptItem[]; }
