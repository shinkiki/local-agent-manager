/**
 * 목표 카드와 회차 결과(M10).
 *
 * 사용자는 목표만 적는다. "설계 시작"을 누르면 AIA 가 회차 설계 스킬(round-designer)을 따라
 * 스킬·스크립트·시험·워크플로 계약·반복 요청을 만들고, 등록은 승인 카드로 끝난다. 그 뒤 회차가
 * 남긴 구조화된 보고와 사람이 정할 것은 목표 카드의 "회차 상세" 모달(RoundReportsModal)에서
 * 읽고 답한다. 카드에는 "결정 대기 N" 배지만 올라와 어느 목표를 열어야 하는지 알린다.
 *
 * 스크립트를 여기서 돌리지 않는다. 회차는 워크플로가 띄운 에이전트 채팅이 돈다.
 */
import { FileText, LoaderCircle, Play, Plus, Target, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../lib/i18n";
import {
  createRoundGoal,
  deleteRoundGoal,
  getRoundGoals,
  listRoundReports,
  updateRoundGoal,
} from "../lib/ipc";
import { roundDesignPrompt } from "../lib/roundDesign";
import type { RoundGoal, RoundGoalInput, RoundGoalStatus, RoundReport } from "../types";
import { pendingDecisionCount, RoundReportsModal } from "./RoundReportsModal";
import { ErrorBanner, useConfirm } from "./Shared";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyDraft(): RoundGoalInput {
  return { title: "", goal: "", targetPath: "", verification: "", cadence: "" };
}

type Text = (ko: string, en: string) => string;

function statusLabel(text: Text, status: RoundGoalStatus): string {
  switch (status) {
    case "draft": return text("초안", "Draft");
    case "designing": return text("설계 중", "Designing");
    case "active": return text("회차 진행", "Active");
    case "paused": return text("일시정지", "Paused");
    case "done": return text("끝남", "Done");
  }
}

export function RoundGoalsPanel({ onRequestAiaPrompt, refreshNonce = 0 }: { onRequestAiaPrompt?: (prompt: string) => void; refreshNonce?: number }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [goals, setGoals] = useState<RoundGoal[] | null>(null);
  const [reports, setReports] = useState<RoundReport[]>([]);
  const [draft, setDraft] = useState<RoundGoalInput | null>(null);
  const [detailGoal, setDetailGoal] = useState<RoundGoal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 목표 상태를 바꿀 때 반복 요청도 함께 멈추거나 되살린다. 말하지 않으면 사용자는 목표만
  // 바뀐 줄 알고, 멈춘 줄 알면서 사용량이 계속 나가던 예전과 같은 자리에 선다.
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    return Promise.all([getRoundGoals(), listRoundReports({ limit: 60 })])
      .then(([nextGoals, nextReports]) => { setGoals(nextGoals); setReports(nextReports); })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  }, []);

  // 목표 상태는 이 화면 밖(회차·AIA·다른 기기)에서도 바뀐다. 마운트 때 한 번만 읽던 동안은
  // 앱을 껐다 켜야 반영됐는데, 끄면 페이싱과 세션이 함께 끊긴다. 로고 새로고침이 올려 주는
  // 나수를 같이 보고 다시 읽는다.
  useEffect(() => { void load(); }, [load, refreshNonce]);

  const save = useCallback(() => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    createRoundGoal(draft)
      .then(() => { setDraft(null); return load(); })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  }, [draft, load]);

  const setStatus = useCallback((goal: RoundGoal, status: RoundGoalStatus) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    updateRoundGoal(goal.id, { status })
      .then((updated) => {
        const changed = updated.scheduleChanged;
        if (changed) {
          setNotice(changed.enabled
            ? text("반복 요청도 함께 다시 켰습니다.", "The recurring request was resumed too.")
            : text("반복 요청도 함께 멈췄습니다.", "The recurring request was paused too."));
        }
        return load();
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  }, [load]);

  const remove = useCallback((goal: RoundGoal) => {
    void confirm({
      title: text(`'${goal.title}' 목표를 지울까요?`, `Delete the goal '${goal.title}'?`),
      message: text(
        "목표만 지웁니다. 설계가 만든 스킬·워크플로·반복 요청과 회차 보고는 남습니다.",
        "Only the goal is removed. Skills, workflows, recurring requests, and round reports stay.",
      ),
      confirmLabel: text("지우기", "Delete"),
      tone: "danger",
    }).then((accepted) => {
      if (!accepted) return;
      setBusy(true);
      deleteRoundGoal(goal.id).then(() => load()).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
    });
  }, [confirm, load, text]);

  // 설계는 AIA 가 한다. 요청문 하나로 AIA 대화를 띄우고 목표 상태를 "설계 중"으로 옮긴다 —
  // 등록은 그 대화 안의 승인 카드로 사람이 확인한다.
  const design = useCallback((goal: RoundGoal) => {
    if (!onRequestAiaPrompt) return;
    onRequestAiaPrompt(roundDesignPrompt(goal));
    if (goal.status === "draft") setStatus(goal, "designing");
  }, [onRequestAiaPrompt, setStatus]);

  // 카드 배지용. 보고 목록은 모달이 목표별로 따로 조회하므로 여기서는 미결 개수만 센다.
  const pendingByGoal = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const report of reports) {
      if (!report.goalId) continue;
      counts[report.goalId] = (counts[report.goalId] ?? 0) + pendingDecisionCount(report);
    }
    return counts;
  }, [reports]);

  return (
    // 자동화 탭의 형제(AIA 선제 제안)와 같은 카드 틀을 쓴다. settings-subsection은 카드
    // *안에* 서는 조각이라 단독으로 두면 테두리도 표제 띠도 없이 배경 위에 떠 버린다.
    // 본문은 subsection으로 한 겹 감싸, 안쪽 여백 규칙(.settings-subsection > .detail-card)을
    // 그대로 물려받게 한다.
    <section className="settings-card" data-ui-anchor="addons.round-goals">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><Target size={18} /></i>
          <div>
            <span>{text("자동화", "Automation")}</span>
            <h2>{text("회차 목표", "Round goals")}</h2>
          </div>
          {busy && <LoaderCircle className="spin" size={14} />}
        </div>
        <p>{text(
          "목표만 적으면 AIA 가 회차 설계 스킬을 따라 스킬·스크립트·시험·워크플로·반복 요청을 만들고, 등록은 승인 카드로 끝납니다. 회차가 남긴 보고와 사람이 정할 것은 각 목표의 회차 상세에서 읽고 결정합니다.",
          "Write the goal; AIA follows the round-designer skill to create the skill, scripts, tests, workflow, and recurring request, and registration ends with approval cards. Read each goal's round reports and answer its decisions in its round detail.",
        )}</p>
      </header>
      <div className="settings-subsection">
        {error && <ErrorBanner message={error} />}
        {notice && <p className="account-action-notice" role="status">{notice}</p>}
        {goals !== null && goals.length === 0 && (
          <div className="plugin-empty-state">
            <i><Target size={25} /></i>
            <div>
              <strong>{text("적어 둔 목표가 없습니다", "No goals yet")}</strong>
              <small>{text(
                "무엇을 이루려는지와 대상 경로를 적으면 AIA 가 설계를 시작합니다.",
                "Write what to achieve and the target path, and AIA starts the design.",
              )}</small>
            </div>
          </div>
        )}
        {(goals ?? []).length > 0 && <div className="plugin-list db-connection-list">
          {(goals ?? []).map((goal) => {
            return (
              <article className="db-connection-row" key={goal.id} data-goal-id={goal.id}>
                <div className="db-connection-head">
                  <strong>{goal.title}</strong>
                  <span className={goal.status === "active" ? "health ready" : "health warning"}>{statusLabel(text, goal.status)}</span>
                  {goal.skillKey && <span className="db-badge">{text("스킬", "Skill")} {goal.skillKey}</span>}
                  {goal.scheduleId && <span className="db-badge">{text("반복 요청", "Recurring")}</span>}
                  {(pendingByGoal[goal.id] ?? 0) > 0 && <span className="db-badge round-goal-pending">{text(`결정 대기 ${pendingByGoal[goal.id]}`, `${pendingByGoal[goal.id]} pending`)}</span>}
                </div>
                <p>{goal.goal}</p>
                <small className="db-connection-meta">
                  {goal.targetPath}
                  {goal.cadence ? ` · ${text("주기", "Cadence")} ${goal.cadence}` : ""}
                  {goal.verification ? ` · ${text("검증", "Verification")} ${goal.verification}` : ""}
                </small>
                {goal.notes && <small className="db-connection-meta">{goal.notes}</small>}
                <div className="db-connection-actions">
                  {onRequestAiaPrompt && (goal.status === "draft" || goal.status === "designing") && (
                    <button className="button compact primary" type="button" disabled={busy} onClick={() => design(goal)}>
                      <Play size={13} />{goal.status === "draft" ? text("설계 시작", "Start design") : text("설계 이어서", "Continue design")}
                    </button>
                  )}
                  {goal.status === "active" && <button className="button compact" type="button" disabled={busy} onClick={() => setStatus(goal, "paused")}>{text("일시정지", "Pause")}</button>}
                  {/* `done` 에서도 되돌릴 수 있어야 한다. 끝냄은 되돌릴 수 없는 전이가 아니다 —
                      2차 범위가 붙으면 같은 목표를 다시 연다. 이 조건에 done 이 빠져 있던 동안
                      완료된 목표는 화면에서 버튼이 하나도 뜨지 않아 빠져나올 길이 없었다. */}
                  {(goal.status === "paused" || goal.status === "done") && <button className="button compact" type="button" disabled={busy} onClick={() => setStatus(goal, "active")}>{text("다시 진행", "Resume")}</button>}
                  {goal.status !== "done" && <button className="button compact" type="button" disabled={busy} onClick={() => setStatus(goal, "done")}>{text("끝냄", "Mark done")}</button>}
                  <button className="button compact" type="button" disabled={busy} onClick={() => setDetailGoal(goal)}>
                    <FileText size={13} />{text("회차 상세", "Round detail")}{(pendingByGoal[goal.id] ?? 0) > 0 ? ` (${pendingByGoal[goal.id]})` : ""}
                  </button>
                  <button className="button compact danger" type="button" disabled={busy} onClick={() => remove(goal)}><Trash2 size={13} />{text("지우기", "Delete")}</button>
                </div>
              </article>
            );
          })}
        </div>}
        {/* 추가 단추는 목록 안이 아니라 DB 연결 카드와 같은 "새 ○○" 줄에 세운다. 목록 상자
            안에서는 폭을 다 차지한 띠처럼 보여 항목과 구분되지 않았다. */}
        {!draft && (
          <div className="settings-update-body">
            <span className="settings-update-status">
              <strong>{text("새 목표", "New goal")}</strong>
              <small>{text("설계는 AIA 가 맡습니다. 검증 방식과 주기는 비워 두면 설계가 정합니다.", "AIA takes the design. Leave verification and cadence empty to let the design decide.")}</small>
            </span>
            <button className="button compact primary" type="button" disabled={busy} onClick={() => setDraft(emptyDraft())}><Plus size={13} />{text("목표 추가", "Add goal")}</button>
          </div>
        )}
        {draft && (
          <div className="detail-card" data-ui-anchor="addons.round-goals.editor">
            <div className="form-row">
              <label htmlFor="round-goal-title">{text("이름", "Name")}</label>
              <div><input id="round-goal-title" type="text" value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></div>
            </div>
            <div className="form-row">
              <label htmlFor="round-goal-goal">{text("목표", "Goal")}</label>
              <div>
                <textarea id="round-goal-goal" rows={3} value={draft.goal} disabled={busy} placeholder={text("무엇을 이루려는지 한 문단. 예: 로컬 모델의 계획 프로토콜을 파인튜닝으로 굳힌다.", "One paragraph on what to achieve.")} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="round-goal-path">{text("대상 경로", "Target path")}</label>
              <div><input id="round-goal-path" type="text" value={draft.targetPath} disabled={busy} placeholder="F:\\Project\\..." onChange={(event) => setDraft({ ...draft, targetPath: event.target.value })} /></div>
            </div>
            <div className="form-row">
              <label htmlFor="round-goal-verification">{text("검증 방식", "Verification")}</label>
              <div>
                <input id="round-goal-verification" type="text" value={draft.verification} disabled={busy} placeholder={text("비우면 설계가 정합니다. 예: 학습에 없는 과제로 레인당 n≥20, 실패 종류로 판정", "Leave empty to let the design decide.")} onChange={(event) => setDraft({ ...draft, verification: event.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="round-goal-cadence">{text("주기", "Cadence")}</label>
              <div><input id="round-goal-cadence" type="text" value={draft.cadence} disabled={busy} placeholder={text("cron 또는 auto. 비우면 설계가 정합니다", "cron or auto; empty lets the design decide")} onChange={(event) => setDraft({ ...draft, cadence: event.target.value })} /></div>
            </div>
            <div className="form-row">
              <label />
              <div className="path-field-group">
                <button className="button compact primary" type="button" disabled={busy || !draft.title.trim() || !draft.goal.trim() || !draft.targetPath.trim()} onClick={save}>{text("저장", "Save")}</button>
                <button className="button compact" type="button" disabled={busy} onClick={() => setDraft(null)}>{text("닫기", "Close")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {detailGoal && <RoundReportsModal goal={detailGoal} onClose={() => setDetailGoal(null)} onResolved={() => { void load(); }} />}
      {confirmDialog}
    </section>
  );
}
