import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import type { UiText } from "../lib/i18nLocale";
import { getProjectGitDiff } from "../lib/ipc";
import { openPopoutWindow } from "../lib/popoutWindow";
import { displayPath } from "../lib/displayPath";
import type { GitDiff } from "../types";
import { ErrorBanner, LoadingState, Modal } from "./Shared";
import { UnifiedDiffView } from "./UnifiedDiffView";

/** 모달과 별도 창이 함께 쓰는 diff 대상. 커밋이 있으면 커밋 diff, 없으면 작업 트리·인덱스다. */
export interface GitDiffTarget {
  projectPath: string;
  path: string;
  originalPath: string | null;
  staged: boolean;
  commit: string | null;
  /** B9. 비교 요약에서 연 파일은 커밋 하나가 아니라 `<from>...<to>` 범위다. */
  rangeFrom?: string | null;
  rangeTo?: string | null;
  /** 워크트리 목록에서 연 파일. 그 워크트리의 작업 트리·인덱스다. */
  worktreePath?: string | null;
}

/** 대상이 무엇과 무엇을 견주는지 한 줄. 모달 제목과 새 창 제목이 같은 말을 쓴다. */
export function gitDiffTargetLabel(target: GitDiffTarget, text: UiText): string {
  // 범위를 커밋 제목으로 적으면 어느 범위를 보고 있는지 사라진다 — 요약이 집은 범위를 그대로 쓴다.
  if (target.rangeFrom && target.rangeTo) return `${target.rangeFrom}...${target.rangeTo}`;
  if (target.commit) return `${text("커밋", "Commit")} ${target.commit.slice(0, 7)}`;
  const side = target.staged ? text("스테이지됨", "Staged") : text("작업 트리", "Working tree");
  return target.worktreePath ? `${text("연결된 워크트리", "Linked worktree")} ${displayPath(target.worktreePath)} · ${side}` : side;
}

/** diff 본문. 종류별 안내와 잘림 표시는 모달과 별도 창이 같아야 한다. */
export function GitDiffBody({ diff }: { diff: GitDiff }) {
  const { text } = useI18n();
  if (diff.kind === "binary") {
    return <p className="skill-diff-note">{text("텍스트가 아니어서 내용을 비교할 수 없습니다.", "Not a text file; contents cannot be compared.")}</p>;
  }
  if (diff.kind === "untracked") {
    return <p className="skill-diff-note">{text("아직 추적하지 않는 새 파일이라 비교할 원본이 없습니다. 스테이지하면 추가 내용이 보입니다.", "This is a new, untracked file with nothing to compare against. Stage it to see its contents as additions.")}</p>;
  }
  if (diff.kind === "empty" || diff.patch.trim() === "") {
    return <p className="skill-diff-note">{text("변경 내용이 없습니다.", "No changes.")}</p>;
  }
  return (
    <>
      {diff.truncated && <p className="skill-diff-note">{text("차이가 너무 커서 일부만 보입니다.", "The diff is too large; only part of it is shown.")}</p>}
      <UnifiedDiffView patch={diff.patch} />
    </>
  );
}

/**
 * 변경 파일 하나의 diff 모달. 작업 트리·스테이지·커밋 어느 대상이든 같은 창이고, 머리줄의
 * 새 창 버튼은 같은 대상을 별도 창으로 연다 — 큰 diff를 옆에 두고 다른 파일을 보거나 커밋
 * 메시지를 쓸 수 있게.
 */
export function GitDiffModal({ target, diff, error, loading, onClose }: {
  target: GitDiffTarget;
  diff: GitDiff | null;
  error: string | null;
  loading: boolean;
  onClose: () => void;
}) {
  const { text } = useI18n();
  const [full, setFull] = useState(false);
  const [fullDiff, setFullDiff] = useState<GitDiff | null>(null);
  const [fullError, setFullError] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const label = gitDiffTargetLabel(target, text);
  useEffect(() => {
    if (!full) return;
    let live = true;
    setFullDiff(null);
    setFullError(null);
    setFullLoading(true);
    getProjectGitDiff({
      ...target,
      worktreePath: target.worktreePath ?? null,
      rangeFrom: target.rangeFrom ?? null,
      rangeTo: target.rangeTo ?? null,
      fullContext: true,
    })
      .then((next) => { if (live) setFullDiff(next); })
      .catch((cause: unknown) => { if (live) setFullError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (live) setFullLoading(false); });
    return () => { live = false; };
  }, [full, target.projectPath, target.worktreePath, target.path, target.originalPath, target.staged, target.commit, target.rangeFrom, target.rangeTo]);
  let body: ReactNode;
  if (full) {
    if (fullError) body = <ErrorBanner message={fullError} />;
    else if (fullDiff === null || fullLoading) body = <LoadingState label={text("파일 전체 내용과 변경 내용을 읽고 있습니다", "Reading the full file and its changes")} />;
    else body = <GitDiffBody diff={fullDiff} />;
  } else if (error) body = <ErrorBanner message={error} />;
  else if (diff === null || (loading && diff.path !== target.path)) body = <LoadingState label={text("차이를 읽고 있습니다", "Reading the diff")} />;
  else body = <GitDiffBody diff={diff} />;
  const openWindow = () => {
    // 팝업 차단을 피하려면 클릭과 같은 흐름에서 열어야 하므로 기다리지 않는다.
    void openPopoutWindow({ kind: "gitDiff", ...target }).catch(() => undefined);
  };
  return (
    <Modal
      size={full ? "full" : "wide"}
      title={<span className="git-diff-modal-title"><code>{target.path}</code><small>{label}{target.originalPath ? ` · ${target.originalPath} →` : ""}</small></span>}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" aria-pressed={full} onClick={() => setFull((current) => !current)}>
            {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {full ? text("기본 보기", "Default view") : text("전체 보기", "Full view")}
          </button>
          <button className="button" type="button" onClick={openWindow}>
            <ExternalLink size={14} />{text("새 창", "New window")}
          </button>
          <button className="button secondary" type="button" onClick={onClose}>{text("닫기", "Close")}</button>
        </>
      }
    >
      <div className="git-diff-modal-body">{body}</div>
    </Modal>
  );
}
