import type { SessionFolder } from "../types";
import { bucketFor } from "./sequence.ts";

/**
 * 저장된 정리폴더 목록 한 벌을 트리로 세울 수 있는 자료로 바꾸는 규칙 — 못 믿을 상위 참조
 * 다듬기, ID 색인, 자매 순서대로 묶은 하위 색인.
 *
 * 이 모듈은 "목록을 어떻게 세우는가"만 다루고 "세운 것에 무엇을 묻는가"는 다루지 않는다.
 * 순회·파생값·캐시는 `sessionFolderTree.ts`가 이 결과 위에 얹는다. 둘이 한 파일에 있던
 * 동안에는 순회 규칙을 하나 손보러 들어와도 순환 상위 참조를 떼어 내는 규칙까지 함께
 * 스크롤해야 했고, 그 반대도 마찬가지였다 — 두 벌은 서로를 부르지 않는다.
 *
 * 여기 함수는 모두 순수하다. 같은 목록으로 두 번 부르지 않게 막는 일은 캐시를 쥔
 * `sessionFolderTree.ts`가 맡는다.
 */

export function indexById(folders: SessionFolder[]): Map<string, SessionFolder> {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

/**
 * 소문자로 내린 두 이름을 **코드포인트** 순서로 견준다. 백엔드
 * `session_folders.rs::sibling_order`가 `to_lowercase().cmp()`로 하는 일과 같다 — Rust의
 * 문자열 비교는 UTF-8 바이트순이고, 그것이 곧 코드포인트순이다.
 *
 * `localeCompare`를 쓰면 안 된다. 대조표는 한글을 라틴 앞에 두거나(ko-KR) 악센트를 밑글자
 * 옆에 붙이므로 백엔드가 세운 순서와 갈리고, 심지어 실행 장치의 기본 로케일까지 탄다.
 * 그러면 낙관적 재집계가 그린 목록과 다음 스냅숏이 그린 목록의 차례가 달라 화면이 한 번
 * 튄다. 자바스크립트의 `<`도 UTF-16 코드유닛 비교라 대리쌍(이모지)이 U+E000~U+FFFF보다
 * 앞서므로, 코드포인트를 직접 걸어 견준다.
 */
function compareLowercasedNames(left: string, right: string): number {
  const lower = left.toLowerCase();
  const other = right.toLowerCase();
  let index = 0;
  let cursor = 0;
  while (index < lower.length && cursor < other.length) {
    const point = lower.codePointAt(index) as number;
    const otherPoint = other.codePointAt(cursor) as number;
    if (point !== otherPoint) return point < otherPoint ? -1 : 1;
    index += point > 0xffff ? 2 : 1;
    cursor += otherPoint > 0xffff ? 2 : 1;
  }
  // 한쪽이 다른 쪽의 앞머리면 짧은 쪽이 먼저다.
  return Math.sign((lower.length - index) - (other.length - cursor));
}

/** 자매 폴더의 표시 순서. 정렬 순서가 앞선 것을 먼저, 같으면 이름 사전순(대소문자 무시)으로 세운다. */
function compareFolderOrder(left: SessionFolder, right: SessionFolder): number {
  return left.sortOrder - right.sortOrder || compareLowercasedNames(left.name, right.name);
}

export function childrenIndex(folders: SessionFolder[]): Map<string | null, SessionFolder[]> {
  const children = new Map<string | null, SessionFolder[]>();
  for (const folder of folders) {
    bucketFor(children, folder.parentId ?? null, () => []).push(folder);
  }
  for (const bucket of children.values()) {
    bucket.sort(compareFolderOrder);
  }
  return children;
}

/** 없어진 상위 참조와 순환을 최상위로 되돌려, 어떤 저장본이 와도 트리를 그릴 수 있게 한다. */
export function sanitizeParents(folders: SessionFolder[]): SessionFolder[] {
  const direct = directParents(folders);
  const rooted = rootedIds(direct);
  let changed = false;
  const sanitized = folders.map((folder) => {
    const parentId = rooted.has(folder.id) ? direct.get(folder.id) ?? null : null;
    if (parentId === (folder.parentId ?? null)) return folder;
    changed = true;
    return { ...folder, parentId };
  });
  return changed ? sanitized : folders;
}

/** 한 걸음 위. 자기 자신을 가리키거나 목록에 없는 상위 참조는 여기서 이미 최상위가 된다. */
function directParents(folders: SessionFolder[]): Map<string, string | null> {
  const known = new Set(folders.map((folder) => folder.id));
  const direct = new Map<string, string | null>();
  for (const folder of folders) {
    const parentId = folder.parentId && folder.parentId !== folder.id && known.has(folder.parentId)
      ? folder.parentId
      : null;
    direct.set(folder.id, parentId);
  }
  return direct;
}

/**
 * 상위 사슬이 최상위에서 끝나는 폴더. 여기 없는 폴더는 사슬이 순환으로 들어가 끝나지
 * 않으므로 상위 참조를 떼어 낸다 — 순환에 걸린 폴더뿐 아니라 그 순환 아래 매달린 폴더도
 * 함께 떼어야 트리를 그릴 수 있다.
 *
 * 폴더마다 사슬을 처음부터 다시 걸으며 방문 집합을 따로 세우던 동안에는, 한 사슬을 그
 * 아래 폴더 수만큼 되걷고 그때마다 `Set` 하나를 만들어 버렸다. 판정을 물려받으면 폴더
 * 하나가 사슬에 한 번만 올라간다.
 */
function rootedIds(direct: ReadonlyMap<string, string | null>): Set<string> {
  const rooted = new Set<string>();
  const detached = new Set<string>();
  for (const start of direct.keys()) {
    if (rooted.has(start) || detached.has(start)) continue;
    const path: string[] = [];
    const visited = new Set<string>();
    let cursor: string | null = start;
    // 배열은 판정 결과를 물려줄 순서를, 집합은 이번 사슬의 순환 여부를 맡는다.
    while (cursor !== null && !rooted.has(cursor) && !detached.has(cursor) && !visited.has(cursor)) {
      path.push(cursor);
      visited.add(cursor);
      cursor = direct.get(cursor) ?? null;
    }
    const reachesRoot = cursor === null || rooted.has(cursor);
    for (const id of path) (reachesRoot ? rooted : detached).add(id);
  }
  return rooted;
}
