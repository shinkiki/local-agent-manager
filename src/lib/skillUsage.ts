import type { ContentBlock, TranscriptItem } from "../types";

/**
 * 한 턴에서 에이전트가 실제로 실행한 스킬. 라이브 채팅(도구 이벤트)과 세션 트랜스크립트
 * (도구 블록 + CLI가 주입한 SKILL.md 레코드)에서 같은 모양으로 뽑아, 대화 흐름에 별도
 * 항목으로 보여주고 상세에서 SKILL.md 본문까지 펼칠 수 있게 한다.
 */
export interface SkillUsage {
  /** 카드 안에서 유일한 키. 같은 스킬을 여러 번 실행하면 항목도 여러 개다. */
  id: string;
  /** 스킬 이름. Claude는 도구 인자, Codex는 읽은 SKILL.md 경로의 디렉터리 이름이다. */
  name: string;
  /** 에이전트가 스킬에 함께 넘긴 지시. 없으면 빈 문자열. */
  args: string;
  /** `chat-tool-state-*` 클래스와 같은 값. */
  status: string;
  /** 주입 레코드 첫 줄에서 얻은 스킬 디렉터리. 못 얻으면 빈 문자열. */
  directory: string;
  /** CLI가 주입한 SKILL.md 본문. 트랜스크립트에만 있다(라이브 스트림은 이 레코드를 받지 않는다). */
  body: string;
  /**
   * `tool`은 스킬 실행 전용 도구로 확인한 것, `path`는 SKILL.md를 직접 읽은 명령에서
   * 추정한 것이다. Codex·Antigravity는 전용 도구 없이 파일을 읽어 스킬을 시작한다.
   */
  detection: "tool" | "path";
}

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
 * 저장소 전체를 훑는 검색 명령이 스킬 실행으로 보이지 않게 한다.
 */
