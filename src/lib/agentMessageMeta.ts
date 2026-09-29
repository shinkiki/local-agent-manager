import { closesMarkdownFence, markdownFenceOpen } from "./markdownBlocks.ts";

/**
 * 공급자가 답변 본문에 섞어 보내는 내부 메타 블록. 사용자에게 읽히라고 쓴 문장이 아니라
 * 런타임이 붙인 표시라서, 마크다운 파서에 그대로 넘기면 XML이 답변 한가운데 문단으로
 * 찍힌다. 태그는 언제나 자기 줄을 통째로 쓰므로 줄 단위로만 알아본다.
 */
interface MetaBlockSpec {
  tag: string;
  label: string;
}

const META_BLOCKS: MetaBlockSpec[] = [
  // Codex가 메모리를 인용한 턴 끝에 붙이는 출처 묶음.
  { tag: "oai-mem-citation", label: "메모리 인용" },
];

export interface AgentMessageMeta {
  tag: string;
  label: string;
  /** 태그 안쪽 원문. 출처를 확인할 수 있게 버리지 않고 접어 둔다. */
  text: string;
}

export interface AgentMessageParts {
  /** 메타 블록을 걷어낸 본문. 이것만 마크다운으로 그리고, 복사·읽어주기도 이걸 쓴다. */
  text: string;
  meta: AgentMessageMeta[];
}

/** 메타가 없을 때 늘 같은 배열을 돌려줘 렌더가 헛돌지 않게 한다. */
const NO_META: AgentMessageMeta[] = [];

interface ReadMetaBlockResult {
  meta: AgentMessageMeta;
  nextIndex: number;
}

/** 열린 메타 태그의 본문을 읽고, 닫는 줄 다음(없으면 입력 끝)을 돌려준다. */
function readMetaBlock(
  lines: string[],
  opened: MetaBlockSpec,
  bodyStart: number,
): ReadMetaBlockResult {
  const close = `</${opened.tag}>`;
  const body: string[] = [];
  let index = bodyStart;
  while (index < lines.length && lines[index].trim() !== close) {
    body.push(lines[index]);
    index += 1;
  }
  return {
    meta: { tag: opened.tag, label: opened.label, text: body.join("\n").trim() },
    nextIndex: index < lines.length ? index + 1 : index,
  };
}

/**
 * 이 줄을 지난 뒤 열려 있는 펜스의 마커. 닫는 줄은 여는 줄과 같은 종류여야 하므로
 * 여부가 아니라 마커를 쥔다.
 *
 * 펜스가 열리는 줄과 닫히는 줄이 훑기 루프 안에 두 갈래로 박혀 있었다. 둘은 같은
 * 상태 하나를 옮기는 일인데 갈래가 떨어져 있으면 한쪽만 고쳐져 펜스가 영영 열린
 * 채로 남거나(뒤따르는 메타 태그를 전부 놓친다) 곧바로 닫힌 것으로 읽힌다. 전이를
 * 여기 한 벌만 두고, 훑는 쪽은 "지금 펜스 안인가"만 본다.
 */
function nextFenceMarker(fence: string | null, line: string): string | null {
  if (fence !== null) return closesMarkdownFence(line, fence) ? null : fence;
  return markdownFenceOpen(line)?.marker ?? null;
}

/** 이 줄이 여는 메타 블록. 태그는 언제나 자기 줄을 통째로 쓰므로 줄 전체를 견준다. */
function openedMetaBlock(blocks: MetaBlockSpec[], line: string): MetaBlockSpec | undefined {
  return blocks.find((block) => line.trim() === `<${block.tag}>`);
}

/**
 * 답변에서 내부 메타 블록을 떼어낸다. 코드 펜스 안은 건드리지 않으므로, 태그를 설명하려고
 * 본문에 적어 보낸 예시는 그대로 남는다.
 */
export function splitAgentMessageMeta(source: string): AgentMessageParts {
  const blocks = META_BLOCKS.filter((block) => source.includes(`<${block.tag}>`));
  if (blocks.length === 0) return { text: source, meta: NO_META };

  const lines = source.split("\n");
  const kept: string[] = [];
  const meta: AgentMessageMeta[] = [];
  // 열려 있는 펜스의 마커. 없으면 펜스 밖이고, 그때만 메타 태그를 알아본다.
  let fence: string | null = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const opened = fence === null ? openedMetaBlock(blocks, line) : undefined;
    if (opened) {
      // 닫는 줄이 아직 없으면 블록이 흘러오는 중이다. 남은 줄을 본문으로 되돌리면 델타마다
      // XML이 나타났다 사라지므로, 끝까지 메타로 보고 접어 둔 채 자라게 둔다.
      const read = readMetaBlock(lines, opened, index + 1);
      meta.push(read.meta);
      index = read.nextIndex;
      continue;
    }
    fence = nextFenceMarker(fence, line);
    kept.push(line);
    index += 1;
  }

  return { text: kept.join("\n").trimEnd(), meta };
}
