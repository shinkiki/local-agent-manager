import { closesMarkdownFence, markdownFenceOpen, type MarkdownFenceOpen } from "./markdownFences.ts";

/**
 * 문서를 빈 줄 경계로 나누는 규칙 — 스트리밍 미리보기가 다시 그릴 범위를 좁히기 위한 것.
 *
 * 여는 줄·닫는 줄의 문법(`markdownFences`)과 한 파일에 있었지만 둘이 바뀌는 이유는 다르다.
 * 문법은 에이전트가 실제로 내보내는 여는 줄 모양이 늘 때 손대고(물결 펜스, `flowchart LR`
 * 같은 정보 문자열), 여기 있는 것은 델타마다 문서 전체를 다시 엘리먼트로 만들지 않기 위한
 * 경계 규칙이라 렌더 비용을 재는 쪽에서 손댄다. 문법 한 줄을 고치러 들어온 사람이 덩어리
 * memo의 불변식까지 함께 읽을 필요는 없다.
 *
 * 가른 뒤에도 덩어리 경계는 문법을 **그대로** 쓴다. 펜스 판정을 여기서 다시 적으면 분할
 * 지점이 펜스 안으로 들어가 코드가 본문 문단으로 새어 나온다.
 */

export interface MarkdownChunk {
  /** 문서 전체 기준 시작 줄. 뒤에 내용이 붙어도 바뀌지 않으므로 렌더 key로 쓴다. */
  start: number;
  /** 덩어리 본문. 완성된 덩어리는 문서가 자라도 문자열이 그대로다. */
  text: string;
}

export interface MarkdownFence {
  /** 여는 ``` 줄의 문서 전체 기준 번호. */
  line: number;
  language: string;
  /** 정보 문자열 전체. `markdownFenceOpen`의 것과 같은 값이다. */
  info: string;
  code: string;
}

export interface MarkdownChunkSplit {
  chunks: MarkdownChunk[];
  fences: MarkdownFence[];
}

interface ConsumedMarkdownFence {
  fence: MarkdownFence;
  nextIndex: number;
}

/**
 * 여는 줄 다음부터 같은 펜스가 닫히거나 문서가 끝날 때까지 소비한다. 덩어리 경계를
 * 찾는 바깥 순회와 펜스의 종료 규칙을 갈라 두어, 어느 쪽을 바꿔도 다른 쪽의 인덱스
 * 전개를 다시 해석하지 않아도 된다.
 */
function consumeMarkdownFence(
  lines: readonly string[],
  index: number,
  opened: MarkdownFenceOpen,
): ConsumedMarkdownFence {
  const code: string[] = [];
  let nextIndex = index + 1;
  while (nextIndex < lines.length && !closesMarkdownFence(lines[nextIndex], opened.marker)) {
    code.push(lines[nextIndex]);
    nextIndex += 1;
  }
  // 닫히지 않은 펜스는 문서 끝까지가 코드다. 파서와 같은 판단이라 결과가 어긋나지 않는다.
  if (nextIndex < lines.length) nextIndex += 1;
  return {
    fence: { line: index, language: opened.language, info: opened.info, code: code.join("\n") },
    nextIndex,
  };
}

/**
 * 문서를 빈 줄 경계로 나눈다. 코드 펜스를 뺀 모든 블록은 빈 줄에서 끝나므로, 펜스 밖의
 * 빈 줄에서만 자르면 덩어리마다 블록이 온전히 담긴다. 즉 덩어리별로 파싱한 결과가 문서
 * 전체를 한 번에 파싱한 결과와 같다.
 *
 * 스트리밍 중에는 마지막 덩어리만 자라고 앞의 덩어리는 문자열이 그대로다. 덩어리 단위로
 * memo하면 델타마다 문서 전체를 다시 엘리먼트로 만드는 비용(O(글자수²))이 사라진다.
 */
export function splitMarkdownChunks(normalized: string): MarkdownChunkSplit {
  const lines = normalized.split("\n");
  const chunks: MarkdownChunk[] = [];
  const fences: MarkdownFence[] = [];
  let start = -1;
  let index = 0;

  const close = () => {
    if (start < 0) return;
    chunks.push({ start, text: lines.slice(start, index).join("\n") });
    start = -1;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      close();
      index += 1;
      continue;
    }
    if (start < 0) start = index;

    const opened = markdownFenceOpen(line);
    if (opened) {
      const consumed = consumeMarkdownFence(lines, index, opened);
      fences.push(consumed.fence);
      index = consumed.nextIndex;
      continue;
    }
    index += 1;
  }
  close();
  return { chunks, fences };
}
