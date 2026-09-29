/**
 * 다이어그램을 별도 창으로 넘기는 통로.
 *
 * 기존 팝아웃(AIA·채팅·세션)은 주소에 대상 id만 실으면 새 창이 백엔드에서 그 대상을 읽어
 * 온다. 다이어그램은 백엔드에 없는 값 — 대화 한 줄이나 문서 안의 원문 — 이라 그렇게 할 수
 * 없다. 원문을 주소에 실으면 2만 자까지 오는 값을 URL에 밀어넣게 되므로, 같은 origin이
 * 공유하는 저장소에 두고 주소에는 그 열쇠만 싣는다(네이티브 창도 브라우저 팝업도 같은
 * origin이다).
 *
 * 열쇠는 원문의 해시다. 그래서 같은 다이어그램을 다시 열면 새 창이 늘지 않고 이미 열린
 * 창이 앞으로 온다 — 다른 팝아웃과 같은 규칙이다.
 */

import type { AppLocale } from "../types";

const STORAGE_PREFIX = "agent-manager.diagram-popout.";

/** 저장·조회·정리가 모두 같은 키 규칙을 쓰도록 접두사 조립을 한곳에 둔다. */
function diagramStorageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

/** 저장소에 남겨 둘 원문 개수. 새 창은 새로고침될 수 있어 읽고 지우지는 않는다. */
const MAX_STASHED = 8;

/** 저장소에 적히는 모양. 정리 순서를 위해 저장 시각까지 함께 남긴다. */
interface StoredDiagram {
  source: string;
  /** 창을 연 화면의 UI 언어. 새 창은 백엔드를 부르지 않아 설정을 읽을 수 없다. */
  locale: AppLocale;
  savedAt: number;
}

/** 새 창이 읽어 가는 값. */
interface StashedDiagram {
  source: string;
  locale: AppLocale;
}

/** 저장 레코드의 JSON 해석. 읽기와 오래된 항목 정리가 같은 실패 규칙을 쓴다. */
function parseStoredDiagram(raw: string | null): Partial<StoredDiagram> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<StoredDiagram>;
  } catch {
    return null;
  }
}

/**
 * 원문의 열쇠. FNV-1a 32비트를 16진수로 쓴다 — 창 label 규칙(영숫자·-·_)에 그대로 맞고,
 * 충돌해도 결과는 "같은 그림을 같은 창에서 연다"라서 손해가 없다.
 */
export function diagramPopoutId(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 원문을 저장소에 두고 열쇠를 돌려준다. 저장소가 막혀 있으면(사파리 프라이빗) 열쇠만
 * 돌려준다 — 새 창은 원문을 찾지 못했다고 알리고, 본 창의 그림은 그대로다.
 *
 * UI 언어를 함께 싣는다. 새 창은 백엔드를 부르지 않아 언어 설정을 읽을 수 없으므로,
 * 창을 연 화면의 언어를 그대로 물려받게 하는 것이 유일하게 어긋나지 않는 값이다.
 */
export function stashDiagramSource(storage: Storage, source: string, locale: AppLocale = "ko", now = Date.now()): string {
  const id = diagramPopoutId(source);
  const entry: StoredDiagram = { source, locale, savedAt: now };
  try {
    storage.setItem(diagramStorageKey(id), JSON.stringify(entry));
    pruneStashedDiagrams(storage, id);
  } catch {
    // 저장에 실패해도 열쇠는 같다. 이미 저장돼 있던 원문이라면 새 창은 그것을 읽는다.
  }
  return id;
}

/** 저장해 둔 원문과 언어. 없거나 깨졌으면 null. 언어를 못 읽으면 한국어로 떨어진다. */
export function readStashedDiagram(storage: Storage, id: string): StashedDiagram | null {
  try {
    const stored = parseStoredDiagram(storage.getItem(diagramStorageKey(id)));
    if (typeof stored?.source !== "string" || !stored.source) return null;
    return { source: stored.source, locale: stored.locale ?? "ko" };
  } catch {
    return null;
  }
}

interface StashedDiagramEntry {
  key: string;
  savedAt: number;
}

/** 방금 저장한 값을 빼고, 정리 순서를 판단할 수 있는 저장 항목만 모은다. */
function stashedDiagramEntries(storage: Storage, keepKey: string): StashedDiagramEntry[] {
  const entries: StashedDiagramEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX) || key === keepKey) continue;
    const savedAt = Number(parseStoredDiagram(storage.getItem(key))?.savedAt) || 0;
    entries.push({ key, savedAt });
  }
  return entries;
}

/** 오래된 원문을 지운다. 방금 저장한 것은 언제나 남긴다. */
function pruneStashedDiagrams(storage: Storage, keepId: string): void {
  const keepKey = diagramStorageKey(keepId);
  const entries = stashedDiagramEntries(storage, keepKey);
  entries.sort((left, right) => right.savedAt - left.savedAt);
  for (const stale of entries.slice(MAX_STASHED - 1)) storage.removeItem(stale.key);
}

/** 새 창 주소의 쿼리. `parseDiagramPopoutId`와 한 쌍이다. */
export function diagramPopoutSearch(id: string): string {
  const params = new URLSearchParams();
  params.set("popout", "diagram");
  params.set("diagram", id);
  return `?${params.toString()}`;
}

/**
 * 주소가 다이어그램 창을 가리키면 그 열쇠를, 아니면 null. 앱 셸을 띄우기 전에 이것부터
 * 보므로, 형식이 어긋나면 일반 화면으로 떨어져야 한다.
 */
export function parseDiagramPopoutId(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("popout") !== "diagram") return null;
  const id = params.get("diagram");
  return id && /^[0-9a-f]{1,16}$/.test(id) ? id : null;
}

/** 같은 그림을 다시 열면 창을 늘리지 않도록 열쇠에서 고정 창 이름을 만든다. */
export function diagramPopoutWindowName(id: string): string {
  return `popout-diagram-${id}`;
}
