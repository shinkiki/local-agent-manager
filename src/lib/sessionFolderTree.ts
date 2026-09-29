import type { SessionFolder } from "../types";
import { bucketFor } from "./sequence.ts";
import { childrenIndex, indexById, sanitizeParents } from "./sessionFolderIndex.ts";

/**
 * 정리폴더 목록 한 벌 위에 세운 조회 색인. 트리 질의는 모두 이 한 벌을 나눠 쓴다 —
 * 함수마다 같은 목록을 다시 다듬고 다시 묶으면, 한 화면에서 여러 질의를 이어 부를 때
 * 같은 계산이 그만큼 되풀이된다.
 *
 * 이 모듈은 "어떤 트리인가"만 다루고 "무엇을 묻는가"는 다루지 않는다. 경로 문구·상위
 * 후보 같은 질의는 `sessionFolders.ts`가, 폴더에 담긴 세션 수 세기는
 * `sessionFolderCounts.ts`가 이 원시 연산 위에 얹는다. 색인·순회·캐시가 질의와 한 파일에
 * 섞여 있던 동안에는 질의를 하나 손볼 때마다 캐시 수명과 순회 규칙까지 함께 읽어야 했다.
 *
 * 목록을 트리로 세우는 규칙 자체(상위 참조 다듬기·ID 색인·자매 순서)는 `sessionFolderIndex.ts`가
 * 맡는다. 여기 남은 것은 세워진 트리 위의 캐시·순회·파생값이다.
 */
export type FolderTree = {
  /** 없어진 상위 참조와 순환을 최상위로 되돌린 목록. */
  folders: SessionFolder[];
  byId: Map<string, SessionFolder>;
  /** 상위 폴더 ID(최상위는 null)별 하위 폴더. 화면에 그릴 순서로 정렬돼 있다. */
  children: Map<string | null, SessionFolder[]>;
  /**
   * 트리 전체를 훑어야 나오는 파생값. 처음 필요할 때 세우고 같은 트리에서 다시 쓴다.
   * 트리 자체가 목록 한 벌마다 새로 만들어지므로, 여기 매달아 두면 목록이 바뀔 때
   * 함께 버려진다 — 파생값만 따로 무효화할 일이 없다.
   */
  derived: Partial<DerivedFolderData>;
  /** 물어본 폴더 몫만 세워 두는 파생값. 수명은 [`derived`]와 같다. */
  keyed: { [Key in keyof KeyedFolderData]?: Map<string, KeyedFolderData[Key]> };
};

/** 최상위부터의 전위 순회 결과 한 항목. 화면에 그리는 순서와 같다. */
type OrderedFolder = { folder: SessionFolder; depth: number };

/**
 * 트리 한 벌에서 뽑아 두는 파생값의 전체 목록. 여기 한 줄을 더하면 `derive`가 캐시 자리를
 * 함께 만들어 준다 — 파생값마다 `null` 초기값·읽기·되쓰기 세 줄을 손으로 적던 동안에는
 * 그중 되쓰기 한 줄만 빠져도 캐시가 조용히 꺼진 채로 돌았다.
 */
type DerivedFolderData = {
  ordered: OrderedFolder[];
  leafFirst: OrderedFolder[];
  hidden: Set<string>;
  depths: Map<string, number>;
  heights: Map<string, number>;
};

/**
 * 폴더 하나를 물을 때마다 그 폴더 몫만 세우는 파생값. 트리 전체를 미리 훑지 않는다는 점이
 * [`DerivedFolderData`]와 다르므로 표를 갈라 둔다 — 한 표에 섞여 있던 동안에는 파생값의
 * 타입이 `Map<string, …>`이라는 것만으로 "폴더별 값"인지 "지도 한 벌이 곧 그 파생값"인지
 * 갈리지 않아, 단계 표(`depths`)와 하위 트리 캐시(`subtrees`)가 같은 모양으로 나란히 섰다.
 * 실제로 둘을 꺼내 쓰는 모양은 달라서, 폴더별 값 쪽만 호출부가 캐시 지도를 직접 받아
 * 열쇠를 하나 더 파고들어야 했다.
 */
