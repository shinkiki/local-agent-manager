/**
 * 채팅 화면의 반복 요청 탭. 목록 카드와 실행 내역이 여기 산다. 편집기는
 * ChatScheduleEditor, 두 쪽이 함께 쓰는 계정 조회는 ChatScheduleAccounts에 있다.
 *
 * 대화 화면(ChatView)과 같은 파일에 있었지만 공유하는 것은 탭 자리 하나뿐이라, 대화
 * 상태를 읽지도 쓰지도 않는 이 갈래를 따로 두어 대화 쪽을 읽을 때 함께 딸려오지
 * 않게 한다. 화면 밖으로 내보내는 것은 SchedulesPanel 하나다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../lib/i18n";
import {
  cancelScheduledRun,
  deleteScheduledRequest,
  getScheduledRequestDetail,
  getScheduledRunDetail,
  getSystemWorkflows,
  runScheduledRequestNow,
  setScheduleEnabled,
  setSchedulesPaused,
} from "../lib/ipc";
import { formatDate, formatRelative } from "../lib/format";
import type {
  AccountSnapshot,
  ChatSessionInfo,
  ModelOption,
  ProjectOption,
  ProviderAccountView,
  ProviderId,
  ProviderStatus,
  ResumeFailurePolicy,
  ScheduleRun,
  ScheduleRunSessionRead,
  ScheduleRunStatus,
  ScheduledRequest,
  SchedulerSnapshot,
  SessionSummary,
  SystemWorkflowSummary,
} from "../types";
import { EmptyState, ErrorBanner, SourceBadge, useConfirm } from "./Shared";
import { approvalModeLabel, effectiveApprovalMode, permissionModeLabel, reasoningLabel } from "../lib/chatSettings";
import { describeSessionReadPolicy } from "../lib/sessionReadPolicy";
import { accountById } from "./ChatScheduleAccounts";
import { ScheduleEditor } from "./ChatScheduleEditor";
import { isWaitingRunStatus, withSchedule, withScheduleEnabled } from "../lib/schedulerSnapshot";
import { describeScheduleWorkflow } from "../lib/scheduleWorkflow";
import { activeWindowEnded, describeActiveWindow } from "../lib/scheduleWindow";
import { errorText } from "../lib/errorText";

/**
 * 반복 요청 목록이 거는 쓰기 동작 한 벌 — 오류 배너, 실행 취소 표시, 그리고 목록에서
 * 시작할 수 있는 다섯 갈래(지금 실행·활성 여부·전체 일시정지·실행 취소·삭제).
 *
 * 패널 본문에 state 셋과 동작 여섯이 렌더 앞에 그대로 늘어서 있어, 목록이 무엇을 거르고
 * 카드에 무엇을 넘기는지 읽으려면 쓰기 경로 전부를 지나가야 했다. 쓰기 경로는 오류 한
 * 자리와 즉시 갱신을 저희끼리만 공유하므로 여기 한 벌로 모으고, 패널에는 편집기 상태와
 * 목록 계산만 남긴다. 되묻기 모달도 두 동작만 쓰므로 함께 옮긴다.
 *
 * 되돌리기가 필요한 두 갈래(활성 여부·전체 일시정지)는 같은 봉투를 쓴다 — 화면을 먼저
 * 바꾸고, 응답이 오면 서버가 계산한 값으로 맞추고, 거절되면 돌려놓는다. 두 벌로 적어
 * 두면 한쪽만 되돌리기를 고치는 어긋남이 생기므로 `optimistic` 하나로 둔다.
 */
