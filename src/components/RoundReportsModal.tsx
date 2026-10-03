/**
 * 목표 하나의 회차 보고를 읽고 결정을 답하는 모달(M10).
 *
 * 보고와 미결 결정은 목표 카드 아래에 펼쳐 쌓지 않고 여기 한 곳에서 본다. 목표가 여럿이면
 * 어느 목표의 보고인지, 무엇을 정하는지가 한 화면에 섞여 흐름이 끊겼다(사용자 결정 2026-09-30).
 * 목록은 이 목표만 따로 조회하므로 패널의 전체 60건 상한에 잘리지 않는다.
 */
import { FileText } from "lucide-react";
import { type PropsWithChildren, useCallback, useEffect, useMemo, useState } from "react";

import { formatDateTime } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { listRoundReports, resolveRoundDecision } from "../lib/ipc";
import type { RoundDecision, RoundGoal, RoundReport } from "../types";
import { ErrorBanner, Modal } from "./Shared";

type Text = (ko: string, en: string) => string;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function outcomeLabel(text: Text, outcome: RoundReport["outcome"]): string {
  switch (outcome) {
    case "pass": return text("통과", "Pass");
    case "partial": return text("부분", "Partial");
    case "fail": return text("실패", "Fail");
  }
}

export function pendingDecisionCount(report: RoundReport): number {
  return report.decisions.filter((decision) => !decision.resolved).length;
}

/** 미결 결정 하나에 답하는 줄: 선택지 버튼(추천은 강조) + 직접 적기. */
export function RoundDecisionForm({ decision, busy, value, onChange, onAnswer }: {
  decision: RoundDecision;
  busy: boolean;
  value: string;
  onChange: (value: string) => void;
  onAnswer: (value: string) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="path-field-group round-decision-form">
      {decision.options.map((option) => (
        <button key={option} className={`button compact${decision.recommendation === option ? " primary" : ""}`} type="button" disabled={busy} onClick={() => onAnswer(option)}>
          {option}{decision.recommendation === option ? ` (${text("추천", "recommended")})` : ""}
        </button>
      ))}
      <input type="text" value={value} placeholder={text("직접 적기", "Write your own")} disabled={busy} onChange={(event) => onChange(event.target.value)} />
      <button className="button compact" type="button" disabled={busy || !value.trim()} onClick={() => onAnswer(value)}>{text("적기", "Answer")}</button>
    </div>
  );
}

/** 보고 한 건의 본문. `children` 자리에 미결 결정 폼이 선다. */
export function RoundReportBlock({ report, children }: PropsWithChildren<{ report: RoundReport }>) {
  const { text } = useI18n();
  return (
    <div className="round-report-body">
      {report.summary && <p>{report.summary}</p>}
      {report.measures.length > 0 && (
        <table className="round-report-table">
          <thead><tr><th>{text("측정", "Measure")}</th><th>{text("전", "Before")}</th><th>{text("후", "After")}</th></tr></thead>
          <tbody>{report.measures.map((measure, index) => <tr key={`${measure.label}:${index}`}><td>{measure.label}</td><td>{measure.before}</td><td>{measure.after}</td></tr>)}</tbody>
        </table>
      )}
      {report.failureKinds.length > 0 && (
        <small className="db-connection-meta">
          {text("실패 종류", "Failure kinds")}: {report.failureKinds.map((kind) => `${kind.kind} ${kind.before}→${kind.after}`).join(" · ")}
        </small>
      )}
      {report.fixes.length > 0 && <small className="db-connection-meta">{text("고친 것", "Fixes")}: {report.fixes.join(" · ")}</small>}
      {report.commits.length > 0 && <small className="db-connection-meta">{text("커밋", "Commits")}: {report.commits.join(", ")}</small>}
      {report.reverted.length > 0 && <small className="db-connection-meta">{text("되돌린 것", "Reverted")}: {report.reverted.join(" · ")}</small>}
      {report.next.length > 0 && <small className="db-connection-meta">{text("다음", "Next")}: {report.next.join(" · ")}</small>}
      {report.decisions.map((decision, index) => decision.resolved
        ? <small className="db-connection-meta" key={index}>{text("결정", "Decision")}: {decision.question} → {decision.resolved}</small>
        : null)}
      {children}
    </div>
  );
}

