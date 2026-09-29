import {
  isSkillToolName,
  launchedSkillName,
  parseInjectedSkillBody,
  parseSkillInvocation,
  skillContextLabelName,
  skillPathNames,
} from "./skillUsageParse.ts";
import type { ContentBlock, TranscriptItem } from "../types";

/**
 * 쓰는 쪽이 보는 입구는 이 모듈 하나다. 원문을 조각내는 문법은 수집과 읽을 것이 없어 따로
 * 두었지만, 채팅 흐름·트랜스크립트·활동 필터가 어느 판정이 어디로 갔는지 알아야 할 이유는
 * 없다 — 나눈 쪽의 사정이 호출부의 import 목록으로 새어 나가면 다음에 다시 나눌 때마다
 * 호출부를 함께 고쳐야 한다.
 */
export {
  isSkillToolName,
  launchedSkillName,
  parseInjectedSkillBody,
  skillContextLabelName,
  SKILL_CONTEXT_LABEL_PREFIX,
} from "./skillUsageParse.ts";

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

/**
 * 도구 호출 하나를 읽는 데 필요한 것. 라이브 채팅 항목과 트랜스크립트 블록은 필드 이름만
 * 다를 뿐 같은 재료를 들고 있어, 수집 지점마다 다른 것은 키를 만드는 방법과 인자에서
 * 이름을 못 얻었을 때의 대비뿐이다.
 */
interface SkillToolSource {
  /** 도구 이름. 스킬 실행 도구인지 여기서 가른다. */
  toolName: string | undefined;
  /** 도구 인자 원문. 스킬 이름·지시와 SKILL.md 경로를 모두 여기서 읽는다. */
  inputJson: string;
  status: string;
  /** 인자에서 이름을 못 얻었을 때 쓸 이름. 라이브 채팅은 확인 문장에서 얻는다. */
  fallbackName?: string;
  /** 항목 키. 유일성의 근거가 수집 지점마다 달라(항목 ID / 블록 순번) 밖에서 만든다. */
  usageId: (detection: SkillUsage["detection"], name: string) => string;
}

/**
 * 도구 호출 하나에서 읽어낼 스킬 실행. 스킬 실행 도구면 인자에서 이름과 지시를 뽑고,
 * 그 밖의 도구면 인자에 든 SKILL.md 경로에서 이름을 추정한다.
 *
 * 라이브 채팅과 트랜스크립트가 이 판정을 각자 적고 있었다. 두 벌이면 이름을 못 얻었을
 * 때의 대비나 경로 추정 규칙을 한쪽만 고쳐도, 같은 대화가 흐름과 기록에서 다른 스킬
 * 목록으로 보인다.
 */
function toolSkillUsages(source: SkillToolSource): SkillUsage[] {
  if (isSkillToolName(source.toolName)) {
    const invocation = parseSkillInvocation(source.inputJson);
    const name = invocation.name || source.fallbackName || UNKNOWN_SKILL_NAME;
    return [skillUsage(source.usageId("tool", invocation.name), name, "tool", source.status, {
      args: invocation.args,
    })];
  }
  return skillPathNames(source.inputJson)
    .map((name) => skillUsage(source.usageId("path", name), name, "path", source.status));
}