function useScheduleListActions({ onRefresh, onSnapshot }: {
  onRefresh: () => Promise<void>;
  onSnapshot: (update: (current: SchedulerSnapshot) => SchedulerSnapshot) => void;
}) {
  const { text } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [runActionId, setRunActionId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<Record<string, string>>({});
  // 실행 취소·반복 요청 삭제 되묻기는 브라우저 confirm 대신 앱 공용 확인 모달로 띄운다.
  const { confirm, confirmDialog } = useConfirm();
  // 스냅샷 자체는 App의 폴링이 공급한다. 여기서는 변경 직후 즉시 갱신만 요청한다.
  const refresh = useCallback(async () => {
    try {
      await onRefresh();
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [onRefresh]);
  const act = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); await refresh(); } catch (cause) { setError(errorText(cause)); }
  }, [refresh]);
  // 누른 쪽이 결과를 이미 아는 동작. 쓰기 왕복에 목록 전체 재조회를 더해 기다리면(act)
  // 스위치가 두 왕복 뒤에야 움직인다.
  const optimistic = useCallback((
    apply: (current: SchedulerSnapshot) => SchedulerSnapshot,
    request: () => Promise<(current: SchedulerSnapshot) => SchedulerSnapshot>,
    revert: (current: SchedulerSnapshot) => SchedulerSnapshot,
  ) => {
    setError(null);
    onSnapshot(apply);
    void request()
      .then((settle) => onSnapshot(settle))
      .catch((cause: unknown) => {
        onSnapshot(revert);
        setError(errorText(cause));
      });
  }, [onSnapshot]);
  const runNow = useCallback((scheduleId: string) => act(() => runScheduledRequestNow(scheduleId)), [act]);
  const toggleScheduleEnabled = useCallback((schedule: ScheduledRequest) => {
    const enabled = !schedule.enabled;
    optimistic(
      (current) => withScheduleEnabled(current, schedule.id, enabled),
      async () => {
        const next = await setScheduleEnabled(schedule.id, enabled);
        return (current) => withSchedule(current, next);
      },
      // 되돌리는 것은 이 항목의 활성 여부뿐이다. 그사이 다른 항목을 바꿨다면 그대로 둔다.
      (current) => withScheduleEnabled(current, schedule.id, schedule.enabled),
    );
  }, [optimistic]);
  const toggleSchedulesPaused = useCallback((paused: boolean) => {
    optimistic(
      (current) => ({ ...current, paused }),
      async () => {
        const next = await setSchedulesPaused(paused);
        return () => next;
      },
      (current) => ({ ...current, paused: !paused }),
    );
  }, [optimistic]);
  const cancelRun = useCallback(async (run: ScheduleRun, _source: ProviderId) => {
    const accepted = await confirm({
      title: text("반복 실행 취소", "Cancel recurring run"),
      message: text("이 반복 실행을 취소할까요?\n실행 중 런타임이 있으면 안전하게 종료합니다.", "Cancel this recurring run?\nActive runtimes will be stopped safely."),
      confirmLabel: text("실행 취소", "Cancel run"),
      tone: "danger",
    });
    if (!accepted) return;
    setRunActionId(run.id);
    setError(null);
    try {
      const receipt = await cancelScheduledRun(run.id, text("스케줄러 UI에서 운영자가 실행 취소를 요청했습니다", "Operator requested cancellation from scheduler UI"));
      setRunResults((current) => ({
        ...current,
        [run.id]: receipt.alreadyTerminal
          ? text("이미 terminal 상태입니다", "Already in terminal state")
          : receipt.stopError
            ? text(`취소 영속화 완료 · 런타임 종료 확인 실패: ${receipt.stopError}`, `Cancellation persisted · failed to confirm runtime exit: ${receipt.stopError}`)
            : text("취소 완료", "Cancelled"),
      }));
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunActionId(null);
    }
  }, [confirm, refresh, text]);
  const deleteSchedule = useCallback(async (schedule: ScheduledRequest) => {
    const accepted = await confirm({
      title: text("반복 요청 삭제", "Delete recurring schedule"),
      message: text("이 반복 요청을 삭제할까요?\n공급자 대화는 유지됩니다.", "Delete this recurring schedule?\nProvider conversations will be preserved."),
      items: [schedule.name],
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!accepted) return;
    await act(() => deleteScheduledRequest(schedule.id));
  }, [act, confirm, text]);
  return { error, setError, runActionId, runResults, confirmDialog, refresh, runNow, toggleScheduleEnabled, toggleSchedulesPaused, cancelRun, deleteSchedule };
}

