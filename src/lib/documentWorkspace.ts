/**
 * 문서 트리가 화면에 들고 있는 폴더 쪽 캐시와 그 합치기 규칙.
 *
 * 트리거 편집기의 유효성 검사는 여기 있지 않다(`documentTriggerDraft.ts`). 바뀌는 이유가
 * 서로 달라 갈라 두었고, 화면 쪽 import 경로를 그대로 두려고 이름만 여기서 다시 내보낸다.
 */
import type { DocumentEntry, DocumentEntryPage } from "../types";

export {
  validateDocumentTriggerDraft,
  type DocumentTriggerActionKind,
  type DocumentTriggerDraftLike,
} from "./documentTriggerDraft.ts";

interface DocumentTreePageState extends DocumentEntryPage {
  loaded: boolean;
}

export type DocumentTreeCache = ReadonlyMap<string, DocumentTreePageState>;

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
  const previous = append ? documentEntriesForParent(cache, parentPath) : [];
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
  const merged = new Map<string, DocumentEntry>(
    current.map((entry) => [entry.relativePath, entry]),
  );
  for (const entry of incoming) {
    merged.set(entry.relativePath, entry);
  }
  return Array.from(merged.values());
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
