import { markdownFenceLanguage } from "./markdownFences.ts";

/**
 * mermaid 다이어그램으로 그릴 펜스인지 가리는 규칙. 판별만 여기 두는 이유는 두 가지다.
 * 렌더 컴포넌트는 DOM과 엔진 로딩에 묶여 있어 node 테스트로 확인할 수 없고, 에이전트가
 * 실제로 내보내는 여는 줄이 한 가지가 아니라 목록이 늘어난다.
 *
 * 정식 표기는 ```` ```mermaid ````이고 다이어그램 종류는 코드 첫 줄에 적힌다. 그런데
 * 종류를 정보 문자열에 바로 적는 출력(```` ```flowchart LR ````)도 오므로, 그 경우에는
 * 정보 문자열을 코드의 머리줄로 되돌려 붙여 같은 원문으로 만든다.
 */

/** 정보 문자열에 바로 적힐 수 있는 다이어그램 종류. mermaid가 첫 줄로 받아들이는 이름만 둔다. */
const DIAGRAM_KEYWORDS: ReadonlySet<string> = new Set([
  "sequencediagram",
  "flowchart",
  "flowchart-elk",
  "graph",
  "classdiagram",
  "erdiagram",
  "statediagram",
  "statediagram-v2",
  "gantt",
  "pie",
  "mindmap",
  "journey",
  "gitgraph",
  "quadrantchart",
  "timeline",
]);

/**
 * 다이어그램 하나의 원문 상한. 넘으면 그리지 않고 코드 상자로 남긴다 — 스트리밍으로
 * 들어오는 원문에는 다이어그램이 아닌 긴 붙여넣기도 섞이는데, 엔진이 그걸 붙들고
 * 레이아웃을 계산하면 그리는 동안 화면이 멈춘다. `codeHighlight`의 상한과 같은 뜻이다.
 *
 * 이 수치는 파일 밖으로 내보내지 않는다. 바깥이 쓰는 모양은 "이 펜스를 그릴 것인가"를
 * 답하는 `mermaidSource` 하나뿐이고, 상한까지 함께 내주면 그 판정을 거치지 않고 길이만
 * 따로 재는 두 번째 경로가 열린다 — 그쪽에는 빈 원문·언어 판정이 없다. 실제로 이 상수를
 * 부르던 것은 자기 테스트뿐이었고, 그 시험은 상한을 넘는 원문이 null이 되는 것으로 같은
 * 사실을 짚는다. 합친 결과를 내주지 않는 `projectRegistry`, 중간 단계를 닫아 둔
 * `navigationPreferences`와 같은 경계다.
 */
const MAX_MERMAID_CHARACTERS = 20_000;

/**
 * 정보 문자열과 본문에서 엔진에 넘길 다이어그램 원문을 조립한다.
 * mermaid 언어면 본문을 그대로 쓰고, 정보 문자열에 종류가 직접 적힌 펜스는 그 머리줄을
 * 되돌려 붙인다. 다이어그램 언어가 아니면 null.
 */
function rawDiagramSource(info: string, trimmed: string): string | null {
  const language = markdownFenceLanguage(info).toLowerCase();
  if (language === "mermaid") return trimmed;
  if (DIAGRAM_KEYWORDS.has(language)) return `${info.trim()}\n${trimmed}`;
  return null;
}

/**
 * 이 펜스를 mermaid로 그릴 수 있으면 엔진에 넘길 원문을, 아니면 null을 돌려준다.
 * `info`는 여는 줄의 정보 문자열 전체(`markdownFenceOpen`이 주는 값)다.
 *
 * 정보 문자열에서 언어 이름을 꺼내는 일은 펜스를 읽는 쪽(`markdownFenceLanguage`)에
 * 맡긴다. 같은 여는 줄을 코드 상자와 다이어그램이 다른 이름으로 읽는 일이 없어야 한다.
 * 언어 판별과 머리줄 복원은 `rawDiagramSource`로 분리하고, 개행 정규화는 조립된 원문에만
 * 한 번 적용한다.
 */
export function mermaidSource(info: string, code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed || code.length > MAX_MERMAID_CHARACTERS) return null;
  const raw = rawDiagramSource(info, trimmed);
  return raw ? normalizeLineBreaks(raw) : null;
}

/** 설정 지시문. 안쪽은 JSON이라 손대면 안 된다. */
const MERMAID_DIRECTIVE = /%%\{[\s\S]*?\}%%/g;

/** 보호 구간은 원문대로 두고 그 사이의 일반 원문에만 변환을 적용한다. */
function mapOutsideDirectives(source: string, transform: (segment: string) => string): string {
  let result = "";
  let index = 0;
  for (const match of source.matchAll(MERMAID_DIRECTIVE)) {
    result += transform(source.slice(index, match.index)) + match[0];
    index = match.index + match[0].length;
  }
  return result + transform(source.slice(index));
}

/**
 * 라벨 안의 리터럴 `\n`(역슬래시+n 두 글자)을 `<br/>`로 바꾼다.
 *
 * 엔진이 이 표기를 종류마다 다르게 다룬다. 흐름도 라벨(`A["첫 줄\n둘째 줄"]`)에서는
 * 줄바꿈이 되지만, **시퀀스 메시지(`A->>B: 첫 줄\n둘째 줄`)에서는 글자 그대로 남는다**
 * — 실제 답변에서 `Base64 디코딩\n앞 16byte=IV`가 한 줄에 역슬래시까지 붙어 나왔다.
 * 에이전트는 흐름도에서 되는 표기를 시퀀스에도 그대로 쓰므로, 그 어긋남이 사용자에게는
 * 그냥 깨진 그림으로 보인다.
 *
 * `<br/>`은 두 경로 모두 줄바꿈으로 받으므로 여기서 한 표기로 모은다. 종류별 표를 두지
 * 않는 이유는 그 표가 엔진 판올림마다 조용히 틀려지기 때문이다.
 *
 * 잃는 것: 역슬래시+n **두 글자를 글자로 보여 주려는** 라벨. 그런 라벨은 흐름도에서는
 * 이미 줄바꿈이 되고 있었으니, 이 치환은 없던 동작을 만드는 것이 아니라 종류 사이의
 * 어긋남을 없애는 쪽이다.
 */
function normalizeLineBreaks(source: string): string {
  return mapOutsideDirectives(source, (segment) => segment.replace(/\\n/g, "<br/>"));
}
