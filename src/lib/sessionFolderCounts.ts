import type { SessionFolder, SessionSummary } from "../types";
import { bucketFor } from "./sequence.ts";
import { sessionKey } from "./sessionKey.ts";
import { foldUpward, folderTree, orderedFolders } from "./sessionFolderTree.ts";
import type { FolderTree } from "./sessionFolderTree.ts";

/**
 * 폴더에 담긴 세션을 세어 목록의 단계·직접 개수·하위 합계를 다시 채우는 규칙.
 *
 * 폴더 트리에 던지는 질의(`sessionFolders.ts`)와 한 파일에 있던 동안에는, 같은 세션이
 * 여러 폴더에 담겼을 때 하위 합계를 어떻게 세는지 보러 들어와도 상위 후보 거르기와 폴더
 * 경로 문구까지 함께 스크롤해야 했고 그 반대도 마찬가지였다. 둘은 바뀌는 이유가 다르다 —
 * 이쪽은 무엇을 몇 번 세는지가 바뀔 때, 저쪽은 화면이 트리에 묻는 것이 늘 때 바뀐다.
 *
 * 가르는 자리는 타입이 이미 말해 주고 있었다. 세션을 아는 것은 이 한 벌뿐이라, 떼어 내면
 * 질의 쪽은 `SessionSummary`도 세션 열쇠도 모르는 순수한 폴더 규칙만 남는다.
 *
 * 화면은 이 규칙을 `sessionFolders.ts` 이름으로 가져다 쓰므로 그쪽에서 다시 내보낸다.
 */

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
    const key = sessionKey(session.source, session.id);
    for (const folderId of session.meta.folderIds) {
      bucketFor(direct, folderId, () => new Set<string>()).add(key);
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
  return foldUpward<Set<string>>(tree, (folder, children) => {
    const sessionKeys = new Set(direct.get(folder.id) ?? []);
    for (const child of children) {
      if (child.folder.hidden) continue;
      for (const key of child.value) sessionKeys.add(key);
    }
    return sessionKeys;
  });
}
