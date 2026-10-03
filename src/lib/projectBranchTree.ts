/** A display-only tree for slash-separated git ref names (B1/B2). */
export interface ProjectBranchTreeNode {
  name: string;
  path: string;
  branches: string[];
  children: ProjectBranchTreeNode[];
}

/**
 * Groups branch names by slash into virtual folders. This intentionally only
 * transforms already-read names: it has no IPC or git side effects (B2).
 */
export function buildBranchTree(branches: readonly string[]): ProjectBranchTreeNode[] {
  const roots: ProjectBranchTreeNode[] = [];

  for (const branch of branches) {
    const parts = branch.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let level = roots;
    let path = "";
    for (const [index, part] of parts.entries()) {
      path = path ? `${path}/${part}` : part;
      let node = level.find((candidate) => candidate.name === part);
      if (!node) {
        node = { name: part, path, branches: [], children: [] };
        level.push(node);
      }
      if (index === parts.length - 1) node.branches.push(branch);
      level = node.children;
    }
  }

  const sort = (nodes: ProjectBranchTreeNode[]) => {
    nodes.sort((left, right) => left.name.localeCompare(right.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}