type KeyedFolderData = {
  subtrees: Set<string>;
  visibleSubtrees: Set<string>;
};

/** 파생값 한 종류를 처음 필요할 때만 세운다. 값 자체는 각 파생 함수가 정한다. */
function derive<K extends keyof DerivedFolderData>(
  tree: FolderTree,
  key: K,
  compute: () => DerivedFolderData[K],
): DerivedFolderData[K] {
  const cached = tree.derived[key];
  if (cached !== undefined) return cached;
  const value = compute();
  tree.derived[key] = value;
  return value;
}

/**
 * 폴더별 파생값 하나를 그 폴더에 대해 처음 물었을 때만 세운다. 캐시 지도를 세우는 일과
 * 그 안에서 열쇠를 찾는 일이 두 걸음으로 나뉘어 호출부에 적혀 있었다 — 두 질의가 같은 두
 * 줄을 각자 적으면서, 그중 지도를 받는 지역 변수 이름이 이 모듈의 목록 캐시([`cache`])를
 * 가려 같은 이름이 한 파일에서 서로 다른 두 캐시를 가리켰다.
 */
function deriveByKey<K extends keyof KeyedFolderData>(
  tree: FolderTree,
  key: K,
  id: string,
  compute: () => KeyedFolderData[K],
): KeyedFolderData[K] {
  const cached = tree.keyed[key];
  const buckets = cached ?? new Map<string, KeyedFolderData[K]>();
  if (!cached) tree.keyed[key] = buckets;
  return bucketFor(buckets, id, compute);
}

/**
 * 목록 한 벌에 대해 세운 파생 자료. 화면 한 번을 그리는 동안 경로 문구·필터 판정·상위
 * 후보가 같은 배열로 이 모듈을 폴더 수만큼 다시 부르는데, 부를 때마다 상위 참조를 다시
 * 다듬고 색인을 다시 세우면 폴더 수의 제곱만큼 일이 늘어난다. 스냅샷 목록은 통째로 갈아
 * 끼우고 제자리에서 고치지 않으므로, 배열 참조가 같으면 파생 자료도 같다.
 *
 * 두 색인을 따로 두는 이유는 보는 목록이 다르기 때문이다 — 트리 질의는 다듬은 목록을,
 * 경로 문구는 저장된 상위 참조를 그대로 읽는다. 한 벌만 두면 둘 중 하나의 규칙이 바뀐다.
 */
type FolderCache = {
  input: readonly SessionFolder[];
  tree: FolderTree | null;
  rawById: Map<string, SessionFolder> | null;
};

let cache: FolderCache | null = null;

function cacheFor(folders: SessionFolder[]): FolderCache {
  if (!cache || cache.input !== folders) cache = { input: folders, tree: null, rawById: null };
  return cache;
}

export function folderTree(folders: SessionFolder[]): FolderTree {
  const entry = cacheFor(folders);
  if (!entry.tree) {
    const sanitized = sanitizeParents(folders);
    entry.tree = {
      folders: sanitized,
      byId: indexById(sanitized),
      children: childrenIndex(sanitized),
      derived: {},
      keyed: {},
    };
  }
  return entry.tree;
}

/** 다듬지 않은 목록 그대로의 색인. 경로 문구만 쓰므로 트리 색인과 섞지 않는다. */
function rawIndexById(folders: SessionFolder[]): Map<string, SessionFolder> {
  const entry = cacheFor(folders);
  if (!entry.rawById) entry.rawById = indexById(folders);
  return entry.rawById;
}

/**
 * 트리를 그리는 순서대로 편다. 상위가 하위보다 먼저 오고, 뒤집으면 잎이 먼저 오므로
 * 위에서 아래로 물려주는 계산과 아래에서 위로 접어 올리는 계산이 이 한 벌을 같이 쓴다.
 */
