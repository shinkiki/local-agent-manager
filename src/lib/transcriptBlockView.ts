import type { ContentBlock, TranscriptItem } from "../types";
import { isSkillUsageBlock } from "./skillUsage.ts";

/**
 * 도구가 돌려준 화면 캡처인지. 사용자가 메시지에 붙인 이미지는 대화에, 도구가 만든
 * 캡처는 작업 로그에 두어 같은 이미지가 두 화면에 겹쳐 나오지 않게 한다.
 */
function isToolImage(block: ContentBlock, item: TranscriptItem): boolean {
  return block.kind === "image"
    && item.blocks.some((other) => other.kind === "tool_use" || other.kind === "tool_result");
}

/**
 * 블록 하나가 화면에서 어떤 성격으로 다뤄지는지. 블록 종류는 아홉 가지인데 표시 술어 셋,
 * 카드 종류 판정, 접힌 로그 요약이 저마다 그 종류 이름을 늘어놓고 있었다. 종류가 하나
 * 늘거나 성격이 바뀔 때 다섯 자리를 같이 고쳐야 했으므로 가름은 여기 한 벌만 둔다.
 */
export type TranscriptBlockGroup = "message" | "tool" | "reasoning" | "context" | "failure";

export function transcriptBlockGroup(block: ContentBlock, item: TranscriptItem): TranscriptBlockGroup {
  switch (block.kind) {
    case "tool_use":
    case "tool_result":
      return "tool";
    case "thinking":
      return "reasoning";
    case "context":
    case "session_info":
    case "raw":
      return "context";
    case "runtime_failure":
      return "failure";
    case "image":
      return isToolImage(block, item) ? "tool" : "message";
    default:
      return "message";
  }
}

/** 한 항목을 그릴 때 고르는 표시 갈래와 그 갈래가 남기는 블록. */
export type TranscriptBlockView = "conversation" | "activity" | "operational";

/**
 * 표시 갈래마다 어떤 블록을 남기는지. 블록 자체가 아니라 이미 유도된 성격(`group`)을 받는
 * 것이 요점이다 — 한 항목을 그릴 때 이 셋과 카드 종류 판정이 저마다 `transcriptBlockGroup`을
 * 다시 불러, 같은 블록의 성격을 최대 네 번 유도하고 있었다. 성격은 부르는 쪽이 한 번 내고
 * 여기서는 가름만 한다. `operational`만 블록을 함께 보는데, 스킬 실행은 성격이 아니라
 * 사용 스킬 카드가 대신 그린다는 자리 배분의 문제라 갈래로 나타나지 않기 때문이다.
 */
const TRANSCRIPT_BLOCK_VIEWS: Record<TranscriptBlockView, (group: TranscriptBlockGroup, block: ContentBlock) => boolean> = {
  conversation: (group) => group === "message" || group === "failure",
  activity: (group) => group !== "message",
  /** 대화 흐름에 딸려 나오는 작업 로그. 스킬 실행은 사용 스킬 카드가 대신 보여준다. */
  operational: (group, block) => !isSkillUsageBlock(block) && (group === "tool" || group === "reasoning"),
};

function transcriptBlockInView(view: TranscriptBlockView, block: ContentBlock, item: TranscriptItem): boolean {
  return TRANSCRIPT_BLOCK_VIEWS[view](transcriptBlockGroup(block, item), block);
}

export function isConversationBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return transcriptBlockInView("conversation", block, item);
}

export function isActivityBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return transcriptBlockInView("activity", block, item);
}

export function isConversationActivityBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return transcriptBlockInView("operational", block, item);
}

/** 한 항목이 한 표시 갈래에서 실제로 그리는 블록과, 그 블록들에서 한 번에 읽어 둔 성격. */
export interface VisibleTranscriptBlocks {
  visible: ContentBlock[];
  /** 남은 블록들이 속한 성격 전부. 카드 종류 판정이 이것만 보고 결정한다. */
  groups: Set<TranscriptBlockGroup>;
  /** 세션 정보는 컨텍스트 성격에 묻히므로 따로 표시해 둔다. */
  hasSessionInfo: boolean;
}

/**
 * 한 항목의 블록을 한 번만 훑어 표시 갈래가 남길 블록과 그 성격을 함께 낸다. 성격을 내는
 * `transcriptBlockGroup`은 이미지 블록일 때 항목의 블록 전체를 다시 훑으므로(`isToolImage`),
 * 블록마다 갈래별로 되풀이하면 그 비용이 항목 크기의 제곱으로 겹친다.
 */
export function visibleTranscriptBlocks(item: TranscriptItem, view: TranscriptBlockView): VisibleTranscriptBlocks {
  const keeps = TRANSCRIPT_BLOCK_VIEWS[view];
  const visible: ContentBlock[] = [];
  const groups = new Set<TranscriptBlockGroup>();
  let hasSessionInfo = false;
  for (const block of item.blocks) {
    const group = transcriptBlockGroup(block, item);
    if (!keeps(group, block)) continue;
    visible.push(block);
    groups.add(group);
    if (block.kind === "session_info") hasSessionInfo = true;
  }
  return { visible, groups, hasSessionInfo };
}

