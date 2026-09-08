/**
 * 채팅 화면의 반복 요청 탭. 목록 카드와 실행 내역, 반복 요청 편집기가 여기 산다.
 *
 * 대화 화면(ChatView)과 같은 파일에 있었지만 공유하는 것은 탭 자리 하나뿐이라, 대화
 * 상태를 읽지도 쓰지도 않는 이 세 갈래를 따로 두어 대화 쪽을 읽을 때 함께 딸려오지
 * 않게 한다. 화면 밖으로 내보내는 것은 SchedulesPanel 하나다.
 */
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import {
  cancelScheduledRun,
  createScheduledRequest,
  deleteScheduledRequest,
  getBackgroundSettings,
  getScheduledRequestDetail,
  getScheduledRunDetail,
  getSystemWorkflows,
  hasTauriRuntime,
  runScheduledRequestNow,
  setScheduleEnabled,
  setBackgroundSettings,
  setSchedulesPaused,
  updateScheduledRequest,
} from "../lib/ipc";
import { formatDate, formatRelative } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatMode,
  ChatSessionInfo,
  ModelOption,
  ProjectOption,
  ProviderId,
  ProviderStatus,
  ReasoningEffort,
  ResumeFailurePolicy,
  ScheduleFrequency,
  ScheduleRun,
  ScheduledRequest,
  ScheduledRequestInput,
  SchedulerSnapshot,
  SessionSummary,
  SystemWorkflowSummary,
} from "../types";
import { EmptyState, ErrorBanner, SourceBadge, useConfirm, WorkflowInputControl } from "./Shared";
import {
  approvalModeLabel,
  defaultApprovalMode,
  effectiveApprovalMode,
  normalizeSettingValue,
  permissionModeLabel,
  reasoningLabel,
  settingFieldsFor,
} from "../lib/chatSettings";
import {
  clampSessionReadPolicy,
  describeSessionReadPolicy,
  sessionReadOriginFor,
  sessionReadSettingsOrDefault,
} from "../lib/sessionReadPolicy";
import { SessionReadPolicyFields } from "./SessionReadPolicyFields";
import { initialScheduleEditorModelSelection, isWaitingRunStatus, withSchedule, withScheduleEnabled } from "../lib/schedulerSnapshot";
import { buildWorkflowArguments, describeScheduleWorkflow, validateScheduleWorkflowDraft, workflowInputDefaults, workflowInputEntries, workflowInputsFromArguments } from "../lib/scheduleWorkflow";
import { activeWindowEnded, describeActiveWindow, fromDatetimeLocalValue, toDatetimeLocalValue } from "../lib/scheduleWindow";
import { reasoningOptionsFor, useProviderOptions } from "../lib/providerOptions";
import { defaultEffortFor, RuntimeSettings } from "./RuntimeSettings";
import { errorText } from "../lib/errorText";