export function SchedulesPanel({ providers, accounts, projects, models, sessions, snapshot, onRefresh, onSnapshot, currentSession, currentPrompt, onOpenSession }: { providers: ProviderStatus[]; accounts: AccountSnapshot | null; projects: ProjectOption[]; models: ModelOption[]; sessions: SessionSummary[]; snapshot: SchedulerSnapshot | null; onRefresh: () => Promise<void>; onSnapshot: (update: (current: SchedulerSnapshot) => SchedulerSnapshot) => void; currentSession: ChatSessionInfo | null; currentPrompt: string; onOpenSession: (session: SessionSummary) => void }) {
  const { text } = useI18n();
  const [editing, setEditing] = useState<ScheduledRequest | "new" | null>(null);
  const { error, setError, runActionId, runResults, confirmDialog, refresh, runNow, toggleScheduleEnabled, toggleSchedulesPaused, cancelRun, deleteSchedule } = useScheduleListActions({ onRefresh, onSnapshot });
  // 편집기의 선택지와 카드 표기(재승인 필요 여부)가 같은 목록을 본다. 목록을 못 읽어도
  // 채팅 반복 요청은 그대로 만들 수 있으므로 선택지만 비워 둔다.
  const [workflows, setWorkflows] = useState<SystemWorkflowSummary[]>([]);
  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflows((await getSystemWorkflows()).workflows);
    } catch {
      setWorkflows([]);
    }
  }, []);
  useEffect(() => { void loadWorkflows(); }, [loadWorkflows]);
  const editorRef = useRef<HTMLDivElement>(null);
  // 스냅샷의 프롬프트는 미리보기다. 편집기에는 전문이 필요하므로 열 때 상세를 받는다.
  const openEditor = useCallback(async (schedule: ScheduledRequest) => {
    setError(null);
    try {
      void loadWorkflows();
      setEditing(await getScheduledRequestDetail(schedule.id));
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [loadWorkflows]);
  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      editorRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);
  // 페이싱이 켜진 워크플로를 도는 반복 요청은 워크플로 페이싱 탭이 트리거까지 관리한다.
  // 여기에도 보여 주면 관리 주체가 둘로 갈라지므로 목록에서 뺀다. 워크플로 목록을 못
  // 읽었으면 아무것도 숨기지 않아 관리 경로가 사라지는 일이 없다.
  const pacingWorkflowIds = new Set(workflows.filter((item) => item.pacingEnabled).map((item) => item.id));
  const visibleSchedules = snapshot?.schedules.filter((schedule) => !(schedule.workflow && pacingWorkflowIds.has(schedule.workflow.workflowId))) ?? [];
  const pacedHiddenCount = (snapshot?.schedules.length ?? 0) - visibleSchedules.length;
  return (
    <section className="schedules-panel">
      <header><div><h2>{text("반복 요청", "Recurring Schedules")}</h2><p>{text("로그인 후 백그라운드에서 에이전트 요청을 실행합니다.", "Runs agent requests in the background after login.")}</p></div><div>{snapshot && <button className={snapshot.paused ? "button primary" : "button"} type="button" onClick={() => toggleSchedulesPaused(!snapshot.paused)}>{snapshot.paused ? text("전체 재개", "Resume All") : text("전체 일시정지", "Pause All")}</button>}<button className="button primary" type="button" onClick={() => { void loadWorkflows(); setEditing("new"); }}>{text("새 반복 요청", "New Schedule")}</button></div></header>
      {error && <ErrorBanner message={error} />}
      {snapshot && !snapshot.runnerActive && <div className="warning-banner">{text("다른 Agent Manager 프로세스가 반복 실행을 담당하고 있습니다.", "Another Agent Manager process is handling schedule runs.")}</div>}
      {snapshot?.paused && <div className="warning-banner">{text("전체 일시정지 중입니다. 예약 실행만 멈추고 지금 실행은 그대로 나갑니다.", "All schedules are paused. Scheduled triggers are paused, but Run Now requests will still execute.")}</div>}
      {editing && <div className="schedule-editor-anchor" ref={editorRef}><ScheduleEditor key={editing === "new" ? "new" : editing.id} providers={providers} accounts={accounts} projects={projects} models={models} workflows={workflows} currentSession={currentSession} initialPrompt={currentPrompt} schedule={editing === "new" ? undefined : editing} onSaved={() => { setEditing(null); void refresh(); }} onCancel={() => setEditing(null)} /></div>}
      {pacedHiddenCount > 0 && <p className="schedules-paced-note">{text(`페이싱 회차 ${pacedHiddenCount}건은 워크플로 화면의 워크플로 페이싱 탭에서 관리합니다.`, `${pacedHiddenCount} paced runs are managed in the Workflow Pacing tab on the Workflows page.`)}</p>}
      {!snapshot ? <div className="state-panel"><span className="spinner" /><p>{text("반복 요청을 읽고 있습니다.", "Loading recurring schedules…")}</p></div> : visibleSchedules.length === 0 ? (pacedHiddenCount > 0 ? null : <EmptyState title={text("등록된 반복 요청이 없습니다", "No recurring schedules registered")} detail={text("이 탭에서 새 반복 작업을 만드세요.", "Create a new recurring task in this tab.")} />) : (
        <div className="schedule-list">{visibleSchedules.map((schedule) => (
          <ScheduleCard
            key={schedule.id}
            schedule={schedule}
            runs={snapshot.runs.filter((run) => run.scheduleId === schedule.id)}
            accounts={accounts}
            sessions={sessions}
            workflows={workflows}
            runActionId={runActionId}
            runResults={runResults}
            onRunNow={() => void runNow(schedule.id)}
            onToggleEnabled={() => toggleScheduleEnabled(schedule)}
            onEdit={() => void openEditor(schedule)}
            onDelete={() => void deleteSchedule(schedule)}
            onCancelRun={cancelRun}
            onOpenSession={onOpenSession}
          />
        ))}</div>
      )}
      {confirmDialog}
    </section>
  );
}
/**
 * 반복 요청 카드 한 장. 카드가 쓰는 파생값(최근 실행·활성 실행·계정 표기·활성 기간
 * 판정)과 머리·요약·버튼 세 줄의 마크업이 목록 렌더의 map 콜백 안에 통째로 들어 있어,
 * 목록이 무엇을 거르고 무엇을 넘기는지 읽으려면 카드 마크업까지 함께 지나가야 했다.
 * 파생값 계산을 카드가 직접 하게 옮기고, 목록에는 넘기는 것만 남긴다. 버튼이 하는 일은
 * 목록 쪽 상태(act·스냅샷 되돌리기)를 건드리므로 콜백으로 그대로 받는다.
 */
