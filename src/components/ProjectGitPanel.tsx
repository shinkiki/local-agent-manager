import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch as GitBranchIcon, GitCompareArrows, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { UiText } from "../lib/i18nLocale";
import { formatDate, formatRelative } from "../lib/format";
import { displayPath } from "../lib/displayPath";
import { getWebAccessStatus, type WebAccessStatus } from "../lib/ipcTransport";
import {
  commitProjectGit,
  fetchProjectGit,
  getProjectGitCommitFiles,
  getProjectGitDiff,
  getProjectGitLog,
  getProjectGitOverview,
  getProjectGitStatus,
  pullProjectGit,
  pushProjectGit,
  rebaseProjectGit,
  stageProjectGitPaths,
  stashProjectGit,
  switchProjectGitBranch,
  unstageProjectGitPaths,
} from "../lib/ipc";
import { gitChangeCode, gitChangeKindCode, gitChangeLabelKey, groupGitStatus, type GitChangeLabelKey } from "../lib/gitStatus";
import { layoutGitGraph, type GitGraphRow } from "../lib/gitGraph";
import { gitConflictAiaPrompt } from "../lib/gitConflictAiaPrompt";
import { MAX_AIA_REVIEW_COMMITS, buildAiaCommitReviewRequest } from "../lib/projectAiaHandoff";
import type {
  GitActionReceipt,
  GitBranch,
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
  const { overview, status, loading, loadError, receipt, access, busy, actionError } = git;

  const canWrite = access?.writable === true;
  const writeReason = access === null
    ? text("접속 권한을 확인하고 있습니다.", "Checking access.")
    : !canWrite
      ? text("원격 편집이 꺼져 있어 변경할 수 없습니다.", "Remote editing is off; changes are disabled.")
      : null;
  const remote = access?.remote === true;
  const locked = !canWrite || busy !== null;

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
  const requestAiaConflictHelp = (operation: string, conflicts: readonly string[], blocked: readonly string[] = []) => {
    onRequestAiaPrompt(gitConflictAiaPrompt({ projectPath, operation, conflictedFiles: conflicts, blockedFiles: blocked }));
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
        remote={remote}
        writeReason={writeReason}
        confirm={confirm}
        git={git}
      />
      {repository.inProgress && <InProgressBanner inProgress={repository.inProgress} conflictedFiles={conflictedFiles} locked={locked} confirm={confirm} onRequestAiaConflictHelp={requestAiaConflictHelp} git={git} />}
      {receipt && <ReceiptBanner receipt={receipt} showAiaHelp={repository.inProgress === null} onRequestAiaConflictHelp={requestAiaConflictHelp} />}
      <div className="git-panel">
        <div className="git-panel-aside">
          <ChangesSection status={status} locked={locked} git={git} />
          <CommitBox status={status} locked={locked} git={git} />
          <FollowCardsSection repository={repository} />
          <BranchesSection repository={repository} locked={locked} confirm={confirm} git={git} />
          <WorktreesSection worktrees={repository.worktrees} />
          <StashesSection repository={repository} locked={locked} confirm={confirm} git={git} />
        </div>
        <div className="git-panel-main">
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
}

const LOG_PAGE = 30;

interface ProjectGitState {
  projectPath: string;
  overview: GitOverview | null;
  status: GitStatus | null;
  loading: boolean;
  loadError: string | null;
  receipt: GitActionReceipt | null;
  access: WebAccessStatus | null;
  busy: GitBusyKey | null;
  actionError: string | null;
  selectedDiff: DiffSelection | null;
  diff: GitDiff | null;
  diffError: string | null;
  diffLoading: boolean;
  log: GitLog | null;
  logError: string | null;
  logLoading: boolean;
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
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
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

  useEffect(() => {
    let disposed = false;
    getWebAccessStatus().then((next) => { if (!disposed) setAccess(next); }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);

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
    if (!active || selectedDiff === null || (selectedDiff.commit === null && status === null)) {
      if (selectedDiff === null) setDiff(null);
      return;
    }
    const generation = diffGeneration.open();
    setDiffLoading(true);
    void diffGeneration.latest(
      generation,
      () => getProjectGitDiff({ projectPath, path: selectedDiff.path, originalPath: selectedDiff.originalPath, staged: selectedDiff.staged, commit: selectedDiff.commit }),
      {
        onResult: (next) => { setDiff(next); setDiffError(null); },
        onError: setDiffError,
        onSettled: () => setDiffLoading(false),
      },
    );
  }, [active, selectedDiff, status, projectPath, diffGeneration]);

  const mutate = useCallback(async (key: GitBusyKey, action: () => Promise<GitActionReceipt>) => {
    let result: GitActionReceipt | null = null;
    await run(key, async () => {
      setReceipt(null);
      try {
        result = await action();
        setReceipt(result);
      } finally {
        await refresh();
      }
    });
    return result;
  }, [run, refresh]);

  return {
    projectPath, overview, status, loading, loadError, receipt, access, busy, actionError,
    selectedDiff, diff, diffError, diffLoading, log, logError, logLoading,
    refresh, mutate, selectDiff: setSelectedDiff, loadMoreLog,
  };
}

// ---------------------------------------------------------------------------
// 개요 머리

function OverviewHeader({ projectPath, repository, locked, loading, remote, writeReason, confirm, git }: {
  projectPath: string;
  repository: GitRepositoryInfo;
  locked: boolean;
  loading: boolean;
  remote: boolean;
  writeReason: string | null;
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

  const pushDisabled = locked || remote || head.unborn || head.detached;
  const pushTitle = remote
    ? text("밀어올리기는 호스트 화면에서만 할 수 있습니다.", "Push is available only on the host.")
    : undefined;

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
        <button className="button compact" type="button" disabled={pushDisabled} title={pushTitle} onClick={() => void push()}>
          {text("밀어올리기", "Push")}
        </button>
        <button className="button compact" type="button" disabled={locked || head.unborn || repository.inProgress !== null} onClick={() => setRebaseOpen((open) => !open)}>
          {text("리베이스…", "Rebase…")}
        </button>
        {writeReason && <small className="git-write-reason">{writeReason}</small>}
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
  onRequestAiaConflictHelp: (operation: string, conflicted: readonly string[], blocked?: readonly string[]) => void;
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
              <Sparkles size={13} />{text("AIA로 해결", "Resolve with AIA")}
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
  onRequestAiaConflictHelp: (operation: string, conflicted: readonly string[], blocked?: readonly string[]) => void;
}) {
  const { text } = useI18n();
  const output = [receipt.stdout, receipt.stderr].filter((part) => part.trim().length > 0).join("\n");
  const canAskAia = showAiaHelp && !receipt.succeeded && (receipt.conflictedFiles.length > 0 || receipt.blockedFiles.length > 0);
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
          <button className="button compact git-aia-resolve" type="button" onClick={() => onRequestAiaConflictHelp(receipt.action, receipt.conflictedFiles, receipt.blockedFiles)}>
            <Sparkles size={13} />{text("AIA로 해결", "Resolve with AIA")}
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
      </header>
      {total === 0 && <p className="git-empty-note">{text("변경 내용이 없습니다.", "No changes.")}</p>}
      {order.map((id) => groups[id].length > 0 && (
        <div className="git-change-group" data-group={id} key={id}>
          <div className="git-change-group-head">
            <strong>{labels[id]} <span>{groups[id].length}</span></strong>
            {id === "staged" && (
              <button className="button compact" type="button" disabled={locked} onClick={() => unstage(groups.staged.flatMap(entryPaths))}>{text("모두 내리기", "Unstage all")}</button>
            )}
            {(id === "unstaged" || id === "untracked") && (
              <button className="button compact" type="button" disabled={locked} onClick={() => stage(groups[id].flatMap(entryPaths))}>{text("모두 스테이지", "Stage all")}</button>
            )}
          </div>
          <ul className="git-change-list">
            {groups[id].map((entry) => (
              <ChangeRow
                key={`${id}:${entry.path}`}
                entry={entry}
                group={id}
                locked={locked}
                selected={git.selectedDiff?.commit === null && git.selectedDiff.path === entry.path && git.selectedDiff.staged === (id === "staged")}
                onToggle={(checked) => (checked ? stage(entryPaths(entry)) : unstage(entryPaths(entry)))}
                onSelect={() => git.selectDiff({ path: entry.path, staged: id === "staged", originalPath: entry.originalPath, commit: null })}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
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

function ChangeRow({ entry, group, locked, selected, onToggle, onSelect }: {
  entry: GitStatusEntry;
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
    <li className={`git-change-row${selected ? " selected" : ""}`}>
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
        <span>{entry.path}</span>
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
        disabled={!git.access?.writable}
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
// 팔로우 기준 동기화 상태

/**
 * 업스트림이 붙은 로컬 브랜치는 팔로우 카드로 따로 읽는다. `ahead`/`behind`는 Core가
 * 마지막 fetch 뒤의 로컬 ref에서 계산한 값이므로, 원격에 다시 묻는 화면 조회와 섞지
 * 않는다. fetch 시각 자체는 팔로우 저장소가 다음 단계에서 보관해 이 카드에 넘긴다.
 *
 * B5: 그래서 화면은 이 수를 **마지막 fetch 기준**이라고 못박는다. 예전 문구는
 * "가장 최근 가져오기 결과를 반영합니다"였는데, 그것은 값이 어디서 왔는지만 말할 뿐
 * 지금 원격과 다를 수 있다는 말이 아니었다. 사용자가 이 수를 실시간으로 읽으면
 * 가져오기를 하지 않은 채 "받을 것 없음"으로 판단하게 된다 — 로컬 ref가 몇 시간째
 * 그대로여도 수신 0은 그대로 0이기 때문이다. 그래서 섹션 캡션과 카드의 수치 칸
 * 양쪽에 같은 기준을 적고, 갱신하는 방법(가져오기)까지 한 문장에 담는다.
 */
function FollowCardsSection({ repository }: { repository: GitRepositoryInfo }) {
  const { text } = useI18n();
  const followedBranches = repository.localBranches.filter((branch) => branch.upstream !== null);
  if (followedBranches.length === 0) return null;

  return (
    <section className="git-branch-follows settings-subsection">
      <header>
        <div>
          <strong>{text("팔로우 중인 브랜치", "Followed branches")}</strong>
          <small>{text("수신·송신 수와 분기 상태는 실시간이 아니라 마지막 fetch 기준입니다. 최신 값을 보려면 가져오기를 실행하세요.", "Incoming, outgoing, and diverged are not live — they are as of the last fetch. Run fetch to refresh them.")}</small>
        </div>
      </header>
      <ul className="git-branch-follow-list">
        {followedBranches.map((branch) => {
          const incoming = branch.behind;
          const outgoing = branch.ahead;
          const diverged = incoming > 0 && outgoing > 0;
          // B4: 이 단계의 overview에는 fetch 시각이 없으므로 추측한 시간을 표시하지 않는다.
          const lastFetchedAt: number | null = null;
          return (
            <li className="git-branch-follow-card" key={branch.name}>
              <strong>{branch.name}</strong>
              <dl>
                <div><dt>{text("upstream", "Upstream")}</dt><dd>{branch.upstream}</dd></div>
                <div><dt>{text("마지막 fetch", "Last fetch")}</dt><dd>{lastFetchedAt === null ? text("기록 없음", "Not recorded") : formatDate(lastFetchedAt)}</dd></div>
                <div><dt>{text("수신", "Incoming")}</dt><dd>{incoming}<small className="git-follow-basis">{text("마지막 fetch 기준", "As of last fetch")}</small></dd></div>
                <div><dt>{text("송신", "Outgoing")}</dt><dd>{outgoing}<small className="git-follow-basis">{text("마지막 fetch 기준", "As of last fetch")}</small></dd></div>
                <div><dt>{text("분기됨", "Diverged")}</dt><dd>{diverged ? text("예", "Yes") : text("아니요", "No")}</dd></div>
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
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

  const row = (branch: GitBranch, isRemote: boolean) => (
    <li
      className={`git-branch-row${branch.isHead ? " current" : ""}`}
      key={`${isRemote ? "r" : "l"}:${branch.name}`}
      onContextMenu={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = event.clientX || bounds.left + 24;
        const y = event.clientY || bounds.top + 24;
        setContextMenu({ branch, remote: isRemote, x: Math.min(x, window.innerWidth - 238), y: Math.min(y, window.innerHeight - 126) });
      }}
    >
      <div className="git-branch-main">
        <strong>{branch.name}</strong>
        <small>
          {branch.sha.slice(0, 7)}
          {branch.upstream && ` · ${branch.upstream} ↑${branch.ahead} ↓${branch.behind}${branch.gone ? ` (${text("사라짐", "gone")})` : ""}`}
          {branch.committedAt > 0 && ` · ${formatRelative(branch.committedAt * 1000)}`}
        </small>
        {branch.subject && <small className="git-branch-subject" title={branch.subject}>{branch.subject}</small>}
      </div>
      <button className="button compact" type="button" disabled={locked || branch.isHead} onClick={() => void switchTo(branch, isRemote)}>
        {text("전환", "Switch")}
      </button>
    </li>
  );

  return (
    <section className="git-branches settings-subsection">
      <header>
        <div>
          <strong>{text("브랜치", "Branches")}</strong>
          {repository.branchesTruncated && <small>{text("브랜치가 많아 일부만 보입니다.", "Too many branches; only some are shown.")}</small>}
        </div>
        <button className="button compact" type="button" disabled={locked} onClick={() => setCreateOpen((open) => !open)}>{text("새 브랜치", "New branch")}</button>
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
      <ul className="git-branch-list">
        {repository.localBranches.map((branch) => row(branch, false))}
      </ul>
      {repository.remoteBranches.length > 0 && (
        <>
          <div className="git-change-group-head"><strong>{text("원격 브랜치", "Remote branches")}</strong></div>
          <ul className="git-branch-list">
            {repository.remoteBranches.map((branch) => row(branch, true))}
          </ul>
        </>
      )}
      {contextMenu && (
        <div
          className="git-branch-context-menu"
          ref={contextMenuRef}
          role="menu"
          aria-label={text(`${contextMenu.branch.name} 브랜치 메뉴`, `${contextMenu.branch.name} branch menu`)}
          style={{ left: Math.max(8, contextMenu.x), top: Math.max(8, contextMenu.y) }}
        >
          <header><strong>{contextMenu.branch.name}</strong></header>
          <button
            type="button"
            role="menuitem"
            disabled={locked || contextMenu.branch.isHead}
            onClick={() => { const target = contextMenu; setContextMenu(null); void switchTo(target.branch, target.remote); }}
          >
            <GitBranchIcon size={14} />{text("이 브랜치로 전환", "Switch to this branch")}
          </button>
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
      <label className="check-filter git-log-pick">
        <input
          type="checkbox"
          checked={picked}
          onChange={onTogglePick}
          aria-label={text(`AIA에 넘길 커밋으로 선택: ${commit.subject}`, `Select for AIA: ${commit.subject}`)}
        />
      </label>
      <button
        className="git-log-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        title={commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject}
      >
        <GitGraphCell row={graphRow} columns={graphColumns} />
        <code className="git-log-sha" title={commit.sha}>{commit.shortSha}</code>
        <div className="git-log-main">
          <strong>{commit.subject}</strong>
          <small>
            {commit.authorName} · <span title={formatDate(commit.committedAt * 1000)}>{formatRelative(commit.committedAt * 1000)}</span>
            {commit.parents.length > 1 && ` · ${text("병합", "merge")}`}
          </small>
          {commit.refs.length > 0 && (
            <span className="git-log-refs">{commit.refs.map((ref) => <span className="skill-extra-pill" key={ref}>{ref}</span>)}</span>
          )}
        </div>
      </button>
      </div>
      {expanded && (
        <div className="git-log-expanded" style={{ paddingLeft: graphColumns * GIT_GRAPH_COLUMN_WIDTH }}>
          <GitGraphTails row={graphRow} columns={graphColumns} />
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
  /** 고른 커밋의 SHA를 **고른 순서대로** 담는다. Set 을 쓰면 그 순서가 사라진다. */
  const [picked, setPicked] = useState<readonly string[]>([]);
  const graph = useMemo(() => layoutGitGraph(log?.commits ?? []), [log?.commits]);
  const togglePick = useCallback((sha: string) => {
    setPicked((current) => current.includes(sha) ? current.filter((entry) => entry !== sha) : [...current, sha]);
  }, []);
  const requestAiaReview = (intent: "review" | "analyze") => {
    const bySha = new Map((log?.commits ?? []).map((commit) => [commit.sha, commit]));
    const commits = picked
      .map((sha) => bySha.get(sha))
      .filter((commit): commit is GitCommit => commit !== undefined)
      .map((commit) => ({ sha: commit.sha, subject: commit.subject }));
    if (commits.length === 0) return;
    onRequestAiaPrompt(buildAiaCommitReviewRequest({ projectPath, commits, intent }).prompt);
    setPicked([]);
  };
  const overCap = picked.length > MAX_AIA_REVIEW_COMMITS;
  return (
    <section className="git-log settings-subsection">
      <header>
        <div><strong>{text("이력", "History")}</strong></div>
        {picked.length > 0 && (
          <span className="git-row-actions">
            <small>
              {text(`${picked.length}개 선택`, `${picked.length} selected`)}
              {overCap && ` · ${text(`앞 ${MAX_AIA_REVIEW_COMMITS}개만 전달됩니다`, `only the first ${MAX_AIA_REVIEW_COMMITS} are sent`)}`}
            </small>
            <button className="button compact" type="button" onClick={() => requestAiaReview("review")}>
              <Sparkles size={13} />{text("AIA 리뷰", "AIA review")}
            </button>
            <button className="button compact" type="button" onClick={() => requestAiaReview("analyze")}>
              {text("AIA 분석", "AIA analysis")}
            </button>
            <button className="button compact" type="button" onClick={() => setPicked([])}>{text("선택 해제", "Clear")}</button>
          </span>
        )}
      </header>
      {logError && <ErrorBanner message={logError} />}
      {log === null && !logError && (logLoading
        ? <LoadingState label={text("이력을 읽고 있습니다", "Reading history")} />
        : <p className="git-empty-note">{text("표시할 커밋이 없습니다.", "No commits to show.")}</p>)}
      {log && log.commits.length === 0 && <p className="git-empty-note">{text("표시할 커밋이 없습니다.", "No commits to show.")}</p>}
      {log && log.commits.length > 0 && (
        <ul className="git-log-list">
          {log.commits.map((commit, index) => (
            <LogRow key={commit.sha} commit={commit} graphRow={graph.rows[index]} graphColumns={graph.columns} expanded={expanded === commit.sha} onToggle={() => setExpanded(expanded === commit.sha ? null : commit.sha)} picked={picked.includes(commit.sha)} onTogglePick={() => togglePick(commit.sha)} git={git} />
          ))}
        </ul>
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
