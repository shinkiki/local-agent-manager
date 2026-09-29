import { useMemo, useState } from "react";
import { collapseUnchanged, diffLines, diffStats } from "../lib/textDiff";
import { useI18n } from "../lib/i18n";
import { contractText, workflowContractChanges } from "../lib/workflowContractDiff";
import type { SystemWorkflowVersion } from "../types";

/**
 * 등록된 두 버전 사이의 차이.
 *
 * 계약 본문은 상세 응답의 `versions[].contract`에 실려 오므로 비교는 화면 안에서 끝난다.
 * 백엔드를 한 번 더 부르지 않고, 버전을 바꿔 가며 보는 동안에도 왕복이 없다.
 *
 * 계약 본문이 없는 구형 백엔드 응답에서는 이 자리가 통째로 빠진다 — 빈 비교를 보여 주는 것과
 * 비교할 수 없다고 말하는 것은 다르고, 후자가 사실이다.
 */
export function WorkflowVersionDiff({ versions }: { versions: SystemWorkflowVersion[] }) {
  const { text } = useI18n();
  const comparable = versions.filter((version) => version.contract != null);
  const [base, setBase] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);

  // 고르지 않았으면 가장 최근 두 벌을 본다. 버전을 올린 직후 알고 싶은 것이 그것이다.
  const baseVersion = base ?? comparable[comparable.length - 2]?.version ?? null;
  const targetVersion = target ?? comparable[comparable.length - 1]?.version ?? null;
  const before = comparable.find((version) => version.version === baseVersion)?.contract ?? null;
  const after = comparable.find((version) => version.version === targetVersion)?.contract ?? null;

  const view = useMemo(() => {
    if (!before || !after) return null;
    const lines = diffLines(contractText(before), contractText(after));
    return { changes: workflowContractChanges(before, after), rows: collapseUnchanged(lines), stats: diffStats(lines) };
  }, [before, after]);

  if (comparable.length < 2) {
    return <p className="workflow-diff-note">{text(
      "비교할 이전 버전이 없습니다.",
      "There is no earlier version to compare against.",
    )}</p>;
  }

  return <div className="workflow-version-diff">
    <div className="workflow-diff-picker">
      <label>
        <span>{text("기준", "Base")}</span>
        <select value={baseVersion ?? ""} onChange={(event) => setBase(Number(event.target.value))}>
          {comparable.map((version) => <option value={version.version} key={version.version}>v{version.version}</option>)}
        </select>
      </label>
      <label>
        <span>{text("비교", "Compare")}</span>
        <select value={targetVersion ?? ""} onChange={(event) => setTarget(Number(event.target.value))}>
          {comparable.map((version) => <option value={version.version} key={version.version}>v{version.version}</option>)}
        </select>
      </label>
      {view && <span className="workflow-diff-counts">
        <span className="skill-diff-count added">+{view.stats.added}</span>
        <span className="skill-diff-count removed">-{view.stats.removed}</span>
      </span>}
    </div>
    {view?.changes.identical
      ? <p className="workflow-diff-note">{text("두 버전의 계약 내용이 같습니다.", "The two versions carry the same contract.")}</p>
      : view && <>
        <ul className="workflow-diff-summary">
          {summaryLines(view.changes, text).map((line) => <li key={line}>{line}</li>)}
        </ul>
        <pre className="skill-diff" data-user-content>
          {view.rows.map((row, index) => row.kind === "skip"
            ? <div className="skip" key={`skip-${index}`}>{text(`… ${row.count}줄 동일`, `… ${row.count} unchanged line(s)`)}</div>
            : <div className={row.kind} key={`${row.kind}-${row.before ?? ""}-${row.after ?? ""}`}>
              <span className="ln">{row.before ?? ""}</span>
              <span className="ln">{row.after ?? ""}</span>
              <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
              <span className="txt">{row.text}</span>
            </div>)}
        </pre>
      </>}
  </div>;
}

/**
 * 버전을 올린 이유를 먼저 한 줄씩 말한다. 원문 비교만 있으면 JSON에서 그 이유를 사람이
 * 찾아 읽어야 하고, 단계 인자가 긴 계약에서는 그 일이 사실상 불가능하다.
 */
function summaryLines(
  changes: ReturnType<typeof workflowContractChanges>,
  text: (ko: string, en: string) => string,
): string[] {
  const lines: string[] = [];
  const group = (label: string, names: string[]) => (names.length > 0 ? `${label} ${names.join(", ")}` : null);
  for (const line of [
    group(text("단계 추가", "Steps added"), changes.steps.added),
    group(text("단계 삭제", "Steps removed"), changes.steps.removed),
    group(text("단계 변경", "Steps changed"), changes.steps.changed),
    group(text("입력 추가", "Inputs added"), changes.inputs.added),
    group(text("입력 삭제", "Inputs removed"), changes.inputs.removed),
    group(text("입력 변경", "Inputs changed"), changes.inputs.changed),
    group(text("스킬 추가", "Skills added"), changes.skills.added),
    group(text("스킬 삭제", "Skills removed"), changes.skills.removed),
    changes.riskChanged ? text("위험도 변경", "Risk changed") : null,
    changes.runtimeChanged ? text("공통 실행설정 변경", "Shared runtime settings changed") : null,
    changes.pacedChanged ? text("페이싱 회차 계약 여부 변경", "Paced-round contract flag changed") : null,
  ]) {
    if (line) lines.push(line);
  }
  // 네 갈래 어디에도 잡히지 않는 차이는 표시 이름·설명뿐이다. 아래 원문 비교가 그것을 보여 준다.
  if (lines.length === 0) lines.push(text("이름·설명만 달라졌습니다.", "Only the name or description changed."));
  return lines;
}
