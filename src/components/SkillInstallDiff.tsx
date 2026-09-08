import { useEffect, useMemo, useState } from "react";
import { compareSkillInstall } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errorText";
import { collapseUnchanged, diffLines, diffStats } from "../lib/textDiff";
import type { SkillFileChange, SkillInstallComparison } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";

/**
 * 외부 수정이 감지된 설치본 하나와 보관 원본의 파일별 차이. 방향은 "원본 → 설치본"이라
 * `+`는 설치본에만 있는 줄, `-`는 원본에만 있는 줄이다. 동기화·덮어쓰기 버튼은
 * 부모(드로어)가 이미 갖고 있으므로 여기서는 읽기만 한다.
 */
export function SkillInstallDiff({ skillId, refreshKey }: { skillId: string; refreshKey?: string | null }) {
  const { text } = useI18n();
  const [comparison, setComparison] = useState<SkillInstallComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setComparison(null);
    setError(null);
    compareSkillInstall(skillId)
      .then((result) => {
        if (cancelled) return;
        setComparison(result);
        setOpenPath(result.files[0]?.path ?? null);
      })
      .catch((cause) => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [skillId, refreshKey]);

  if (error) return <ErrorBanner message={error} />;
  if (!comparison) return <LoadingState label={text("변경 내용을 비교하는 중…", "Comparing…")} />;

  const counts = { added: 0, removed: 0, modified: 0 };
  for (const file of comparison.files) counts[file.status] += 1;

  return (
    <div className="skill-diff-panel" data-testid="skill-install-diff">
      <div className="skill-diff-summary">
        <span>{text("보관 원본 → 이 설치본", "Archived source → this install")}</span>
        <span className="skill-diff-count added">{text(`추가 ${counts.added}`, `${counts.added} added`)}</span>
        <span className="skill-diff-count removed">{text(`삭제 ${counts.removed}`, `${counts.removed} removed`)}</span>
        <span className="skill-diff-count modified">{text(`수정 ${counts.modified}`, `${counts.modified} modified`)}</span>
        <span className="skill-diff-count">{text(`동일 ${comparison.unchangedCount}`, `${comparison.unchangedCount} unchanged`)}</span>
      </div>
      {comparison.symlinks.length > 0 && (
        <p className="skill-diff-note">{text(
          `설치본의 심볼릭 링크 ${comparison.symlinks.length}개는 비교에서 제외했습니다. 링크가 있으면 이 버전으로 동기화할 수 없습니다.`,
          `${comparison.symlinks.length} symlink(s) in the install were skipped. Syncing to this version is refused while links exist.`,
        )}</p>
      )}
      {comparison.truncated && (
        <p className="skill-diff-note">{text("설치본 파일이 너무 많아 일부만 비교했습니다.", "Too many files in the install; only part was compared.")}</p>
      )}
      {comparison.files.length === 0 ? (
        <p className="skill-diff-note">{text(
          "내용 차이가 없습니다. 지문만 다른 경우이므로 다시 조회하면 사라질 수 있습니다.",
          "No content differences. Only the digest differed; refreshing may clear the flag.",
        )}</p>
      ) : (
        <ul className="skill-diff-files">
          {comparison.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`skill-diff-file${openPath === file.path ? " active" : ""}`}
                aria-expanded={openPath === file.path}
                onClick={() => setOpenPath(openPath === file.path ? null : file.path)}
              >
                <span className={`skill-diff-status ${file.status}`}>{statusLabel(file, text)}</span>
                <code>{file.path}</code>
                <FileStats file={file} />
              </button>
              {openPath === file.path && <FileDiff file={file} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function statusLabel(file: SkillFileChange, text: (ko: string, en: string) => string): string {
  const base = file.status === "added"
    ? text("추가", "added")
    : file.status === "removed"
      ? text("삭제", "removed")
      : text("수정", "modified");
  return file.executableChanged ? `${base} · ${text("실행 권한", "exec bit")}` : base;
}

function FileStats({ file }: { file: SkillFileChange }) {
  const { text } = useI18n();
  if (file.binary) return <small>{text("바이너리", "binary")}</small>;
  if (file.tooLarge) return <small>{text("너무 큼", "too large")}</small>;
  const stats = diffStats(diffLines(file.source ?? "", file.install ?? ""));
  return (
    <small>
      {stats.added > 0 && <span className="skill-diff-count added">+{stats.added}</span>}
      {stats.removed > 0 && <span className="skill-diff-count removed">-{stats.removed}</span>}
    </small>
  );
}

function FileDiff({ file }: { file: SkillFileChange }) {
  const { text } = useI18n();
  // 내용이 같은 파일은 collapseUnchanged가 동일 줄을 skip 행 하나로 접어 돌려주므로 rows가
  // 비지 않는다. "차이가 있는가"는 rows 유무가 아니라 추가·삭제 줄 수로 판단해야, 실행
  // 권한만 다른 파일이 "… N줄 동일"만 든 빈 diff 대신 안내를 받는다(QA #45).
  const { rows, changed } = useMemo(() => {
    if (file.binary || file.tooLarge) return { rows: [], changed: false };
    const lines = diffLines(file.source ?? "", file.install ?? "");
    const stats = diffStats(lines);
    return { rows: collapseUnchanged(lines), changed: stats.added + stats.removed > 0 };
  }, [file]);
  if (file.binary) {
    return <p className="skill-diff-note">{text("텍스트가 아니어서 내용을 비교할 수 없습니다.", "Not a text file; contents cannot be compared.")}</p>;
  }
  if (file.tooLarge) {
    return <p className="skill-diff-note">{text("파일이 너무 커서 내용을 싣지 않았습니다.", "File is too large to show inline.")}</p>;
  }
  if (!changed) {
    return file.executableChanged
      ? <p className="skill-diff-note">{text("내용은 같고 실행 권한만 다릅니다.", "Contents match; only the exec bit differs.")}</p>
      : <p className="skill-diff-note">{text("이 파일은 내용 차이가 없습니다.", "No content differences in this file.")}</p>;
  }
  return (
    <pre className="skill-diff" data-user-content>
      {rows.map((row, index) => row.kind === "skip"
        ? <div className="skip" key={`skip-${index}`}>{text(`… ${row.count}줄 동일`, `… ${row.count} unchanged line(s)`)}</div>
        : (
          <div className={row.kind} key={`${row.kind}-${row.before ?? ""}-${row.after ?? ""}`}>
            <span className="ln">{row.before ?? ""}</span>
            <span className="ln">{row.after ?? ""}</span>
            <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
            <span className="txt">{row.text}</span>
          </div>
        ))}
    </pre>
  );
}