export function orderedFolders(tree: FolderTree): OrderedFolder[] {
  return derive(tree, "ordered", () => {
    const ordered: OrderedFolder[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const folder of tree.children.get(parentId) ?? []) {
        ordered.push({ folder, depth });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return ordered;
  });
}

/**
 * 잎이 먼저 오는 순서. 접어 올리는 계산은 모두 `foldUpward`를 거쳐 이 한 벌을 나눠 쓴다 —
 * 호출마다 `[...orderedFolders(tree)].reverse()`를 적던 동안에는 같은 배열 복사가 하위 트리
 * 높이와 폴더별 세션 수 두 곳에서 따로 되풀이됐다.
 */
function leafFirstFolders(tree: FolderTree): OrderedFolder[] {
  return derive(tree, "leafFirst", () => [...orderedFolders(tree)].reverse());
}

/** 접어 올리는 계산이 보는 하위 폴더 하나 — 폴더 자체와 그 폴더까지 접힌 값. */
type FoldedChild<T> = { folder: SessionFolder; value: T };

/**
 * 잎에서 뿌리 방향으로 트리를 한 번만 훑어 폴더별 값을 접어 올린다. 잎이 먼저 오는 순서를
 * 쓰므로 `fold`가 불릴 때 그 폴더의 하위 폴더 값은 모두 정해져 있다.
 *
 * 하위 트리 높이와 폴더별 세션 수가 각자 같은 순회를 적고 있었다 — 잎 우선 순서를 돌리고,
 * 자식 목록을 `tree.children`에서 다시 꺼내고, 방금 접은 값을 자기 지도에서 되읽는 세 걸음이
 * 두 파일에 같은 모양으로 있었다. 그중 한쪽만 자식을 걸러도(예: 숨김) 그것이 순회 규칙의
 * 차이인지 계산의 차이인지 두 루프를 나란히 놓고서야 알 수 있었다. 순회를 여기서 맡으면
 * 남는 것은 "자식 값으로 내 값을 어떻게 만드는가" 한 줄이다.
 */
export function foldUpward<T>(
  tree: FolderTree,
  fold: (folder: SessionFolder, children: readonly FoldedChild<T>[]) => T,
): Map<string, T> {
  const values = new Map<string, T>();
  for (const { folder } of leafFirstFolders(tree)) {
    // 잎 우선 순서라 하위 폴더는 이미 접혀 있다. `has`로 보는 것은 규칙의 일부다 — 값이
    // 없다는 것과 값이 `undefined`라는 것을 섞으면 T가 undefined를 담는 순간 자식이 사라진다.
    const children: FoldedChild<T>[] = [];
    for (const child of tree.children.get(folder.id) ?? []) {
      if (values.has(child.id)) {
        children.push({ folder: child, value: values.get(child.id) as T });
      }
    }
    values.set(folder.id, fold(folder, children));
  }
  return values;
}

/**
 * 이 폴더와 그 아래 모든 폴더. 숨김과 무관하게 트리 전체를 본다.
 *
 * 숨김에서 멈추는지 아닌지를 불리언 인자 하나로 받던 동안에는, 호출부에 `true`·`false`
 * 리터럴만 남아 어느 쪽이 숨긴 폴더를 걷어내는 쪽인지 이 파일을 열어야 알 수 있었다.
 * 두 질의는 부르는 자리도 뜻도 달라서, 고르는 일을 이름이 하게 둔다.
 */
export function subtreeIds(tree: FolderTree, id: string): Set<string> {
  return deriveByKey(tree, "subtrees", id, () => collectSubtree(tree, id, false));
}

/**
 * 숨긴 하위 폴더 앞에서 멈춘 하위 트리. 숨김은 하위로 이어지므로 그 폴더 아래는 통째로
 * 빠진다. 시작 폴더 자신은 숨김이어도 포함한다 — 판정은 내려갈 때만 본다.
 */
export function visibleSubtreeIds(tree: FolderTree, id: string): Set<string> {
  return deriveByKey(tree, "visibleSubtrees", id, () => collectSubtree(tree, id, true));
}

function collectSubtree(tree: FolderTree, id: string, stopAtHidden: boolean): Set<string> {
  const collected = new Set<string>([id]);
  const frontier = [id];
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const child of tree.children.get(current) ?? []) {
      if (collected.has(child.id)) continue;
      if (stopAtHidden && child.hidden) continue;
      collected.add(child.id);
      frontier.push(child.id);
    }
  }
  return collected;
}

