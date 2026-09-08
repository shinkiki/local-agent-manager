import type { SessionFolder, SessionSummary } from "../types";
import { sessionKey } from "./sessionKey.ts";
import {
  ancestorChain,
  folderDepth,
  folderTree,
  hiddenIds,
  leafFirstFolders,
  orderedFolders,
  rawIndexById,
  subtreeHeight,
  subtreeIds,
} from "./sessionFolderTree.ts";
import type { FolderTree } from "./sessionFolderTree.ts";

/**
 * 정리폴더 트리에 던지는 질의. 색인·순회·캐시 같은 트리 자체의 규칙은
 * `sessionFolderTree.ts`가 맡고, 이 파일은 그 위에서 화면이 실제로 묻는 것만 다룬다.
 */

/** 정리폴더 트리에서 허용하는 최대 단계. Rust Core의 MAX_SESSION_FOLDER_DEPTH와 같다. */
export const MAX_SESSION_FOLDER_DEPTH = 5;

/** 트리 화면이 쓰는 상위 폴더 값. 최상위는 별도 항목으로 고른다. */
export const ROOT_FOLDER_VALUE = "root";

/**
 * 백엔드와 같은 규칙으로 폴더 목록을 트리 순서로 다시 세운다. 세션 메타를 화면에서
 * 낙관적으로 고칠 때 폴더 개수를 다시 조회하지 않고도 단계·직접 개수·하위 합계를
 * 맞추려고 쓴다. 상위 참조가 사라졌거나 순환이면 최상위로 되돌린다.
 */
export function recountSessionFolders(folders: SessionFolder[], sessions: SessionSummary[]): SessionFolder[] {
  const tree = folderTree(folders);
  const ordered = orderedFolders(tree);
  const direct = directSessionKeys(sessions);
  const subtree = subtreeSessionKeys(tree, direct);
  return ordered.map(({ folder, depth }) => ({
    ...folder,
    depth,
    sessionCount: direct.get(folder.id)?.size ?? 0,
    totalSessionCount: subtree.get(folder.id)?.size ?? 0,
  }));
}

/** 폴더 ID별로 그 폴더에 직접 담긴 세션 키. 같은 세션이 여러 폴더에 담겨 있으면 각각 센다. */
function directSessionKeys(sessions: SessionSummary[]): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const session of sessions) {
    for (const folderId of session.meta.folderIds) {
      const bucket = direct.get(folderId) ?? new Set<string>();
      bucket.add(sessionKey(session.source, session.id));
      direct.set(folderId, bucket);
    }
  }
  return direct;
}

/**
 * 하위 합계는 잎에서 뿌리 방향으로 접어 올린다. 같은 세션이 한 트리의 여러 폴더에 담겨
 * 있어도 한 번만 센다. 숨긴 하위 폴더는 그 하위 트리째 빼서, 상위 폴더 배지가 숨긴
 * 세션을 다시 드러내지 않게 한다.
 */
function subtreeSessionKeys(
  tree: FolderTree,
  direct: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const subtree = new Map<string, Set<string>>();
  for (const { folder } of leafFirstFolders(tree)) {
    const sessionKeys = new Set(direct.get(folder.id) ?? []);
    for (const child of tree.children.get(folder.id) ?? []) {
      if (child.hidden) continue;
      for (const key of subtree.get(child.id) ?? []) sessionKeys.add(key);
    }
    subtree.set(folder.id, sessionKeys);
  }
  return subtree;
}

/** 이 폴더와 모든 하위 폴더의 ID. 삭제 범위처럼 숨김과 무관한 트리 전체가 필요할 때 쓴다. */
export function folderSubtreeIds(folders: SessionFolder[], id: string): Set<string> {
  return subtreeIds(folderTree(folders), id, false);
}

/**
 * 이 폴더를 골랐을 때 함께 보여 줄 하위 폴더 ID. 숨긴 하위 폴더 앞에서 멈추므로 상위
 * 폴더를 골라도 숨긴 폴더의 세션은 딸려 오지 않는다. 고른 폴더 자신은 숨김이어도
 * 포함한다 — 숨긴 폴더를 직접 누르는 것이 그 안을 보는 유일한 길이다.
 */
export function visibleFolderSubtreeIds(folders: SessionFolder[], id: string): Set<string> {
  return subtreeIds(folderTree(folders), id, true);
}

/**
 * 숨긴 폴더와 그 하위 폴더의 ID. 숨김은 하위로 이어지므로, 숨긴 폴더 밑의 폴더는
 * 스스로 숨김이 아니어도 전체 목록에서 함께 빠진다.
 */
export function hiddenFolderIds(folders: SessionFolder[]): Set<string> {
  return hiddenIds(folderTree(folders));
}

/**
 * 숨긴 폴더에만 담겨 전체 목록에서 빼야 하는 세션인지. 보이는 폴더에도 담겨 있으면
 * 그 폴더에서 계속 보여야 하므로 빼지 않고, 어느 폴더에도 없는 세션은 미분류라 그대로 둔다.
 */
export function hiddenByFolders(folderIds: string[], hidden: Set<string>): boolean {
  return folderIds.length > 0 && folderIds.every((folderId) => hidden.has(folderId));
}

/**
 * 지금 걸린 폴더 필터가 이 세션을 보여 주는지. 목록 필터와 같은 규칙을 쓰므로, 바깥에서
 * 연 세션이 폴더 때문에 가려졌는지 판정할 때 이 함수 하나만 보면 된다.
 */
export function folderFilterShows(
  folders: SessionFolder[],
  filter: string,
  folderIds: string[],
): boolean {
  if (filter === "unfiled") return folderIds.length === 0;
  const tree = folderTree(folders);
  if (filter === "all") return !hiddenByFolders(folderIds, hiddenIds(tree));
  const subtree = subtreeIds(tree, filter, true);
  return folderIds.some((folderId) => subtree.has(folderId));
}

/** 최상위부터 이어 붙인 폴더 경로. 같은 이름이 여러 단계에 있어도 구분된다. */
export function folderPathLabel(folders: SessionFolder[], id: string, separator = " / "): string {
  const chain = ancestorChain(rawIndexById(folders), id);
  return chain.reverse().map((folder) => folder.name).join(separator);
}

/**
 * 옮길 폴더가 상위로 삼을 수 있는 후보. 자기 자신과 하위 트리는 순환이 되므로 빼고,
 * 하위 트리 높이를 더해 최대 단계를 넘는 후보도 뺀다.
 */
export function folderParentOptions(folders: SessionFolder[], id: string): SessionFolder[] {
  const tree = folderTree(folders);
  const blocked = subtreeIds(tree, id, false);
  const height = subtreeHeight(tree, id);
  return tree.folders.filter((folder) => (
    !blocked.has(folder.id) && folderDepth(tree, folder.id) + height + 2 <= MAX_SESSION_FOLDER_DEPTH
  ));
}

/** 이 폴더 밑에 하위 폴더를 더 만들 수 있는지. */
export function canAddChildFolder(folder: SessionFolder): boolean {
  return folder.depth + 2 <= MAX_SESSION_FOLDER_DEPTH;
}
