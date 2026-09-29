import { useCallback, useEffect, useMemo, useState } from "react";
import { setProjectActive } from "./lib/ipc";
import { notifyNewProjects } from "./lib/webNotifications";
import { errorText } from "./lib/errorText";
import type { ManagerSnapshot, ProjectRegistryEntry } from "./types";
import type { PopoutRequest } from "./lib/popout";

/**
 * 새로 감지된 프로젝트 알림창 한 벌 — 대기 목록, 웹 알림, "활성 유지/제외/모두 유지/나중에"
 * 네 결정, 그 사이의 진행 표시와 오류 배너, 그리고 알림창을 띄울지 말지까지를 훅 하나가
 * 맡는다. App 본문에는 상태 둘·useMemo 하나·useEffect 하나·useCallback 넷이 다른 관심사
 * 사이에 흩어져 있어, "왜 이 창이 다시 뜨는가"를 고치려면 일곱 자리를 함께 읽어야 했다.
 * 화면이 쓰는 것은 목록과 네 창구, 그리고 띄울지 여부뿐이라 미뤄 둔 경로 집합은 밖에서
 * 보이지 않아도 된다.
 */
export function useNewProjectsPrompt({ snapshot, popoutRequest, onDecided }: {
  snapshot: ManagerSnapshot | null;
  popoutRequest: PopoutRequest | null;
  onDecided: () => void;
}) {
  // "나중에"로 닫은 프로젝트의 경로를 기억해, 그중 하나가 설정에서 정리돼 대기 집합이
  // 줄기만 해도 다시 띄우지 않고, 미뤄 둔 적 없는 프로젝트가 더 감지될 때만 다시 띄운다.
  // 집합 키 한 줄로 비교하면 줄어든 집합도 "달라진 집합"이 되어 방금 미룬 알림창이 되살아난다.
  const [dismissedPaths, setDismissedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [busyPath, setBusyPath] = useState<string | null>(null);
  /**
   * 마지막 결정이 실패한 사유. **전역 오류 배너로 보내지 않는다** — 그 자리는 본문 영역이라
   * 알림창의 백드롭 아래에 깔리고, 알림창을 보고 있는 사용자에게는 닿지 않았다(QA #98).
   * '모두 활성 유지'는 건별로 저장하므로 어디까지 적용됐는지도 함께 들고, 문장은 화면
   * 언어를 아는 알림창이 짓는다.
   */
  const [failure, setFailure] = useState<NewProjectsFailure | null>(null);

  const pendingProjects = useMemo(() => snapshot?.pendingProjects ?? [], [snapshot?.pendingProjects]);
  useEffect(() => {
    if (!snapshot || popoutRequest) return;
    void notifyNewProjects(pendingProjects);
  }, [pendingProjects, popoutRequest, snapshot]);

  // 결정은 "어느 줄을 잠글지"와 "무엇을 저장할지"만 다르고, 진행 표시·자원 화면
  // 무효화·오류 배너는 같다. 그 한 벌을 여기서만 적는다.
  const runDecision = useCallback(async (
    lockedPath: string,
    total: number,
    /** 적용에 성공한 건수를 돌려준다. 실패했으면 그때까지의 건수를 담아 던진다. */
    apply: () => Promise<void>,
  ) => {
    setBusyPath(lockedPath);
    setFailure(null);
    try {
      await apply();
      onDecided();
    } catch (cause) {
      setFailure({
        message: errorText(cause),
        applied: cause instanceof PartialDecisionError ? cause.applied : 0,
        total,
      });
      // 실패했을 때는 자원 화면을 다시 읽지 않는다. '모두 활성 유지'가 중간에 멈추면 앞선
      // 건은 이미 저장돼 있지만, 그 갱신은 이 알림창을 닫아 남은 줄을 다시 정할 자리를
      // 없앤다. 어디까지 적용됐는지는 아래 `failure.applied`로 알리고, 목록 갱신은
      // 사용자가 남은 줄을 정하거나 창을 닫은 뒤에 이뤄진다.
    } finally {
      setBusyPath(null);
    }
  }, [onDecided]);

  const decide = useCallback((entry: ProjectRegistryEntry, active: boolean) => (
    runDecision(entry.path, 1, async () => { await setProjectActive({ path: entry.path, active }); })
  ), [runDecision]);

  const keepAll = useCallback(() => runDecision("*", pendingProjects.length, async () => {
    // 건별 저장이라 중간에서 멈추면 앞쪽은 이미 적용된 상태로 남는다. 되돌릴 방법이 없으므로
    // 어디까지 갔는지를 실패에 실어 알림창이 적게 한다(QA #98).
    let applied = 0;
    for (const entry of pendingProjects) {
      try {
        await setProjectActive({ path: entry.path, active: true });
      } catch (cause) {
        throw new PartialDecisionError(errorText(cause), applied);
      }
      applied += 1;
    }
  }), [pendingProjects, runDecision]);

  const defer = useCallback(() => {
    setDismissedPaths((current) => new Set([...current, ...pendingProjects.map((entry) => entry.path)]));
  }, [pendingProjects]);

  const visible = Boolean(snapshot) && !popoutRequest
    && pendingProjects.some((entry) => !dismissedPaths.has(entry.path));

  return { pendingProjects, busyPath, visible, failure, decide, keepAll, defer };
}

/** 알림창이 적을 결정 실패 한 벌. `applied`는 '모두 활성 유지'가 멈추기 전까지 저장된 건수다. */
export interface NewProjectsFailure {
  message: string;
  applied: number;
  total: number;
}

/** 건별 반복 중에 멈춘 실패. 어디까지 적용됐는지를 함께 나른다. */
class PartialDecisionError extends Error {
  readonly applied: number;

  constructor(message: string, applied: number) {
    super(message);
    this.name = "PartialDecisionError";
    this.applied = applied;
  }
}
