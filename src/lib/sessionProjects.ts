import type { SessionSummary } from "../types";
import { displayPath } from "./displayPath.ts";

/**
 * 프로젝트 좁히기 칸에 세울 항목 하나. 값은 세션의 작업 경로고, 보이는 문구는 그 경로를
 * 사람이 읽을 꼴로 줄인 것이다. 화면 쪽에서 다시 줄이지 않도록 완성된 문구로 넘긴다.
 */
export interface SessionProjectOption {
  /** 필터 값으로 쓰는 세션의 작업 경로(`SessionListFilters.project`). */
  path: string;
  label: string;
  count: number;
}

/**
 * 세션이 이 프로젝트(작업 경로 문자열)에 속하는가. 작업 경로가 같거나, 작업 경로 밖에서
 * 그 프로젝트를 손댄 대화(`relatedProjects`)면 속한다. AIA는 늘 자기 작업공간에서 돌며
 * 프로젝트를 쓰기 루트로만 붙여 고치므로, 작업 경로만 보면 맡긴 프로젝트 작업이 그
 * 프로젝트 필터에서 빠진다.
 */
export function sessionInProject(session: SessionSummary, project: string): boolean {
  return session.cwd === project || (session.relatedProjects ?? []).includes(project);
}

/** 작업 경로의 마지막 조각. 관련 프로젝트만 있고 그 경로의 세션이 목록에 없을 때 이름으로 쓴다. */
function pathTail(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

/**
 * 지금 들고 있는 세션에서 프로젝트 좁히기 목록을 만든다. 등록 프로젝트 목록(`ProjectOption`)과
 * 달리 보관·AIA 세션도 세는데, 이 칸은 "새 작업을 시작할 프로젝트"가 아니라 "이 목록에
 * 들어 있는 세션을 가르는 축"이라 목록에 보이는 것은 모두 고를 수 있어야 하기 때문이다.
 * 개수는 그 항목을 골랐을 때 남는 세션 수와 같게 관련 프로젝트로 잡힌 세션까지 센다.
 * 이름은 그 경로에서 돈 세션의 프로젝트 이름을 먼저 쓴다. 세션이 많은 프로젝트를 앞에 둔다.
 */
export function collectSessionProjectOptions(sessions: readonly SessionSummary[]): SessionProjectOption[] {
  const options = new Map<string, SessionProjectOption>();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const known = options.get(session.cwd);
    if (known) {
      known.count += 1;
      continue;
    }
    options.set(session.cwd, { path: session.cwd, label: displayPath(session.project ?? session.cwd), count: 1 });
  }
  for (const session of sessions) {
    for (const project of new Set(session.relatedProjects ?? [])) {
      if (project === session.cwd) continue;
      const known = options.get(project);
      if (known) {
        known.count += 1;
        continue;
      }
      options.set(project, { path: project, label: displayPath(pathTail(project)), count: 1 });
    }
  }
  return [...options.values()].sort((left, right) => right.count - left.count);
}

/**
 * 직접 이어 둘 수 있는 프로젝트 후보. 사용자가 고른 작업 경로만 프로젝트다 — AIA·기본
 * 작업공간은 앱이 마련한 폴더라 빼고, 이 세션 자신의 작업 경로도 뺀다(이미 그 프로젝트다).
 */
export function linkableProjectOptions(
  sessions: readonly SessionSummary[],
  session: SessionSummary,
): SessionProjectOption[] {
  const eligible = sessions.filter((candidate) => !candidate.aiaWorkspace && !candidate.defaultWorkspace);
  return collectSessionProjectOptions(eligible)
    .filter((option) => option.path !== session.cwd)
    .sort((left, right) => left.label.localeCompare(right.label));
}
