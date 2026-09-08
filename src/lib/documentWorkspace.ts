import type { DocumentEntry, DocumentEntryPage } from "../types";

export interface DocumentTreePageState extends DocumentEntryPage {
  loaded: boolean;
}

export type DocumentTreeCache = ReadonlyMap<string, DocumentTreePageState>;

/**
 * 화면에 보여주는 액션 구분. 저장 형식에서 `runSkill`은 스킬을 고정한 `startChat`이지만,
 * 승인 규칙이 다르므로 편집 중에는 따로 다룬다.
 */
export type DocumentTriggerActionKind = "runSchedule" | "startChat" | "runSkill" | "executeWorkflow";

export interface DocumentTriggerDraftLike {
  name: string;
  /** 없으면 검사하지 않는다. 폴더 선택이 있는 편집기만 넘긴다. */
  rootId?: string | null;
  changeKinds: readonly string[];
  actionKind: DocumentTriggerActionKind | null;
  actionTargetId?: string | null;
  prompt?: string | null;
  /** 스킬 실행에서 고른 스킬 키. */
  skillId?: string | null;
  /** 고른 스킬의 현재 내용 지문. 공통 원본 목록에서 찾지 못하면 없다. */
  skillContentDigest?: string | null;
  /** 고정할 워크플로 승인 버전. 카탈로그에서 읽지 못하면 없다. */
  workflowApprovedVersion?: number | null;
  /** 전체 접근으로 자동 실행된다는 안내를 확인했는지. */
  fullAccessMode?: boolean;
  fullAccessAcknowledged?: boolean;
}

/**
 * A folder page is immutable from the caller's point of view. Replacing the first page drops
 * stale children, while pagination appends and de-duplicates entries by their canonical relative
 * path. The backend owns ordering, so replacing an existing entry never moves it in the list.
 */
export function mergeDocumentEntryPage(
  cache: DocumentTreeCache,
  parentPath: string,
  page: DocumentEntryPage,
  append: boolean,
): Map<string, DocumentTreePageState> {
  const next = new Map(cache);
  const previous = append ? cache.get(parentPath)?.entries ?? [] : [];
  const entries = mergeDocumentEntries(previous, page.entries);
  next.set(parentPath, {
    entries,
    nextCursor: page.nextCursor,
    total: page.total,
    loaded: true,
  });
  return next;
}

export function mergeDocumentEntries(
  current: readonly DocumentEntry[],
  incoming: readonly DocumentEntry[],
): DocumentEntry[] {
  const positions = new Map<string, number>();
  const merged = current.map((entry, index) => {
    positions.set(entry.relativePath, index);
    return entry;
  });

  for (const entry of incoming) {
    const index = positions.get(entry.relativePath);
    if (index === undefined) {
      positions.set(entry.relativePath, merged.length);
      merged.push(entry);
    } else {
      merged[index] = entry;
    }
  }
  return merged;
}

export function documentEntriesForParent(
  cache: DocumentTreeCache,
  parentPath: string,
): readonly DocumentEntry[] {
  return cache.get(parentPath)?.entries ?? [];
}

export function documentFileName(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() ?? relativePath;
}

/**
 * Frontend validation keeps the editor actionable; the Core remains authoritative. Target IDs
 * are required for schedule/workflow actions, while a new chat needs a non-empty prompt.
 * 스킬 실행은 고른 스킬의 현재 지문까지 있어야 저장할 수 있다. 지문이 곧 승인값이고,
 * 그 값 없이 저장하면 실행 시점에 무엇을 승인했는지 대조할 수 없기 때문이다.
 */
export function validateDocumentTriggerDraft(draft: DocumentTriggerDraftLike): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("트리거 이름을 입력하세요.");
  if (draft.rootId !== undefined && !(draft.rootId ?? "").trim()) errors.push("감시할 문서 폴더를 선택하세요.");
  if (draft.changeKinds.length === 0) errors.push("감지할 변경 종류를 하나 이상 선택하세요.");
  if (!draft.actionKind) {
    errors.push("실행할 액션을 선택하세요.");
  } else if (draft.actionKind === "startChat" || draft.actionKind === "runSkill") {
    if (!draft.prompt?.trim()) errors.push("새 채팅 요청 내용을 입력하세요.");
    if (draft.actionKind === "runSkill") {
      if (!draft.skillId?.trim()) errors.push("적용할 스킬을 선택하세요.");
      else if (!draft.skillContentDigest?.trim()) {
        errors.push("선택한 스킬의 현재 내용을 공통 원본에서 확인할 수 없어 승인값으로 고정할 수 없습니다.");
      }
    }
    if (draft.fullAccessMode && !draft.fullAccessAcknowledged) {
      errors.push("전체 접근 자동 실행 안내를 확인하세요.");
    }
  } else if (!draft.actionTargetId?.trim()) {
    errors.push(draft.actionKind === "runSchedule"
      ? "실행할 반복 요청을 선택하세요."
      : "실행할 시스템 워크플로를 선택하세요.");
  } else if (draft.actionKind === "executeWorkflow" && !((draft.workflowApprovedVersion ?? 0) >= 1)) {
    errors.push("승인할 워크플로 버전을 확인할 수 없습니다.");
  }
  return errors;
}