export function collectChatSkillUsages(entries: readonly SkillToolEntry[]): SkillUsage[] {
  const collected = new SkillUsageSet();
  for (const entry of entries) {
    if (entry.type !== "tool") continue;
    const usages = toolSkillUsages({
      toolName: entry.name,
      inputJson: entry.detail ?? "",
      status: entry.status ?? "running",
      fallbackName: launchedSkillName(entry.output ?? "") ?? "",
      usageId: (detection, name) => (detection === "tool" ? entry.id : `${entry.id}:${name}`),
    });
    collected.addAll(usages);
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
    const usages = toolSkillUsages({
      toolName: block.name,
      inputJson: block.inputJson,
      status: "completed",
      // 이름을 못 얻은 스킬 실행도 블록 순번으로는 구분된다.
      usageId: (_detection, name) => `${index}:${name || "skill"}`,
    });
    collected.addAll(usages);
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
  if (block.kind === "context") {
    const name = skillContextLabelName(block.label);
    if (name !== null) {
      collected.addInjected(`${index}:${name}`, name, parseInjectedSkillBody(block.text));
    }
  }
}

/**
 * 수집 지점이 알아낸 상세 중 "값이 있으면 더 확실한 것"으로 취급하는 필드. 빈 값은 아직
 * 모른다는 뜻이지 비우라는 뜻이 아니므로, 어느 지점에서 왔든 덮는 규칙이 같다.
 */
const SKILL_USAGE_DETAIL_FIELDS = ["args", "directory", "body"] as const;

type SkillUsageDetails = Partial<Pick<SkillUsage, (typeof SKILL_USAGE_DETAIL_FIELDS)[number]>>;

/**
 * 이름이 같은 스킬 실행을 하나로 모은다. 같은 스킬 하나가 도구 호출·확인 문장·주입
 * 레코드 세 군데에 나타나므로, 그대로 쌓으면 한 번 쓴 스킬이 세 개로 보인다.
 *
 * 합치는 규칙은 전부 이 집합이 소유한다. 상세를 덮는 규칙이 도구 항목과 주입 레코드에
 * 각각 적혀 있었고, 주입 레코드는 "붙여 보고 실패하면 새로 만든다"를 호출부가 두 걸음으로
 * 밟고 있었다. 그러면 상세 필드가 하나 늘 때 한쪽만 채워도 빌드가 통과하고, 같은 스킬이
 * 어느 경로로 먼저 왔느냐에 따라 상세가 비어 보인다.
 */
class SkillUsageSet {
  private readonly usages: SkillUsage[] = [];
  /**
   * 이름 → 이미 담은 항목. 합칠 상대를 찾는 일이 항목마다 목록 전체를 되훑고 있었다.
   * 트랜스크립트 수집은 블록 하나하나가 이 찾기를 부르므로, 긴 세션에서는 블록 수 × 담은
   * 항목 수만큼 훑는다. 담는 자리가 여기 하나뿐이라 색인은 목록과 어긋날 수 없고,
   * 순서는 목록이 그대로 들고 있어 `list`의 답도 달라지지 않는다.
   */
  private readonly byName = new Map<string, SkillUsage>();

  private find(name: string): SkillUsage | undefined {
    return this.byName.get(name);
  }

  /** 새 항목을 담는 유일한 자리. 목록과 색인이 함께 늘어야 둘이 어긋나지 않는다. */
  private push(usage: SkillUsage): void {
    this.usages.push(usage);
    this.byName.set(usage.name, usage);
  }

  /** 나중에 온 상세로 기존 항목을 채운다. 빈 값은 모른다는 뜻이라 덮지 않는다. */
  private mergeDetails(existing: SkillUsage, details: SkillUsageDetails): void {
    for (const field of SKILL_USAGE_DETAIL_FIELDS) {
      const value = details[field];
      if (value) existing[field] = value;
    }
  }

  add(usage: SkillUsage): void {
    const existing = this.find(usage.name);
    if (!existing) {
      this.push(usage);
      return;
    }
    this.mergeDetails(existing, usage);
    // 나중에 온 값이 더 확실할 때만 덮는다. 상태는 진행 중 → 완료·실패로만 나아간다.
    if (usage.detection === "tool") existing.detection = "tool";
    if (usage.status !== "running") existing.status = usage.status;
  }

  /** 도구 호출 하나에서 경로별 사용이 여러 건 잡혀도 같은 병합 규칙으로 차례로 넣는다. */
  addAll(usages: readonly SkillUsage[]): void {
    for (const usage of usages) this.add(usage);
  }

  /**
   * 주입된 SKILL.md를 같은 이름의 실행 항목 상세로 붙인다. 붙일 항목이 없으면 이
   * 레코드만으로 항목을 만든다. 이 레코드는 상세일 뿐이라, 붙일 항목이 있을 때는 그
   * 항목의 탐지 방식·상태를 건드리지 않는다(`add`와 다른 점은 이것 하나다).
   */
  addInjected(id: string, name: string, injected: { directory: string; body: string }): void {
    const existing = this.find(name);
    if (existing) {
      this.mergeDetails(existing, injected);
      return;
    }
    this.push(skillUsage(id, name, "tool", "completed", injected));
  }

  list(): SkillUsage[] {
    return this.usages;
  }
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
