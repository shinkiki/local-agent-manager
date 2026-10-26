/**
 * 회차 목표·보고의 긴 글을 화면 문단으로 나눈다.
 *
 * 회차는 요약을 줄바꿈 없는 한 문단으로 적어 왔다(2026-10-10 기준 저장된 보고 272건 중 줄바꿈이
 * 있는 것 0건, 긴 것은 1,500자). `<p>` 하나에 그대로 넣으면 벽처럼 읽혀서, 줄바꿈이 있으면 그대로
 * 따르고 한 줄이 길면 문장 끝에서 끊어 몇 문장씩 묶는다. 저장된 글은 바꾸지 않는다.
 */

/** 한 문단에 묶을 글자 수의 대략적인 상한. 한 문장이 이보다 길면 그 문장 하나가 문단이 된다. */
export const ROUND_PARAGRAPH_CHARS = 180;

/** 문장 끝(마침표·물음표·느낌표 뒤 공백)에서 자른다. `7.3.2` 처럼 공백이 없는 점은 끊지 않는다. */
function sentences(line: string): string[] {
  return line.replace(/([.!?。])\s+/g, "$1\u0000").split("\u0000").filter((part) => part.length > 0);
}

function chunkLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences(line)) {
    if (current && current.length + 1 + sentence.length > limit) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

/** 요약과 결정 질문에 같은 줄바꿈·공백 정리를 적용한다. 저장된 글은 바꾸지 않는다. */
function nonemptyLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function roundTextParagraphs(text: string, limit = ROUND_PARAGRAPH_CHARS): string[] {
  return nonemptyLines(text).flatMap((line) => chunkLine(line, limit));
}

/** 회차 결정 질문을 화면 자리별로 나눈 것. */
export type RoundDecisionQuestionParts = {
  /** 첫 줄 — 무슨 일인지. 제목처럼 굵게 보인다. */
  lead: string;
  /** 가운데 줄들 — 왜 지금 정하나, 선택지별로 바뀌는 것, 추천 이유. */
  body: string[];
  /** 마지막 `근거:` 줄 — 다음 회차가 찾을 id·수치라 흐리게 보인다. */
  evidence: string | null;
};

const EVIDENCE_PREFIX = /^근거\s*[:：]/;

/**
 * 회차 스킬은 결정 질문을 줄바꿈으로 나눈 다섯 줄(무슨 일·왜 지금·선택지별 결과·추천 이유·`근거:`)로
 * 쓴다(2026-10-24). 한 `<p>` 에 넣으면 줄바꿈이 사라지고 id 가 섞인 근거 줄까지 같은 굵기로 읽혀서
 * 자리를 나눈다. 근거는 마지막 줄일 때만 떼어 낸다 — 가운데의 `근거:` 는 사람이 읽을 본문일 수 있다.
 * 줄바꿈 없는 예전 질문은 문장으로 끊지 않고 첫 줄 하나로 둔다(예전 화면과 같게).
 */
export function roundDecisionQuestionParts(question: string): RoundDecisionQuestionParts {
  const lines = nonemptyLines(question);
  const evidence = lines.length > 1 && EVIDENCE_PREFIX.test(lines[lines.length - 1]) ? lines.pop() ?? null : null;
  const [lead = "", ...body] = lines;
  return { lead, body, evidence };
}