function ScheduleCard({ schedule, runs, accounts, sessions, workflows, runActionId, runResults, onRunNow, onToggleEnabled, onEdit, onDelete, onCancelRun, onOpenSession }: { schedule: ScheduledRequest; runs: ScheduleRun[]; accounts: AccountSnapshot | null; sessions: SessionSummary[]; workflows: SystemWorkflowSummary[]; runActionId: string | null; runResults: Record<string, string>; onRunNow: () => void; onToggleEnabled: () => void; onEdit: () => void; onDelete: () => void; onCancelRun: (run: ScheduleRun, source: ProviderId) => Promise<void>; onOpenSession: (session: SessionSummary) => void }) {
  const { text } = useI18n();
  const last = runs[0];
  const activeRun = runs.find((run) => run.status === "running" || isWaitingRunStatus(run.status));
  const scheduleAccount = accountById(accounts, schedule.accountId);
  const lastRunAccount = accountById(accounts, last?.actualAccountId);
  // 워크플로 반복 요청은 공급자·계정·권한 항목이 실행에 쓰이지 않는다. 카드도
  // 실제로 도는 대상만 보여 준다.
  const workflowBinding = schedule.workflow ?? null;
  const workflowInputCount = Object.keys(workflowBinding?.arguments ?? {}).length;
  const queued = Boolean(schedule.manualRunRequestedAt) && !activeRun;
  // 활성 종료가 지난 회차는 켜져 있어도 예약 실행이 더 나가지 않는다. 백엔드가
  // enabled를 끄지 않으므로(종료를 미루면 다시 돈다) 카드가 그 상태를 구분한다.
  const windowEnded = activeWindowEnded(schedule);
  const windowSummary = describeActiveWindow(schedule);
  const { status, label: statusLabel } = scheduleCardStatus({ enabled: schedule.enabled, windowEnded, activeRun, queued, last }, text);
  return <article className={`schedule-card ${schedule.enabled && !windowEnded ? "" : "disabled"}`}>
    <header>{workflowBinding ? <span className="source-badge source-workflow">{text("워크플로", "Workflow")}</span> : <SourceBadge source={schedule.source} />}<div><strong>{schedule.name}</strong><small>{workflowBinding ? describeScheduleWorkflow(workflowBinding, workflows) : schedule.prompt}</small></div><span className={`schedule-status ${status}`}>{statusLabel}</span></header>
    <div className="schedule-meta">
      {workflowBinding
        ? <span>{workflowInputCount > 0 ? text(`입력 ${workflowInputCount}개`, `${workflowInputCount} inputs`) : text("입력 없음", "No inputs")}</span>
        : <ScheduleChatMetaChips schedule={schedule} scheduleAccount={scheduleAccount} lastRunAccount={lastRunAccount} />}
      <span>{windowEnded ? text("다음 없음 · 기간 종료", "No upcoming runs · Window ended") : text(`다음 ${schedule.enabled ? formatRelative(schedule.nextRunAt) : "–"}`, `Next: ${schedule.enabled ? formatRelative(schedule.nextRunAt) : "–"}`)}</span>
      {windowSummary && <span className="schedule-active-window">{text(`활성 ${windowSummary}`, `Active: ${windowSummary}`)}</span>}
      {schedule.sessionReference?.policy.enabled && <span className="schedule-session-reference">{text(`세션 참조 ${describeSessionReadPolicy(schedule.sessionReference.policy)}`, `Session Reference: ${describeSessionReadPolicy(schedule.sessionReference.policy)}`)}</span>}
    </div>
    <footer>
      <button className="button" type="button" disabled={Boolean(activeRun) || queued} onClick={onRunNow}>{activeRun ? runStatusLabel(activeRun.status, text) : queued ? text("실행 요청됨", "Run Requested") : text("지금 실행", "Run Now")}</button>
      <button className="button" type="button" onClick={onToggleEnabled}>{schedule.enabled ? text("일시정지", "Pause") : text("활성화", "Enable")}</button>
      <button className="button" type="button" onClick={onEdit}>{text("수정", "Edit")}</button>
      <button className="button danger-subtle" type="button" onClick={onDelete}>{text("삭제", "Delete")}</button>
    </footer>
    {runs.length > 0 && <ScheduleRunHistory runs={runs} source={schedule.source} sessions={sessions} actionRunId={runActionId} results={runResults} onCancel={onCancelRun} onOpenSession={onOpenSession} />}
  </article>;
}

