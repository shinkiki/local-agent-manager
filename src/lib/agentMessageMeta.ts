import { closesMarkdownFence, markdownFenceOpen } from "./markdownBlocks.ts";

/**
 * 공급자가 답변 본문에 섞어 보내는 내부 메타 블록. 사용자에게 읽히라고 쓴 문장이 아니라
 * 런타임이 붙인 표시라서, 마크다운 파서에 그대로 넘기면 XML이 답변 한가운데 문단으로
 * 찍힌다. 태그는 언제나 자기 줄을 통째로 쓰므로 줄 단위로만 알아본다.
 */
const META_BLOCKS: { tag: string; label: string }[] = [
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
  // 열려 있는 펜스의 마커. 닫는 줄은 같은 종류여야 하므로 여부가 아니라 마커를 쥔다.
  let fence: string | null = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (fence) {
      if (closesMarkdownFence(line, fence)) fence = null;
      kept.push(line);
      index += 1;
      continue;
    }
    const fenceOpen = markdownFenceOpen(line);
    if (fenceOpen) {
      fence = fenceOpen.marker;
      kept.push(line);
      index += 1;
      continue;
    }
    const opened = blocks.find((block) => line.trim() === `<${block.tag}>`);
    if (!opened) {
      kept.push(line);
      index += 1;
      continue;
    }

    const close = `</${opened.tag}>`;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== close) {
      body.push(lines[index]);
      index += 1;
    }
    // 닫는 줄이 아직 없으면 블록이 흘러오는 중이다. 남은 줄을 본문으로 되돌리면 델타마다
    // XML이 나타났다 사라지므로, 끝까지 메타로 보고 접어 둔 채 자라게 둔다.
    if (index < lines.length) index += 1;
    meta.push({ tag: opened.tag, label: opened.label, text: body.join("\n").trim() });
  }

  return { text: kept.join("\n").trimEnd(), meta };
}