export function SchedulesPanel({ providers, accounts, projects, models, sessions, snapshot, onRefresh, onSnapshot, currentSession, currentPrompt, onOpenSession }: { providers: ProviderStatus[]; accounts: AccountSnapshot | null; projects: ProjectOption[]; models: ModelOption[]; sessions: SessionSummary[]; snapshot: SchedulerSnapshot | null; onRefresh: () => Promise<void>; onSnapshot: (update: (current: SchedulerSnapshot) => SchedulerSnapshot) => void; currentSession: ChatSessionInfo | null; currentPrompt: string; onOpenSession: (session: SessionSummary) => void }) {
  const [editing, setEditing] = useState<ScheduledRequest | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runActionId, setRunActionId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<Record<string, string>>({});
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
  // 스냅샷 자체는 App의 폴링이 공급한다. 여기서는 변경 직후 즉시 갱신만 요청한다.
  const refresh = useCallback(async () => {
    try {
      await onRefresh();
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [onRefresh]);
  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      editorRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);
  const act = async (action: () => Promise<unknown>) => { setError(null); try { await action(); await refresh(); } catch (cause) { setError(errorText(cause)); } };
  // 활성 여부와 전체 일시정지는 누른 쪽이 결과를 이미 안다. 쓰기 왕복에 목록 전체 재조회를
  // 더해 기다리면(act) 스위치가 두 왕복 뒤에야 움직인다. 화면을 먼저 바꾸고, 응답이 오면
  // 서버가 계산한 다음 실행 시각까지 반영한다. 거절되면 이전 스냅샷으로 되돌린다.
  const toggleScheduleEnabled = (schedule: ScheduledRequest) => {
    const enabled = !schedule.enabled;
    setError(null);
    onSnapshot((current) => withScheduleEnabled(current, schedule.id, enabled));
    void setScheduleEnabled(schedule.id, enabled)
      .then((next) => onSnapshot((current) => withSchedule(current, next)))
      .catch((cause: unknown) => {
        // 되돌리는 것은 이 항목의 활성 여부뿐이다. 그사이 다른 항목을 바꿨다면 그대로 둔다.
        onSnapshot((current) => withScheduleEnabled(current, schedule.id, schedule.enabled));
        setError(errorText(cause));
      });
  };
  const toggleSchedulesPaused = (paused: boolean) => {
    setError(null);
    onSnapshot((current) => ({ ...current, paused }));
    void setSchedulesPaused(paused)
      .then((next) => onSnapshot(() => next))
      .catch((cause: unknown) => {
        onSnapshot((current) => ({ ...current, paused: !paused }));
        setError(errorText(cause));
      });
  };
  const cancelRun = async (run: ScheduleRun, _source: ProviderId) => {
    if (!window.confirm("이 반복 실행을 취소할까요? 실행 중 런타임이 있으면 안전하게 종료합니다.")) return;
    setRunActionId(run.id);
    setError(null);
    try {
      const receipt = await cancelScheduledRun(run.id, "스케줄러 UI에서 운영자가 실행 취소를 요청했습니다");
      setRunResults((current) => ({
        ...current,
        [run.id]: receipt.alreadyTerminal ? "이미 terminal 상태입니다" : receipt.stopError ? `취소 영속화 완료 · 런타임 종료 확인 실패: ${receipt.stopError}` : "취소 완료",
      }));
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunActionId(null);
    }
  };
  // 페이싱이 켜진 워크플로를 도는 반복 요청은 워크플로 페이싱 탭이 트리거까지 관리한다.
  // 여기에도 보여 주면 관리 주체가 둘로 갈라지므로 목록에서 뺀다. 워크플로 목록을 못
  // 읽었으면 아무것도 숨기지 않아 관리 경로가 사라지는 일이 없다.
  const pacingWorkflowIds = new Set(workflows.filter((item) => item.pacingEnabled).map((item) => item.id));
  const visibleSchedules = snapshot?.schedules.filter((schedule) => !(schedule.workflow && pacingWorkflowIds.has(schedule.workflow.workflowId))) ?? [];
  const pacedHiddenCount = (snapshot?.schedules.length ?? 0) - visibleSchedules.length;
  return (
    <section className="schedules-panel">
      <header><div><h2>반복 요청</h2><p>로그인 후 백그라운드에서 에이전트 요청을 실행합니다.</p></div><div>{snapshot && <button className={snapshot.paused ? "button primary" : "button"} type="button" onClick={() => toggleSchedulesPaused(!snapshot.paused)}>{snapshot.paused ? "전체 재개" : "전체 일시정지"}</button>}<button className="button primary" type="button" onClick={() => { void loadWorkflows(); setEditing("new"); }}>새 반복 요청</button></div></header>
      {error && <ErrorBanner message={error} />}
      {snapshot && !snapshot.runnerActive && <div className="warning-banner">다른 Agent Manager 프로세스가 반복 실행을 담당하고 있습니다.</div>}
      {snapshot?.paused && <div className="warning-banner">전체 일시정지 중입니다. 예약 실행만 멈추고 지금 실행은 그대로 나갑니다.</div>}
      {editing && <div className="schedule-editor-anchor" ref={editorRef}><ScheduleEditor key={editing === "new" ? "new" : editing.id} providers={providers} accounts={accounts} projects={projects} models={models} workflows={workflows} currentSession={currentSession} initialPrompt={currentPrompt} schedule={editing === "new" ? undefined : editing} onSaved={() => { setEditing(null); void refresh(); }} onCancel={() => setEditing(null)} /></div>}
      {pacedHiddenCount > 0 && <p className="schedules-paced-note">페이싱 회차 {pacedHiddenCount}건은 워크플로 화면의 워크플로 페이싱 탭에서 관리합니다.</p>}
      {!snapshot ? <div className="state-panel"><span className="spinner" /><p>반복 요청을 읽고 있습니다.</p></div> : visibleSchedules.length === 0 ? (pacedHiddenCount > 0 ? null : <EmptyState title="등록된 반복 요청이 없습니다" detail="이 탭에서 새 반복 작업을 만드세요." />) : (
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
            onRunNow={() => act(() => runScheduledRequestNow(schedule.id))}
            onToggleEnabled={() => toggleScheduleEnabled(schedule)}
            onEdit={() => void openEditor(schedule)}
            onDelete={() => { if (window.confirm(`'${schedule.name}' 반복 요청을 삭제할까요? 공급자 대화는 유지됩니다.`)) void act(() => deleteScheduledRequest(schedule.id)); }}
            onCancelRun={cancelRun}
            onOpenSession={onOpenSession}
          />
        ))}</div>
      )}
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
  const last = runs[0];
  const activeRun = runs.find((run) => run.status === "running" || isWaitingRunStatus(run.status));
  const scheduleAccount = accounts?.accounts.find((account) => account.id === schedule.accountId);
  const lastRunAccount = accounts?.accounts.find((account) => account.id === last?.actualAccountId);
  // 워크플로 반복 요청은 공급자·계정·권한 항목이 실행에 쓰이지 않는다. 카드도
  // 실제로 도는 대상만 보여 준다.
  const workflowBinding = schedule.workflow ?? null;
  const workflowInputCount = Object.keys(workflowBinding?.arguments ?? {}).length;
  const queued = Boolean(schedule.manualRunRequestedAt) && !activeRun;
  // 활성 종료가 지난 회차는 켜져 있어도 예약 실행이 더 나가지 않는다. 백엔드가
  // enabled를 끄지 않으므로(종료를 미루면 다시 돈다) 카드가 그 상태를 구분한다.
  const windowEnded = activeWindowEnded(schedule);
  const windowSummary = describeActiveWindow(schedule);
  const { status, label: statusLabel } = scheduleCardStatus({ enabled: schedule.enabled, windowEnded, activeRun, queued, last });
  return <article className={`schedule-card ${schedule.enabled && !windowEnded ? "" : "disabled"}`}>
    <header>{workflowBinding ? <span className="source-badge source-workflow">워크플로</span> : <SourceBadge source={schedule.source} />}<div><strong>{schedule.name}</strong><small>{workflowBinding ? describeScheduleWorkflow(workflowBinding, workflows) : schedule.prompt}</small></div><span className={`schedule-status ${status}`}>{statusLabel}</span></header>
    <div className="schedule-meta">{workflowBinding ? <span>{workflowInputCount > 0 ? `입력 ${workflowInputCount}개` : "입력 없음"}</span> : <><span>{schedule.useActiveAccount ? `계정 실행 시점 기본${lastRunAccount ? ` · 최근 ${lastRunAccount.displayName}` : ""}` : `계정 ${scheduleAccount?.displayName ?? schedule.accountId}`}</span><span>{permissionModeLabel(schedule.mode)}</span><span>{approvalModeLabel(effectiveApprovalMode(schedule.source, schedule.approvalMode ?? "never"))}</span>{schedule.reasoningEffort && <span>추론 {reasoningLabel(schedule.reasoningEffort)}</span>}<span>{schedule.sessionStrategy === "continue" ? `동일 대화 · ${resumePolicyLabel(schedule.resumeFailurePolicy)}` : "매번 새 채팅"}</span></>}<span>{windowEnded ? "다음 없음 · 기간 종료" : `다음 ${schedule.enabled ? formatRelative(schedule.nextRunAt) : "–"}`}</span>{windowSummary && <span className="schedule-active-window">활성 {windowSummary}</span>}{schedule.sessionReference?.policy.enabled && <span className="schedule-session-reference">세션 참조 {describeSessionReadPolicy(schedule.sessionReference.policy)}</span>}</div>
    <footer><button className="button" type="button" disabled={Boolean(activeRun) || queued} onClick={onRunNow}>{activeRun ? runStatusLabel(activeRun.status) : queued ? "실행 요청됨" : "지금 실행"}</button><button className="button" type="button" onClick={onToggleEnabled}>{schedule.enabled ? "일시정지" : "활성화"}</button><button className="button" type="button" onClick={onEdit}>수정</button><button className="button danger-subtle" type="button" onClick={onDelete}>삭제</button></footer>
    {runs.length > 0 && <ScheduleRunHistory runs={runs} source={schedule.source} sessions={sessions} actionRunId={runActionId} results={runResults} onCancel={onCancelRun} onOpenSession={onOpenSession} />}
  </article>;
}

