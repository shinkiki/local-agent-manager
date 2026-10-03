/**
 * 반복 요청 편집기. 새 반복 요청과 수정이 쓰는 폼 한 벌 — 칸 묶음, 칸 초안 훅, 폼 값을
 * 저장 입력으로 접는 두 갈래(에이전트 요청·시스템 워크플로)가 여기 산다.
 *
 * 목록과 같은 파일에 있었지만 둘이 공유하는 것은 계정 조회뿐이고 합쳐서 900줄이 넘었다.
 * 목록 카드의 상태 사다리를 읽으려다 편집기의 칸 초안 훅을 지나가야 했고, 그 반대도
 * 같았다. 화면 밖으로 내보내는 것은 ScheduleEditor 하나다.
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import {
  createDirectory,
  createScheduledRequest,
  previewDirectoryCreation,
  updateScheduledRequest,
} from "../lib/ipc";
import { directoryCreationItems, missingDirectoryPath } from "../lib/missingDirectory";
import { activeAccountId } from "../lib/launchAccount";
import { displayPath } from "../lib/displayPath";
import { useI18n, type UiText } from "../lib/i18n";
import { supportsAiaSystemTools } from "../lib/aiaRuntime.ts";
import { ALL_WEEKDAYS, weekdayChoiceLabel } from "../lib/pacingSchedule";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatMode,
  ChatSessionInfo,
  ModelOption,
  ProjectOption,
  ProviderAccountView,
  ProviderId,
  ProviderStatus,
  ReasoningEffort,
  ResumeFailurePolicy,
  ScheduleFrequency,
  ScheduledRequest,
  ScheduledRequestInput,
  SessionReadOrigin,
  SessionReadPolicy,
  SystemWorkflowSummary,
} from "../types";
import { ErrorBanner, useConfirm, WorkflowInputControl } from "./Shared";
import {
  defaultApprovalMode,
  effectiveApprovalMode,
  normalizeSettingValue,
  settingFieldsFor,
} from "../lib/chatSettings";
import {
  clampSessionReadPolicy,
  describeSessionReadPolicy,
  SESSION_READ_PERIOD_INVERTED_TEXT,
  sessionReadOriginFor,
  sessionReadPeriodInverted,
  sessionReadSettingsOrDefault,
} from "../lib/sessionReadPolicy";
import { SessionReadPolicyFields } from "./SessionReadPolicyFields";
import { ACTIVE_ACCOUNT_CHOICE, accountById, defaultAccountIdFor, initialScheduleAccountId, providerManagesAccounts, selectableAccountsFor } from "./ChatScheduleAccounts";
import { initialScheduleEditorModelSelection } from "../lib/schedulerSnapshot";
import { localConnectionIdForRequest } from "../lib/localConnections";
import { buildWorkflowArguments, validateScheduleWorkflowDraft, workflowInputDefaults, workflowInputEntries, workflowInputsFromArguments } from "../lib/scheduleWorkflow";
import { describeActiveWindow, fromDatetimeLocalValue, toDatetimeLocalValue } from "../lib/scheduleWindow";
import { useProviderOptions } from "../lib/providerOptions";
import { useCatalogReasoningOptions } from "./ChatRuntimeSettingsMenu";
import { defaultEffortFor, RuntimeSettings } from "./RuntimeSettings";
import { errorText } from "../lib/errorText";


/**
 * 이름 칸이 받는 최대 글자 수. 백엔드가 저장 직전에 같은 수로 자른다
 * (`scheduler.rs`의 `input.name.trim().chars().take(120)`). 칸이 더 받아 두면 저장 뒤에야
 * 뒤가 잘린 이름을 보게 되고, 잘렸다는 표시도 없다(QA #91). 두 값이 갈라지지 않게 여기
 * 한 자리에 적고 칸과 안내가 같이 읽는다.
 */
const SCHEDULE_NAME_MAX = 120;

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

/**
 * 범위가 정해진 숫자 칸 하나의 초안. 간격·시·분 세 칸은 "문자열로 들고 있다가 칸을 떠날
 * 때와 저장할 때만 범위 안으로 자른다"는 같은 규칙을 쓰는데, 상태 선언과 `onBlur`의 보정
 * 호출과 저장 직전의 보정 호출이 파일의 서로 다른 세 자리에 흩어져 세 벌씩 있었다. 어느
 * 한 칸만 규칙이 어긋나도(예: `onBlur`를 빠뜨려 저장 때만 잘리는 칸) 화면에서 드러나지
 * 않으므로 한 벌로 모은다. `input`에 그대로 펼칠 수 있는 모양(`min`·`max`·두 손잡이)으로
 * 내보내 칸마다 범위를 다시 적지 않게 한다.
 */
function useClampedNumberDraft(initial: number, bounds: { min: number; max: number }) {
  const [draft, setDraft] = useState(String(initial));
  return {
    /** 저장 직전에만 부른다 — 치는 도중이 아니라 여기서 범위 안으로 자른다. */
    toNumber: () => clampScheduleNumber(draft, bounds),
    field: {
      value: draft,
      min: bounds.min,
      max: bounds.max,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      onBlur: () => setDraft(String(clampScheduleNumber(draft, bounds))),
    },
  };
}

