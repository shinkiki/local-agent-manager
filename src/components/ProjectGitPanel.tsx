import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, FoldVertical, Folder, GitBranch as GitBranchIcon, GitCompareArrows, Layers, Link2, RefreshCw, Search, Sparkles, UnfoldVertical, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { UiText } from "../lib/i18nLocale";
import { formatDate, formatRelative } from "../lib/format";
import { displayPath } from "../lib/displayPath";
import {
  commitProjectGit,
  fetchProjectGit,
  getProjectBranchComparison,
  getProjectGitCommitFiles,
  getProjectGitDiff,
  getProjectGitLog,
  getProjectGitOverview,
  getProjectGitStatus,
  pullProjectGit,
  pushProjectGit,
  reapplyProjectOverlays,
  rebaseProjectGit,
  stageProjectGitPaths,
  stashProjectGit,
  switchProjectGitBranch,
  unstageProjectGitPaths,
} from "../lib/ipc";
import { gitChangeCode, gitChangeKindCode, gitChangeLabelKey, groupGitStatus, type GitChangeLabelKey } from "../lib/gitStatus";
import { layoutGitGraph, type GitGraphRow } from "../lib/gitGraph";
import { buildGitBranchTree, collectGitBranchFolderPaths, type GitBranchTreeLeaf, type GitBranchTreeNode } from "../lib/gitBranchTree";
import { filterGitCommits } from "../lib/gitCommitSearch";
import { buildGitFileTree, type GitFileTreeNode } from "../lib/gitFileTree";
import { canRequestGitConflictAia, gitConflictAiaPrompt } from "../lib/gitConflictAiaPrompt";
import { MAX_AIA_REVIEW_COMMITS, buildAiaCommitReviewRequest, resolveAiaReviewSelection } from "../lib/projectAiaHandoff";
import type {
  GitActionReceipt,
  GitBranch,
  GitBranchComparison,
  GitCommitFile,
  GitCommit,
  GitCommitFiles,
  GitDiff,
  GitInProgress,
  GitLog,
  GitOverview,
  GitPullMode,
  GitRepositoryInfo,
  GitStash,
  GitStatus,
  GitStatusEntry,
  GitUnavailableReason,
  GitWorktree,
  ProjectOverlayReapply,
} from "../types";
import { EmptyState, ErrorBanner, LoadingState, NoticeBanner, useBusyAction, useConfirm, useEscapeToClose, useOutsidePointerToClose, type ConfirmRequest } from "./Shared";
import { useRequestGeneration } from "./DocumentTreePane";
import { GitDiffModal } from "./GitDiffModal";

/**
 * 프로젝트 화면의 형상관리 탭(C16). 부모가 활성 등록 프로젝트를 골라 `projectPath`로 넘기고,
 * 탭이 숨겨져도 패널은 DOM에 남으므로 모든 조회는 `active`에 묶는다 — 켜지는 순간과 변경
 * 뒤에만 읽고, 주기 조회는 하지 않는다.
 *
 * 변경은 영수증(`GitActionReceipt`)으로 결말을 돌려준다. 충돌·거절은 `succeeded: false`이지
 * 오류가 아니므로 배너에 그대로 적고, 성공·실패 어느 쪽이든 개요를 다시 읽는다(충돌한
 * 리베이스는 `inProgress`를 바꾼다).
 */