function ScheduleRunHistory({ runs, source, sessions, actionRunId, results, onCancel, onOpenSession }: { runs: ScheduleRun[]; source: ProviderId; sessions: SessionSummary[]; actionRunId: string | null; results: Record<string, string>; onCancel: (run: ScheduleRun, source: ProviderId) => Promise<void>; onOpenSession: (session: SessionSummary) => void }) {
  // 카드가 길어지지 않게 최근 실행 1건만 두고, 나머지는 펼침 버튼으로 연다.
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? runs : runs.slice(0, 1);
  const hidden = runs.length - visible.length;
  return <section className="schedule-run-history">
    {visible.map((run, index) => <ScheduleRunView key={run.id} run={run} source={source} sessions={sessions} busy={actionRunId === run.id} result={results[run.id]} onCancel={onCancel} onOpenSession={onOpenSession} label={index === 0 ? "최근 실행" : "이전 실행"} />)}
    {(hidden > 0 || expanded) && <button className="schedule-run-more" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}><ChevronDown size={13} aria-hidden="true" className={expanded ? "open" : ""} />{expanded ? "실행 내역 접기" : "이전 실행 보기"}{!expanded && <em>{hidden}</em>}</button>}
  </section>;
}

function ScheduleRunView({ run, source, sessions, busy, result, onCancel, onOpenSession, label }: { run: ScheduleRun; source: ProviderId; sessions: SessionSummary[]; busy: boolean; result?: string; onCancel: (run: ScheduleRun, source: ProviderId) => Promise<void>; onOpenSession: (session: SessionSummary) => void; label: string }) {
  const session = run.providerSessionId ? sessions.find((item) => item.source === source && item.id === run.providerSessionId) : null;
  const active = run.status === "running" || isWaitingRunStatus(run.status);
  const heartbeatAge = run.lastHeartbeatAt ? Math.max(0, Math.floor((Date.now() - run.lastHeartbeatAt) / 1000)) : null;
  // 폴링 스냅샷의 요약은 미리보기다. 끝난 실행은 펼칠 때 전문을 한 번만 받아온다.
  // 진행 중인 실행은 계속 자라므로 폴링이 주는 최신 미리보기를 그대로 보여준다.
  const [fullBody, setFullBody] = useState<{ summary: string | null; error: string | null } | null>(null);
  const bodyRequested = useRef(false);
  const loadFullBody = useCallback(async () => {
    if (bodyRequested.current) return;
    bodyRequested.current = true;
    try {
      const detail = await getScheduledRunDetail(run.id);
      setFullBody({ summary: detail.run.summary, error: detail.run.error });
    } catch {
      // 다시 펼칠 때 재시도할 수 있게 요청 표시를 되돌린다. 미리보기는 그대로 보인다.
      bodyRequested.current = false;
    }
  }, [run.id]);
  const summary = (active ? null : fullBody?.summary) ?? run.summary;
  // 대기 중인 회차의 `error`는 실패가 아니라 왜 멈춰 있고 언제 다시 도는지에 대한 안내다.
  // 오류로 그리면 사용량이 돌아오길 기다리는 정상 상태가 실패처럼 보인다.
  const waitingNotice = isWaitingRunStatus(run.status)
    ? run.error ?? "실행 계정을 준비하지 못해 잠시 뒤 다시 시도합니다."
    : null;
  const failure = waitingNotice ? null : (active ? null : fullBody?.error) ?? run.error;
  return <details className="schedule-run" open={active} onToggle={(event) => { if (event.currentTarget.open && !active) void loadFullBody(); }}><summary><span>{label} · {formatDate(run.startedAt ?? run.scheduledFor)}</span><em className={run.status}>{runStatusLabel(run.status)}</em></summary><div>{run.status === "running" && <p>에이전트 응답을 기다리고 있습니다.</p>}{waitingNotice && <p className="schedule-run-waiting">{waitingNotice}</p>}{active && <p className="schedule-run-evidence">stale 판정 근거 · providerSessionId {run.providerSessionId ? "있음" : "없음"} · heartbeat {heartbeatAge === null ? "없음" : `${heartbeatAge}초 전`}</p>}{run.sessionReplaced && <p>대화 재개 실패 후 새 세션으로 전환됨 · 재시도 {run.retryCount}회</p>}{run.sessionReference && <div className="schedule-run-session-reference"><p>{run.sessionReference.granted ? "세션 참조 적용" : "세션 참조 없음"} · {run.sessionReference.summary}{run.sessionReference.windowFrom && run.sessionReference.windowTo ? ` · ${formatDate(run.sessionReference.windowFrom)} ~ ${formatDate(run.sessionReference.windowTo)}` : ""}</p>{(run.sessionReference.notes ?? []).map((note) => <small key={note}>{note}</small>)}</div>}{summary && <pre>{summary}</pre>}{failure && <p className="schedule-run-error">{failure}</p>}{run.recoveryError && <p className="schedule-run-error">복구 오류: {run.recoveryError}</p>}{result && <p className="schedule-run-result">{result}</p>}<div className="schedule-run-actions">{active && <button className="button danger-subtle" type="button" disabled={busy} onClick={() => void onCancel(run, source)}>{busy ? "처리 중…" : "실행 취소"}</button>}{session && <button className="button" type="button" onClick={() => onOpenSession(session)}>결과 세션 열기</button>}</div></div></details>;
}