type ClampedNumberField = ReturnType<typeof useClampedNumberDraft>["field"];

/**
 * 반복 규칙의 종류에 따라 함께 바뀌는 입력 묶음. 편집기 본문에서는 저장 대상 상태만
 * 소유하고, 각 빈도에 맞는 칸과 숫자 초안 보정은 이 컴포넌트가 한 자리에서 보여 준다.
 */
function ScheduleRecurrenceFields({
  frequency,
  interval,
  hour,
  minute,
  weekday,
  cron,
  onFrequencyChange,
  onWeekdayChange,
  onCronChange,
}: {
  frequency: ScheduleFrequency;
  interval: ClampedNumberField;
  hour: ClampedNumberField;
  minute: ClampedNumberField;
  weekday: number;
  cron: string;
  onFrequencyChange: (value: ScheduleFrequency) => void;
  onWeekdayChange: (value: number) => void;
  onCronChange: (value: string) => void;
}) {
  const { text } = useI18n();
  return <>
    <label><span>주기</span><select value={frequency} onChange={(event) => onFrequencyChange(event.target.value as ScheduleFrequency)}><option value="hourly">매 N시간</option><option value="daily">매일</option><option value="weekdays">평일</option><option value="weekly">매주</option><option value="cron">고급 Cron</option><option value="auto">자동 · 가드 창 간격</option></select></label>
    {frequency === "hourly" && <label><span>간격</span><input type="number" {...interval} /></label>}
    {frequency !== "hourly" && frequency !== "cron" && frequency !== "auto" && <label><span>실행 시각</span><div className="time-fields"><input type="number" {...hour} /><b>:</b><input type="number" {...minute} /></div></label>}
    {frequency === "weekly" && <label><span>요일</span><select value={weekday} onChange={(event) => onWeekdayChange(Number(event.target.value))}>{ALL_WEEKDAYS.map((day) => <option value={day} key={day}>{weekdayChoiceLabel(day, text)}</option>)}</select></label>}
    {frequency === "cron" && <label className="wide"><span>Cron · 분 시 일 월 요일</span><input value={cron} onChange={(event) => onCronChange(event.target.value)} placeholder="0 9 * * 1-5" /></label>}
  </>;
}


/**
 * 반복 주기 칸의 초안 상태. 여섯 칸과 그 칸을 저장 모양으로 접는 규칙이 편집기 본문의
 * useState 무더기와 submit 양쪽에 흩어져 있으면, 어떤 칸이 어떤 범위로 잘리는지 보려고
 * 200줄을 오가야 한다. 상태·저장 변환·칸 묶음에 넘길 props를 여기 한 자리에 둔다.
 */
function useScheduleRecurrenceDraft(schedule: ScheduledRequest | undefined) {
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.recurrence.frequency ?? "daily");
  // 간격·실행 시각은 문자열 초안이다. 칸을 떠날 때와 저장할 때 범위 안으로 되돌린다.
  const interval = useClampedNumberDraft(schedule?.recurrence.interval ?? 1, INTERVAL_HOURS);
  const hour = useClampedNumberDraft(schedule?.recurrence.hour ?? 9, RUN_HOUR);
  const minute = useClampedNumberDraft(schedule?.recurrence.minute ?? 0, RUN_MINUTE);
  const [weekday, setWeekday] = useState(schedule?.recurrence.weekday ?? 1);
  const [cron, setCron] = useState(schedule?.recurrence.cron ?? "0 9 * * 1-5");
  const timezone = schedule?.recurrence.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return {
    timezone,
    fields: {
      frequency,
      interval: interval.field,
      hour: hour.field,
      minute: minute.field,
      weekday,
      cron,
      onFrequencyChange: setFrequency,
      onWeekdayChange: setWeekday,
      onCronChange: setCron,
    },
    /** 저장 직전에만 부른다 — 치는 도중이 아니라 여기서 숫자 초안을 범위 안으로 자른다. */
    toRecurrence: () => ({
      frequency,
      interval: interval.toNumber(),
      hour: hour.toNumber(),
      minute: minute.toNumber(),
      weekday,
      cron: frequency === "cron" ? cron : null,
      timezone,
    }),
  };
}

/**
 * 활성 창 두 칸의 초안 상태. 화면은 datetime-local이라 로컬 시각 문자열로 들고 있다가
 * 저장할 때 절대 시각으로 바꾼다. 역전된 창(종료 <= 시작)은 백엔드가 같은 문장으로
 * 거절한다(scheduler.rs). 저장 버튼을 눌러서야 알면 늦으므로 입력 시점에 칸 옆과 고급
 * 옵션 요약에 같은 이유를 적고 저장을 막는데(QA #49), 그 판정과 문구가 갈라지지 않도록
 * 절대 시각·역전 여부·문구를 한 곳에서 함께 낸다.
 */
