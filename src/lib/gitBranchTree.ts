import type { GitBranch } from "../types";

/**
 * 브랜치 이름을 `/`로 갈라 폴더 트리로 읽는다(B4). 저장소 하나에 `round/lane-L01`,
 * `round/lane-L02`, `develop` …가 한 줄씩 평평하게 깔리면 목록 길이가 그대로
 * 레인 수가 되어 왼쪽 열이 브랜치만으로 가득 찬다. 그래서 같은 접두사끼리 폴더로
 * 묶고 기본은 접어 둔다 — 펼침 상태는 화면이 따로 기억한다.
 *
 * 폴더는 **이름의 접두사일 뿐** git의 무엇도 아니다. 그래서 여기서는 트리 모양만
 * 만들고 전환·리베이스 같은 동작은 잎에 달린 `GitBranch`가 그대로 들고 간다.
 *
 * 폴더는 `/` 조각마다 한 단계씩 선다. `origin/feat/login`은 `origin` › `feat` › `login`이다.
 * 예외는 맨 위 단계 하나다 — 브랜치가 하나뿐인 최상위 이름 공간(`origin/develop` 하나만
 * 있는 원격 등)은 폴더로 접지 않고 전체 이름의 잎으로 둔다. 접힌 기본 상태에서 그 브랜치가
 * 화면에서 통째로 사라지지 않게 하려는 것이다. 이미 폴더 안이면 상위 폴더가 개수를 보여 주므로
 * 브랜치 하나짜리 하위 접두사도 폴더로 세운다. 예전에는 이 규칙이 모든 단계에 걸려
 * `origin/feat/x`가 `origin` 아래 `feat/x` 한 줄로 뭉개졌다.
 *
 * 루트에서는 `/` 없는 직접 브랜치를 먼저, 경로형 브랜치와 접두사 폴더를 그다음에 둔다.
 * 두 묶음 안에서는 들어온 차례를 그대로 둔다. Core가 `--sort=-committerdate`로 최근 순으로
 * 잘라 보내므로(`branchesTruncated`) 여기서 이름순으로 다시 세우면 "최근 N개"가 알파벳 한
 * 토막으로 바뀌어, 방금 쓰던 브랜치가 목록 끝으로 밀린다.
 */

export interface GitBranchTreeLeaf {
  kind: "branch";
  /** 트리에서 보이는 조각. 보통 `round/lane-L01`의 `lane-L01`이다. */
  label: string;
  branch: GitBranch;
}

export interface GitBranchTreeFolder {
  kind: "folder";
  /** `round`, `origin/feature` 꼴의 전체 접두사. 펼침 상태의 열쇠다. */
  path: string;
  /** 이 단계의 표시 이름. `origin/feature`라면 `origin`, 그 아래 `feature`가 각각 선다. */
  label: string;
  children: GitBranchTreeNode[];
  /** 하위 폴더까지 합한 브랜치 수. 접힌 채로도 몇 개가 들었는지 보이게 한다. 최상위 폴더는
   * 늘 2 이상이고, 하위 폴더는 1일 수 있다. */
  count: number;
  /** 이 폴더 아래에 현재 HEAD가 있다. 접힌 폴더에 표식을 다는 데 쓴다. */
  hasHead: boolean;
}

export type GitBranchTreeNode = GitBranchTreeFolder | GitBranchTreeLeaf;

interface MutableFolder {
  kind: "folder";
  path: string;
  /** 폴더와 잎을 한 줄에 섞어 **들어온 차례대로** 담는다. */
  entries: MutableNode[];
  /** 같은 접두사를 다시 만났을 때 찾아 쓰는 색인. `entries`와 같은 것을 가리킨다. */
  index: Map<string, MutableFolder>;
}

type MutableNode = MutableFolder | GitBranchTreeLeaf;

function emptyFolder(path: string): MutableFolder {
  return { kind: "folder", path, entries: [], index: new Map() };
}

function countBranches(node: GitBranchTreeNode): number {
  return node.kind === "folder" ? node.count : 1;
}

function hasHeadBranch(node: GitBranchTreeNode): boolean {
  return node.kind === "folder" ? node.hasHead : node.branch.isHead;
}

/** 폴더 아래 첫 브랜치. 브랜치가 하나뿐인 최상위 폴더를 잎으로 되돌릴 때만 부르므로 늘 하나 나온다. */
function firstLeaf(nodes: GitBranchTreeNode[]): GitBranchTreeLeaf | null {
  for (const node of nodes) {
    const found = node.kind === "branch" ? node : firstLeaf(node.children);
    if (found !== null) return found;
  }
  return null;
}

function toNode(folder: MutableFolder, prefixLength: number, topLevel: boolean): GitBranchTreeNode {
  const children = buildChildren(folder);
  const count = children.reduce((total, child) => total + countBranches(child), 0);
  const only = topLevel && count === 1 ? firstLeaf(children) : null;
  if (only !== null) {
    // 브랜치가 하나뿐인 최상위 이름 공간은 폴더로 만들지 않는다. 폴더로 두면 접힌 기본
    // 상태에서 그 브랜치가 화면에서 아예 사라지고, 펼쳐도 한 줄뿐이라 접고 펼 이유가 없다.
    return { kind: "branch", label: only.branch.name.slice(prefixLength), branch: only.branch };
  }
  return {
    kind: "folder",
    path: folder.path,
    label: folder.path.slice(prefixLength),
    children,
    count,
    hasHead: children.some(hasHeadBranch),
  };
}

function buildChildren(folder: MutableFolder): GitBranchTreeNode[] {
  const prefixLength = folder.path === "" ? 0 : folder.path.length + 1;
  const topLevel = folder.path === "";
  const nodes = folder.entries.map((entry) => (entry.kind === "folder" ? toNode(entry, prefixLength, topLevel) : entry));
  if (folder.path !== "") return nodes;
  // 이름순 정렬은 Core의 최근순을 잃는다. 루트의 직접 브랜치만 안정 분할해서 먼저 훑고,
  // `/`가 있는 외자식과 접두사 폴더는 원래 순서를 지킨 채 그다음에 둔다.
  const directBranches = nodes.filter((node) => node.kind === "branch" && !node.branch.name.includes("/"));
  const pathEntries = nodes.filter((node) => node.kind === "folder" || node.branch.name.includes("/"));
  return [...directBranches, ...pathEntries];
}

export function buildGitBranchTree(branches: GitBranch[]): GitBranchTreeNode[] {
  const root = emptyFolder("");
  for (const branch of branches) {
    const segments = branch.name.split("/").filter((segment) => segment !== "");
    // 이름이 `/`로만 된 ref는 git에 없지만, 들어오면 잎 하나로 두고 트리를 깨지 않는다.
    const label = segments.length === 0 ? branch.name : segments[segments.length - 1];
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let next = folder.index.get(segment);
      if (next === undefined) {
        next = emptyFolder(folder.path === "" ? segment : `${folder.path}/${segment}`);
        folder.index.set(segment, next);
        folder.entries.push(next);
      }
      folder = next;
    }
    folder.entries.push({ kind: "branch", label, branch });
  }
  return buildChildren(root);
}

/** 트리에 있는 모든 폴더 경로. 일괄 펴기가 켤 대상이다. */
export function collectGitBranchFolderPaths(nodes: GitBranchTreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (list: GitBranchTreeNode[]) => {
    for (const node of list) {
      if (node.kind !== "folder") continue;
      paths.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return paths;
}
