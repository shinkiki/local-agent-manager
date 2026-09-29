import { useMemo } from "react";
import { useI18n } from "../lib/i18n";
import { parseUnifiedDiff, unifiedDiffStats } from "../lib/unifiedDiff";

/**
 * unified diff 원문을 `SkillInstallDiff`의 `FileDiff`와 같은 행 틀로 그린다 — 줄 번호 두
 * 칸, 기호, 본문. hunk 머리말은 접힌 행(`.skip`)의 자리를 빌리고, 파일 머리말(`diff --git`·
 * `index`·`---`·`+++`)은 `.meta`로 흐리게 둔다.
 */
export function UnifiedDiffView({ patch }: { patch: string }) {
  const { text } = useI18n();
  const rows = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const stats = useMemo(() => unifiedDiffStats(rows), [rows]);
  return (
    <div className="git-diff-view">
      <div className="skill-diff-summary">
        <span className="skill-diff-count added">+{stats.added}</span>
        <span className="skill-diff-count removed">-{stats.removed}</span>
      </div>
      <pre className="skill-diff git-diff" data-user-content>
        {rows.map((row, index) => {
          if (row.kind === "hunk") return <div className="skip" key={`hunk-${index}`}>{row.text}</div>;
          if (row.kind === "meta") return <div className="meta" key={`meta-${index}`}>{row.text}</div>;
          if (row.kind === "noNewline") {
            return <div className="meta" key={`nonl-${index}`}>{text("\\ 파일 끝에 개행 없음", "\\ No newline at end of file")}</div>;
          }
          return (
            <div className={row.kind} key={`${row.kind}-${index}`}>
              <span className="ln">{row.before ?? ""}</span>
              <span className="ln">{row.after ?? ""}</span>
              <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
              <span className="txt">{row.text}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
