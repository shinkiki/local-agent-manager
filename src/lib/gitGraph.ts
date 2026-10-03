import type { GitCommit } from "../types";

const GIT_GRAPH_COLOR_COUNT = 8;

interface ActiveLane {
  sha: string;
  color: number;
}

export interface GitGraphSegment {
  from: number;
  to: number;
  start: "top" | "node";
  color: number;
}

export interface GitGraphRow {
  lane: number;
  color: number;
  continuesFromTop: boolean;
  segments: GitGraphSegment[];
  tails: Array<{ lane: number; color: number }>;
}

export interface GitGraphLayout {
  rows: GitGraphRow[];
  columns: number;
}

/**
 * C16-7 이력 응답의 부모 SHA만으로 화면용 git 그래프를 만든다. 활성 레인은 아직 목록에
 * 나오지 않은 커밋 하나를 가리키며, 첫 부모는 현재 색을 이어 받고 병합 부모는 새 색을 받는다.
 * 이미 활성인 부모로 합류할 때는 레인을 하나로 접어 GitLens 같은 합류선을 만든다.
 */
export function layoutGitGraph(commits: readonly Pick<GitCommit, "sha" | "parents">[]): GitGraphLayout {
  let nextColor = 0;
  let lanes: ActiveLane[] = [];
  let columns = 1;
  const rows = commits.map((commit) => {
    let lane = lanes.findIndex((active) => active.sha === commit.sha);
    const continuesFromTop = lane >= 0;
    if (lane < 0) {
      lane = lanes.length;
      lanes.push({ sha: commit.sha, color: nextColor++ % GIT_GRAPH_COLOR_COUNT });
    }

    const before = lanes;
    const current = before[lane];
    const after = before.filter((_, index) => index !== lane);
    let insertion = Math.min(lane, after.length);
    commit.parents.forEach((sha, parentIndex) => {
      if (after.some((active) => active.sha === sha)) return;
      after.splice(insertion, 0, {
        sha,
        color: parentIndex === 0 ? current.color : nextColor++ % GIT_GRAPH_COLOR_COUNT,
      });
      insertion += 1;
    });

    const segments: GitGraphSegment[] = [];
    before.forEach((active, from) => {
      if (from === lane) return;
      const to = after.findIndex((candidate) => candidate.sha === active.sha);
      if (to >= 0) segments.push({ from, to, start: "top", color: active.color });
    });
    commit.parents.forEach((parent) => {
      const to = after.findIndex((active) => active.sha === parent);
      // 합류선은 도착 레인의 색을 쓴다. 원류(현재 커밋) 색으로 그리면 이미 다른 색으로
      // 이어지고 있던 레인이 합류 지점에서만 색이 바뀌어 다른 갈래처럼 보인다.
      if (to >= 0) segments.push({ from: lane, to, start: "node", color: after[to].color });
    });

    columns = Math.max(columns, before.length, after.length);
    lanes = after;
    const tails = after.map((active, index) => ({ lane: index, color: active.color }));
    return { lane, color: current.color, continuesFromTop, segments, tails };
  });

  return { rows, columns };
}
