import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { getProjectGitDiff } from "../lib/ipc";
import { usePopoutWindowTitle } from "../lib/popoutWindow";
import type { PopoutRequest } from "../lib/popout";
import type { GitDiff } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";
import { GitDiffBody, gitDiffTargetLabel } from "./GitDiffModal";

type GitDiffRequest = Extract<PopoutRequest, { kind: "gitDiff" }>;

/**
 * 프로젝트 diff 하나만 띄우는 별도 창. 앱 셸(내비·상단바) 없이 제목줄과 본문만 그리며,
 * 대상은 주소에서 받아 백엔드에서 다시 읽는다 — 원본 창과 같은 백엔드를 공유하므로 열어
 * 둔 채 원본 창에서 파일을 바꾸면 이 창을 새로 고쳐 최신 내용을 본다.
 */
export function GitDiffWindow({ request }: { request: GitDiffRequest }) {
  const { text } = useI18n();
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const label = gitDiffTargetLabel(request, text);
  usePopoutWindowTitle(`${request.path} · ${label}`);

  const load = () => {
    setLoading(true);
    getProjectGitDiff({
      projectPath: request.projectPath,
      path: request.path,
      originalPath: request.originalPath,
      staged: request.staged,
      commit: request.commit,
    })
      .then((next) => { setDiff(next); setError(null); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };
  // 창이 뜰 때 한 번 읽는다. 다시 읽기는 머리줄 버튼이 한다.
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="git-diff-window">
      <header className="git-diff-window-head">
        <div>
          <strong><code>{request.path}</code></strong>
          <small>{label}{request.originalPath ? ` · ${request.originalPath} →` : ""} · {request.projectPath}</small>
        </div>
        <button className="button compact" type="button" onClick={load} disabled={loading}>{text("새로고침", "Refresh")}</button>
      </header>
      <div className="git-diff-window-body">
        {error && <ErrorBanner message={error} />}
        {loading && diff === null ? <LoadingState label={text("차이를 읽고 있습니다", "Reading the diff")} /> : null}
        {diff && <GitDiffBody diff={diff} />}
      </div>
    </div>
  );
}
