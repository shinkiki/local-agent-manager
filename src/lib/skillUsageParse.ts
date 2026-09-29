/**
 * 스킬 실행이 원문에 남는 모양 — 도구 이름, 도구 인자 JSON, 확인 문장, CLI가 주입한
 * SKILL.md 레코드, 그리고 인자에 섞여 오는 SKILL.md 경로.
 *
 * 수집·합치기(`skillUsage`)와는 서로 읽을 것이 없다. 저쪽은 같은 스킬이 여러 경로로 들어올
 * 때 무엇을 더 확실한 값으로 보고 어떻게 한 항목으로 접을지를 정하는 일이고, 여기는 문자열
 * 하나를 받아 조각으로 가르는 순수 함수들이다. 답이 달라지는 이유도 겹치지 않는다 —
 * 저쪽은 수집 지점이, 여기는 CLI가 찍는 문자열의 모양이 바뀔 때 달라진다.
 *
 * 이 문법을 아는 곳은 여기 하나다. 앞머리 문자열은 백엔드 `catalog.rs`가 찍는 것과 짝이라,
 * 두 벌로 흩어 두면 CLI 쪽 문구가 바뀔 때 한쪽만 따라가 같은 대화가 흐름과 기록에서 다른
 * 스킬 목록으로 보인다.
 */

/** Claude CLI의 스킬 실행 도구 이름. */
const SKILL_TOOL_NAME = "skill";
/** Skill 도구가 돌려주는 확인 문장. 스트리밍이 끊겨 인자를 못 받았을 때의 이름 출처다. */
const LAUNCH_PREFIX = "Launching skill:";
/** CLI가 사용자 턴 자리에 주입하는 SKILL.md 앞머리. `catalog.rs`의 같은 상수와 짝이다. */
const BASE_DIRECTORY_PREFIX = "Base directory for this skill:";
/** 주입 레코드에 트랜스크립트가 붙이는 라벨. `catalog.rs`가 만든다. */
export const SKILL_CONTEXT_LABEL_PREFIX = "사용 스킬 · ";
/**
 * 스킬 디렉터리의 SKILL.md를 직접 가리키는 경로. `skills/<이름>/SKILL.md` 꼴만 받아,
 * 저장소 전체를 훑는 검색 명령이 스킬 실행으로 보이지 않게 한다. 가운데 조각은 실제
 * 디렉터리 이름의 글자만 받는다. 아무 글자나 받으면 코드를 고치는 도구 인자에 들어 있는
 * 템플릿 문자열(스킬 경로를 조립하는 코드)이나 별표 글롭까지 스킬 이름으로 잡혀, 실행한
 * 적 없는 자리표시자가 사용 스킬 카드에 오른다.
 */
const SKILL_PATH_PATTERN = /skills[\\/]([A-Za-z0-9][A-Za-z0-9._-]*)[\\/]SKILL\.md/g;

export function isSkillToolName(name: string | undefined): boolean {
  return name?.trim().toLowerCase() === SKILL_TOOL_NAME;
}

/**
 * 앞머리가 붙은 첫 줄에서 값을, 그 뒤가 있으면 본문을 읽는다. 앞머리로 시작하지 않으면
 * 이 문법의 글이 아니라는 뜻으로 null이다.
 *
 * 위의 앞머리 상수 셋이 전부 같은 모양으로 읽히는데, 그 읽기를 세 자리가 각자 적고 있었다
 * — 확인 문장은 `split("\n", 1)[0]` 뒤 `startsWith`로, 주입 레코드는 `indexOf("\n")`으로
 * 머리와 본문을 갈라서, 트랜스크립트 라벨은 수집 쪽(`skillUsage`)에서 `startsWith` +
 * `slice(길이)`로. 세 벌이면 "값을 어디까지로 보는가"(줄바꿈 전까지인가 끝까지인가,
 * 양끝 공백을 어떻게 다루는가)가 앞머리마다 다르게 굳고, 실제로 달랐다. 앞머리 상수를
 * 소유한 이 모듈이 그 상수를 읽는 법까지 함께 가져야 그 어긋남이 생길 자리가 없다.
 *
 * 값은 언제나 **첫 줄**까지다. 앞머리 셋 모두 한 줄짜리 값을 쓰고(라벨은 백엔드
 * `catalog.rs`가 한 줄로 만든다), 뒷줄은 값이 아니라 본문이다.
 */
function prefixedLine(text: string, prefix: string): { value: string; body: string } | null {
  if (!text.startsWith(prefix)) return null;
  const breakAt = text.indexOf("\n");
  if (breakAt < 0) return { value: text.slice(prefix.length).trim(), body: "" };
  return { value: text.slice(prefix.length, breakAt).trim(), body: text.slice(breakAt + 1).trim() };
}

/** Skill 도구 인자에서 스킬 이름과 지시를 뽑는다. 스트리밍 중이면 JSON이 아직 깨져 있다. */
export function parseSkillInvocation(detail: string): { name: string; args: string } {
  const text = detail.trim();
  if (!text) return { name: "", args: "" };
  try {
    const value = JSON.parse(text) as { skill?: unknown; args?: unknown };
    return {
      name: typeof value.skill === "string" ? value.skill.trim() : "",
      args: typeof value.args === "string" ? value.args.trim() : "",
    };
  } catch {
    // 부분 JSON에서라도 이름은 알려 준다. 카드가 이름 없이 뜨는 편보다 낫다.
    return {
      name: text.match(/"skill"\s*:\s*"([^"]*)"/)?.[1]?.trim() ?? "",
      args: text.match(/"args"\s*:\s*"([^"]*)"/)?.[1]?.trim() ?? "",
    };
  }
}

/** `Launching skill: <이름>` 확인 문장에서 스킬 이름을 뽑는다. 이름이 비면 못 얻은 것과 같다. */
export function launchedSkillName(text: string | undefined): string | null {
  return prefixedLine(text?.trimStart() ?? "", LAUNCH_PREFIX)?.value || null;
}

/** CLI가 주입한 SKILL.md 레코드를 스킬 디렉터리와 본문으로 나눈다. 앞머리가 없으면 전부 본문이다. */
export function parseInjectedSkillBody(text: string): { directory: string; body: string } {
  const trimmed = text.trimStart();
  const head = prefixedLine(trimmed, BASE_DIRECTORY_PREFIX);
  return head ? { directory: head.value, body: head.body } : { directory: "", body: trimmed };
}

/**
 * 트랜스크립트 주입 레코드 라벨(`사용 스킬 · <이름>`)에서 스킬 이름을 읽는다. 이 문법의
 * 라벨이 아니면 null이다. 이름 자리가 비어 있는 라벨(`""`)은 null과 구분된다 — 라벨은
 * 있었으니 주입 레코드로 받아 상세를 붙이되, 붙일 이름이 없다는 뜻이다.
 */
export function skillContextLabelName(label: string): string | null {
  return prefixedLine(label, SKILL_CONTEXT_LABEL_PREFIX)?.value ?? null;
}

/** 도구 인자 안에서 `skills/<이름>/SKILL.md`를 가리키는 경로의 스킬 이름들. */
export function skillPathNames(detail: string): string[] {
  const names: string[] = [];
  for (const match of detail.matchAll(SKILL_PATH_PATTERN)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
