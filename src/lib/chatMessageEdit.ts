import type { TranscriptItem } from "../types";
import { editableTranscriptText } from "./messageEdit.ts";

/** Resolve a live replay against the authoritative transcript, never by text alone. */
export function resolveLiveMessageEdit(
  transcript: TranscriptItem[],
  replay: { id: string; text: string }[],
  selectedId: string,
): TranscriptItem | null {
  const selected = replay.findIndex((entry) => entry.id === selectedId);
  if (selected < 0 || replay.filter((entry) => entry.id === selectedId).length !== 1) return null;
  const users = transcript.filter((item) => item.role === "user");
  const matches: TranscriptItem[] = [];
  for (let start = 0; start + replay.length <= users.length; start++) {
    if (replay.every((entry, offset) => editableTranscriptText(users[start + offset]) === entry.text)) {
      matches.push(users[start + selected]);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