/**
 * 채팅 반복 요청 카드가 보여 주는 실행 조건 칩들. 워크플로 반복 요청에는 쓰이지 않는
 * 항목이라 갈래 하나를 통째로 이 자리로 옮겨, 카드 본문에는 "워크플로면 입력 개수,
 * 아니면 실행 조건"이라는 갈림만 남는다.
 */
function ScheduleChatMetaChips({ schedule, scheduleAccount, lastRunAccount }: {
  schedule: ScheduledRequest;
  scheduleAccount: ProviderAccountView | undefined;
  lastRunAccount: ProviderAccountView | undefined;
}) {
  const { text } = useI18n();
  return <>
    <span>
      {schedule.useActiveAccount
        ? (lastRunAccount
            ? text(`계정 실행 시점 기본 · 최근 ${lastRunAccount.displayName}`, `Account: Default at run time · Recent: ${lastRunAccount.displayName}`)
            : text("계정 실행 시점 기본", "Account: Default at run time"))
        : text(`계정 ${scheduleAccount?.displayName ?? schedule.accountId}`, `Account: ${scheduleAccount?.displayName ?? schedule.accountId}`)}
    </span>
    <span>{permissionModeLabel(schedule.mode)}</span>
    <span>{approvalModeLabel(effectiveApprovalMode(schedule.source, schedule.approvalMode ?? "never"))}</span>
    {schedule.reasoningEffort && <span>{text(`추론 ${reasoningLabel(schedule.reasoningEffort)}`, `Reasoning: ${reasoningLabel(schedule.reasoningEffort)}`)}</span>}
    <span>{schedule.sessionStrategy === "continue" ? text(`동일 대화 · ${resumePolicyLabel(schedule.resumeFailurePolicy, text)}`, `Same conversation · ${resumePolicyLabel(schedule.resumeFailurePolicy, text)}`) : text("매번 새 채팅", "New chat every time")}</span>
  </>;
}

function ScheduleRunHistory({ runs, source, sessions, actionRunId, results, onCancel, onOpenSession }: { runs: ScheduleRun[]; source: ProviderId; sessions: SessionSummary[]; actionRunId: string | null; results: Record<string, string>; onCancel: (run: ScheduleRun, source: ProviderId) => Promise<void>; onOpenSession: (session: SessionSummary) => void }) {
  const { text } = useI18n();
  // 카드가 길어지지 않게 최근 실행 1건만 두고, 나머지는 펼침 버튼으로 연다.
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? runs : runs.slice(0, 1);
  const hidden = runs.length - visible.length;
  return <section className="schedule-run-history">
    {visible.map((run, index) => <ScheduleRunView key={run.id} run={run} source={source} sessions={sessions} busy={actionRunId === run.id} result={results[run.id]} onCancel={onCancel} onOpenSession={onOpenSession} label={index === 0 ? text("최근 실행", "Latest run") : text("이전 실행", "Previous run")} />)}
    {(hidden > 0 || expanded) && <button className="schedule-run-more" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}><ChevronDown size={13} aria-hidden="true" className={expanded ? "open" : ""} />{expanded ? text("실행 내역 접기", "Collapse run history") : text("이전 실행 보기", "View previous runs")}{!expanded && <em>{hidden}</em>}</button>}
  </section>;
}