const SKILL_PATH_PATTERN = /skills[\\/]([^\\/\s"'`]+)[\\/]SKILL\.md/g;

/** 인자·확인 문장 어디에서도 이름을 못 얻었을 때 카드에 적는 이름. */
const UNKNOWN_SKILL_NAME = "이름 확인 불가";

/**
 * `SkillUsage` 한 건을 만든다. 수집 지점마다 알아낼 수 있는 정보가 달라 대부분의 필드는
 * 빈 값으로 시작하고, `SkillUsageSet.add`가 나중에 더 확실한 값으로 채운다. 그 빈 값을
 * 호출부마다 나열하면 실제로 다른 것(id·이름·탐지 방식·상태)이 묻히므로 여기 한 벌만 둔다.
 */
function skillUsage(
  id: string,
  name: string,
  detection: SkillUsage["detection"],
  status: string,
  rest: Partial<Pick<SkillUsage, "args" | "directory" | "body">> = {},
): SkillUsage {
  return { id, name, args: "", directory: "", body: "", ...rest, status, detection };
}

/** 라이브 채팅 도구 항목 중 이 판정에 필요한 부분만. 컴포넌트 타입에 묶이지 않게 구조로 받는다. */
interface SkillToolEntry {
  type: string;
  id: string;
  name?: string;
  status?: string;
  detail?: string;
  output?: string;
}

export function isSkillToolName(name: string | undefined): boolean {
  return name?.trim().toLowerCase() === SKILL_TOOL_NAME;
}

/**
 * 대화 흐름에서 사용 스킬 카드가 대신 보여주는 블록인지. 스킬 실행 도구 호출과 그 확인
 * 문장만 해당한다. SKILL.md를 직접 읽은 셸 명령은 그 자체로 도구 실행이므로 로그에 남긴다.
 */
export function isSkillUsageBlock(block: ContentBlock): boolean {
  if (block.kind === "tool_use") return isSkillToolName(block.name);
  return block.kind === "tool_result" && launchedSkillName(block.text) !== null;
}

/** 라이브 채팅 항목 중 사용 스킬 카드가 대신 보여주는 항목인지. */
export function isSkillUsageEntry(entry: SkillToolEntry): boolean {
  return entry.type === "tool" && isSkillToolName(entry.name);
}

export function collectChatSkillUsages(entries: readonly SkillToolEntry[]): SkillUsage[] {
  const collected = new SkillUsageSet();
  for (const entry of entries) {
    if (entry.type !== "tool") continue;
    const status = entry.status ?? "running";
    if (isSkillToolName(entry.name)) {
      const invocation = parseSkillInvocation(entry.detail ?? "");
      const name = invocation.name || launchedSkillName(entry.output ?? "") || UNKNOWN_SKILL_NAME;
      collected.add(skillUsage(entry.id, name, "tool", status, { args: invocation.args }));
      continue;
    }
    for (const name of skillPathNames(entry.detail ?? "")) {
      collected.add(skillUsage(`${entry.id}:${name}`, name, "path", status));
    }
  }
  return collected.list();
}

export function collectTranscriptSkillUsages(items: readonly TranscriptItem[]): SkillUsage[] {
  const collected = new SkillUsageSet();
  for (const item of items) {
    for (const block of item.blocks) collectTranscriptBlock(collected, item.index, block);
  }
  return collected.list();
}

/**
 * 트랜스크립트 블록 한 개에서 읽어낼 수 있는 스킬 실행을 모은다. 블록 종류마다 이름을
 * 얻는 경로가 달라(도구 인자 / 읽은 경로 / 확인 문장 / 주입 레코드) 종류별 분기를 수집
 * 루프에서 떼어 둔다.
 */
function collectTranscriptBlock(collected: SkillUsageSet, index: number, block: ContentBlock): void {
  if (block.kind === "tool_use") {
    if (isSkillToolName(block.name)) {
      const invocation = parseSkillInvocation(block.inputJson);
      const name = invocation.name || UNKNOWN_SKILL_NAME;
      collected.add(skillUsage(`${index}:${invocation.name || "skill"}`, name, "tool", "completed", {
        args: invocation.args,
      }));
      return;
    }
    for (const name of skillPathNames(block.inputJson)) {
      collected.add(skillUsage(`${index}:${name}`, name, "path", "completed"));
    }
    return;
  }
  if (block.kind === "tool_result") {
    const name = launchedSkillName(block.text);
    if (name) {
      collected.add(skillUsage(`${index}:${name}`, name, "tool", block.isError ? "failed" : "completed"));
    }
    return;
  }
  // 주입된 SKILL.md는 앞선 실행 항목의 상세가 된다. 실행 항목을 못 만났으면 이 레코드만으로 만든다.
  if (block.kind === "context" && block.label.startsWith(SKILL_CONTEXT_LABEL_PREFIX)) {
    const name = block.label.slice(SKILL_CONTEXT_LABEL_PREFIX.length).trim();
    const injected = parseInjectedSkillBody(block.text);
    if (!collected.attach(name, injected)) {
      collected.add(skillUsage(`${index}:${name}`, name, "tool", "completed", injected));
    }
  }
}

/**
 * 이름이 같은 스킬 실행을 하나로 모은다. 같은 스킬 하나가 도구 호출·확인 문장·주입
 * 레코드 세 군데에 나타나므로, 그대로 쌓으면 한 번 쓴 스킬이 세 개로 보인다.
 */
class SkillUsageSet {
  private readonly usages: SkillUsage[] = [];

  add(usage: SkillUsage): void {
    const existing = this.usages.find((current) => current.name === usage.name);
    if (!existing) {
      this.usages.push(usage);
      return;
    }
    // 나중에 온 값이 더 확실할 때만 덮는다. 상태는 진행 중 → 완료·실패로만 나아간다.
    if (usage.args) existing.args = usage.args;
    if (usage.body) existing.body = usage.body;
    if (usage.directory) existing.directory = usage.directory;
    if (usage.detection === "tool") existing.detection = "tool";
    if (usage.status !== "running") existing.status = usage.status;
  }

  attach(name: string, injected: { directory: string; body: string }): boolean {
    const existing = this.usages.find((current) => current.name === name);
    if (!existing) return false;
    existing.directory = injected.directory || existing.directory;
    existing.body = injected.body || existing.body;
    return true;
  }

  list(): SkillUsage[] {
    return this.usages;
  }
}

/** Skill 도구 인자에서 스킬 이름과 지시를 뽑는다. 스트리밍 중이면 JSON이 아직 깨져 있다. */
function parseSkillInvocation(detail: string): { name: string; args: string } {
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

/** `Launching skill: <이름>` 확인 문장에서 스킬 이름을 뽑는다. */
export function launchedSkillName(text: string | undefined): string | null {
  const line = text?.trimStart().split("\n", 1)[0] ?? "";
  if (!line.startsWith(LAUNCH_PREFIX)) return null;
  const name = line.slice(LAUNCH_PREFIX.length).trim();
  return name || null;
}

/** CLI가 주입한 SKILL.md 레코드를 스킬 디렉터리와 본문으로 나눈다. */
export function parseInjectedSkillBody(text: string): { directory: string; body: string } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(BASE_DIRECTORY_PREFIX)) return { directory: "", body: trimmed };
  const breakAt = trimmed.indexOf("\n");
  if (breakAt < 0) {
    return { directory: trimmed.slice(BASE_DIRECTORY_PREFIX.length).trim(), body: "" };
  }
  return {
    directory: trimmed.slice(BASE_DIRECTORY_PREFIX.length, breakAt).trim(),
    body: trimmed.slice(breakAt + 1).trim(),
  };
}

/** 도구 인자 안에서 `skills/<이름>/SKILL.md`를 가리키는 경로의 스킬 이름들. */
function skillPathNames(detail: string): string[] {
  const names: string[] = [];
  for (const match of detail.matchAll(SKILL_PATH_PATTERN)) {
    const name = match[1];
    if (name && name !== "." && name !== ".." && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 스킬 목록에서 이 이름을 찾을 때 쓰는 키. 호출 이름에는 플러그인(`plugin:skill`)이나
 * 디렉터리(`apps/web:deploy`) 접두가 붙을 수 있는데, 원본 디렉터리 이름은 마지막 조각이다.
 */
function skillLookupKey(name: string): string {
  const tail = name.split(":").pop() ?? name;
  return tail.trim().toLowerCase();
}

/** 사용 스킬 이름에 대응하는 스킬 목록 항목. 내장 스킬처럼 목록에 없으면 null. */
export function matchSkillLibraryEntry<Entry extends { key: string; name: string; directoryName: string }>(
  entries: readonly Entry[],
  usageName: string,
): Entry | null {
  const key = skillLookupKey(usageName);
  if (!key) return null;
  return entries.find((entry) => [entry.key, entry.directoryName, entry.name]
    .some((candidate) => candidate.trim().toLowerCase() === key)) ?? null;
}

/** 카드 머리에 붙는 스킬 이름 미리보기. 같은 이름은 한 번만 쓴다. */
export function skillUsageNamePreview(usages: readonly SkillUsage[], limit = 3): string {
  const names = [...new Set(usages.map((usage) => usage.name))];
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit ? `${shown} 외 ${names.length - limit}개` : shown;
}