/// 실행 계정 선택에서 특정 계정을 고정하지 않고 실행 시점 기본 계정을 쓰겠다는 값.
/// 계정 id와 겹치지 않게 예약어를 쓰고, 저장할 때 useActiveAccount로 바꾼다.
const ACTIVE_ACCOUNT_CHOICE = "__active__";

// 주기 숫자 칸의 허용 범위. 백엔드가 받는 값과 같다(간격은 시간 단위, 실행 시각은 시·분).
const INTERVAL_HOURS = { min: 1, max: 168 };
const RUN_HOUR = { min: 0, max: 23 };
const RUN_MINUTE = { min: 0, max: 59 };

/**
 * 숫자 칸 초안을 범위 안 정수로 되돌린다. 칸은 문자열 초안으로 들고 있다가 칸을 떠날 때와
 * 저장할 때만 여기로 자른다 — 치는 도중에 Number("")를 담으면 지운 칸에 0이 끼어들어 다시 친
 * 값이 열 배가 된다(QA #33). 빈 칸·숫자 아님은 하한으로 떨어진다.
 */
function clampScheduleNumber(raw: string, bounds: { min: number; max: number }): number {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
}

// 공급자를 바꾸거나 고른 계정이 비었을 때 되돌아갈 기본 계정. 활성 계정이 있으면 그것,
// 없으면 지금 바로 실행할 수 있는(비활성화되지 않고 인증이 끝난) 첫 계정이다.
// 편집기가 처음 열릴 때 고르는 계정은 저장본·현재 대화를 먼저 보는 별도 사다리라 여기
// 합치지 않는다(인증 전 계정도 저장본 그대로 보여 주어야 한다).
function defaultAccountIdFor(accounts: AccountSnapshot | null, source: ProviderId): string {
  return accounts?.providers.find((state) => state.provider === source)?.activeAccountId
    ?? accounts?.accounts.find((account) => account.provider === source && !account.disabled && account.authStatus === "ready")?.id
    ?? "";
}

// 편집기가 열릴 때의 실행 계정 사다리. 훅 선언 사이에 끼워 두면 "저장본 → 지금 대화 →
// 공급자 활성 계정 → 첫 사용 가능 계정" 순서가 묻혀 보이지 않아 밖으로 뺐다.
function initialScheduleAccountId(accounts: AccountSnapshot | null, source: ProviderId, schedule: ScheduledRequest | undefined, currentSession: ChatSessionInfo | null): string {
  return (schedule?.useActiveAccount ? ACTIVE_ACCOUNT_CHOICE : null)
    ?? (schedule?.accountId || null)
    ?? (currentSession?.source === source ? currentSession.accountId : null)
    ?? accounts?.providers.find((state) => state.provider === source)?.activeAccountId
    ?? accounts?.accounts.find((account) => account.provider === source && !account.disabled)?.id
    ?? "";
}