export function RoundReportsModal({ goal, onClose, onResolved }: {
  goal: RoundGoal;
  onClose: () => void;
  /** 결정을 답한 뒤 패널이 배지를 다시 세도록 알린다. */
  onResolved: () => void;
}) {
  const { text } = useI18n();
  const [reports, setReports] = useState<RoundReport[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    return listRoundReports({ goalId: goal.id, limit: 200 })
      .then((next) => setReports([...next].sort((a, b) => b.recordedAt - a.recordedAt)))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  }, [goal.id]);

  useEffect(() => { void load(); }, [load]);

  const answer = useCallback((report: RoundReport, index: number, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    resolveRoundDecision(report.id, index, trimmed)
      .then(() => load())
      .then(() => {
        setAnswers((current) => { const next = { ...current }; delete next[`${report.id}:${index}`]; return next; });
        onResolved();
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  }, [load, onResolved]);

  const pendingTotal = useMemo(() => (reports ?? []).reduce((sum, report) => sum + pendingDecisionCount(report), 0), [reports]);
  // 저장 중에는 배경 클릭·Esc 로 닫히지 않게 한다(Modal 계약).
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);

  return (
    <Modal
      size="wide"
      onClose={close}
      title={(
        <>
          <FileText size={15} />
          <span>{goal.title}</span>
          <span className="db-badge">{text(`회차 보고 ${reports?.length ?? 0}건`, `${reports?.length ?? 0} report(s)`)}</span>
          {pendingTotal > 0 && <span className="db-badge round-goal-pending">{text(`결정 대기 ${pendingTotal}`, `${pendingTotal} pending`)}</span>}
        </>
      )}
      footer={<button className="button" type="button" disabled={busy} onClick={close}>{text("닫기", "Close")}</button>}
    >
      <div className="round-report-modal-body" data-goal-id={goal.id}>
        {error && <ErrorBanner message={error} />}
        {reports !== null && reports.length === 0 && <p className="round-report-empty">{text("아직 보고가 없습니다.", "No reports yet.")}</p>}
        {(reports ?? []).map((report, position) => {
          const pending = pendingDecisionCount(report);
          const head = (
            <>
              <strong>{report.title}</strong>
              <span className={report.outcome === "pass" ? "health ready" : "health warning"}>{outcomeLabel(text, report.outcome)}</span>
              <span className="db-badge">{formatDateTime(report.recordedAt)}</span>
              {pending > 0 && <span className="db-badge round-goal-pending">{text(`결정 대기 ${pending}`, `${pending} pending`)}</span>}
            </>
          );
          const body = (
            <RoundReportBlock report={report}>
              {report.decisions.map((decision, index) => {
                if (decision.resolved) return null;
                const key = `${report.id}:${index}`;
                return (
                  <div className="round-decision" key={key} data-decision-index={index}>
                    <p>{decision.question}</p>
                    <RoundDecisionForm
                      decision={decision}
                      busy={busy}
                      value={answers[key] ?? ""}
                      onChange={(value) => setAnswers((current) => ({ ...current, [key]: value }))}
                      onAnswer={(value) => answer(report, index, value)}
                    />
                  </div>
                );
              })}
            </RoundReportBlock>
          );
          // 최신 보고와 미결 결정이 있는 보고는 펼쳐 두고, 나머지는 접는다. `open`은 첫 렌더에만
          // 먹고(key 가 보고 id) 그 뒤 여닫기는 사용자 몫이다.
          return (
            <details className="round-report-details" key={report.id} data-round-id={report.id} open={position === 0 || pending > 0}>
              <summary className="db-connection-head">{head}</summary>
              {body}
            </details>
          );
        })}
      </div>
    </Modal>
  );
}