/**
 * 끝난 실행의 요약·오류 전문을 펼칠 때 한 번만 받아 온다.
 *
 * 폴링 스냅샷이 주는 것은 미리보기라 긴 요약은 뒤가 잘려 있다. 진행 중인 실행은 내용이
 * 계속 자라므로 전문을 받아 두면 오히려 옛 값에 굳으니, 받아 온 값은 끝난 실행에만 쓴다.
 * 요청 표시는 state가 아니라 ref다 — state로 두면 실패한 요청이 다시 그려질 때마다
 * 되풀이된다.
 */
function useScheduleRunFullBody(runId: string, active: boolean) {
  const [fullBody, setFullBody] = useState<{ summary: string | null; error: string | null } | null>(null);
  const bodyRequested = useRef(false);
  const load = useCallback(async () => {
    if (bodyRequested.current) return;
    bodyRequested.current = true;
    try {
      const detail = await getScheduledRunDetail(runId);
      setFullBody({ summary: detail.run.summary, error: detail.run.error });
    } catch {
      // 다시 펼칠 때 재시도할 수 있게 요청 표시를 되돌린다. 미리보기는 그대로 보인다.
      bodyRequested.current = false;
    }
  }, [runId]);
  return { settled: active ? null : fullBody, load };
}

function ScheduleRunView({ run, source, sessions, busy, result, onCancel, onOpenSession, label }: { run: ScheduleRun; source: ProviderId; sessions: SessionSummary[]; busy: boolean; result?: string; onCancel: (run: ScheduleRun, source: ProviderId) => Promise<void>; onOpenSession: (session: SessionSummary) => void; label: string }) {
  const { text } = useI18n();
  const session = run.providerSessionId ? sessions.find((item) => item.source === source && item.id === run.providerSessionId) : null;
  const active = run.status === "running" || isWaitingRunStatus(run.status);
  const { settled, load: loadFullBody } = useScheduleRunFullBody(run.id, active);
  const summary = settled?.summary ?? run.summary;
  // 대기 중인 회차의 `error`는 실패가 아니라 왜 멈춰 있고 언제 다시 도는지에 대한 안내다.
  // 오류로 그리면 사용량이 돌아오길 기다리는 정상 상태가 실패처럼 보인다.
  const waitingNotice = isWaitingRunStatus(run.status)
    ? run.error ?? text("실행 계정을 준비하지 못해 잠시 뒤 다시 시도합니다.", "Failed to prepare execution account; retrying shortly.")
    : null;
  const failure = waitingNotice ? null : settled?.error ?? run.error;
  return <details className="schedule-run" open={active} onToggle={(event) => { if (event.currentTarget.open && !active) void loadFullBody(); }}>
    <summary><span>{label} · {formatDate(run.startedAt ?? run.scheduledFor)}</span><em className={run.status}>{runStatusLabel(run.status, text)}</em></summary>
    <div>
      <ScheduleRunProgressNotes run={run} active={active} waitingNotice={waitingNotice} />
      {run.sessionReference && <ScheduleRunSessionReference reference={run.sessionReference} />}
      {summary && <pre>{summary}</pre>}
      {failure && <p className="schedule-run-error">{failure}</p>}
      {run.recoveryError && <p className="schedule-run-error">{text(`복구 오류: ${run.recoveryError}`, `Recovery error: ${run.recoveryError}`)}</p>}
      {result && <p className="schedule-run-result">{result}</p>}
      <div className="schedule-run-actions">
        {active && <button className="button danger-subtle" type="button" disabled={busy} onClick={() => void onCancel(run, source)}>{busy ? text("처리 중…", "Processing…") : text("실행 취소", "Cancel run")}</button>}
        {session && <button className="button" type="button" onClick={() => onOpenSession(session)}>{text("결과 세션 열기", "Open result session")}</button>}
      </div>
    </div>
  </details>;
}

