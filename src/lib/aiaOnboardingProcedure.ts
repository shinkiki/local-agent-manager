/**
 * 워크플로 전용 절차 스킬 한 벌을 **어떤 파일로 적는가**. 머리말 두 줄을 복사본 값으로
 * 바꾸고, 그 값이 YAML 구조로 읽히지 않게 다듬는 규칙이 전부다.
 *
 * 조립 모듈(`aiaOnboarding.ts`)에 함께 있었는데 둘은 자라는 축이 다르다 — 머리말 규칙은
 * 사용자가 적는 이름에 무엇이 섞여 들어오는지를 알아 갈 때마다 손보이고(지시자 반복 제거가
 * 그렇게 붙었다), 그동안 계약의 뼈대는 그대로였다. 한 파일에 있는 동안은 계약 한 줄을
 * 고치려 해도 YAML 스칼라 다듬기를 지나쳐 읽어야 했고, 반대로 머리말 한 글자를 더 걷으려
 * 해도 계약 조립과 사전검사 사이에서 그 자리를 찾아야 했다.
 *
 * **무엇을 만들지**(어느 카드가 어떤 키의 스킬을 몇 벌 필요로 하는가)는 그대로 조립
 * 모듈이 갖는다. 그쪽은 카드의 활성 동작과 계약 id를 보아야 정해지고, 여기는 본문 문자열
 * 하나만 보면 되므로 이 모듈은 카드도 값도 모른다. 기존 호출부가 경로를 바꾸지 않도록
 * 이름은 조립 모듈이 그대로 다시 내보낸다.
 */
import { collapseWhitespace } from "./boundedText.ts";

export interface ProcedureSkillFile {
  path: string;
  content: string;
}

/**
 * 절차 스킬 한 벌. 앱이 들고 있는 번들 원본과 카드가 만들 복사본이 같은 모양이라
 * 한 이름으로 둔다 — 같은 세 칸을 인자·반환·지역 변수·보조 함수 네 자리에 손으로 펼쳐
 * 적고 있어, 칸이 하나 늘면 그 네 자리를 함께 고쳐야 했다.
 */
export interface ProcedureSkill {
  key: string;
  description: string;
  files: ProcedureSkillFile[];
}

/**
 * 워크플로 전용 절차 스킬로 복사할 파일. 원본은 앱이 들고 있는 번들 절차이고, 복사본은
 * 그 워크플로의 이름을 쓴다 — 스킬 키와 워크플로 id가 같아야 "이 회차가 따르는 절차"를
 * 찾는 데 다른 규칙이 필요 없다.
 *
 * 머리말의 `name`·`description`을 복사본 값으로 바꾼다. 배포는 그 두 줄을 한 줄짜리로만
 * 읽으므로 여러 줄로 적지 않는다.
 */
export function procedureSkillFiles(body: string, key: string, description: string): ProcedureSkillFile[] {
  // 치환 문자열에는 사용자 값이 들어가므로 함수로 넣는다. 문자열로 넘기면 `$&`·`$'`가
  // 치환 패턴으로 읽혀 머리말 한 줄에 본문이 끼어든다.
  const rewritten = body
    .replace(/^name:.*$/m, () => `name: ${key}`)
    .replace(/^description:.*$/m, () => `description: ${yamlScalar(description) || key}`);
  return [{ path: "SKILL.md", content: rewritten }];
}

/**
 * 머리말 한 줄에 실을 값.
 *
 * 사용자가 적은 시스템 이름이 그대로 들어오므로 YAML이 구조로 읽는 글자가 섞일 수 있다 —
 * `[KBF] 펀드`는 목록으로, `KB: 펀드`는 매핑으로 읽혀 머리말이 깨진다. 따옴표로 묶는 대신
 * **평범한 값이 되도록 다듬는다.** 앱의 머리말 파서는 따옴표를 떼기만 하고 이스케이프를
 * 되돌리지 않아, 묶는 쪽을 고르면 목록에 역슬래시가 그대로 보이기 때문이다.
 */
function yamlScalar(value: string): string {
  const text = collapseWhitespace(value)
    // 콜론과 우물정자는 값 가운데서도 주석·매핑으로 읽힌다.
    .replace(/:/g, "·")
    .replace(/#/g, "·")
    // 따옴표는 묶음의 시작으로 읽힌다.
    .replace(/["']/g, "")
    .trim();
  // 첫 글자가 지시자면 그 자체로 다른 구조가 된다. `- [KBF]`처럼 지시자가 이어지면 한
  // 덩어리만 걷어서는 여전히 목록으로 읽히므로, 더 걷을 것이 없을 때까지 반복한다.
  let head = text;
  let previous = "";
  while (head !== previous) {
    previous = head;
    head = head.replace(/^[-?,[\]{}&*!|>%@`]+\s*/, "").trim();
  }
  return head;
}