export function ProjectGitPanel({ projectPath, active, onRequestAiaPrompt }: {
  projectPath: string;
  active: boolean;
  onRequestAiaPrompt: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const git = useProjectGit(projectPath, active);
  const {
    overview, status, loading, loadError, receipt, busy, actionError,
    overlayReapply, overlayReapplyError,
  } = git;

  // C20. 로그인한 채널은 모두 데스크톱과 같은 권한이다 — 읽기 전용 원격 모드도, 호스트 전용
  // 명령도 없다. 그래서 화면이 잠그는 조건은 "다른 변경이 돌고 있다" 하나뿐이다.
  const locked = busy !== null;

  if (overview === null && loading) return <div className="git-panel-shell"><LoadingState /></div>;
  if (overview === null) {
    return (
      <div className="git-panel-shell">
        {loadError && <ErrorBanner message={loadError} />}
        <button className="button" type="button" onClick={() => void git.refresh()} disabled={loading}>
          <RefreshCw size={14} />{text("새로고침", "Refresh")}
        </button>
      </div>
    );
  }
  if (overview.repository === null) {
    return (
      <div className="git-panel-shell">
        <UnavailableState reason={overview.unavailableReason} detail={overview.unavailableDetail} />
        <button className="button" type="button" onClick={() => void git.refresh()} disabled={loading}>
          <RefreshCw size={14} />{text("새로고침", "Refresh")}
        </button>
      </div>
    );
  }

  const repository = overview.repository;
  const conflictedFiles = status?.entries.filter((entry) => entry.unmerged !== null).map((entry) => entry.path) ?? [];
  // 기본은 읽기·분석이다(점검표 A6). 버튼 하나가 작업 트리를 바꿀 권한까지 넘기지 않는다.
  const requestAiaConflictHelp = (operation: string, conflicts: readonly string[], kind: "conflict" | "blocked" = "conflict") => {
    onRequestAiaPrompt(gitConflictAiaPrompt({ projectPath, operation, conflictedFiles: conflicts, kind }));
  };
  return (
    <div className="git-panel-shell">
      {loadError && <ErrorBanner message={loadError} />}
      {actionError && <ErrorBanner message={actionError} />}
      <OverviewHeader
        projectPath={projectPath}
        repository={repository}
        locked={locked}
        loading={loading}
        confirm={confirm}
        git={git}
      />
      {repository.inProgress && <InProgressBanner inProgress={repository.inProgress} conflictedFiles={conflictedFiles} locked={locked} confirm={confirm} onRequestAiaConflictHelp={requestAiaConflictHelp} git={git} />}
      {receipt && <ReceiptBanner receipt={receipt} showAiaHelp={repository.inProgress === null} onRequestAiaConflictHelp={requestAiaConflictHelp} />}
      {overlayReapply && <OverlayReapplyBanner result={overlayReapply} />}
      {overlayReapplyError && <OverlayReapplyFailureBanner reason={overlayReapplyError} />}
      <div className="git-panel">
        <div className="git-panel-aside">
          <ChangesSection status={status} locked={locked} git={git} />
          <CommitBox status={status} locked={locked} git={git} />
          <BranchesSection repository={repository} locked={locked} confirm={confirm} git={git} />
          <WorktreesSection worktrees={repository.worktrees} />
          <StashesSection repository={repository} locked={locked} confirm={confirm} git={git} />
        </div>
        <div className="git-panel-main">
          <BranchComparisonSection repository={repository} git={git} />
          <LogSection git={git} onRequestAiaPrompt={onRequestAiaPrompt} />
        </div>
      </div>
      {git.selectedDiff && (
        <GitDiffModal
          target={{ projectPath, ...git.selectedDiff }}
          diff={git.diff}
          error={git.diffError}
          loading={git.diffLoading}
          onClose={() => git.selectDiff(null)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 상태 훅

type GitBusyKey = "fetch" | "pull" | "push" | "rebase" | "stage" | "commit" | "switch" | "stash";

interface DiffSelection {
  path: string;
  staged: boolean;
  originalPath: string | null;
  /** 커밋 SHA면 그 커밋의 변경, null이면 작업 트리·인덱스. */
  commit: string | null;
  /** B9. 비교 요약에서 연 파일. 둘 다 있으면 `<from>...<to>` 범위이고 commit·staged는 쓰지 않는다. */
  rangeFrom?: string | null;
  rangeTo?: string | null;
}

const LOG_PAGE = 30;

interface ProjectGitState {
  projectPath: string;
  overview: GitOverview | null;
  status: GitStatus | null;
  loading: boolean;
  loadError: string | null;
  receipt: GitActionReceipt | null;
  busy: GitBusyKey | null;
  actionError: string | null;
  selectedDiff: DiffSelection | null;
  diff: GitDiff | null;
  diffError: string | null;
  diffLoading: boolean;
  log: GitLog | null;
  logError: string | null;
  logLoading: boolean;
  /** 앱이 시작한 Git 작업 뒤 보관된 overlay를 다시 넣은 결과(C19-3). 없으면 null. */
  overlayReapply: ProjectOverlayReapply | null;
  overlayReapplyError: string | null;
  refresh: () => Promise<void>;
  mutate: (key: GitBusyKey, action: () => Promise<GitActionReceipt>) => Promise<GitActionReceipt | null>;
  selectDiff: (selection: DiffSelection | null) => void;
  loadMoreLog: () => void;
}

function useProjectGit(projectPath: string, active: boolean): ProjectGitState {
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<GitActionReceipt | null>(null);
  const [overlayReapply, setOverlayReapply] = useState<ProjectOverlayReapply | null>(null);
  const [overlayReapplyError, setOverlayReapplyError] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [log, setLog] = useState<GitLog | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const { busy, error: actionError, run } = useBusyAction<GitBusyKey>();
  const overviewGeneration = useRequestGeneration();
  const diffGeneration = useRequestGeneration();
  const logGeneration = useRequestGeneration();

  const refresh = useCallback(() => {
    const generation = overviewGeneration.open();
    setLoading(true);
    return overviewGeneration.latest(
      generation,
      () => Promise.all([getProjectGitOverview(projectPath), getProjectGitStatus(projectPath)]),
      {
        onResult: ([nextOverview, nextStatus]) => {
          setOverview(nextOverview);
          setStatus(nextStatus);
          setLoadError(null);
        },
        onError: setLoadError,
        onSettled: () => setLoading(false),
      },
    );
  }, [overviewGeneration, projectPath]);

  // 켜지는 순간(처음 마운트 포함)에만 읽는다. 숨겨진 채로는 아무것도 요청하지 않는다.
  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  const loadLog = useCallback((skip: number) => {
    const generation = logGeneration.open();
    setLogLoading(true);
    return logGeneration.latest(
      generation,
      () => getProjectGitLog({ projectPath, limit: LOG_PAGE, skip }),
      {
        onResult: (page) => {
          setLogError(null);
          setLog((current) => skip === 0 || current === null ? page : { ...page, commits: [...current.commits, ...page.commits] });
        },
        onError: setLogError,
        onSettled: () => setLogLoading(false),
      },
    );
  }, [logGeneration, projectPath]);

  // 개요가 새로 올 때마다(켜짐·변경 뒤·새로고침) 이력을 첫 페이지부터 다시 읽는다.
  useEffect(() => {
    if (!active || overview === null) return;
    if (overview.repository === null || overview.repository.head.unborn) {
      setLog(null);
      return;
    }
    void loadLog(0);
  }, [active, overview, loadLog]);

  const loadMoreLog = useCallback(() => {
    if (log === null || !log.hasMore || logLoading) return;
    void loadLog(log.commits.length);
  }, [log, logLoading, loadLog]);

  // 고른 파일의 diff. 작업 트리 대상은 상태가 다시 오면(스테이지 뒤) 같은 선택을 다시 읽고,
  // 커밋 대상은 내용이 고정이라 상태와 무관하다.
  useEffect(() => {
    // 범위 diff 는 커밋처럼 내용이 고정이라 작업 트리 상태를 기다리지 않는다.
    const fixed = selectedDiff?.commit !== null || (selectedDiff?.rangeFrom != null && selectedDiff?.rangeTo != null);
    if (!active || selectedDiff === null || (!fixed && status === null)) {
      if (selectedDiff === null) setDiff(null);
      return;
    }
    const generation = diffGeneration.open();
    setDiffLoading(true);
    void diffGeneration.latest(
      generation,
      () => getProjectGitDiff({ projectPath, path: selectedDiff.path, originalPath: selectedDiff.originalPath, staged: selectedDiff.staged, commit: selectedDiff.commit, rangeFrom: selectedDiff.rangeFrom ?? null, rangeTo: selectedDiff.rangeTo ?? null }),
      {
        onResult: (next) => { setDiff(next); setDiffError(null); },
        onError: setDiffError,
        onSettled: () => setDiffLoading(false),
      },
    );
  }, [active, selectedDiff, status, projectPath, diffGeneration]);

  /**
   * HEAD를 옮기는 작업(C19-3이 이름까지 적은 switch·pull·rebase). 이 뒤에만 overlay를
   * 자동으로 다시 넣는다 — stage·commit·fetch는 작업 트리의 로컬 변경을 걷어내지 않으므로
   * 다시 넣을 것이 없고, 매번 부르면 git 작업마다 저장소 잠금을 한 번씩 더 잡게 된다.
   */
  const movesHead = (key: GitBusyKey) => key === "switch" || key === "pull" || key === "rebase";

  const mutate = useCallback(async (key: GitBusyKey, action: () => Promise<GitActionReceipt>) => {
    let result: GitActionReceipt | null = null;
    await run(key, async () => {
      setReceipt(null);
      setOverlayReapply(null);
      setOverlayReapplyError(null);
      // C19-3의 실행 규칙 7. Git 작업이 **실패했는가**를 재적용에 그대로 전한다. 다시 넣는
      // 일은 성공한 뒤와 같지만, 실패한 switch는 HEAD를 움직이지 않았으므로 영수증이
      // "브랜치를 옮긴 뒤"라고 적으면 거짓이다. 복구였다는 사실은 호출부만 안다.
      let gitFailed = false;
      try {
        result = await action();
        setReceipt(result);
      } catch (error) {
        gitFailed = true;
        throw error;
      } finally {
        // C19-3. 앱이 시작한 Git 작업 뒤의 자동 재적용. **성공·실패를 가리지 않는다** —
        // 실패한 switch는 HEAD를 움직이지 않지만 스냅샷으로 빠져 있던 로컬 변경은 그대로
        // 빠져 있고, C19-3은 그 경우 "이전 브랜치에서 재적용"하라고 적었다.
        //
        // 재적용 실패가 git 작업의 결말을 덮지 않게 따로 가둔다. 브랜치는 이미 옮겨졌고
        // 그 영수증이 사용자가 기다리던 답이다 — overlay가 막혔다는 사실은 그 옆에 적는다.
        if (movesHead(key)) {
          try {
            setOverlayReapply(await reapplyProjectOverlays({ projectPath, recovery: gitFailed }));
          } catch (error) {
            // 조용히 삼키지 않는다(C19-3). 재적용까지 실패하면 사용자는 실패한 Git 작업과
            // **빠져 있는 로컬 변경**을 동시에 떠안는데, 화면이 아무 말도 하지 않으면 그
            // 사실을 알 길이 없다. patch는 앱 데이터에 그대로 있으므로 할 일은 그 둘을
            // 알리는 것이다.
            setOverlayReapply(null);
            setOverlayReapplyError(error instanceof Error ? error.message : String(error));
          }
        }
        await refresh();
      }
    });
    return result;
  }, [run, refresh, projectPath]);

  return {
    projectPath, overview, status, loading, loadError, receipt, busy, actionError,
    selectedDiff, diff, diffError, diffLoading, log, logError, logLoading, overlayReapply,
    overlayReapplyError,
    refresh, mutate, selectDiff: setSelectedDiff, loadMoreLog,
  };
}

/**
 * 다시 넣기 **호출 자체**가 실패했을 때의 한 줄(C19-3의 실행 규칙 7).
 *
 * 예전에는 이 자리가 `setOverlayReapply(null)` 하나였다. 그러면 사용자는 실패한 Git 영수증과
 * 빠져 있는 로컬 변경을 동시에 떠안는데 화면은 아무 말도 하지 않는다 — overlay가 없애려던
 * 수고보다 나쁜 상태다. patch는 앱 데이터에 그대로 있으므로 여기서 할 일은 그 둘을 알리고
 * overlay 탭으로 보내는 데까지다.
 */
function OverlayReapplyFailureBanner({ reason }: { reason: string }) {
  const { text } = useI18n();
  return (
    <div
      className="notice-banner overlay-reapply overlay-receipt-conflict"
      role="note"
      data-overlay-reapply="failed"
    >
      <span>
        <Layers size={14} />
        {text(
          "보관해 둔 overlay를 다시 넣지 못했습니다. patch는 그대로 남아 있으니 overlay 탭에서 다시 적용하세요.",
          "Stored overlays could not be re-applied. Their patches are intact — apply them again from the overlay tab.",
        )}
      </span>
      <span className="muted">{reason}</span>
    </div>
  );
}

/**
 * 앱이 브랜치를 옮긴 **직후** overlay를 다시 넣은 결과(C19-3, C19-5).
 *
 * 화면에 한 줄이 꼭 필요하다. 자동으로 돌기 때문이다 — 사용자가 누른 적 없는 작업이
 * 작업 트리를 바꿨으면 무엇이 바뀌었는지 같은 자리에 적혀 있어야 하고, 막힌 세트가 있을
 * 때는 더 그렇다. 막힌 세트의 patch는 앱 데이터에 그대로 남아 있으므로 여기서 하는 일은
 * 그 사실과 충돌 경로를 알리는 데까지이고, 다시 넣는 것은 overlay 탭의 버튼이다.
 *
 * 아무 세트도 다시 넣지 않았으면 그리지 않는다(호출부의 `applied + needsResolution` 판정).
 */
function OverlayReapplyBanner({ result }: { result: ProjectOverlayReapply }) {
  const { text } = useI18n();
  if (
    result.applied === 0 && result.needsResolution === 0 && result.busy === 0
    && result.failed.length === 0
  ) return null;
  const blocked = result.receipts.filter((receipt) => receipt.outcome === "overlayNeedsResolution");
  const stuck = blocked.length > 0 || result.failed.length > 0;
  return (
    <div
      className={`notice-banner overlay-reapply${stuck ? " overlay-receipt-conflict" : ""}`}
      role="note"
      data-overlay-reapply={stuck ? "needsResolution" : "applied"}
      data-overlay-recovery={result.recovery ? "true" : "false"}
    >
      <span>
        <Layers size={14} />
        {result.applied > 0
          ? (result.recovery
            // C19-3의 실행 규칙 7. 실패한 Git 작업은 HEAD를 움직이지 않았으므로 "브랜치를
            // 옮긴 뒤"라고 적으면 거짓이다. 사용자가 보는 것은 실패한 영수증 옆의 복구 기록이다.
            ? text(
              `Git 작업이 실패해 이전 브랜치에서 overlay ${result.applied}개를 되돌려 넣었습니다.`,
              `The git operation failed; restored ${result.applied} overlay set(s) on the previous branch.`,
            )
            : text(
              `브랜치를 옮긴 뒤 보관해 둔 overlay ${result.applied}개를 다시 넣었습니다.`,
              `Re-applied ${result.applied} stored overlay set(s) after the branch moved.`,
            ))
          : text("보관해 둔 overlay를 다시 넣지 못했습니다.", "Stored overlays could not be re-applied.")}
      </span>
      {result.failed.length > 0 && (
        <span className="muted">
          {text(
            `세트 ${result.failed.length}개는 오류로 끝났습니다. patch는 그대로 남아 있습니다 — ${result.failed[0].reason}`,
            `${result.failed.length} set(s) ended in an error. Their patches are intact — ${result.failed[0].reason}`,
          )}
        </span>
      )}
      {blocked.length > 0 && (
        <>
          <span className="muted">
            {text(
              "막힌 세트는 아무것도 적용하지 않았고 patch는 그대로 남아 있습니다. 충돌을 푼 뒤 overlay 탭에서 다시 적용하세요.",
              "Blocked sets applied nothing and their patches are intact. Resolve the conflict, then apply again from the overlay tab.",
            )}
          </span>
          <ul className="overlay-receipt-paths">
            {blocked.flatMap((receipt) => receipt.affected).map((path) => <li key={path}><code>{path}</code></li>)}
          </ul>
        </>
      )}
      {result.busy > 0 && (
        <span className="muted">
          {text("저장소에서 다른 git 변경이 돌고 있어 건너뛴 세트가 있습니다.", "Some sets were skipped because another git change was running.")}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 개요 머리

function OverviewHeader({ projectPath, repository, locked, loading, confirm, git }: {
  projectPath: string;
  repository: GitRepositoryInfo;
  locked: boolean;
  loading: boolean;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  git: ProjectGitState;
}) {
  const { text } = useI18n();
  const [pullMode, setPullMode] = useState<GitPullMode>("ffOnly");
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const { head, upstream } = repository;
  const branchNames = useMemo(
    () => [...repository.localBranches, ...repository.remoteBranches].map((branch) => branch.name),
    [repository.localBranches, repository.remoteBranches],
  );
  const [rebaseOnto, setRebaseOnto] = useState<string>("");
  const rebaseTarget = rebaseOnto || upstream?.name || branchNames.find((name) => name !== head.branch) || "";
  const remoteName = upstream?.name.split("/")[0] ?? repository.remotes[0]?.name ?? "origin";

  const headLabel = head.unborn
    ? text("커밋 없음", "No commits")
    : head.detached
      ? `${text("분리됨", "detached")} ${head.shortSha ?? ""}`.trim()
      : head.branch ?? head.shortSha ?? "";

  // C20. push는 더 이상 호스트 전용이 아니다 — 로그인한 원격 화면도 같은 권한으로 밀어올린다.
  // 바깥으로 나가는 명령이라 UI 확인창(아래 `confirm`)은 그대로 둔다.
  const pushDisabled = locked || head.unborn || head.detached;

  const push = async () => {
    const message = upstream === null
      ? text(`${head.branch ?? ""} → ${remoteName}\n업스트림이 없어 이 브랜치를 ${remoteName}에 새로 올리고 추적하도록 설정합니다.`, `${head.branch ?? ""} → ${remoteName}\nNo upstream: this branch will be pushed to ${remoteName} and set to track it.`)
      : text(`${head.branch ?? ""} → ${upstream.name}`, `${head.branch ?? ""} → ${upstream.name}`);
    const accepted = await confirm({
      title: text("밀어올리기", "Push"),
      message,
      confirmLabel: text("밀어올리기", "Push"),
    });
    if (!accepted) return;
    await git.mutate("push", () => pushProjectGit({ projectPath, remote: remoteName, setUpstream: upstream === null }));
  };

  const startRebase = async () => {
    if (!rebaseTarget) return;
    const accepted = await confirm({
      title: text("리베이스 시작", "Start rebase"),
      message: text(`${headLabel}을(를) ${rebaseTarget} 위로 리베이스합니다. 충돌이 나면 여기서 계속·건너뛰기·중단할 수 있습니다.`, `Rebase ${headLabel} onto ${rebaseTarget}. If conflicts occur you can continue, skip, or abort here.`),
      confirmLabel: text("시작", "Start"),
    });
    if (!accepted) return;
    setRebaseOpen(false);
    await git.mutate("rebase", () => rebaseProjectGit({ projectPath, action: "start", onto: rebaseTarget }));
  };

  return (
    <div className="git-overview">
      <div className="git-overview-head">
        <strong className="git-branch-name">{headLabel}</strong>
        {upstream && (
          <span className="git-upstream" title={upstream.name}>
            {upstream.name} ↑{upstream.ahead} ↓{upstream.behind}{upstream.gone ? ` (${text("사라짐", "gone")})` : ""}
          </span>
        )}
        {repository.repositoryRoot !== projectPath && (
          <small className="git-repo-root" title={repository.repositoryRoot}>{text("저장소 루트", "Repository root")}: <code>{displayPath(repository.repositoryRoot)}</code></small>
        )}
        {repository.isLinkedWorktree && <small className="git-repo-root">{text("연결된 워크트리", "Linked worktree")}</small>}
      </div>
      <div className="git-overview-actions">
        <button className="button compact" type="button" onClick={() => void git.refresh()} disabled={loading}>
          <RefreshCw size={13} />{text("새로고침", "Refresh")}
        </button>
        <button className="button compact" type="button" disabled={locked} onClick={() => void git.mutate("fetch", () => fetchProjectGit({ projectPath, prune: true }))}>
          {text("가져오기", "Fetch")}
        </button>
        <span className="git-action-group">
          <button className="button compact" type="button" disabled={locked || head.unborn} onClick={() => void git.mutate("pull", () => pullProjectGit({ projectPath, mode: pullMode }))}>
            {text("끌어오기", "Pull")}
          </button>
          <select aria-label={text("끌어오기 방식", "Pull mode")} value={pullMode} disabled={locked} onChange={(event) => setPullMode(event.target.value as GitPullMode)}>
            <option value="ffOnly">{text("빨리감기만", "Fast-forward only")}</option>
            <option value="rebase">{text("리베이스", "Rebase")}</option>
          </select>
        </span>
        <button className="button compact" type="button" disabled={pushDisabled} onClick={() => void push()}>
          {text("밀어올리기", "Push")}
        </button>
        <button className="button compact" type="button" disabled={locked || head.unborn || repository.inProgress !== null} onClick={() => setRebaseOpen((open) => !open)}>
          {text("리베이스…", "Rebase…")}
        </button>
      </div>
      {rebaseOpen && (
        <form className="git-inline-form git-rebase-form" onSubmit={(event) => { event.preventDefault(); void startRebase(); }}>
          <label>
            <span>{text("대상", "Onto")}</span>
            <select aria-label={text("리베이스 대상", "Rebase onto")} value={rebaseTarget} onChange={(event) => setRebaseOnto(event.target.value)}>
              {branchNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <button className="button compact primary" type="submit" disabled={locked || !rebaseTarget}>{text("시작", "Start")}</button>
          <button className="button compact" type="button" onClick={() => setRebaseOpen(false)}>{text("닫기", "Close")}</button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 진행 중 작업

function InProgressBanner({ inProgress, conflictedFiles, locked, confirm, onRequestAiaConflictHelp, git }: {
  inProgress: GitInProgress;
  conflictedFiles: string[];
  locked: boolean;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onRequestAiaConflictHelp: (operation: string, conflicted: readonly string[], kind?: "conflict" | "blocked") => void;
  git: ProjectGitState;
}) {
  const { text } = useI18n();
  const { projectPath } = git;
  const kindLabel: Record<GitInProgress["kind"], string> = {
    rebase: text("리베이스", "Rebase"),
    rebaseInteractive: text("대화형 리베이스", "Interactive rebase"),
    am: text("패치 적용(am)", "Patch apply (am)"),
    merge: text("병합", "Merge"),
    cherryPick: text("체리픽", "Cherry-pick"),
    revert: text("되돌리기", "Revert"),
    bisect: text("이분 탐색", "Bisect"),
  };
  const isRebase = inProgress.kind === "rebase" || inProgress.kind === "rebaseInteractive";
  const progress = inProgress.step !== null && inProgress.total !== null ? ` ${inProgress.step}/${inProgress.total}` : "";
  const target = inProgress.onto ? ` → ${inProgress.onto}` : "";
  const abort = async () => {
    const accepted = await confirm({
      title: text("리베이스 중단", "Abort rebase"),
      message: text("진행 중인 리베이스를 중단하고 시작 전 상태로 되돌립니다.", "Abort the rebase in progress and return to the state before it started."),
      confirmLabel: text("중단", "Abort"),
      tone: "danger",
    });
    if (!accepted) return;
    await git.mutate("rebase", () => rebaseProjectGit({ projectPath, action: "abort" }));
  };
  return (
    <div className="notice-banner git-inprogress" role="note">
      <span>
        <strong>{kindLabel[inProgress.kind]}{progress}{target}</strong>{" "}
        {isRebase
          ? text("진행 중입니다. 충돌을 해결한 뒤 계속하거나 건너뛰거나 중단하세요.", "In progress. Resolve conflicts, then continue, skip, or abort.")
          : text("진행 중입니다. 터미널에서 마무리한 뒤 새로고침하세요.", "In progress. Finish it in a terminal, then refresh.")}
      </span>
      {(isRebase || conflictedFiles.length > 0) && (
        <span className="git-inprogress-actions">
          {conflictedFiles.length > 0 && (
            <button className="button compact git-aia-resolve" type="button" onClick={() => onRequestAiaConflictHelp(kindLabel[inProgress.kind], conflictedFiles)}>
              <Sparkles size={13} />{text("AIA로 분석", "Analyze with AIA")}
            </button>
          )}
          {isRebase && <>
          <button className="button compact" type="button" disabled={locked} onClick={() => void git.mutate("rebase", () => rebaseProjectGit({ projectPath, action: "continue" }))}>{text("계속", "Continue")}</button>
          <button className="button compact" type="button" disabled={locked} onClick={() => void git.mutate("rebase", () => rebaseProjectGit({ projectPath, action: "skip" }))}>{text("건너뛰기", "Skip")}</button>
          <button className="button compact danger" type="button" disabled={locked} onClick={() => void abort()}>{text("중단", "Abort")}</button>
          </>}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 영수증

function ReceiptBanner({ receipt, showAiaHelp, onRequestAiaConflictHelp }: {
  receipt: GitActionReceipt;
  showAiaHelp: boolean;
  onRequestAiaConflictHelp: (operation: string, conflicted: readonly string[], kind?: "conflict" | "blocked") => void;
}) {
  const { text } = useI18n();
  const output = [receipt.stdout, receipt.stderr].filter((part) => part.trim().length > 0).join("\n");
  // 요청문은 충돌 파일만 싣지만(A6) 막힌 영수증도 넘길 수 있다 — 그쪽은 좌표 없이 상황만
  // 알리고 AIA가 git 상태를 직접 읽는다. 판정은 시험이 닿는 lib에 있다.
  const canAskAia = showAiaHelp && canRequestGitConflictAia(receipt);
  const details = (
    <>
      {receipt.conflictedFiles.length > 0 && (
        <div className="git-receipt-list">
          <small>{text("충돌한 파일", "Conflicted files")}</small>
          <ul className="git-conflict-list">{receipt.conflictedFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        </div>
      )}
      {receipt.blockedFiles.length > 0 && (
        <div className="git-receipt-list">
          <small>{text("가로막은 로컬 변경", "Blocking local changes")}</small>
          <ul className="git-blocked-list">{receipt.blockedFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        </div>
      )}
      {receipt.droppedStashSha && (
        <small className="git-receipt-hint">
          {text("버린 스태시는 다음 명령으로 되살릴 수 있습니다:", "The dropped stash can be recovered with:")} <code>git stash apply {receipt.droppedStashSha}</code>
        </small>
      )}
      {output && (
        <details className="git-receipt-output">
          <summary>{text("명령 출력", "Command output")}{receipt.truncated ? ` (${text("일부 생략", "truncated")})` : ""}</summary>
          <pre data-user-content>{output}</pre>
        </details>
      )}
    </>
  );
  if (receipt.succeeded) {
    return (
      <div className="git-receipt succeeded">
        <NoticeBanner message={receipt.message} />
        {details}
      </div>
    );
  }
  return (
    <div className="git-receipt failed">
      <div className="error-banner">
        <strong>{text("변경이 끝나지 않았습니다.", "The change did not complete.")} <code>{receipt.outcome}</code></strong>
        <span>{receipt.message}</span>
      </div>
      {details}
      {canAskAia && (
        <div className="git-receipt-actions">
          <button className="button compact git-aia-resolve" type="button" onClick={() => onRequestAiaConflictHelp(receipt.action, receipt.conflictedFiles, receipt.conflictedFiles.length > 0 ? "conflict" : "blocked")}>
            <Sparkles size={13} />{text("AIA로 분석", "Analyze with AIA")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 변경 목록

type GroupId = "staged" | "unstaged" | "untracked" | "conflicted";

function ChangesSection({ status, locked, git }: { status: GitStatus | null; locked: boolean; git: ProjectGitState }) {
  const { text } = useI18n();
  const [view, setView] = useState<"list" | "tree">("list");
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => groupGitStatus(status?.entries ?? []), [status]);
  const { projectPath } = git;
  const labels: Record<GroupId, string> = {
    staged: text("스테이지됨", "Staged"),
    unstaged: text("변경됨", "Changed"),
    untracked: text("추적 안 됨", "Untracked"),
    conflicted: text("충돌", "Conflicts"),
  };
  const stage = (paths: string[]) => void git.mutate("stage", () => stageProjectGitPaths({ projectPath, paths }));
  const unstage = (paths: string[]) => void git.mutate("stage", () => unstageProjectGitPaths({ projectPath, paths }));
  const order: GroupId[] = ["conflicted", "staged", "unstaged", "untracked"];
  const total = order.reduce((sum, id) => sum + groups[id].length, 0);
  return (
    <section className="git-changes settings-subsection">
      <header>
        <div>
          <strong>{text("변경", "Changes")}</strong>
          {status?.truncated && <small>{text("항목이 많아 일부만 보입니다.", "Too many entries; only some are shown.")}</small>}
        </div>
        <div className="git-change-view-toggle" role="group" aria-label={text("변경 파일 보기 방식", "Changed file view")}>
          <button className="button compact" type="button" aria-pressed={view === "list"} onClick={() => setView("list")} title={text("파일 목록으로 보기", "View as file list")}>
            <Layers size={13} />{text("목록", "List")}
          </button>
          <button className="button compact" type="button" aria-pressed={view === "tree"} onClick={() => setView("tree")} title={text("폴더형으로 보기", "View as folders")}>
            <Folder size={13} />{text("폴더", "Folders")}
          </button>
        </div>
      </header>
      {total === 0 && <p className="git-empty-note">{text("변경 내용이 없습니다.", "No changes.")}</p>}
      {order.map((id) => groups[id].length > 0 && (
        <div className="git-change-group" data-group={id} key={id}>
          <div className="git-change-group-head">
            <strong>{labels[id]} <span>{groups[id].length}</span></strong>
            {id !== "conflicted" && (
              <label className="git-change-select-all">
                <input
                  type="checkbox"
                  checked={id === "staged"}
                  disabled={locked}
                  onChange={(event) => event.target.checked
                    ? stage(groups[id].flatMap(entryPaths))
                    : unstage(groups[id].flatMap(entryPaths))}
                />
                <span>{id === "staged" ? text("전체 선택 해제", "Clear all") : text("전체 선택", "Select all")}</span>
              </label>
            )}
          </div>
          {view === "list" ? (
            <ul className="git-change-list">
              {groups[id].map((entry) => (
                <ChangeRow key={`${id}:${entry.path}`} entry={entry} group={id} locked={locked} selected={git.selectedDiff?.commit === null && git.selectedDiff.path === entry.path && git.selectedDiff.staged === (id === "staged")} onToggle={(checked) => (checked ? stage(entryPaths(entry)) : unstage(entryPaths(entry)))} onSelect={() => git.selectDiff({ path: entry.path, staged: id === "staged", originalPath: entry.originalPath, commit: null })} />
              ))}
            </ul>
          ) : (
            <GitChangeTree
              nodes={buildGitFileTree(groups[id], (entry) => entry.path)}
              group={id}
              locked={locked}
              collapsed={collapsedFolders}
              onToggleFolder={(path) => setCollapsedFolders((current) => {
                const key = `${id}:${path}`;
                const next = new Set(current);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
              })}
              selectedDiff={git.selectedDiff}
              onToggleEntry={(entry, checked) => (checked ? stage(entryPaths(entry)) : unstage(entryPaths(entry)))}
              onSelectEntry={(entry) => git.selectDiff({ path: entry.path, staged: id === "staged", originalPath: entry.originalPath, commit: null })}
            />
          )}
        </div>
      ))}
    </section>
  );
}

function GitChangeTree({ nodes, group, locked, collapsed, onToggleFolder, selectedDiff, onToggleEntry, onSelectEntry, depth = 0 }: {
  nodes: readonly GitFileTreeNode<GitStatusEntry>[];
  group: GroupId;
  locked: boolean;
  collapsed: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
  selectedDiff: DiffSelection | null;
  onToggleEntry: (entry: GitStatusEntry, checked: boolean) => void;
  onSelectEntry: (entry: GitStatusEntry) => void;
  depth?: number;
}) {
  const isCollapsed = (path: string) => collapsed.has(`${group}:${path}`);
  return (
    <ul className="git-change-list git-change-tree">
      {nodes.map((node) => node.kind === "folder" ? (
        <li className="git-change-folder" key={node.path}>
          <button type="button" className="git-change-folder-toggle" style={{ paddingLeft: 4 + depth * 14 }} aria-expanded={!isCollapsed(node.path)} onClick={() => onToggleFolder(node.path)} title={node.path}>
            {isCollapsed(node.path) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <Folder size={13} />
            <strong>{node.label}</strong>
            <small>{node.count}</small>
          </button>
          {!isCollapsed(node.path) && <GitChangeTree nodes={node.children} group={group} locked={locked} collapsed={collapsed} onToggleFolder={onToggleFolder} selectedDiff={selectedDiff} onToggleEntry={onToggleEntry} onSelectEntry={onSelectEntry} depth={depth + 1} />}
        </li>
      ) : (
        <ChangeRow key={`${node.item.originalPath ?? ""}:${node.item.path}`} entry={node.item} displayName={node.label} depth={depth} group={group} locked={locked} selected={selectedDiff?.commit === null && selectedDiff.path === node.item.path && selectedDiff.staged === (group === "staged")} onToggle={(checked) => onToggleEntry(node.item, checked)} onSelect={() => onSelectEntry(node.item)} />
      ))}
    </ul>
  );
}

/**
 * stage·unstage에 보낼 경로. 이름이 바뀐 항목은 새 경로와 원래 경로가 한 변경이라 둘을
 * 함께 보낸다 — 새 경로만 내리면 원래 경로의 삭제가 인덱스에 남아 반쪽만 풀린다.
 */
function entryPaths(entry: GitStatusEntry): string[] {
  return entry.originalPath ? [entry.path, entry.originalPath] : [entry.path];
}

/** 변경 종류의 표시 이름. 변경 목록 행과 커밋 파일 목록이 같은 말을 쓴다. */
function changeKindLabels(text: UiText): Record<GitChangeLabelKey, string> {
  return {
    modified: text("수정됨", "Modified"),
    typeChanged: text("종류 바뀜", "Type changed"),
    added: text("추가됨", "Added"),
    deleted: text("삭제됨", "Deleted"),
    renamed: text("이름 바뀜", "Renamed"),
    copied: text("복사됨", "Copied"),
    untracked: text("추적 안 됨", "Untracked"),
    ignored: text("무시됨", "Ignored"),
    unmerged: text("충돌", "Conflict"),
    unmodified: text("변경 없음", "Unchanged"),
  };
}

function ChangeRow({ entry, displayName, depth = 0, group, locked, selected, onToggle, onSelect }: {
  entry: GitStatusEntry;
  displayName?: string;
  depth?: number;
  group: GroupId;
  locked: boolean;
  selected: boolean;
  onToggle: (checked: boolean) => void;
  onSelect: () => void;
}) {
  const { text } = useI18n();
  const staged = group === "staged";
  const side = staged ? "index" : "worktree";
  const code = gitChangeCode(entry, side);
  const labelKey = gitChangeLabelKey(staged ? entry.indexStatus : entry.worktreeStatus);
  const title = entry.unmerged ? `${text("충돌", "Conflict")} ${entry.unmerged}` : changeKindLabels(text)[labelKey];
  return (
    <li className={`git-change-row${selected ? " selected" : ""}`} style={depth > 0 ? { paddingLeft: 4 + depth * 14 } : undefined}>
      <label className="git-change-check" title={staged ? text("스테이지 내리기", "Unstage") : text("스테이지", "Stage")}>
        <input
          type="checkbox"
          checked={staged}
          disabled={locked || group === "conflicted"}
          aria-label={staged ? text(`${entry.path} 스테이지 내리기`, `Unstage ${entry.path}`) : text(`${entry.path} 스테이지`, `Stage ${entry.path}`)}
          onChange={(event) => onToggle(event.target.checked)}
        />
      </label>
      <code className="git-change-code" title={title}>{code}</code>
      <button className="git-change-path" type="button" onClick={onSelect} title={text("변경 내용 보기", "Show diff")}>
        {entry.originalPath && <><span className="git-change-origin">{entry.originalPath}</span> → </>}
        <span>{displayName ?? entry.path}</span>
        {entry.isSubmodule && <small> ({text("서브모듈", "submodule")})</small>}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 커밋

function CommitBox({ status, locked, git }: { status: GitStatus | null; locked: boolean; git: ProjectGitState }) {
  const { text } = useI18n();
  const [message, setMessage] = useState("");
  const { projectPath } = git;
  const stagedCount = status?.stagedCount ?? 0;
  const disabled = locked || stagedCount === 0 || message.trim() === "";
  const commit = async () => {
    const receipt = await git.mutate("commit", () => commitProjectGit({ projectPath, message: message.trim() }));
    if (receipt?.succeeded) setMessage("");
  };
  return (
    <section className="git-commit-box settings-subsection">
      <header>
        <div>
          <strong>{text("커밋", "Commit")}</strong>
          <small>{text(`스테이지된 파일 ${stagedCount}개`, `${stagedCount} staged file(s)`)}</small>
        </div>
      </header>
      <textarea
        aria-label={text("커밋 메시지", "Commit message")}
        placeholder={text("커밋 메시지", "Commit message")}
        value={message}
        disabled={locked}
        rows={3}
        onChange={(event) => setMessage(event.target.value)}
      />
      <div className="form-actions">
        <button className="button compact primary" type="button" disabled={disabled} onClick={() => void commit()}>{text("커밋", "Commit")}</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 비교 — 수신과 송신을 갈라 본다

/**
 * B6/B8. 현재 브랜치와 그 upstream의 차이를 **방향으로 갈라** 보여 준다. 팔로우 카드가 주는
 * 것은 수신·송신 두 숫자뿐이라 "3 커밋 차이"가 무엇인지 말하지 못한다. 여기서는 방향마다
 * 커밋 목록과 **그 커밋들이 합쳐서 바꾸는 파일 요약**을 나란히 둔다 — 지금 pull하면 내가
 * 손대고 있는 파일이 건드려지는지는 커밋 제목이 아니라 파일 목록만 답할 수 있다.
 *
 * B5와 같은 기준을 다시 적는다: 이 수치는 네트워크가 아니라 마지막 fetch가 가져다 놓은
 * 원격 추적 ref에서 나온다.
 */
function BranchComparisonSection({ repository, git }: { repository: GitRepositoryInfo; git: ProjectGitState }) {
  const { text } = useI18n();
  const { projectPath } = git;
  const branch = repository.head.branch;
  const upstream = useMemo(
    () => repository.localBranches.find((entry) => entry.name === branch)?.upstream ?? null,
    [repository.localBranches, branch],
  );
  const [comparison, setComparison] = useState<GitBranchComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branch || !upstream) {
      setComparison(null);
      setError(null);
      return;
    }
    let live = true;
    getProjectBranchComparison({ projectPath, branch, upstream })
      .then((next) => { if (live) { setComparison(next); setError(null); } })
      .catch((cause: unknown) => { if (live) { setComparison(null); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [projectPath, branch, upstream, repository.head.sha]);

  if (!branch || !upstream) return null;

  return (
    <section className="git-branch-comparison settings-subsection">
      <header>
        <div>
          <strong>{text("upstream과 비교", "Compared with upstream")}</strong>
          <small>
            {branch} ↔ {upstream} · {text("마지막 fetch 기준", "As of last fetch")}
            {comparison?.lastFetchedAt != null && ` (${formatDate(comparison.lastFetchedAt * 1000)})`}
          </small>
        </div>
      </header>
      {error && <ErrorBanner message={error} />}
      {comparison === null && !error && <p className="git-commit-files-note">{text("비교를 읽고 있습니다…", "Reading comparison…")}</p>}
      {comparison !== null && comparison.incomingCount === 0 && comparison.outgoingCount === 0 && (
        <p className="git-commit-files-note">{text("upstream과 같습니다.", "Up to date with upstream.")}</p>
      )}
      {comparison !== null && (comparison.incomingCount > 0 || comparison.outgoingCount > 0) && (
        <div className="git-comparison-sides">
          <ComparisonSide
            title={text("수신", "Incoming")}
            hint={text("가져오면 들어오는 변경", "Lands here when you pull")}
            count={comparison.incomingCount}
            commits={comparison.incoming}
            commitsTruncated={comparison.incomingTruncated}
            files={comparison.incomingFiles}
            filesTruncated={comparison.incomingFilesTruncated}
            rangeFrom={branch}
            rangeTo={upstream}
            selectDiff={git.selectDiff}
            selected={git.selectedDiff}
          />
          <ComparisonSide
            title={text("송신", "Outgoing")}
            hint={text("보내면 나가는 변경", "Leaves here when you push")}
            count={comparison.outgoingCount}
            commits={comparison.outgoing}
            commitsTruncated={comparison.outgoingTruncated}
            files={comparison.outgoingFiles}
            filesTruncated={comparison.outgoingFilesTruncated}
            rangeFrom={upstream}
            rangeTo={branch}
            selectDiff={git.selectDiff}
            selected={git.selectedDiff}
          />
        </div>
      )}
      {comparison?.diverged && (
        <p className="git-commit-files-note">{text("양쪽 모두 커밋이 있어 fast-forward로 정리되지 않습니다.", "Both sides have commits — this will not fast-forward.")}</p>
      )}
    </section>
  );
}

/** 한 방향. 커밋 목록과 파일 요약을 같은 칸에 두되 서로 섞지 않는다. */
function ComparisonSide({ title, hint, count, commits, commitsTruncated, files, filesTruncated, rangeFrom, rangeTo, selectDiff, selected }: {
  title: string;
  hint: string;
  count: number;
  commits: GitCommit[];
  commitsTruncated: boolean;
  files: GitCommitFile[];
  filesTruncated: boolean;
  /** 이 방향이 쓴 범위. 요약과 본문이 같은 범위여야 하므로 양쪽을 같은 값으로 연다. */
  rangeFrom: string;
  rangeTo: string;
  selectDiff: (selection: DiffSelection | null) => void;
  selected: DiffSelection | null;
}) {
  const { text } = useI18n();
  return (
    <div className="git-comparison-side">
      <header>
        <strong>{title} {count}</strong>
        <small>{hint}</small>
      </header>
      {count === 0 ? (
        <p className="git-commit-files-note">{text("없음", "None")}</p>
      ) : (
        <>
          <ul className="git-comparison-commits">
            {commits.map((commit) => (
              <li key={commit.sha}>
                <code>{commit.shortSha}</code> <span title={commit.subject}>{commit.subject}</span>
              </li>
            ))}
          </ul>
          {commitsTruncated && <p className="git-commit-files-note">{text("커밋이 많아 일부만 보입니다.", "Too many commits; only some are shown.")}</p>}
          <ul className="git-commit-files">
            {files.map((file) => (
              <li className="git-commit-file" key={`${file.originalPath ?? ""}→${file.path}`}>
                <code className="git-change-code" title={changeKindLabels(text)[gitChangeLabelKey(file.status)]}>{gitChangeKindCode(file.status)}</code>
                {/* 요약은 merge-base부터 끝점까지 한 범위라 커밋 하나의 diff로는 열 수 없다. 그래서
                    같은 세 점 범위(`<from>...<to>`)를 그대로 열는다(B9) — 목록과 본문이 한 범위다. */}
                <button
                  type="button"
                  className={`git-change-path git-change-path-button${selected?.rangeFrom === rangeFrom && selected?.rangeTo === rangeTo && selected.path === file.path ? " selected" : ""}`}
                  title={file.path}
                  onClick={() => selectDiff({ path: file.path, originalPath: file.originalPath, staged: false, commit: null, rangeFrom, rangeTo })}
                >
                  {file.originalPath && <><span className="git-change-origin">{file.originalPath}</span> → </>}
                  {file.path}
                </button>
              </li>
            ))}
          </ul>
          {filesTruncated && <p className="git-commit-files-note">{text("파일이 많아 일부만 보입니다.", "Too many files; only some are shown.")}</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 브랜치

interface BranchContextMenuState {
  branch: GitBranch;
  remote: boolean;
  x: number;
  y: number;
}

/** 저장소마다 어떤 폴더를 펼쳐 두었는지. 화면 설정이므로 읽기·쓰기 실패는 모두 삼킨다. */
const BRANCH_FOLDERS_KEY = "agent-manager.git-branch-folders.v1";

function readExpandedBranchFolders(projectPath: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(BRANCH_FOLDERS_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") return [];
    const stored = (parsed as Record<string, unknown>)[projectPath];
    return Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

function writeExpandedBranchFolders(projectPath: string, paths: string[]): void {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(BRANCH_FOLDERS_KEY) ?? "{}");
    const all = parsed !== null && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};
    if (paths.length === 0) delete all[projectPath];
    else all[projectPath] = paths;
    window.localStorage.setItem(BRANCH_FOLDERS_KEY, JSON.stringify(all));
  } catch {
    // 저장소를 쓸 수 없어도 이번 실행의 펼침은 그대로 둔다.
  }
}

function BranchesSection({ repository, locked, confirm, git }: {
  repository: GitRepositoryInfo;
  locked: boolean;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  git: ProjectGitState;
}) {
  const { text } = useI18n();
  const { projectPath } = git;
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [startPoint, setStartPoint] = useState("HEAD");
  const [contextMenu, setContextMenu] = useState<BranchContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const localNames = useMemo(() => new Set(repository.localBranches.map((branch) => branch.name)), [repository.localBranches]);
  const remoteNames = useMemo(() => repository.remotes.map((remote) => remote.name), [repository.remotes]);

  /**
   * 폴더는 기본으로 접혀 있고, 사용자가 펼친 것만 저장소별로 기억한다. 접힘이 기본이면
   * 브랜치가 수십 개인 저장소에서도 왼쪽 열이 브랜치만으로 차지 않고, 펼쳐 둔 자리는 다음에
   * 들어와도 그대로다 — 기억하는 쪽이 펼침이라 새로 생긴 폴더는 저절로 접힌 채로 나온다.
   */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readExpandedBranchFolders(projectPath)));
  useEffect(() => { setExpanded(new Set(readExpandedBranchFolders(projectPath))); }, [projectPath]);
  const applyExpanded = useCallback((next: Set<string>) => {
    setExpanded(next);
    writeExpandedBranchFolders(projectPath, [...next]);
  }, [projectPath]);
  const toggleFolder = (key: string) => {
    const next = new Set(expanded);
    if (!next.delete(key)) next.add(key);
    applyExpanded(next);
  };

  const localTree = useMemo(() => buildGitBranchTree(repository.localBranches), [repository.localBranches]);
  const remoteTree = useMemo(() => buildGitBranchTree(repository.remoteBranches), [repository.remoteBranches]);
  const allFolders = useMemo(
    // 두 목록은 이름 공간이 겹친다 — 로컬에 `origin/wip`가 있으면 양쪽에 `origin` 폴더가
    // 선다. 접두사만으로 기억하면 둘이 함께 열리고 닫히므로 목록을 열쇠에 같이 적는다.
    () => [
      ...collectGitBranchFolderPaths(localTree).map((path) => `l:${path}`),
      ...collectGitBranchFolderPaths(remoteTree).map((path) => `r:${path}`),
    ],
    [localTree, remoteTree],
  );
  const allExpanded = allFolders.length > 0 && allFolders.every((key) => expanded.has(key));

  const switchTo = (branch: GitBranch, isRemote: boolean) => {
    if (!isRemote) {
      return git.mutate("switch", () => switchProjectGitBranch({ projectPath, branch: branch.name }));
    }
    const remote = remoteNames.find((name) => branch.name.startsWith(`${name}/`));
    const local = remote ? branch.name.slice(remote.length + 1) : branch.name.split("/").slice(1).join("/");
    if (localNames.has(local)) {
      return git.mutate("switch", () => switchProjectGitBranch({ projectPath, branch: local }));
    }
    return git.mutate("switch", () => switchProjectGitBranch({ projectPath, branch: local, create: true, startPoint: branch.name }));
  };
  const remoteFor = (branch: GitBranch) => remoteNames.find((name) => branch.name.startsWith(`${name}/`)) ?? null;
  const pullCurrent = (mode: GitPullMode) => git.mutate("pull", () => pullProjectGit({ projectPath, mode }));
  const fetchRemote = (branch: GitBranch) => {
    const remote = remoteFor(branch);
    if (remote === null) return Promise.resolve(null);
    return git.mutate("fetch", () => fetchProjectGit({ projectPath, remote, prune: true }));
  };
  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const receipt = await git.mutate("switch", () => switchProjectGitBranch({ projectPath, branch: name, create: true, startPoint }));
    if (receipt?.succeeded) {
      setNewName("");
      setCreateOpen(false);
    }
  };
  const rebaseOnto = async (branch: GitBranch) => {
    const head = repository.head.branch ?? repository.head.shortSha ?? "HEAD";
    const accepted = await confirm({
      title: text("리베이스 시작", "Start rebase"),
      message: text(`${head}을(를) ${branch.name} 위로 리베이스합니다. 충돌이 나면 형상관리 화면에서 계속·건너뛰기·중단할 수 있습니다.`, `Rebase ${head} onto ${branch.name}. If conflicts occur, you can continue, skip, or abort from source control.`),
      confirmLabel: text("시작", "Start"),
    });
    if (!accepted) return;
    await git.mutate("rebase", () => rebaseProjectGit({ projectPath, action: "start", onto: branch.name }));
  };
  useEscapeToClose(() => setContextMenu(null), contextMenu !== null);
  useOutsidePointerToClose(() => setContextMenu(null), contextMenu !== null, [contextMenuRef]);
  const startPoints = ["HEAD", ...repository.localBranches.map((branch) => branch.name), ...repository.remoteBranches.map((branch) => branch.name)];

  /**
   * B4. 한 줄에 upstream을 따르는지(팔로우 표식)와 그 upstream과 몇 커밋 어긋났는지를 방향
   * 화살표로 함께 싣는다. 예전에는 같은 값이 위쪽 팔로우 카드와 이 목록에 두 번 나왔는데,
   * 카드가 더 주는 것은 없었다 — `incoming`/`outgoing`은 여기 `behind`/`ahead`와 같은 값이고
   * `diverged`는 둘 다 0보다 큰지일 뿐이다. 수치는 모두 마지막 fetch가 가져다 둔 원격 추적
   * ref에서 나오므로, 기준은 비교 섹션 머리글이 한 번만 적는다.
   */
  const branchRow = (leaf: GitBranchTreeLeaf, isRemote: boolean, depth: number) => {
    const { branch } = leaf;
    const incoming = branch.behind;
    const outgoing = branch.ahead;
    const diverged = incoming > 0 && outgoing > 0;
    // 조각마다 text()로 감싼다. 보간된 한 문장으로 적으면 `${…}`로 뭉개져 번역 카탈로그에
    // 실리지 않고, 조건부로 끼운 한국어 조각은 감싸지 않은 문구로 남는다.
    const trackTitle = [
      branch.upstream,
      `${text("수신", "Incoming")} ${incoming}`,
      `${text("송신", "Outgoing")} ${outgoing}`,
      diverged ? text("분기됨", "Diverged") : null,
      text("마지막 fetch 기준", "As of last fetch"),
    ].filter((part): part is string => part !== null).join(" · ");
    return (
      <li
        className={`git-branch-row${branch.isHead ? " current" : ""}`}
        key={`${isRemote ? "r" : "l"}:${branch.name}`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onContextMenu={(event) => {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = event.clientX || bounds.left + 24;
          const y = event.clientY || bounds.top + 24;
          setContextMenu({ branch, remote: isRemote, x: Math.min(x, window.innerWidth - 246), y: Math.min(y, window.innerHeight - 230) });
        }}
      >
        <div className="git-branch-main">
          <strong title={branch.name}>
            {branch.upstream !== null && (
              <Link2
                size={11}
                className={`git-branch-followed${branch.gone ? " gone" : ""}`}
                role="img"
                aria-label={text(`팔로우 중: ${branch.upstream}`, `Followed: ${branch.upstream}`)}
              />
            )}
            {leaf.label}
          </strong>
          <small>
            {branch.sha.slice(0, 7)}
            {branch.upstream && ` · ${branch.upstream}${branch.gone ? ` (${text("사라짐", "gone")})` : ""}`}
            {branch.committedAt > 0 && ` · ${formatRelative(branch.committedAt * 1000)}`}
          </small>
          {branch.subject && <small className="git-branch-subject" title={branch.subject}>{branch.subject}</small>}
        </div>
        {branch.upstream !== null && (incoming > 0 || outgoing > 0) && (
          <span className={`git-branch-track${diverged ? " diverged" : ""}`} title={trackTitle}>
            {incoming > 0 && <span className="git-track-in"><ArrowDown size={11} />{incoming}</span>}
            {outgoing > 0 && <span className="git-track-out"><ArrowUp size={11} />{outgoing}</span>}
          </span>
        )}
        <button className="button compact" type="button" disabled={locked || branch.isHead} onClick={() => void switchTo(branch, isRemote)}>
          {text("전환", "Switch")}
        </button>
      </li>
    );
  };

  /** 펼친 폴더만 자식을 이어 붙인다. 접힌 가지는 아예 그리지 않아 목록 길이가 접힘을 따른다. */
  const rows = (list: GitBranchTreeNode[], isRemote: boolean, depth: number): ReactElement[] =>
    list.flatMap((node) => {
      if (node.kind === "branch") return [branchRow(node, isRemote, depth)];
      const key = `${isRemote ? "r" : "l"}:${node.path}`;
      const open = expanded.has(key);
      const folder = (
        <li className="git-branch-folder" key={`folder:${key}`}>
          <button
            type="button"
            className="git-branch-folder-toggle"
            style={{ paddingLeft: `${12 + depth * 14}px` }}
            aria-expanded={open}
            onClick={() => toggleFolder(key)}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder size={13} />
            <strong>{node.label}</strong>
            <small>{node.count}</small>
            {/* 접힌 폴더 안에 현재 브랜치가 있으면 펼치지 않고도 어디 있는지 보이게 한다. */}
            {node.hasHead && !open && (
              <span className="git-branch-folder-head" title={text("현재 브랜치가 이 폴더에 있습니다", "The current branch is in this folder")} />
            )}
          </button>
        </li>
      );
      return open ? [folder, ...rows(node.children, isRemote, depth + 1)] : [folder];
    });

  return (
    <section className="git-branches settings-subsection">
      <header>
        <div>
          <strong>{text("브랜치", "Branches")}</strong>
          {repository.branchesTruncated && <small>{text("브랜치가 많아 일부만 보입니다.", "Too many branches; only some are shown.")}</small>}
        </div>
        <div className="git-branch-header-actions">
          <button className="button compact" type="button" disabled={locked} onClick={() => setCreateOpen((open) => !open)}>{text("새 브랜치", "New branch")}</button>
        </div>
      </header>
      {createOpen && (
        <form className="git-inline-form git-branch-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <input
            type="text"
            aria-label={text("새 브랜치 이름", "New branch name")}
            placeholder={text("브랜치 이름", "Branch name")}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <select aria-label={text("시작 지점", "Start point")} value={startPoint} onChange={(event) => setStartPoint(event.target.value)}>
            {startPoints.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button className="button compact primary" type="submit" disabled={locked || newName.trim() === ""}>{text("만들기", "Create")}</button>
        </form>
      )}
      {allFolders.length > 0 && (
        <div className="git-branch-list-toolbar">
          <small>{text("브랜치 폴더", "Branch folders")}</small>
          <button
            className="button compact git-branch-fold-all"
            type="button"
            aria-label={allExpanded ? text("모든 브랜치 폴더 접기", "Collapse all branch folders") : text("모든 브랜치 폴더 펴기", "Expand all branch folders")}
            onClick={() => applyExpanded(allExpanded ? new Set() : new Set(allFolders))}
          >
            {allExpanded ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
            {allExpanded ? text("전체 접기", "Collapse all") : text("전체 펴기", "Expand all")}
          </button>
        </div>
      )}
      <div className="git-branch-scope local">
        <div className="git-branch-scope-head">
          <span className="git-branch-scope-icon"><GitBranchIcon size={13} /></span>
          <div>
            <strong>{text("로컬 브랜치", "Local branches")}</strong>
            <small>{text("이 저장소에서 작업하는 브랜치", "Branches in this repository")}</small>
          </div>
          <span className="git-branch-scope-count">{repository.localBranches.length}</span>
        </div>
        <ul className="git-branch-list">
          {rows(localTree, false, 0)}
        </ul>
      </div>
      {remoteTree.length > 0 && (
        <div className="git-branch-scope remote">
          <div className="git-branch-scope-head">
            <span className="git-branch-scope-icon"><Download size={13} /></span>
            <div>
              <strong>{text("원격 브랜치", "Remote branches")}</strong>
              <small>{text("마지막 fetch로 확인한 원격 추적 브랜치", "Remote-tracking branches as of last fetch")}</small>
            </div>
            <span className="git-branch-scope-count">{repository.remoteBranches.length}</span>
          </div>
          <ul className="git-branch-list">
            {rows(remoteTree, true, 0)}
          </ul>
        </div>
      )}
      {contextMenu && (
        <div
          className="git-branch-context-menu"
          ref={contextMenuRef}
          role="menu"
          aria-label={text(`${contextMenu.branch.name} 브랜치 메뉴`, `${contextMenu.branch.name} branch menu`)}
          style={{ left: Math.max(8, contextMenu.x), top: Math.max(8, contextMenu.y) }}
        >
          <header>
            <strong>{contextMenu.branch.name}</strong>
            <small>{contextMenu.remote ? text("원격 브랜치", "Remote branch") : contextMenu.branch.isHead ? text("현재 브랜치", "Current branch") : text("로컬 브랜치", "Local branch")}</small>
          </header>
          <button
            type="button"
            role="menuitem"
            disabled={locked || contextMenu.branch.isHead}
            onClick={() => { const target = contextMenu; setContextMenu(null); void switchTo(target.branch, target.remote); }}
          >
            <GitBranchIcon size={14} />{text("이 브랜치로 전환", "Switch to this branch")}
          </button>
          {!contextMenu.remote && (
            <>
              <button
                type="button"
                role="menuitem"
                title={!contextMenu.branch.isHead ? text("Pull하려면 먼저 이 브랜치로 전환하세요.", "Switch to this branch before pulling.") : contextMenu.branch.upstream === null ? text("upstream이 있는 브랜치만 Pull할 수 있습니다.", "Only branches with an upstream can be pulled.") : undefined}
                disabled={locked || !contextMenu.branch.isHead || contextMenu.branch.upstream === null || contextMenu.branch.gone || repository.inProgress !== null}
                onClick={() => { setContextMenu(null); void pullCurrent("ffOnly"); }}
              >
                <Download size={14} />{text("이 브랜치 Pull", "Pull this branch")}
              </button>
              <button
                type="button"
                role="menuitem"
                title={!contextMenu.branch.isHead ? text("Pull하려면 먼저 이 브랜치로 전환하세요.", "Switch to this branch before pulling.") : contextMenu.branch.upstream === null ? text("upstream이 있는 브랜치만 Pull할 수 있습니다.", "Only branches with an upstream can be pulled.") : undefined}
                disabled={locked || !contextMenu.branch.isHead || contextMenu.branch.upstream === null || contextMenu.branch.gone || repository.inProgress !== null}
                onClick={() => { setContextMenu(null); void pullCurrent("rebase"); }}
              >
                <GitCompareArrows size={14} />{text("Pull 후 리베이스", "Pull with rebase")}
              </button>
            </>
          )}
          {contextMenu.remote && (
            <button
              type="button"
              role="menuitem"
              disabled={locked || remoteFor(contextMenu.branch) === null}
              onClick={() => { const target = contextMenu.branch; setContextMenu(null); void fetchRemote(target); }}
            >
              <Download size={14} />{text("이 원격 가져오기", "Fetch this remote")}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={locked || repository.head.unborn || repository.head.detached || repository.inProgress !== null || contextMenu.branch.isHead}
            onClick={() => { const target = contextMenu.branch; setContextMenu(null); void rebaseOnto(target); }}
          >
            <GitCompareArrows size={14} />{text("이 브랜치 위로 리베이스", "Rebase onto this branch")}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 워크트리

function WorktreesSection({ worktrees }: { worktrees: GitWorktree[] }) {
  const { text } = useI18n();
  if (worktrees.length === 0) return null;
  const flags = (worktree: GitWorktree) => [
    worktree.isCurrent ? text("현재", "current") : null,
    worktree.bare ? text("bare", "bare") : null,
    worktree.locked ? text("잠김", "locked") : null,
    worktree.prunable ? text("정리 가능", "prunable") : null,
  ].filter((flag): flag is string => flag !== null);
  return (
    <section className="git-worktrees settings-subsection">
      <header><div><strong>{text("워크트리", "Worktrees")}</strong></div></header>
      <ul className="git-worktree-list">
        {worktrees.map((worktree) => (
          <li className="git-worktree-row" key={worktree.path}>
            <code title={worktree.path}>{displayPath(worktree.path)}</code>
            <small>
              {worktree.branch ?? (worktree.detached ? `${text("분리됨", "detached")} ${worktree.head?.slice(0, 7) ?? ""}` : worktree.head?.slice(0, 7) ?? "")}
              {flags(worktree).length > 0 && ` · ${flags(worktree).join(", ")}`}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 스태시

function StashesSection({ repository, locked, confirm, git }: {
  repository: GitRepositoryInfo;
  locked: boolean;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  git: ProjectGitState;
}) {
  const { text } = useI18n();
  const { projectPath } = git;
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const push = async () => {
    const receipt = await git.mutate("stash", () => stashProjectGit({ projectPath, action: "push", message: message.trim() || null, includeUntracked }));
    if (receipt?.succeeded) setMessage("");
  };
  const act = (stash: GitStash, action: "pop" | "apply" | "drop") =>
    git.mutate("stash", () => stashProjectGit({ projectPath, action, index: stash.index, expectedSha: stash.sha }));
  const drop = async (stash: GitStash) => {
    const accepted = await confirm({
      title: text("스태시 버리기", "Drop stash"),
      message: text(`stash@{${stash.index}}을(를) 버립니다. 영수증에 남는 SHA로 되살릴 수 있지만 목록에서는 사라집니다.`, `Drop stash@{${stash.index}}. It can be recovered from the SHA on the receipt, but it leaves this list.`),
      items: [stash.message],
      confirmLabel: text("버리기", "Drop"),
      tone: "danger",
    });
    if (!accepted) return;
    await act(stash, "drop");
  };
  return (
    <section className="git-stashes settings-subsection">
      <header>
        <div>
          <strong>{text("스태시", "Stashes")}</strong>
          {repository.stashesTruncated && <small>{text("스태시가 많아 일부만 보입니다.", "Too many stashes; only some are shown.")}</small>}
        </div>
      </header>
      <form className="git-inline-form git-stash-form" onSubmit={(event) => { event.preventDefault(); void push(); }}>
        <input
          type="text"
          aria-label={text("스태시 메시지", "Stash message")}
          placeholder={text("스태시 메시지(선택)", "Stash message (optional)")}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <label className="check-filter">
          <input type="checkbox" checked={includeUntracked} disabled={locked} onChange={(event) => setIncludeUntracked(event.target.checked)} />
          <span>{text("추적 안 된 파일 포함", "Include untracked")}</span>
        </label>
        <button className="button compact" type="submit" disabled={locked}>{text("스태시 보관", "Stash changes")}</button>
      </form>
      {repository.stashes.length === 0
        ? <p className="git-empty-note">{text("보관된 스태시가 없습니다.", "No stashes.")}</p>
        : (
          <ul className="git-stash-list">
            {repository.stashes.map((stash) => (
              <li className="git-stash-row" key={stash.sha}>
                <div className="git-branch-main">
                  <strong>stash@{`{${stash.index}}`}</strong>
                  <small title={stash.message}>{stash.message}</small>
                  <small>{formatRelative(stash.createdAt * 1000)}</small>
                </div>
                <span className="git-row-actions">
                  <button className="button compact" type="button" disabled={locked} onClick={() => void act(stash, "apply")}>{text("적용", "Apply")}</button>
                  <button className="button compact" type="button" disabled={locked} onClick={() => void act(stash, "pop")}>{text("꺼내기", "Pop")}</button>
                  <button className="button compact danger" type="button" disabled={locked} onClick={() => void drop(stash)}>{text("버리기", "Drop")}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 이력

/** 이력 한 줄. 누르면 그 커밋이 바꾼 파일이 아래로 펼쳐지고, 파일을 누르면 diff 모달이 뜬다. */
const GIT_GRAPH_COLUMN_WIDTH = 14;

/** 부모 관계의 한 행. 선은 행 높이에 맞춰 늘어나고 노드는 찌그러지지 않도록 별도 요소로 둔다. */
function GitGraphCell({ row, columns }: { row: GitGraphRow; columns: number }) {
  const x = (lane: number) => lane * GIT_GRAPH_COLUMN_WIDTH + GIT_GRAPH_COLUMN_WIDTH / 2;
  const width = columns * GIT_GRAPH_COLUMN_WIDTH;
  return (
    <span className="git-log-graph" style={{ width }} aria-hidden="true">
      <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
        {row.segments.map((segment, index) => {
          const fromX = x(segment.from);
          const toX = x(segment.to);
          const startY = segment.start === "node" ? 50 : 0;
          const path = fromX === toX
            ? `M ${fromX} ${startY} L ${toX} 100`
            : `M ${fromX} ${startY} C ${fromX} 72, ${toX} 78, ${toX} 100`;
          return <path className={`git-graph-stroke lane-color-${segment.color}`} d={path} key={`${index}:${path}`} />;
        })}
        {row.continuesFromTop && <path className={`git-graph-stroke lane-color-${row.color}`} d={`M ${x(row.lane)} 0 L ${x(row.lane)} 50`} />}
      </svg>
      <span className={`git-log-node lane-color-${row.color}`} style={{ left: x(row.lane) }} />
    </span>
  );
}

/** 펼친 파일 목록의 높이만큼 다음 커밋을 기다리는 레인을 곧게 이어 준다. */
function GitGraphTails({ row, columns }: { row: GitGraphRow; columns: number }) {
  const width = columns * GIT_GRAPH_COLUMN_WIDTH;
  return (
    <span className="git-log-graph git-log-graph-tails" style={{ width }} aria-hidden="true">
      {row.tails.map((tail) => (
        <span
          className={`git-graph-tail lane-color-${tail.color}`}
          style={{ left: tail.lane * GIT_GRAPH_COLUMN_WIDTH + GIT_GRAPH_COLUMN_WIDTH / 2 }}
          key={`${tail.lane}:${tail.color}`}
        />
      ))}
    </span>
  );
}

function LogRow({ commit, graphRow, graphColumns, expanded, onToggle, picked, onTogglePick, git }: {
  commit: GitCommit;
  graphRow: GitGraphRow;
  graphColumns: number;
  expanded: boolean;
  onToggle: () => void;
  picked: boolean;
  onTogglePick: () => void;
  git: ProjectGitState;
}) {
  const { text } = useI18n();
  return (
    <li className={`git-log-row lane-color-${graphRow.color}${expanded ? " expanded" : ""}${picked ? " picked" : ""}`}>
      <div className="git-log-head">
        <button
          className="git-log-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          title={commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject}
        >
          <GitGraphCell row={graphRow} columns={graphColumns} />
          <code className="git-log-sha" title={commit.sha}>{commit.shortSha}</code>
          <div className="git-log-cells">
            <div className="git-log-main">
              <strong>{commit.subject}</strong>
              {commit.refs.length > 0 && (
                <span className="git-log-refs">{commit.refs.map((ref) => <span className="skill-extra-pill" key={ref}>{ref}</span>)}</span>
              )}
              {commit.parents.length > 1 && <small>{text("병합 커밋", "Merge commit")}</small>}
            </div>
            <div className="git-log-author" title={`${commit.authorName} <${commit.authorEmail}>`}>
              <strong>{commit.authorName}</strong>
              <small>{commit.authorEmail}</small>
            </div>
            <time className="git-log-time" dateTime={new Date(commit.committedAt * 1000).toISOString()} title={formatDate(commit.committedAt * 1000)}>
              <strong>{formatDate(commit.committedAt * 1000)}</strong>
              <small>{formatRelative(commit.committedAt * 1000)}</small>
            </time>
          </div>
        </button>
        <label className="check-filter git-log-pick">
          <input
            type="checkbox"
            checked={picked}
            onChange={onTogglePick}
            aria-label={text(`AIA에 넘길 커밋으로 선택: ${commit.subject}`, `Select for AIA: ${commit.subject}`)}
          />
        </label>
      </div>
      {expanded && (
        <div className="git-log-expanded" style={{ paddingLeft: graphColumns * GIT_GRAPH_COLUMN_WIDTH }}>
          <GitGraphTails row={graphRow} columns={graphColumns} />
          <section className="git-commit-detail" aria-label={text("커밋 상세", "Commit details")}>
            <strong>{commit.subject}</strong>
            {commit.body.trim() !== "" && <pre>{commit.body}</pre>}
            <dl>
              <div><dt>{text("작성 계정", "Author")}</dt><dd>{commit.authorName} &lt;{commit.authorEmail}&gt;</dd></div>
              <div><dt>{text("작성 시간", "Authored")}</dt><dd>{formatDate(commit.authoredAt * 1000)}</dd></div>
              <div><dt>{text("커밋 수행 계정", "Committer")}</dt><dd>{commit.committerName}</dd></div>
              <div><dt>{text("커밋 시간", "Committed")}</dt><dd>{formatDate(commit.committedAt * 1000)}</dd></div>
            </dl>
          </section>
          <CommitFilesList commit={commit} git={git} />
        </div>
      )}
    </li>
  );
}

/** 펼친 커밋의 파일 목록. 펼칠 때 한 번 읽고, 실패는 그 자리에 적는다. */
function CommitFilesList({ commit, git }: { commit: GitCommit; git: ProjectGitState }) {
  const { text } = useI18n();
  const { projectPath } = git;
  const [files, setFiles] = useState<GitCommitFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getProjectGitCommitFiles({ projectPath, sha: commit.sha })
      .then((next) => { if (live) { setFiles(next); setError(null); } })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [projectPath, commit.sha]);
  if (error) return <div className="git-commit-files-note"><ErrorBanner message={error} /></div>;
  if (files === null) return <p className="git-commit-files-note">{text("바꾼 파일을 읽고 있습니다…", "Reading changed files…")}</p>;
  if (files.files.length === 0) return <p className="git-commit-files-note">{text("바꾼 파일이 없습니다.", "No files changed.")}</p>;
  return (
    <>
      <ul className="git-commit-files">
        {files.files.map((file) => (
          <li className="git-commit-file" key={`${file.originalPath ?? ""}→${file.path}`}>
            <code className="git-change-code" title={changeKindLabels(text)[gitChangeLabelKey(file.status)]}>{gitChangeKindCode(file.status)}</code>
            <button
              className="git-change-path"
              type="button"
              title={file.path}
              onClick={() => git.selectDiff({ path: file.path, originalPath: file.originalPath, staged: false, commit: commit.sha })}
            >
              {file.originalPath && <><span className="git-change-origin">{file.originalPath}</span> → </>}
              {file.path}
            </button>
          </li>
        ))}
      </ul>
      {files.truncated && <p className="git-commit-files-note">{text("파일이 많아 일부만 보입니다.", "Too many files; only some are shown.")}</p>}
    </>
  );
}

function LogSection({ git, onRequestAiaPrompt }: { git: ProjectGitState; onRequestAiaPrompt: (prompt: string) => void }) {
  const { text } = useI18n();
  const { log, logError, logLoading, projectPath } = git;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 고른 커밋의 SHA를 **고른 순서대로** 담는다. Set 을 쓰면 그 순서가 사라진다. */
  const [picked, setPicked] = useState<readonly string[]>([]);
  useEffect(() => { setQuery(""); setExpanded(null); setPicked([]); }, [projectPath]);
  const visibleCommits = useMemo(() => filterGitCommits(log?.commits ?? [], query), [log?.commits, query]);
  const graph = useMemo(() => {
    // 검색으로 감춘 부모까지 선을 이어 그리면 화면 밖 커밋으로 향하는 꼬리만 남는다.
    // 보이는 집합 안의 관계만 그래프로 그려 검색 결과를 독립된 이력처럼 읽게 한다.
    const visibleShas = new Set(visibleCommits.map((commit) => commit.sha));
    return layoutGitGraph(visibleCommits.map((commit) => ({
      sha: commit.sha,
      parents: commit.parents.filter((parent) => visibleShas.has(parent)),
    })));
  }, [visibleCommits]);
  const togglePick = useCallback((sha: string) => {
    setPicked((current) => current.includes(sha) ? current.filter((entry) => entry !== sha) : [...current, sha]);
  }, []);
  // 머리글이 세는 수와 요청에 실리는 수는 **같은 계산**에서 나온다. 이력은 개요가 올 때마다
  // 다시 읽히므로 고른 SHA가 사라질 수 있고(브랜치 전환·rebase), 둘을 따로 세면 화면이
  // 전달되지 않을 선택까지 센다.
  const selection = useMemo(
    () => resolveAiaReviewSelection({ picked, commits: log?.commits ?? [] }),
    [picked, log?.commits],
  );
  const requestAiaReview = (intent: "review" | "analyze") => {
    if (selection.commits.length === 0) return;
    onRequestAiaPrompt(buildAiaCommitReviewRequest({ projectPath, commits: selection.commits, intent }).prompt);
    setPicked([]);
  };
  const overCap = selection.commits.length > MAX_AIA_REVIEW_COMMITS;
  return (
    <section className="git-log settings-subsection">
      <header>
        <div><strong>{text("이력", "History")}</strong></div>
        {picked.length > 0 && (
          <span className="git-row-actions">
            <small>
              {text(`${selection.commits.length}개 선택`, `${selection.commits.length} selected`)}
              {overCap && ` · ${text(`앞 ${MAX_AIA_REVIEW_COMMITS}개만 전달됩니다`, `only the first ${MAX_AIA_REVIEW_COMMITS} are sent`)}`}
              {selection.missing.length > 0 && ` · ${text(`${selection.missing.length}개는 지금 이력에 없어 전달되지 않습니다`, `${selection.missing.length} are no longer in this history and will not be sent`)}`}
            </small>
            <button className="button compact" type="button" disabled={selection.commits.length === 0} onClick={() => requestAiaReview("review")}>
              <Sparkles size={13} />{text("AIA 리뷰", "AIA review")}
            </button>
            <button className="button compact" type="button" disabled={selection.commits.length === 0} onClick={() => requestAiaReview("analyze")}>
              {text("AIA 분석", "AIA analysis")}
            </button>
            <button className="button compact" type="button" onClick={() => setPicked([])}>{text("선택 해제", "Clear")}</button>
          </span>
        )}
      </header>
      <div className="git-log-toolbar">
        <div className="git-log-search" role="search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={text("메시지, 계정, SHA, 브랜치 검색", "Search message, account, SHA, or branch")}
            aria-label={text("커밋 이력 검색", "Search commit history")}
          />
          {query !== "" && (
            <button type="button" onClick={() => setQuery("")} aria-label={text("검색어 지우기", "Clear search")} title={text("검색어 지우기", "Clear search")}>
              <X size={13} />
            </button>
          )}
        </div>
        <small>{log ? text(`불러온 ${log.commits.length}개 중 ${visibleCommits.length}개`, `${visibleCommits.length} of ${log.commits.length} loaded`) : text("이력을 불러오는 중", "Loading history")}</small>
      </div>
      {logError && <ErrorBanner message={logError} />}
      {log === null && !logError && (logLoading
        ? <LoadingState label={text("이력을 읽고 있습니다", "Reading history")} />
        : <p className="git-empty-note">{text("표시할 커밋이 없습니다.", "No commits to show.")}</p>)}
      {log && log.commits.length === 0 && <p className="git-empty-note">{text("표시할 커밋이 없습니다.", "No commits to show.")}</p>}
      {log && log.commits.length > 0 && visibleCommits.length === 0 && (
        <p className="git-empty-note">{text("검색 조건과 일치하는 커밋이 없습니다.", "No commits match your search.")}</p>
      )}
      {log && visibleCommits.length > 0 && (
        <>
          <div className="git-log-columns" style={{ paddingLeft: 12 + graph.columns * GIT_GRAPH_COLUMN_WIDTH }} aria-hidden="true">
            <span className="git-log-column-sha">SHA</span>
            <span>{text("커밋 메시지", "Commit message")}</span>
            <span>{text("커밋 계정", "Account")}</span>
            <span>{text("커밋 시간", "Committed")}</span>
            <span className="git-log-column-pick">{text("선택", "Select")}</span>
          </div>
          <ul className="git-log-list">
          {visibleCommits.map((commit, index) => (
            <LogRow key={commit.sha} commit={commit} graphRow={graph.rows[index]} graphColumns={graph.columns} expanded={expanded === commit.sha} onToggle={() => setExpanded(expanded === commit.sha ? null : commit.sha)} picked={picked.includes(commit.sha)} onTogglePick={() => togglePick(commit.sha)} git={git} />
          ))}
          </ul>
        </>
      )}
      {log?.hasMore && (
        <div className="form-actions">
          <button className="button compact" type="button" disabled={logLoading} onClick={git.loadMoreLog}>{text("더 보기", "Show more")}</button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 저장소 아님

function UnavailableState({ reason, detail }: { reason: GitUnavailableReason | null; detail: string | null }) {
  const { text } = useI18n();
  const titles: Record<GitUnavailableReason, string> = {
    gitMissing: text("git을 찾을 수 없습니다.", "git was not found."),
    gitTooOld: text("git 버전이 너무 오래됐습니다.", "The git version is too old."),
    notRepository: text("git 저장소가 아닙니다.", "Not a git repository."),
    bareRepository: text("bare 저장소는 다루지 않습니다.", "Bare repositories are not supported."),
    restrictedRepository: text("이 위치의 저장소는 열 수 없습니다.", "This repository location cannot be opened."),
  };
  const details: Record<GitUnavailableReason, string> = {
    gitMissing: text("git을 설치하거나 PATH에 추가한 뒤 새로고침하세요.", "Install git or add it to PATH, then refresh."),
    gitTooOld: text("git을 업데이트한 뒤 새로고침하세요.", "Update git, then refresh."),
    notRepository: text("프로젝트 폴더나 그 상위에 .git이 없습니다.", "Neither the project folder nor its parents contain a .git directory."),
    bareRepository: text("작업 트리가 있는 클론을 등록하세요.", "Register a clone that has a working tree."),
    restrictedRepository: text("공급자 홈이나 앱 데이터 안의 저장소는 다루지 않습니다.", "Repositories inside a provider home or the app data directory are not handled."),
  };
  const title = reason ? titles[reason] : text("git 정보를 읽을 수 없습니다.", "Git information is unavailable.");
  const body = [reason ? details[reason] : null, detail].filter((part): part is string => Boolean(part)).join("\n");
  return <EmptyState title={title} detail={body || undefined} />;
}