export function hiddenIds(tree: FolderTree): Set<string> {
  return derive(tree, "hidden", () => {
    const hidden = new Set<string>();
    // 전위 순회라 상위가 항상 먼저 판정된다. 그래서 상속은 상위 ID 하나만 되돌아보면 된다.
    for (const { folder } of orderedFolders(tree)) {
      const inherited = folder.parentId != null && hidden.has(folder.parentId);
      if (inherited || folder.hidden) hidden.add(folder.id);
    }
    return hidden;
  });
}

/**
 * 자기 자신부터 최상위까지의 폴더 사슬. 다듬지 않은 목록이 와도 순환에서 멈춘다.
 *
 * 어느 색인을 보고 걷는지는 이 질의의 규칙이지 호출부가 고를 일이 아니다. 색인을 인자로
 * 받던 동안에는 그 규칙이 모듈 밖으로 새어 나가, 이 모듈이 색인 세우기까지 따로 내보내고
 * 유일한 호출부가 둘을 맞춰 끼워야 했다. 그러면 다른 질의가 하나 붙을 때 다듬은 색인을
 * 넘겨도 타입이 통과해, 없어진 상위에서 멈춰야 할 사슬이 조용히 최상위까지 이어진다.
 */
export function ancestorChain(folders: SessionFolder[], id: string): SessionFolder[] {
  const byId = rawIndexById(folders);
  const chain: SessionFolder[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(id);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}

/**
 * 최상위를 0으로 센 이 폴더의 단계. 트리에 없는 ID는 최상위로 본다 — 다듬은 목록에서
 * 사라진 폴더를 묻는 자리는 그 폴더를 어디로도 옮길 수 없다고 읽는다.
 */
export function folderDepth(tree: FolderTree, id: string): number {
  return folderDepths(tree).get(id) ?? 0;
}

/** 이 폴더 밑으로 몇 단계가 더 있는지. 잎이면 0이다. */
export function subtreeHeight(tree: FolderTree, id: string): number {
  return subtreeHeights(tree).get(id) ?? 0;
}

/**
 * 폴더별 단계. 전위 순회가 이미 단계를 함께 내보내므로 그 결과를 색인으로 옮긴다.
 * 폴더마다 상위 사슬을 다시 걷던 동안에는 상위 후보를 고르는 한 번의 호출이 폴더 수와
 * 단계 수의 곱만큼 사슬을 되풀이해 걸었다.
 */
function folderDepths(tree: FolderTree): Map<string, number> {
  return derive(tree, "depths", () => {
    const depths = new Map<string, number>();
    for (const { folder, depth } of orderedFolders(tree)) depths.set(folder.id, depth);
    return depths;
  });
}

/**
 * 폴더별 하위 트리 높이. 전위 순회를 뒤집으면 하위가 항상 먼저 나오므로, 재귀로 같은
 * 하위 트리를 여러 번 내려가지 않고 한 벌을 아래에서 위로 접어 올린다.
 */
function subtreeHeights(tree: FolderTree): Map<string, number> {
  return derive(tree, "heights", () => foldUpward<number>(tree, (_folder, children) => (
    children.reduce((height, child) => Math.max(height, child.value + 1), 0)
  )));
}
