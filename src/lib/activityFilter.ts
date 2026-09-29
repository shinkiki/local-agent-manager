import { isSkillToolName, launchedSkillName, SKILL_CONTEXT_LABEL_PREFIX } from "./skillUsage.ts";

export type ActivityFilter = "all" | "tool" | "reasoning" | "skill" | "error";

export type LiveActivityEntry =
  | { type: "message"; role: string; kind: string }
  | { type: "tool"; name: string }
  | { type: "approval" }
  | { type: "error" };

export type TranscriptActivityBlock = {
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

const isLiveActivityAll = (entry: LiveActivityEntry): boolean =>
  entry.type !== "message" || entry.kind === "reasoning" || entry.role === "user";

/**
 * 실시간 활동 항목 필터 표.
 * 'all'을 포함한 모든 필터의 판정 규칙을 한곳에 정적으로 두고 누락을 타입 검사에서 막는다.
 */
const LIVE_ACTIVITY_PREDICATES: Record<ActivityFilter, (entry: LiveActivityEntry) => boolean> = {
  all: isLiveActivityAll,
  tool: (entry) => entry.type === "tool",
  reasoning: (entry) => entry.type === "message" && entry.kind === "reasoning",
  skill: (entry) => entry.type === "tool" && isSkillToolName(entry.name),
  error: (entry) => entry.type === "error" || entry.type === "approval",
};

/**
 * 전사 내역 블록 필터 표.
 */
const TRANSCRIPT_ACTIVITY_PREDICATES: Record<ActivityFilter, (block: TranscriptActivityBlock) => boolean> = {
  all: () => true,
  tool: (block) => block.kind === "tool_use" || block.kind === "tool_result",
  reasoning: (block) => block.kind === "thinking",
  skill: isSkillTranscriptBlock,
  error: (block) => block.kind === "runtime_failure" || (block.kind === "tool_result" && block.isError === true),
};

/** 실시간 활동 항목 필터 술어를 반환한다. */
export function liveActivityPredicate(filter: ActivityFilter): (entry: LiveActivityEntry) => boolean {
  return LIVE_ACTIVITY_PREDICATES[filter];
}

/** 전사 내역 블록 필터 술어를 반환한다. */
export function transcriptActivityPredicate(
  filter: ActivityFilter,
): (block: TranscriptActivityBlock) => boolean {
  return TRANSCRIPT_ACTIVITY_PREDICATES[filter];
}

export function activityMatches(entry: LiveActivityEntry, filter: ActivityFilter): boolean {
  return LIVE_ACTIVITY_PREDICATES[filter](entry);
}

export function transcriptActivityMatches(
  blocks: readonly TranscriptActivityBlock[],
  filter: ActivityFilter,
): boolean {
  if (filter === "all") return true;
  return blocks.some(TRANSCRIPT_ACTIVITY_PREDICATES[filter]);
}