function ScheduleEditor({ providers, accounts, projects, models, workflows, currentSession, initialPrompt, schedule, onSaved, onCancel }: { providers: ProviderStatus[]; accounts: AccountSnapshot | null; projects: ProjectOption[]; models: ModelOption[]; workflows: SystemWorkflowSummary[]; currentSession: ChatSessionInfo | null; initialPrompt: string; schedule?: ScheduledRequest; onSaved: () => void; onCancel: () => void }) {
  const initialModelSelection = initialScheduleEditorModelSelection(
    schedule,
    currentSession,
    providers[0]?.provider ?? "codex",
  );
  const initialSource = initialModelSelection.source;
  const initialAccountId = initialScheduleAccountId(accounts, initialSource, schedule, currentSession);
  const [name, setName] = useState(schedule?.name ?? "");
  // 실행 대상. 워크플로 회차는 공급자 채팅을 띄우지 않으므로 계정·경로·권한 항목이
  // 실행에 쓰이지 않는다. 두 구분을 겹쳐 두면 저장본과 실제 실행이 어긋난다.
  const savedWorkflow = schedule?.workflow ?? null;
  const [target, setTarget] = useState<"chat" | "workflow">(savedWorkflow ? "workflow" : "chat");
  const [workflowId, setWorkflowId] = useState(savedWorkflow?.workflowId ?? "");
  const [workflowInputs, setWorkflowInputs] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState(schedule?.prompt ?? initialPrompt);
  const [source, setSource] = useState<ProviderId>(initialSource);
  const [accountId, setAccountId] = useState(initialAccountId);
  const [cwd, setCwd] = useState(schedule?.cwd ?? currentSession?.cwd ?? projects[0]?.path ?? "");
  const [model, setModel] = useState(initialModelSelection.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(schedule?.reasoningEffort ?? currentSession?.reasoningEffort ?? "");
  const [mode, setMode] = useState<ChatMode>(schedule?.mode ?? currentSession?.mode ?? "workspace");
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode>(effectiveApprovalMode(initialSource, schedule?.approvalMode ?? currentSession?.approvalMode ?? defaultApprovalMode(initialSource)));
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.recurrence.frequency ?? "daily");
  // 간격·실행 시각은 문자열 초안이다. 칸을 떠날 때 clampScheduleNumber로 범위 안에 되돌린다.
  const [intervalDraft, setIntervalDraft] = useState(String(schedule?.recurrence.interval ?? 1));
  const [hourDraft, setHourDraft] = useState(String(schedule?.recurrence.hour ?? 9));
  const [minuteDraft, setMinuteDraft] = useState(String(schedule?.recurrence.minute ?? 0));
  const [weekday, setWeekday] = useState(schedule?.recurrence.weekday ?? 1);
  const [cron, setCron] = useState(schedule?.recurrence.cron ?? "0 9 * * 1-5");
  const [strategy, setStrategy] = useState(schedule?.sessionStrategy ?? "newChat");
  const [failurePolicy, setFailurePolicy] = useState<ResumeFailurePolicy>(schedule?.resumeFailurePolicy ?? "retryThenNewChat");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  // 세션 참조는 접힌 고급 옵션에 둔다. 저장본이 없으면 비활성 기본값으로 열린다.
  const initialSessionReference = sessionReadSettingsOrDefault(schedule?.sessionReference);
  const [sessionPolicy, setSessionPolicy] = useState(initialSessionReference.policy);
  // 활성 창은 datetime-local이라 로컬 시각 문자열로 들고 있다가 저장할 때 절대 시각으로 바꾼다.
  const [activeFrom, setActiveFrom] = useState(toDatetimeLocalValue(schedule?.activeFrom));
  const [activeUntil, setActiveUntil] = useState(toDatetimeLocalValue(schedule?.activeUntil));
  const activeWindow = { from: fromDatetimeLocalValue(activeFrom), until: fromDatetimeLocalValue(activeUntil) };
  const activeWindowSummary = describeActiveWindow({ activeFrom: activeWindow.from, activeUntil: activeWindow.until });
  // 역전된 활성 창(종료 <= 시작)은 백엔드가 같은 문장으로 거절한다(scheduler.rs). 저장 버튼을
  // 눌러서야 알면 늦으므로 입력 시점에 칸 옆과 고급 옵션 요약에 같은 이유를 적고 저장을 막는다(QA #49).
  const activeWindowInverted = activeWindow.from !== null && activeWindow.until !== null && activeWindow.until <= activeWindow.from;
  const { text } = useI18n();
  const activeWindowInvertedText = text("활성 종료 일시는 활성 시작 일시보다 뒤여야 합니다.", "The active end must come after the active start.");
  const [advancedOpen, setAdvancedOpen] = useState(initialSessionReference.policy.enabled || Boolean(schedule?.activeFrom || schedule?.activeUntil));
  const sessionRecommendation = initialSessionReference.aiaRecommendation ?? null;
  const sessionOrigin = sessionReadOriginFor(sessionPolicy, sessionRecommendation);
  const [loginStart, setLoginStart] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const providerOptions = useProviderOptions(source);
  const providerAccounts = accounts?.accounts.filter((account) => account.provider === source && !account.disabled && account.authStatus === "ready") ?? [];
  // 계정 레지스트리는 다중 계정을 관리하는 공급자만 담는다(백엔드 `ProviderId::manages_accounts`).
  // Antigravity는 활성 계정도 고정 계정도 없이 계정 미귀속으로 실행되므로 계정을 묻지 않는다.
  const managesAccounts = source !== "antigravity";
  const providerState = accounts?.providers.find((state) => state.provider === source);
  const actualActiveAccountId = providerState?.activeAccountId ?? null;
  const selectedWorkflow = workflows.find((item) => item.id === workflowId) ?? null;
  const workflowSchema = workflowInputEntries(selectedWorkflow);
  const savedWorkflowMissing = Boolean(savedWorkflow) && !workflows.some((item) => item.id === savedWorkflow?.workflowId);
  const recentModels = models.filter((item) => item.source === source);
  const reasoningOptions = reasoningOptionsFor(providerOptions, model);
  const timezone = schedule?.recurrence.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  useEffect(() => {
    if (hasTauriRuntime()) void getBackgroundSettings().then((settings) => setLoginStart(schedule ? settings.loginStart : true)).catch(() => undefined);
  }, [schedule]);
  useEffect(() => {
    // 카탈로그 로딩 중(options 비어 있음)에는 저장된 값을 지우지 않는다.
    if (reasoningEffort && reasoningOptions.length > 0 && !reasoningOptions.some((option) => option.effort === reasoningEffort)) setReasoningEffort("");
  }, [reasoningEffort, reasoningOptions]);
  // 저장된 인자는 계약을 읽은 뒤에야 폼 값으로 되돌릴 수 있다. 계약이 선언한 기본값을
  // 먼저 깔고, 저장된 워크플로를 고른 동안만 그 위에 저장 값을 덮는다. 다른 워크플로로
  // 바꾸면 그 계약의 기본값에서 시작한다.
  useEffect(() => {
    if (!selectedWorkflow) return;
    const schema = workflowInputEntries(selectedWorkflow);
    const defaults = workflowInputDefaults(schema);
    setWorkflowInputs(selectedWorkflow.id === savedWorkflow?.workflowId
      ? { ...defaults, ...workflowInputsFromArguments(schema, savedWorkflow.arguments) }
      : defaults);
  }, [savedWorkflow, selectedWorkflow]);
  const previousSource = useRef(source);
  useEffect(() => {
    if (previousSource.current === source) return;
    previousSource.current = source;
    setModel("");
    setReasoningEffort("");
    setApprovalMode(defaultApprovalMode(source));
    setAccountId((current) => current === ACTIVE_ACCOUNT_CHOICE ? current : defaultAccountIdFor(accounts, source));
  }, [accounts, source]);
  useEffect(() => {
    if (accountId) return;
    setAccountId(defaultAccountIdFor(accounts, source));
  }, [accountId, accounts, source]);
  // 저장된 반복 요청의 권한·승인 값이 최신 스키마에서 사라졌으면 안전한 값으로 되돌린다.
  useEffect(() => {
    const fields = settingFieldsFor(providerOptions, source);
    setMode((current) => normalizeSettingValue(fields, "mode", current) as ChatMode);
    setApprovalMode((current) => normalizeSettingValue(fields, "approvalMode", current) as ChatApprovalMode);
  }, [providerOptions, source]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const recurrence = {
      frequency,
      interval: clampScheduleNumber(intervalDraft, INTERVAL_HOURS),
      hour: clampScheduleNumber(hourDraft, RUN_HOUR),
      minute: clampScheduleNumber(minuteDraft, RUN_MINUTE),
      weekday,
      cron: frequency === "cron" ? cron : null,
      timezone,
    };
    // 활성 창은 채팅 회차와 워크플로 회차에 똑같이 적용된다. 비운 칸은 제한 없음이다.
    // 역전은 저장 버튼이 이미 막지만, 키보드 제출 같은 다른 길도 같은 문장으로 막아 둔다.
    if (activeWindowInverted) { setError(activeWindowInvertedText); return; }
    // 두 실행 대상이 같은 봉투(주기·권한·활성 창·활성화)를 쓰고 나머지 칸만 갈라진다.
    // 두 벌로 적어 두면 한쪽에만 칸을 더하는 어긋남이 생긴다.
    const envelope = { mode, approvalMode, recurrence, resumeFailurePolicy: failurePolicy, enabled, activeFrom: activeWindow.from, activeUntil: activeWindow.until };
    let input: ScheduledRequestInput;
    if (target === "workflow") {
      const problems = validateScheduleWorkflowDraft({ workflow: selectedWorkflow, inputs: workflowInputs });
      if (problems.length > 0) { setError(problems.join(" ")); return; }
      // 지금 등록된 버전을 승인 버전으로 고정한다. 이후 워크플로가 바뀌면 백엔드가 그
      // 회차를 실행하지 않고 반복 요청을 멈춘다.
      // 병렬 실행 설정은 페이싱 탭의 회차 편집기가 소유한다. 여기서 다시 저장해도 지우지 않는다.
      const workflow = { workflowId: selectedWorkflow!.id, approvedVersion: selectedWorkflow!.version ?? 0, arguments: buildWorkflowArguments(workflowSchema, workflowInputs), pacing: schedule?.workflow?.workflowId === selectedWorkflow!.id ? schedule.workflow.pacing ?? null : null };
      input = { ...envelope, name: name.trim() || selectedWorkflow!.displayName || selectedWorkflow!.id, prompt: "", source, accountId: "", useActiveAccount: false, cwd: "", model: null, reasoningEffort: null, sessionStrategy: "newChat", providerSessionId: null, sessionReference: null, workflow };
    } else {
      const useActiveAccount = accountId === ACTIVE_ACCOUNT_CHOICE;
      input = { ...envelope, name: name.trim() || prompt.trim().slice(0, 60), prompt, source, accountId: useActiveAccount ? "" : accountId, useActiveAccount, cwd, model: model.trim() || null, reasoningEffort: reasoningEffort || null, sessionStrategy: strategy, providerSessionId: strategy === "continue" ? schedule?.providerSessionId ?? (currentSession?.source === source ? currentSession.providerSessionId : null) : null, sessionReference: sessionPolicy.enabled || schedule?.sessionReference ? { policy: clampSessionReadPolicy(sessionPolicy), origin: sessionOrigin, aiaRecommendation: sessionRecommendation } : null, workflow: null };
      if (mode === "fullAccess") {
        const accepted = await confirm({
          title: "전체 접근으로 반복 실행할까요?",
          message: "이 반복 요청은 지정한 시각마다 사용자 확인 없이 실행됩니다.\n전체 접근은 작업 경로 밖의 파일과 명령에도 접근할 수 있습니다.",
          items: [`반복 요청: ${input.name}`, `작업 경로: ${input.cwd}`],
          warning: "신뢰하는 요청과 작업 경로인지 확인한 뒤 저장하세요.",
          confirmLabel: "전체 접근으로 저장",
          cancelLabel: "취소",
          tone: "danger",
        });
        if (!accepted) return;
      }
    }
    setSaving(true); setError(null);
    try { if (schedule) await updateScheduledRequest(schedule.id, input); else await createScheduledRequest(input); if (hasTauriRuntime()) await setBackgroundSettings(loginStart); onSaved(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  };
  return <form className="schedule-editor" onSubmit={submit}><header><div><strong>{schedule ? "반복 요청 수정" : "새 반복 요청"}</strong><span>{timezone}</span></div><button type="button" onClick={onCancel} aria-label="닫기"><X size={16} /></button></header><div className="schedule-editor-grid"><label><span>이름</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="비워두면 요청 앞부분 사용" /></label><label><span>실행 대상</span><select value={target} onChange={(event) => { setTarget(event.target.value as "chat" | "workflow"); setError(null); }}><option value="chat">에이전트 요청</option><option value="workflow">시스템 워크플로</option></select></label>{target === "chat" && <><label><span>공급자</span><select value={source} onChange={(event) => setSource(event.target.value as ProviderId)}>{providers.map((provider) => <option value={provider.provider} key={provider.provider}>{provider.displayName}</option>)}</select></label>{managesAccounts && <label><span>실행 계정</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required><option value="" disabled>계정 선택</option><option value={ACTIVE_ACCOUNT_CHOICE}>실행 시점 기본 계정{actualActiveAccountId ? ` · 지금은 ${accounts?.accounts.find((account) => account.id === actualActiveAccountId)?.displayName ?? actualActiveAccountId}` : ""}</option>{providerAccounts.map((account) => <option value={account.id} key={account.id}>{account.displayName}{account.id === actualActiveAccountId ? " · 기본" : account.isActive ? " · 기본" : ""}</option>)}</select></label>}<label className="wide"><span>반복할 요청</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} required /></label><label className="wide"><span>작업 경로</span><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/project/path" required list="schedule-projects" /><datalist id="schedule-projects">{projects.map((project) => <option value={project.path} key={project.path}>{project.name}</option>)}</datalist></label><RuntimeSettings source={source} mode={mode} onModeChange={setMode} approvalMode={approvalMode} onApprovalModeChange={setApprovalMode} model={model} onModelChange={setModel} catalog={providerOptions} recent={recentModels} reasoningEffort={reasoningEffort} onReasoningChange={setReasoningEffort} reasoningOptions={reasoningOptions} defaultEffort={defaultEffortFor(providerOptions, model)} compact unattended /></>}{target === "workflow" && <><label className="wide"><span>실행할 워크플로</span><select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} required><option value="" disabled>워크플로 선택</option>{savedWorkflowMissing && savedWorkflow && <option value={savedWorkflow.workflowId}>{savedWorkflow.workflowId} · 목록에 없음</option>}{workflows.map((item) => <option value={item.id} key={item.id}>{item.displayName ?? item.id}{item.version ? ` · v${item.version}` : ""}{item.compatible ? "" : " · 카탈로그 비호환"}</option>)}</select></label>{selectedWorkflow?.pacingEnabled && <p className="schedule-workflow-empty wide">페이싱이 켜진 워크플로입니다. 저장한 회차는 워크플로 화면의 워크플로 페이싱 탭에서 관리됩니다.</p>}{workflowSchema.length > 0 && <div className="workflow-inputs wide">{workflowSchema.map(([fieldName, field]) => <WorkflowInputControl key={fieldName} name={fieldName} field={field} value={workflowInputs[fieldName] ?? ""} onChange={(next) => setWorkflowInputs((current) => ({ ...current, [fieldName]: next }))} />)}</div>}{selectedWorkflow && <div className="schedule-workflow-note wide"><p>지금 등록된 v{selectedWorkflow.version ?? "?"}을 승인 버전으로 고정합니다. 이후 워크플로가 바뀌면 그 회차를 실행하지 않고 반복 요청을 일시정지하니, 이 화면에서 다시 저장해 승인하세요.</p><p>워크플로는 등록된 기본 작업만 호출합니다. 공급자 CLI를 띄우지 않아 실행 계정·작업 경로·권한 범위와 세션 참조는 쓰이지 않습니다.</p>{selectedWorkflow.hardToRecoverEffects?.length ? <div><strong>복구가 어려운 영향</strong><ul>{selectedWorkflow.hardToRecoverEffects.map((effect) => <li key={effect}>{effect}</li>)}</ul></div> : null}</div>}{workflows.length === 0 && <p className="schedule-workflow-empty wide">등록된 시스템 워크플로가 없습니다. 워크플로 화면에서 AIA가 먼저 등록해야 선택할 수 있습니다.</p>}</>}<label><span>주기</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as ScheduleFrequency)}><option value="hourly">매 N시간</option><option value="daily">매일</option><option value="weekdays">평일</option><option value="weekly">매주</option><option value="cron">고급 Cron</option><option value="auto">자동 · 가드 창 간격</option></select></label>{frequency === "hourly" && <label><span>간격</span><input type="number" min={INTERVAL_HOURS.min} max={INTERVAL_HOURS.max} value={intervalDraft} onChange={(event) => setIntervalDraft(event.target.value)} onBlur={() => setIntervalDraft(String(clampScheduleNumber(intervalDraft, INTERVAL_HOURS)))} /></label>}{frequency !== "hourly" && frequency !== "cron" && frequency !== "auto" && <label><span>실행 시각</span><div className="time-fields"><input type="number" min={RUN_HOUR.min} max={RUN_HOUR.max} value={hourDraft} onChange={(event) => setHourDraft(event.target.value)} onBlur={() => setHourDraft(String(clampScheduleNumber(hourDraft, RUN_HOUR)))} /><b>:</b><input type="number" min={RUN_MINUTE.min} max={RUN_MINUTE.max} value={minuteDraft} onChange={(event) => setMinuteDraft(event.target.value)} onBlur={() => setMinuteDraft(String(clampScheduleNumber(minuteDraft, RUN_MINUTE)))} /></div></label>}{frequency === "weekly" && <label><span>요일</span><select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{["일", "월", "화", "수", "목", "금", "토"].map((label, index) => <option value={index} key={label}>{label}요일</option>)}</select></label>}{frequency === "cron" && <label className="wide"><span>Cron · 분 시 일 월 요일</span><input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" /></label>}{target === "chat" && <><label><span>세션 방식</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as "newChat" | "continue")}><option value="newChat">매번 새 채팅</option><option value="continue">동일 대화 이어가기</option></select></label>{strategy === "continue" && <label><span>재개 실패 시</span><select value={failurePolicy} onChange={(event) => setFailurePolicy(event.target.value as ResumeFailurePolicy)}><option value="pause">작업 일시정지</option><option value="newChat">즉시 새 대화</option><option value="retryThenNewChat">한 번 재시도 후 새 대화</option></select></label>}</>}<label className="check-filter"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 저장 후 활성화</label>{hasTauriRuntime() && <label className="check-filter"><input type="checkbox" checked={loginStart} onChange={(event) => setLoginStart(event.target.checked)} /> 로그인 시 백그라운드 실행</label>}</div><section className="schedule-advanced"><button type="button" className="schedule-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}고급 옵션<small>{activeWindowInverted ? text("활성 창 역전 · 종료가 시작보다 앞", "Active window inverted · end before start") : activeWindowSummary ? `활성 창 ${activeWindowSummary}` : "활성 창 제한 없음"}{target === "chat" ? ` · 세션 참조: ${describeSessionReadPolicy(sessionPolicy)}` : ""}</small></button>{advancedOpen && <div className="schedule-advanced-window"><label><span>활성 시작</span><input type="datetime-local" value={activeFrom} onChange={(event) => setActiveFrom(event.target.value)} /></label><label><span>활성 종료</span><input type="datetime-local" value={activeUntil} aria-invalid={activeWindowInverted || undefined} onChange={(event) => setActiveUntil(event.target.value)} /></label>{activeWindowInverted && <p className="schedule-window-invalid" role="alert" style={{ color: "var(--danger)" }}>{activeWindowInvertedText}</p>}<p>비우면 제한이 없습니다. 창 밖에서는 예약 실행이 나가지 않고, 종료가 지나도 반복 요청은 꺼지지 않아 종료를 미루면 그대로 다시 돕니다. 지금 실행은 창과 무관합니다.</p></div>}{advancedOpen && target === "chat" && <SessionReadPolicyFields policy={sessionPolicy} origin={sessionOrigin} recommendation={sessionRecommendation} projects={projects} ownScopeLabel="이 일정의 작업 경로" onChange={setSessionPolicy} onReapplyRecommendation={sessionRecommendation ? () => setSessionPolicy(sessionRecommendation) : undefined} />}</section>{target === "chat" && managesAccounts && providerAccounts.length === 0 && <ErrorBanner message="선택한 공급자에 사용 가능한 계정이 없습니다. 설정에서 계정을 추가하세요." />}{error && <ErrorBanner message={error} />}<footer><button className="button" type="button" onClick={onCancel}>취소</button><button className="button primary" type="submit" disabled={saving || activeWindowInverted || (target === "workflow" ? !workflowId : (managesAccounts && !accountId) || !prompt.trim() || !cwd.trim())}>{saving ? "저장 중…" : "저장"}</button></footer>{confirmDialog}</form>;
}