/**
 * 아직 끝나지 않은 실행이 지금 무엇을 하고 있는지 알리는 줄들. 요약·오류와 달리 실행이
 * 끝나면 모두 사라지는 한시적인 안내라 한자리에 모은다.
 */
function ScheduleRunProgressNotes({ run, active, waitingNotice }: { run: ScheduleRun; active: boolean; waitingNotice: string | null }) {
  const { text } = useI18n();
  const heartbeatAge = run.lastHeartbeatAt ? Math.max(0, Math.floor((Date.now() - run.lastHeartbeatAt) / 1000)) : null;
  return <>
    {run.status === "running" && <p>{text("에이전트 응답을 기다리고 있습니다.", "Waiting for agent response.")}</p>}
    {waitingNotice && <p className="schedule-run-waiting">{waitingNotice}</p>}
    {active && <p className="schedule-run-evidence">{text("stale 판정 근거", "Stale criteria")} · providerSessionId {run.providerSessionId ? text("있음", "present") : text("없음", "none")} · heartbeat {heartbeatAge === null ? text("없음", "none") : text(`${heartbeatAge}초 전`, `${heartbeatAge}s ago`)}</p>}
    {run.sessionReplaced && <p>{text(`대화 재개 실패 후 새 세션으로 전환됨 · 재시도 ${run.retryCount}회`, `Switched to a new session after resume failure · Retry ${run.retryCount}`)}</p>}
  </>;
}

/** 이 실행에 붙은 세션 참조 결과 — 적용 여부와 확정 구간, 부분 보고 사유. */
function ScheduleRunSessionReference({ reference }: { reference: ScheduleRunSessionRead }) {
  const { text } = useI18n();
  const windowText = reference.windowFrom && reference.windowTo
    ? ` · ${formatDate(reference.windowFrom)} ~ ${formatDate(reference.windowTo)}`
    : "";
  return <div className="schedule-run-session-reference">
    <p>{reference.granted ? text("세션 참조 적용", "Session reference applied") : text("세션 참조 없음", "No session reference")} · {reference.summary}{windowText}</p>
    {(reference.notes ?? []).map((note) => <small key={note}>{note}</small>)}
  </div>;
}

// 카드의 상태 색과 상태 라벨은 같은 사다리를 두 번 훑고 있었다. 한쪽만 고치면 색과
// 글자가 서로 다른 회차를 가리키므로 한 번 내려가며 둘을 함께 정한다.
function scheduleCardStatus({ enabled, windowEnded, activeRun, queued, last }: { enabled: boolean; windowEnded: boolean; activeRun: ScheduleRun | undefined; queued: boolean; last: ScheduleRun | undefined }, text: (ko: string, en: string) => string): { status: string; label: string } {
  if (!enabled) return { status: "paused", label: text("일시정지", "Paused") };
  if (windowEnded) return { status: "paused", label: text("기간 종료", "Window ended") };
  if (activeRun) return { status: isWaitingRunStatus(activeRun.status) ? activeRun.status : "running", label: runStatusLabel(activeRun.status, text) };
  if (queued) return { status: "requested", label: text("실행 요청됨", "Run requested") };
  return { status: last?.status ?? "idle", label: last ? runStatusLabel(last.status, text) : text("대기", "Waiting") };
}

function runStatusLabel(status: ScheduleRunStatus, text: (ko: string, en: string) => string): string {
  switch (status) {
    case "running":
      return text("실행 중", "Running");
    case "waitingForAccount":
      return text("계정 준비 대기", "Waiting for account");
    case "waitingForUsage":
      return text("사용량 복구 대기", "Waiting for usage");
    case "completed":
      return text("완료", "Completed");
    case "failed":
      return text("실패", "Failed");
    case "cancelled":
      return text("취소됨", "Cancelled");
    case "skipped":
      return text("건너뜀", "Skipped");
    default:
      return text("실행 중", "Running");
  }
}

function resumePolicyLabel(policy: ResumeFailurePolicy, text: (ko: string, en: string) => string): string {
  switch (policy) {
    case "pause":
      return text("실패 시 중지", "Pause on failure");
    case "newChat":
      return text("실패 시 새 대화", "New chat on failure");
    case "retryThenNewChat":
      return text("재시도 후 새 대화", "Retry then new chat");
    default:
      return text("재시도 후 새 대화", "Retry then new chat");
  }
}

