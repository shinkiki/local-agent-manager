/**
 * C16. Git 상태 경로를 파일 탐색기 모양으로 묶는다. 이 트리는 화면 표현만 맡고 실제
 * stage/unstage 요청에는 잎이 들고 있는 원래 항목과 전체 경로를 그대로 사용한다.
 */

export interface GitFileTreeLeaf<T> {
  kind: "file";
  label: string;
  item: T;
}

export interface GitFileTreeFolder<T> {
  kind: "folder";
  path: string;
  label: string;
  count: number;
  children: GitFileTreeNode<T>[];
}

export type GitFileTreeNode<T> = GitFileTreeFolder<T> | GitFileTreeLeaf<T>;

interface MutableFolder<T> {
  path: string;
  entries: Array<MutableFolder<T> | GitFileTreeLeaf<T>>;
  folders: Map<string, MutableFolder<T>>;
}

function folder<T>(path: string): MutableFolder<T> {
  return { path, entries: [], folders: new Map() };
}

function finishFolder<T>(value: MutableFolder<T>): GitFileTreeFolder<T> {
  const children = value.entries.map((entry) => (
    "folders" in entry ? finishFolder(entry) : entry
  ));
  return {
    kind: "folder",
    path: value.path,
    label: value.path.slice(value.path.lastIndexOf("/") + 1),
    count: children.reduce((sum, child) => sum + (child.kind === "folder" ? child.count : 1), 0),
    children,
  };
}

export function buildGitFileTree<T>(items: readonly T[], pathOf: (item: T) => string): GitFileTreeNode<T>[] {
  const root = folder<T>("");
  for (const item of items) {
    const path = pathOf(item);
    const segments = path.split("/").filter(Boolean);
    const label = segments.pop() ?? path;
    let parent = root;
    for (const segment of segments) {
      let child = parent.folders.get(segment);
      if (child === undefined) {
        child = folder(parent.path === "" ? segment : `${parent.path}/${segment}`);
        parent.folders.set(segment, child);
        parent.entries.push(child);
      }
      parent = child;
    }
    parent.entries.push({ kind: "file", label, item });
  }
  return root.entries.map((entry) => ("folders" in entry ? finishFolder(entry) : entry));
}

export function collectGitFileFolderPaths<T>(nodes: readonly GitFileTreeNode<T>[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    paths.push(node.path, ...collectGitFileFolderPaths(node.children));
  }
  return paths;
}