// 카드의 상태 색과 상태 라벨은 같은 사다리를 두 번 훑고 있었다. 한쪽만 고치면 색과
// 글자가 서로 다른 회차를 가리키므로 한 번 내려가며 둘을 함께 정한다.
function scheduleCardStatus({ enabled, windowEnded, activeRun, queued, last }: { enabled: boolean; windowEnded: boolean; activeRun: ScheduleRun | undefined; queued: boolean; last: ScheduleRun | undefined }): { status: string; label: string } {
  if (!enabled) return { status: "paused", label: "일시정지" };
  if (windowEnded) return { status: "paused", label: "기간 종료" };
  if (activeRun) return { status: isWaitingRunStatus(activeRun.status) ? activeRun.status : "running", label: runStatusLabel(activeRun.status) };
  if (queued) return { status: "requested", label: "실행 요청됨" };
  return { status: last?.status ?? "idle", label: last ? runStatusLabel(last.status) : "대기" };
}

function runStatusLabel(status: ScheduleRun["status"]): string { return status === "completed" ? "완료" : status === "failed" ? "실패" : status === "cancelled" ? "취소됨" : status === "skipped" ? "건너뜀" : status === "waitingForAccount" ? "계정 준비 대기" : status === "waitingForUsage" ? "사용량 복구 대기" : "실행 중"; }
function resumePolicyLabel(policy: ResumeFailurePolicy): string { return policy === "pause" ? "실패 시 중지" : policy === "newChat" ? "실패 시 새 대화" : "재시도 후 새 대화"; }