function useScheduleActiveWindowDraft(schedule: ScheduledRequest | undefined) {
  const { text } = useI18n();
  const [from, setFrom] = useState(toDatetimeLocalValue(schedule?.activeFrom));
  const [until, setUntil] = useState(toDatetimeLocalValue(schedule?.activeUntil));
  const activeFrom = fromDatetimeLocalValue(from);
  const activeUntil = fromDatetimeLocalValue(until);
  const inverted = activeFrom !== null && activeUntil !== null && activeUntil <= activeFrom;
  const invertedText = text("활성 종료 일시는 활성 시작 일시보다 뒤여야 합니다.", "The active end must come after the active start.");
  return {
    activeFrom,
    activeUntil,
    inverted,
    invertedText,
    onFromChange: setFrom,
    onUntilChange: setUntil,
    fields: { from, until, inverted, summary: describeActiveWindow({ activeFrom, activeUntil }), invertedText },
  };
}

/**
 * 이 반복 실행이 Agent Manager 자신을 다루는 도구를 쥔다는 안내.
 *
 * 토글이 아니라 안내인 이유: 2026-09-27 사용자 결정으로 **등록 자체가 허용**이다. 사람이
 * 이 화면에서 무엇을 시킬지 적고 실행 모드·승인 처리를 고르는 것이 그 허용이므로, 고를
 * 것을 하나 더 늘리는 대신 무엇이 열리는지 그 자리에서 보이게 한다.
 *
 * 공급자에 따라 사실이 달라지므로 실을 수 없는 공급자에는 적지 않는다 — 없는 것을 있다고
 * 적으면 이 안내가 거짓이 된다.
 */
function ScheduleSystemToolsNotice({ source }: { source: ProviderId }) {
  const { text } = useI18n();
  if (!supportsAiaSystemTools(source)) return null;
  return <p className="schedule-system-tools-notice" role="note">{text(
    "이 반복 실행은 Agent Manager 를 다루는 시스템 도구를 사용합니다 — 세션·스킬·설정·반복 요청을 읽고 바꿀 수 있습니다. SSH·DB 변경과 화면 조작은 실행 중에도 사용자 승인 카드를 요구하므로 무인 실행에서는 완료되지 않습니다. 호출 내역은 감사 기록에 남습니다.",
    "This scheduled run uses the system tools that operate Agent Manager — it can read and change sessions, skills, settings and scheduled requests. SSH and database writes and on-screen actions still require your approval, so an unattended run cannot complete them. Every call is recorded in the audit log.",
  )}</p>;
}

