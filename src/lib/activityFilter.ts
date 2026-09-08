import { isSkillToolName, launchedSkillName, SKILL_CONTEXT_LABEL_PREFIX } from "./skillUsage.ts";

export type ActivityFilter = "all" | "tool" | "reasoning" | "skill" | "error";

type LiveActivityEntry =
  | { type: "message"; role: string; kind: string }
  | { type: "tool"; name: string }
  | { type: "approval" }
  | { type: "error" };

type TranscriptActivityBlock = {
  kind: string;
  label?: string;
  name?: string;
  text?: string;
  isError?: boolean;
};

function isSkillTranscriptBlock(block: TranscriptActivityBlock): boolean {
  if (block.kind === "context") return block.label?.startsWith(SKILL_CONTEXT_LABEL_PREFIX) ?? false;
  if (block.kind === "tool_use") return isSkillToolName(block.name);
  return block.kind === "tool_result" && launchedSkillName(block.text) !== null;
}

export function activityMatches(entry: LiveActivityEntry, filter: ActivityFilter): boolean {
  if (filter === "all") return entry.type !== "message" || entry.kind === "reasoning" || entry.role === "user";
  if (filter === "tool") return entry.type === "tool";
  if (filter === "reasoning") return entry.type === "message" && entry.kind === "reasoning";
  if (filter === "skill") return entry.type === "tool" && isSkillToolName(entry.name);
  return entry.type === "error" || entry.type === "approval";
}

export function transcriptActivityMatches(
  blocks: readonly TranscriptActivityBlock[],
  filter: ActivityFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "tool") return blocks.some((block) => block.kind === "tool_use" || block.kind === "tool_result");
  if (filter === "reasoning") return blocks.some((block) => block.kind === "thinking");
  if (filter === "skill") return blocks.some(isSkillTranscriptBlock);
  return blocks.some((block) => block.kind === "runtime_failure"
    || (block.kind === "tool_result" && block.isError === true));
}
