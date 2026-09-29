/**
 * 미리보기가 마크다운 블록 구조를 한 자리에서 가져가는 통로. 규칙은 하나도 여기 살지
 * 않고, 갈래마다 제 모듈에서 바로 내보내 이 통로가 모듈 사이를 한 번 더 거치지 않게 한다.
 *
 * 목록 줄 문법만 오래 이 파일 본문에 남아 있었다. 나머지 네 갈래가 차례로 제 파일로
 * 나가는 동안 목록은 통로와 한 몸이었는데, 그러면 마커 문법 한 줄을 고치러 들어온 사람이
 * 네 갈래의 가져오기 목록을 먼저 지나야 하고 새 갈래를 더하는 사람은 이 통로가 규칙까지
 * 들고 있는지를 매번 확인해야 한다. 목록도 `markdownListLine`으로 내보내 통로에는 "무엇을
 * 어디서 가져오는가"만 남긴다.
 *
 * 가져오는 자리를 흩지 않으려고 이름은 모두 그대로 다시 내보낸다 — 화면(`MarkdownPreview`)과
 * `agentMessageMeta`는 지금까지처럼 이 통로 하나만 보면 된다. 규칙을 고치는 쪽(`markdownList`)은
 * 통로가 아니라 규칙 모듈을 직접 가져간다.
 */

export {
  markdownListItem,
  startsMarkdownListItem,
  markdownTaskItem,
  type MarkdownListKind,
  type MarkdownListItem,
  type MarkdownTaskItem,
} from "./markdownListLine.ts";

export {
  MARKDOWN_INLINE_TOKEN,
  markdownUnderscoreIsIntraword,
  unescapeMarkdown,
  markdownEscapedChar,
} from "./markdownInline.ts";

export { markdownAngleToken, type MarkdownAngleToken } from "./markdownAngle.ts";

export {
  markdownFenceLanguage,
  markdownFenceOpen,
  closesMarkdownFence,
  type MarkdownFenceOpen,
} from "./markdownFences.ts";

export {
  splitMarkdownChunks,
  type MarkdownChunk,
  type MarkdownFence,
  type MarkdownChunkSplit,
} from "./markdownChunks.ts";