export function ScheduleEditor({ providers, accounts, projects, models, workflows, currentSession, initialPrompt, schedule, onSaved, onCancel }: { providers: ProviderStatus[]; accounts: AccountSnapshot | null; projects: ProjectOption[]; models: ModelOption[]; workflows: SystemWorkflowSummary[]; currentSession: ChatSessionInfo | null; initialPrompt: string; schedule?: ScheduledRequest; onSaved: () => void; onCancel: () => void }) {
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
  // 로컬 공급자의 서빙 연결(M7 7.4). 저장본 → 현재 세션 순으로 잇고, 없으면 기본 연결이다.
  const [localConnectionId, setLocalConnectionId] = useState(schedule?.localConnectionId ?? currentSession?.localConnectionId ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(schedule?.reasoningEffort ?? currentSession?.reasoningEffort ?? "");
  const [mode, setMode] = useState<ChatMode>(schedule?.mode ?? currentSession?.mode ?? "workspace");
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode>(effectiveApprovalMode(initialSource, schedule?.approvalMode ?? currentSession?.approvalMode ?? defaultApprovalMode(initialSource)));
  const recurrenceDraft = useScheduleRecurrenceDraft(schedule);
  const [strategy, setStrategy] = useState(schedule?.sessionStrategy ?? "newChat");
  const [failurePolicy, setFailurePolicy] = useState<ResumeFailurePolicy>(schedule?.resumeFailurePolicy ?? "retryThenNewChat");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  // 세션 참조는 접힌 고급 옵션에 둔다. 저장본이 없으면 비활성 기본값으로 열린다.
  const initialSessionReference = sessionReadSettingsOrDefault(schedule?.sessionReference);
  const [sessionPolicy, setSessionPolicy] = useState(initialSessionReference.policy);
  const activeWindow = useScheduleActiveWindowDraft(schedule);
  const [advancedOpen, setAdvancedOpen] = useState(initialSessionReference.policy.enabled || Boolean(schedule?.activeFrom || schedule?.activeUntil));
  const sessionRecommendation = initialSessionReference.aiaRecommendation ?? null;
  const sessionOrigin = sessionReadOriginFor(sessionPolicy, sessionRecommendation);
  // 세션 참조는 채팅 회차에만 저장되므로(workflowScheduleInput은 정책을 싣지 않는다)
  // 워크플로 대상에서는 역전이 남아 있어도 저장을 막지 않는다. 활성 창 역전과 같은 자리에서
  // 같은 방식으로 막아 저장 버튼을 눌러서야 서버 거절을 만나지 않게 한다(QA #79).
  const sessionPeriodInverted = target === "chat" && sessionPolicy.enabled && sessionReadPeriodInverted(sessionPolicy.period);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const { text } = useI18n();
  const providerOptions = useProviderOptions(source);
  const providerAccounts = selectableAccountsFor(accounts, source, "ready");
  // 계정 레지스트리는 다중 계정을 관리하는 공급자만 담는다(백엔드 `ProviderId::manages_accounts`).
  // 목록을 여기에 적어 두면 공급자가 늘 때 화면만 뒤처져, 계정을 요구하는 공급자에게
  // 계정을 묻지 않는 반복 요청이 저장된다. 스냅숏이 아직 없으면 묻는 쪽으로 둔다 —
  // 선택이 잠깐 숨었다가 나타나는 것보다 낫다.
  const managesAccounts = accounts ? providerManagesAccounts(accounts, source) : true;
  const actualActiveAccountId = activeAccountId(accounts, source);
  const selectedWorkflow = workflows.find((item) => item.id === workflowId) ?? null;
  const workflowSchema = workflowInputEntries(selectedWorkflow);
  const recentModels = models.filter((item) => item.source === source);
  const reasoningOptions = useCatalogReasoningOptions(providerOptions, model, reasoningEffort, () => setReasoningEffort(""));
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
    // 활성 창은 채팅 회차와 워크플로 회차에 똑같이 적용된다. 비운 칸은 제한 없음이다.
    // 역전은 저장 버튼이 이미 막지만, 키보드 제출 같은 다른 길도 같은 문장으로 막아 둔다.
    if (activeWindow.inverted) { setError(activeWindow.invertedText); return; }
    if (sessionPeriodInverted) { setError(SESSION_READ_PERIOD_INVERTED_TEXT); return; }
    // 두 실행 대상이 같은 봉투(주기·권한·활성 창·활성화)를 쓰고 나머지 칸만 갈라진다.
    // 두 벌로 적어 두면 한쪽에만 칸을 더하는 어긋남이 생긴다.
    const envelope: ScheduleEnvelope = { mode, approvalMode, recurrence: recurrenceDraft.toRecurrence(), resumeFailurePolicy: failurePolicy, enabled, activeFrom: activeWindow.activeFrom, activeUntil: activeWindow.activeUntil };
    let input: ScheduledRequestInput;
    if (target === "workflow") {
      const problems = validateScheduleWorkflowDraft({ workflow: selectedWorkflow, inputs: workflowInputs });
      if (problems.length > 0) { setError(problems.join(" ")); return; }
      input = workflowScheduleInput(envelope, { name, source, workflow: selectedWorkflow!, schema: workflowSchema, inputs: workflowInputs, saved: savedWorkflow });
    } else {
      input = chatScheduleInput(envelope, {
        name, prompt, source, accountId, cwd, model, localConnectionId, reasoningEffort, strategy, currentSession,
        sessionPolicy, sessionOrigin, sessionRecommendation,
        savedProviderSessionId: schedule?.providerSessionId ?? null,
        hasSavedSessionReference: Boolean(schedule?.sessionReference),
      });
      if (mode === "fullAccess") {
        const accepted = await confirm(fullAccessScheduleConfirm(input, text));
        if (!accepted) return;
      }
    }
    setSaving(true); setError(null);
    try { await saveWithMissingDirectoryOffer(input); onSaved(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  };
  const save = (input: ScheduledRequestInput) => schedule ? updateScheduledRequest(schedule.id, input) : createScheduledRequest(input);
  /**
   * 작업 경로가 아직 없는 폴더인 채로 저장하는 일은 흔하다 — 로컬 세션에서 이어 받은
   * 경로가 사라졌거나, 앞으로 쓸 폴더를 미리 적었거나. 채팅 시작(`ChatView`)과 같은
   * 순서로, 없는 경로일 때만 만들지 물어보고 승인하면 만든 뒤 같은 저장을 한 번 더
   * 시도한다. 실패가 이 종류가 아니거나 거절하면 원래 실패를 그대로 올린다.
   */
  const saveWithMissingDirectoryOffer = async (input: ScheduledRequestInput) => {
    try {
      return await save(input);
    } catch (cause) {
      const missing = missingDirectoryPath(errorText(cause));
      if (!missing) throw cause;
      // 없는 칸이 여럿이면 중간 칸도 새로 생긴다. 승인 전에 생길 것을 모두 보여 준다(C6-4b).
      const plan = await previewDirectoryCreation(missing).catch(() => null);
      const items = directoryCreationItems(plan, missing);
      const accepted = await confirm({
        title: text("새 폴더 만들기", "Create new folder"),
        message: items.length > 1
          ? text("작업 경로에 폴더가 없습니다. 아래 폴더를 차례로 만들고 반복 요청을 저장할까요?", "There is no folder at the working path. Create the following folders in order and save the scheduled request?")
          : text("작업 경로에 폴더가 없습니다. 새로운 폴더를 만들고 반복 요청을 저장할까요?", "There is no folder at the working path. Create a new folder and save the scheduled request?"),
        items,
        confirmLabel: text("만들고 저장", "Create and save"),
      });
      if (!accepted) throw cause;
      const created = await createDirectory(missing);
      setCwd(created.path);
      return save({ ...input, cwd: created.path });
    }
  };
  return <form className="schedule-editor" onSubmit={submit}><header><div><strong>{schedule ? "반복 요청 수정" : "새 반복 요청"}</strong><span>{recurrenceDraft.timezone}</span></div><button type="button" onClick={onCancel} aria-label="닫기"><X size={16} /></button></header><div className="schedule-editor-grid"><label><span>이름</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={SCHEDULE_NAME_MAX} placeholder={text(`비워두면 요청 앞부분 사용 · 최대 ${SCHEDULE_NAME_MAX}자`, `Leave empty to use the start of the request · up to ${SCHEDULE_NAME_MAX} characters`)} /></label><label><span>실행 대상</span><select value={target} onChange={(event) => { setTarget(event.target.value as "chat" | "workflow"); setError(null); }}><option value="chat">에이전트 요청</option><option value="workflow">시스템 워크플로</option></select></label>{target === "chat" && <><ScheduleChatTargetFields providers={providers} projects={projects} accounts={accounts} source={source} onSourceChange={setSource} managesAccounts={managesAccounts} accountId={accountId} providerAccounts={providerAccounts} activeAccountId={actualActiveAccountId} onAccountIdChange={setAccountId} prompt={prompt} onPromptChange={setPrompt} cwd={cwd} onCwdChange={setCwd} /><RuntimeSettings source={source} mode={mode} onModeChange={setMode} approvalMode={approvalMode} onApprovalModeChange={setApprovalMode} model={model} onModelChange={setModel} localConnectionId={localConnectionId} onLocalConnectionChange={setLocalConnectionId} catalog={providerOptions} recent={recentModels} reasoningEffort={reasoningEffort} onReasoningChange={setReasoningEffort} reasoningOptions={reasoningOptions} defaultEffort={defaultEffortFor(providerOptions, model)} compact unattended /><ScheduleSystemToolsNotice source={source} /></>}{target === "workflow" && <ScheduleWorkflowFields workflows={workflows} workflowId={workflowId} savedWorkflow={savedWorkflow} selected={selectedWorkflow} schema={workflowSchema} inputs={workflowInputs} onWorkflowIdChange={setWorkflowId} onInputChange={(fieldName, next) => setWorkflowInputs((current) => ({ ...current, [fieldName]: next }))} />}<ScheduleRecurrenceFields {...recurrenceDraft.fields} />{target === "chat" && <ScheduleSessionStrategyFields strategy={strategy} onStrategyChange={setStrategy} failurePolicy={failurePolicy} onFailurePolicyChange={setFailurePolicy} />}<label className="check-filter"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 저장 후 활성화</label></div><ScheduleAdvancedSection open={advancedOpen} onToggle={() => setAdvancedOpen((open) => !open)} target={target} activeWindow={activeWindow.fields} onFromChange={activeWindow.onFromChange} onUntilChange={activeWindow.onUntilChange} sessionPolicy={sessionPolicy} sessionOrigin={sessionOrigin} sessionRecommendation={sessionRecommendation} projects={projects} onSessionPolicyChange={setSessionPolicy} />{target === "chat" && managesAccounts && providerAccounts.length === 0 && <ErrorBanner message={text("선택한 공급자에 사용 가능한 계정이 없습니다. 설정에서 계정을 추가하세요.", "The selected provider has no usable account. Add one in Settings.")} />}{error && <ErrorBanner message={error} />}<footer><button className="button" type="button" onClick={onCancel}>취소</button><button className="button primary" type="submit" disabled={saving || activeWindow.inverted || sessionPeriodInverted || (target === "workflow" ? !workflowId : (managesAccounts && !accountId) || !prompt.trim())}>{saving ? "저장 중…" : "저장"}</button></footer>{confirmDialog}</form>;
}

/**
 * 채팅 회차에만 쓰이는 칸 묶음 — 공급자·실행 계정·요청 문장·작업 경로.
 *
 * 워크플로 회차 칸은 이미 `ScheduleWorkflowFields`로 떼어 두었는데 채팅 쪽만 편집기
 * 본문에 그대로 남아 있어, 두 실행 대상 중 한쪽만 이름을 갖고 있었다. 같은 자리에서
 * 갈라지는 두 갈래를 나란한 조각으로 맞춘다. 실행 설정(`RuntimeSettings`)은 이미 이름
 * 있는 조각이라 옮기지 않고 편집기에 그대로 둔다.
 */
function ScheduleChatTargetFields({ providers, projects, accounts, source, onSourceChange, managesAccounts, accountId, providerAccounts, activeAccountId, onAccountIdChange, prompt, onPromptChange, cwd, onCwdChange }: {
  providers: ProviderStatus[];
  projects: ProjectOption[];
  accounts: AccountSnapshot | null;
  source: ProviderId;
  onSourceChange: (source: ProviderId) => void;
  managesAccounts: boolean;
  accountId: string;
  providerAccounts: ProviderAccountView[];
  activeAccountId: string | null;
  onAccountIdChange: (accountId: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  cwd: string;
  onCwdChange: (cwd: string) => void;
}) {
  const { text } = useI18n();
  // 실행 시점 활성 계정이 지금 누구인지 미리 보여 준다. 표시 이름을 모르면 id라도 적는다.
  const activeAccountNow = activeAccountId ? accountById(accounts, activeAccountId)?.displayName ?? activeAccountId : null;
  // 활성 표시는 스냅숏이 짚은 활성 계정이거나 계정 자신이 활성이라고 말할 때 붙는다.
  // 두 갈래가 같은 글자를 내놓으므로 한 조건으로 묻는다.
  const activeSuffix = (account: ProviderAccountView) => account.id === activeAccountId || account.isActive ? ` · ${text("활성", "active")}` : "";
  return <><label><span>{text("공급자", "Provider")}</span><select value={source} onChange={(event) => onSourceChange(event.target.value as ProviderId)}>{providers.map((provider) => <option value={provider.provider} key={provider.provider}>{provider.displayName}</option>)}</select></label>{managesAccounts && <label><span>{text("실행 계정", "Run account")}</span><select value={accountId} onChange={(event) => onAccountIdChange(event.target.value)} required><option value="" disabled>{text("계정 선택", "Select an account")}</option><option value={ACTIVE_ACCOUNT_CHOICE}>{text("실행 시점 활성 계정", "Active account at execution time")}{activeAccountNow ? text(` · 지금은 ${activeAccountNow}`, ` · currently ${activeAccountNow}`) : ""}</option>{providerAccounts.map((account) => <option value={account.id} key={account.id}>{account.displayName}{activeSuffix(account)}</option>)}</select></label>}<label className="wide"><span>{text("반복할 요청", "Request to repeat")}</span><textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={4} required /></label><label className="wide"><span>{text("작업 경로", "Working path")}</span><input value={cwd} onChange={(event) => onCwdChange(event.target.value)} placeholder={text("/absolute/project/path (비우면 작업 경로 없음)", "/absolute/project/path (leave empty for no working path)")} list="schedule-projects" /><datalist id="schedule-projects">{projects.map((project) => <option value={project.path} key={project.path}>{project.name}</option>)}</datalist></label></>;
}

/**
 * 세션 방식 칸. 반복 주기 칸 뒤에 놓여야 해서 위 묶음과 떨어져 있지만 역시 채팅 회차
 * 전용이다. 재개 실패 처리는 대화를 이어갈 때만 물을 것이 있어 함께 접힌다.
 */
function ScheduleSessionStrategyFields({ strategy, onStrategyChange, failurePolicy, onFailurePolicyChange }: {
  strategy: ScheduledRequestInput["sessionStrategy"];
  onStrategyChange: (strategy: ScheduledRequestInput["sessionStrategy"]) => void;
  failurePolicy: ResumeFailurePolicy;
  onFailurePolicyChange: (policy: ResumeFailurePolicy) => void;
}) {
  return <><label><span>세션 방식</span><select value={strategy} onChange={(event) => onStrategyChange(event.target.value as "newChat" | "continue")}><option value="newChat">매번 새 채팅</option><option value="continue">동일 대화 이어가기</option></select></label>{strategy === "continue" && <label><span>재개 실패 시</span><select value={failurePolicy} onChange={(event) => onFailurePolicyChange(event.target.value as ResumeFailurePolicy)}><option value="pause">작업 일시정지</option><option value="newChat">즉시 새 대화</option><option value="retryThenNewChat">한 번 재시도 후 새 대화</option></select></label>}</>;
}

/** 두 실행 대상이 함께 채우는 봉투 — 주기·권한·활성 창·활성화. */
type ScheduleEnvelope = Pick<ScheduledRequestInput, "mode" | "approvalMode" | "recurrence" | "resumeFailurePolicy" | "enabled" | "activeFrom" | "activeUntil">;

/**
 * 폼 값에서 저장 입력을 만드는 두 갈래. 편집기의 제출 처리는 막을 이유를 보고, 확인을
 * 받고, 저장하는 순서만 남기고 어떤 칸이 어떤 값이 되는지는 여기서 정한다. 두 갈래가
 * 같은 함수 안에 이어 붙어 있으면 한쪽 칸을 고치다 다른 쪽 분기를 함께 읽어야 했다.
 *
 * 무엇을 막을지(워크플로 인자 검사, 활성 창 역전)는 옮기지 않았다. 막는 문장은 화면에
 * 그대로 뜨는 값이라 상태를 쥔 쪽에 둔다.
 */
function workflowScheduleInput(envelope: ScheduleEnvelope, draft: {
  name: string;
  source: ProviderId;
  workflow: SystemWorkflowSummary;
  schema: ReturnType<typeof workflowInputEntries>;
  inputs: Record<string, string>;
  saved: ScheduledRequest["workflow"] | null;
}): ScheduledRequestInput {
  return {
    ...envelope,
    name: draft.name.trim() || draft.workflow.displayName || draft.workflow.id,
    prompt: "",
    source: draft.source,
    accountId: "",
    useActiveAccount: false,
    cwd: "",
    model: null,
    reasoningEffort: null,
    sessionStrategy: "newChat",
    providerSessionId: null,
    sessionReference: null,
    // 지금 등록된 버전을 승인 버전으로 고정한다. 이후 워크플로가 바뀌면 백엔드가 그
    // 회차를 실행하지 않고 반복 요청을 멈춘다.
    // 병렬 실행 설정은 페이싱 탭의 회차 편집기가 소유한다. 여기서 다시 저장해도 지우지 않는다.
    workflow: {
      workflowId: draft.workflow.id,
      approvedVersion: draft.workflow.version ?? 0,
      arguments: buildWorkflowArguments(draft.schema, draft.inputs),
      pacing: draft.saved?.workflowId === draft.workflow.id ? draft.saved.pacing ?? null : null,
    },
  };
}

function chatScheduleInput(envelope: ScheduleEnvelope, draft: {
  name: string;
  prompt: string;
  source: ProviderId;
  accountId: string;
  cwd: string;
  model: string;
  localConnectionId: string;
  reasoningEffort: ReasoningEffort | "";
  strategy: ScheduledRequestInput["sessionStrategy"];
  currentSession: ChatSessionInfo | null;
  sessionPolicy: SessionReadPolicy;
  sessionOrigin: SessionReadOrigin;
  sessionRecommendation: SessionReadPolicy | null;
  savedProviderSessionId: string | null;
  hasSavedSessionReference: boolean;
}): ScheduledRequestInput {
  const useActiveAccount = draft.accountId === ACTIVE_ACCOUNT_CHOICE;
  return {
    ...envelope,
    name: draft.name.trim() || draft.prompt.trim().slice(0, 60),
    prompt: draft.prompt,
    source: draft.source,
    accountId: useActiveAccount ? "" : draft.accountId,
    useActiveAccount,
    cwd: draft.cwd,
    model: draft.model.trim() || null,
    localConnectionId: localConnectionIdForRequest(draft.source, draft.localConnectionId),
    reasoningEffort: draft.reasoningEffort || null,
    sessionStrategy: draft.strategy,
    providerSessionId: draft.strategy === "continue"
      ? draft.savedProviderSessionId ?? (draft.currentSession?.source === draft.source ? draft.currentSession.providerSessionId : null)
      : null,
    // 저장본에 세션 참조가 있었다면 꺼진 정책도 그대로 적어 둔다. 지워 버리면 다시 켤 때
    // AIA 권고와 범위가 함께 사라진다.
    sessionReference: draft.sessionPolicy.enabled || draft.hasSavedSessionReference
      ? { policy: clampSessionReadPolicy(draft.sessionPolicy), origin: draft.sessionOrigin, aiaRecommendation: draft.sessionRecommendation }
      : null,
    workflow: null,
  };
}

/** 전체 접근으로 저장하기 전 확인 문구. 무인 실행이라 사용자가 볼 확인은 이 한 번뿐이다. */
function fullAccessScheduleConfirm(input: ScheduledRequestInput, text: UiText) {
  return {
    title: text("전체 접근으로 반복 실행할까요?", "Run this on a schedule with full access?"),
    message: text(
      "이 반복 요청은 지정한 시각마다 사용자 확인 없이 실행됩니다.\n전체 접근은 작업 경로 밖의 파일과 명령에도 접근할 수 있습니다.",
      "This recurring request runs at every scheduled time without asking you.\nFull access can reach files and commands outside the working path.",
    ),
    items: [
      text(`반복 요청: ${input.name}`, `Recurring request: ${input.name}`),
      input.cwd.trim()
        ? text(`작업 경로: ${displayPath(input.cwd)}`, `Working path: ${displayPath(input.cwd)}`)
        : text("작업 경로: 없음 (앱의 기본 작업공간)", "Working path: none (the app's default workspace)"),
    ],
    warning: text("신뢰하는 요청과 작업 경로인지 확인한 뒤 저장하세요.", "Save only after confirming you trust this request and working path."),
    confirmLabel: text("전체 접근으로 저장", "Save with full access"),
    cancelLabel: "취소",
    tone: "danger" as const,
  };
}

/**
 * 워크플로 회차 칸 묶음. 목록·인자·승인 버전 안내는 워크플로를 고른 동안에만 쓰이는
 * 갈래라 편집기 본문에서 떼어 둔다. 저장본이 가리키던 워크플로가 목록에서 사라졌는지는
 * 목록과 저장본만 보면 알 수 있으므로 여기서 판단한다.
 */
function ScheduleWorkflowFields({ workflows, workflowId, savedWorkflow, selected, schema, inputs, onWorkflowIdChange, onInputChange }: {
  workflows: SystemWorkflowSummary[];
  workflowId: string;
  savedWorkflow: ScheduledRequest["workflow"] | null;
  selected: SystemWorkflowSummary | null;
  schema: ReturnType<typeof workflowInputEntries>;
  inputs: Record<string, string>;
  onWorkflowIdChange: (id: string) => void;
  onInputChange: (name: string, value: string) => void;
}) {
  const { text } = useI18n();
  const missing = Boolean(savedWorkflow) && !workflows.some((item) => item.id === savedWorkflow?.workflowId);
  return <><label className="wide"><span>실행할 워크플로</span><select value={workflowId} onChange={(event) => onWorkflowIdChange(event.target.value)} required><option value="" disabled>워크플로 선택</option>{missing && savedWorkflow && <option value={savedWorkflow.workflowId}>{savedWorkflow.workflowId} · 목록에 없음</option>}{workflows.map((item) => <option value={item.id} key={item.id}>{item.displayName ?? item.id}{item.version ? ` · v${item.version}` : ""}{item.compatible ? "" : " · 카탈로그 비호환"}</option>)}</select></label>{selected?.pacingEnabled && <p className="schedule-workflow-empty wide">{text(
    "페이싱이 켜진 워크플로입니다. 저장한 회차는 워크플로 화면의 워크플로 페이싱 탭에서 관리됩니다.",
    "This workflow has pacing on. Saved runs are managed from the Workflow pacing tab on the Workflows screen.",
  )}</p>}{schema.length > 0 && <div className="workflow-inputs wide">{schema.map(([fieldName, field]) => <WorkflowInputControl key={fieldName} name={fieldName} field={field} value={inputs[fieldName] ?? ""} onChange={(next) => onInputChange(fieldName, next)} />)}</div>}{selected && <div className="schedule-workflow-note wide"><p>{text(
    `지금 등록된 v${selected.version ?? "?"}을 승인 버전으로 고정합니다. 이후 워크플로가 바뀌면 그 회차를 실행하지 않고 반복 요청을 일시정지하니, 이 화면에서 다시 저장해 승인하세요.`,
    `Pins v${selected.version ?? "?"} as the approved version. If the workflow changes later, that run is skipped and the recurring request pauses — save again on this screen to approve it.`,
  )}</p><p>워크플로는 등록된 기본 작업만 호출합니다. 공급자 CLI를 띄우지 않아 실행 계정·작업 경로·권한 범위와 세션 참조는 쓰이지 않습니다.</p>{selected.hardToRecoverEffects?.length ? <div><strong>복구가 어려운 영향</strong><ul>{selected.hardToRecoverEffects.map((effect) => <li key={effect}>{effect}</li>)}</ul></div> : null}</div>}{workflows.length === 0 && <p className="schedule-workflow-empty wide">등록된 시스템 워크플로가 없습니다. 워크플로 화면에서 AIA가 먼저 등록해야 선택할 수 있습니다.</p>}</>;
}

/**
 * 접히는 고급 옵션 묶음 — 활성 창 두 칸과 세션 참조. 접힘 요약이 두 값을 함께 읽어야
 * 해서 한 덩어리로 두고, 편집기 본문에서는 떼어낸다. 활성 창 역전 문구는 저장을 막는
 * 쪽과 같은 문장이어야 하므로 만들지 않고 받아 쓴다.
 */
function ScheduleAdvancedSection({ open, onToggle, target, activeWindow, onFromChange, onUntilChange, sessionPolicy, sessionOrigin, sessionRecommendation, projects, onSessionPolicyChange }: {
  open: boolean;
  onToggle: () => void;
  target: "chat" | "workflow";
  activeWindow: { from: string; until: string; inverted: boolean; summary: string | null; invertedText: string };
  onFromChange: (value: string) => void;
  onUntilChange: (value: string) => void;
  sessionPolicy: SessionReadPolicy;
  sessionOrigin: SessionReadOrigin;
  sessionRecommendation: SessionReadPolicy | null;
  projects: ProjectOption[];
  onSessionPolicyChange: (policy: SessionReadPolicy) => void;
}) {
  const { text } = useI18n();
  return <section className="schedule-advanced"><button type="button" className="schedule-advanced-toggle" aria-expanded={open} onClick={() => onToggle()}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{text("고급 옵션", "Advanced options")}<small>{activeWindow.inverted ? text("활성 창 역전 · 종료가 시작보다 앞", "Active window inverted · end before start") : activeWindow.summary ? text(`활성 창 ${activeWindow.summary}`, `Active window ${activeWindow.summary}`) : text("활성 창 제한 없음", "No active window limit")}{target === "chat" ? (() => {
    const invertedSuffix = sessionPolicy.enabled && sessionReadPeriodInverted(sessionPolicy.period) ? text(" · 기간 역전 · 종료가 시작보다 앞", " · Period inverted · end before start") : "";
    return text(` · 세션 참조: ${describeSessionReadPolicy(sessionPolicy)}${invertedSuffix}`, ` · Session reference: ${describeSessionReadPolicy(sessionPolicy)}${invertedSuffix}`);
  })() : ""}</small></button>{open && <div className="schedule-advanced-window"><label><span>{text("활성 시작", "Active from")}</span><input type="datetime-local" value={activeWindow.from} onChange={(event) => onFromChange(event.target.value)} /></label><label><span>{text("활성 종료", "Active until")}</span><input type="datetime-local" value={activeWindow.until} aria-invalid={activeWindow.inverted || undefined} onChange={(event) => onUntilChange(event.target.value)} /></label>{activeWindow.inverted && <p className="schedule-window-invalid" role="alert" style={{ color: "var(--danger)" }}>{activeWindow.invertedText}</p>}<p>{text(
    "비우면 제한이 없습니다. 창 밖에서는 예약 실행이 나가지 않고, 종료가 지나도 반복 요청은 꺼지지 않아 종료를 미루면 그대로 다시 돕니다. 지금 실행은 창과 무관합니다.",
    "Leave both empty for no limit. Scheduled runs never fire outside the window, and passing the end does not turn the recurring request off — push the end back and it runs again. Run now ignores the window.",
  )}</p></div>}{open && target === "chat" && <SessionReadPolicyFields policy={sessionPolicy} origin={sessionOrigin} recommendation={sessionRecommendation} projects={projects} ownScopeLabel={text("이 일정의 작업 경로", "This schedule's working path")} onChange={onSessionPolicyChange} onReapplyRecommendation={sessionRecommendation ? () => onSessionPolicyChange(sessionRecommendation) : undefined} />}</section>;
}

