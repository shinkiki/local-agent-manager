/**
 * 브랜치 규칙 패턴 판정. 저장한 규칙이 지금 체크아웃된 브랜치에 걸리는지 화면에서
 * 표시하려고 쓴다. 실제 적용은 Rust 쪽 `claude_branch_plugins`가 같은 규칙으로 다시
 * 판정하므로, 여기 결과는 표시용이며 두 판정이 어긋나면 Rust 쪽이 맞다.
 *
 * `*`는 `/`를 포함해 아무 글자에나 맞는다.
 */
export function branchMatches(pattern: string, branch: string | null): boolean {
  if (branch === null) return false;
  if (!pattern.includes("*")) return pattern === branch;
  const segments = pattern.split("*");
  const first = segments[0] ?? "";
  if (!branch.startsWith(first)) return false;
  let rest = branch.slice(first.length);
  const tail = segments.slice(1);
  const suffix = tail.pop() ?? "";
  for (const segment of tail) {
    if (!segment) continue;
    const at = rest.indexOf(segment);
    if (at < 0) return false;
    rest = rest.slice(at + segment.length);
  }
  return suffix === "" || (rest.length >= suffix.length && rest.endsWith(suffix));
}
