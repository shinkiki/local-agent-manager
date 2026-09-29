import type { SessionFolder } from "../types";
import {
  ancestorChain,
  folderDepth,
  folderTree,
  hiddenIds,
  subtreeHeight,
  subtreeIds,
  visibleSubtreeIds,
} from "./sessionFolderTree.ts";

/**
 * 정리폴더 트리에 던지는 질의. 색인·순회·캐시 같은 트리 자체의 규칙은
 * `sessionFolderTree.ts`가 맡고, 이 파일은 그 위에서 화면이 실제로 묻는 것만 다룬다.
 *
 * 폴더에 담긴 세션을 세는 일(`sessionFolderCounts.ts`)은 여기 없다. 그 한 벌만
 * `SessionSummary`와 세션 열쇠를 알고, 나머지 질의는 폴더 목록 하나만 보고 답한다 —
 * 세는 규칙이 같은 파일에 있던 동안에는 두 어휘가 섞여 어느 질의가 세션을 봐야 하는
 * 질의인지 함수 본문을 열어야 갈렸다. 화면이 세기까지 이 이름으로 가져다 쓰므로,
 * 그 창구는 여기서 다시 내보낸다.
 */

export { recountSessionFolders } from "./sessionFolderCounts.ts";

/** 정리폴더 트리에서 허용하는 최대 단계. Rust Core의 MAX_SESSION_FOLDER_DEPTH와 같다. */
export const MAX_SESSION_FOLDER_DEPTH = 5;

/** 트리 화면이 쓰는 상위 폴더 값. 최상위는 별도 항목으로 고른다. */
export const ROOT_FOLDER_VALUE = "root";

/**
 * 단계가 `parentDepth`인 폴더 밑에 높이 `subtreeHeight`짜리 하위 트리를 넣어도 최대 단계를
 * 넘지 않는지. 단계는 0부터 세므로 넣은 하위 트리의 가장 깊은 잎은 1부터 센 단계로
 * `parentDepth + subtreeHeight + 2`가 된다.
 *
 * 상위 후보 거르기와 하위 폴더 추가 버튼이 같은 규칙을 각자 적고 있었다. 한쪽은 트리에서
 * 읽은 단계에 하위 트리 높이를 더하고 다른 쪽은 저장된 `depth`에 바로 `+ 2`만 적어, 둘이
 * 같은 규칙이라는 것도 `+ 2`가 무엇인지도 식만 보고는 알 수 없었다. 0부터 세는 단계를
 * 1부터 세는 단계로 옮기는 자리가 하나면, 최대 단계를 손볼 때 볼 곳도 하나다.
 */
function fitsUnderParent(parentDepth: number, subtreeHeight: number): boolean {
  return parentDepth + subtreeHeight + 2 <= MAX_SESSION_FOLDER_DEPTH;
}

/** 이 폴더와 모든 하위 폴더의 ID. 삭제 범위처럼 숨김과 무관한 트리 전체가 필요할 때 쓴다. */
export function folderSubtreeIds(folders: SessionFolder[], id: string): Set<string> {
  return subtreeIds(folderTree(folders), id);
}

/**
 * 이 폴더를 골랐을 때 함께 보여 줄 하위 폴더 ID. 숨긴 하위 폴더 앞에서 멈추므로 상위
 * 폴더를 골라도 숨긴 폴더의 세션은 딸려 오지 않는다. 고른 폴더 자신은 숨김이어도
 * 포함한다 — 숨긴 폴더를 직접 누르는 것이 그 안을 보는 유일한 길이다.
 */
export function visibleFolderSubtreeIds(folders: SessionFolder[], id: string): Set<string> {
  return visibleSubtreeIds(folderTree(folders), id);
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
  const subtree = visibleSubtreeIds(tree, filter);
  return folderIds.some((folderId) => subtree.has(folderId));
}

/** 최상위부터 이어 붙인 폴더 경로. 같은 이름이 여러 단계에 있어도 구분된다. */
export function folderPathLabel(folders: SessionFolder[], id: string, separator = " / "): string {
  const chain = ancestorChain(folders, id);
  return chain.map((folder) => folder.name).reverse().join(separator);
}

/**
 * 옮길 폴더가 상위로 삼을 수 있는 후보. 자기 자신과 하위 트리는 순환이 되므로 빼고,
 * 하위 트리 높이를 더해 최대 단계를 넘는 후보도 뺀다.
 */
export function folderParentOptions(folders: SessionFolder[], id: string): SessionFolder[] {
  const tree = folderTree(folders);
  const blocked = subtreeIds(tree, id);
  const height = subtreeHeight(tree, id);
  return tree.folders.filter((folder) => (
    !blocked.has(folder.id) && fitsUnderParent(folderDepth(tree, folder.id), height)
  ));
}

/** 이 폴더 밑에 하위 폴더를 더 만들 수 있는지. 새로 만드는 폴더는 잎이라 높이가 0이다. */
export function canAddChildFolder(folder: SessionFolder): boolean {
  return fitsUnderParent(folder.depth, 0);
}
