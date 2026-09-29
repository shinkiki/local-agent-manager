import { X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useI18n, type UiText } from "../lib/i18n";
import { createScheduledRequest, updateScheduledRequest } from "../lib/ipc";
import { describeQuietHours, WEEKDAY_NAMES } from "../lib/pacingSummary";
import {
  buildWorkflowArguments,
  validateScheduleWorkflowDraft,
  validateWorkflowModelInputs,
  workflowModelInputChoices,
  workflowModelInputIsMultiple,
  workflowInputDefaults,
  workflowInputEntries,
  workflowInputsFromArguments,
} from "../lib/scheduleWorkflow";
import type { ChatModelCatalogOption, ProviderId, QuietHours, ScheduleFrequency, ScheduledRequest, ScheduledRequestInput, SystemWorkflowSummary } from "../types";
import { ErrorBanner, WorkflowInputControl } from "./Shared";
import { errorText } from "../lib/errorText";
import { useProviderOptions } from "../lib/providerOptions";

/**
 * 페이싱 계약의 모델 입력이 고르게 할 공급자별 모델 목록. `workflowModelInputChoices`와
 * `validateWorkflowModelInputs`가 받는 그 한 벌이고, 아직 못 읽은 공급자는 빈 목록이다 —
 * 선택지와 저장 전 검사가 같은 목록을 봐야 "목록에 없는 값" 판정이 화면과 어긋나지 않는다.
 *
 * 회차 편집기와 워크플로 화면이 공급자 셋을 각자 한 줄씩 읽어 같은 모양의 객체를 손으로
 * 조립하고 있었다. 모델 입력을 받는 공급자가 하나 늘면 두 자리를 함께 고쳐야 하는데 한쪽만
 * 고치면 그 화면에서만 선택지가 비고, 저장 전 검사가 방금 고른 값을 "목록에 없는 값"으로
 * 막는다 — 읽어서는 갈라지지 않는 어긋남이라 조립을 한 자리로 모은다.
 */
export function useWorkflowModelCatalogs(): Partial<Record<ProviderId, readonly ChatModelCatalogOption[]>> {
  const claudeOptions = useProviderOptions("claude");
  const codexOptions = useProviderOptions("codex");
  const antigravityOptions = useProviderOptions("antigravity");
  const localOptions = useProviderOptions("local");
  return {
    claude: claudeOptions?.models ?? [],
    codex: codexOptions?.models ?? [],
    antigravity: antigravityOptions?.models ?? [],
    local: localOptions?.models ?? [],
  };
}

/** 병렬 실행을 켰을 때의 최소 건수. 1건은 "끔"이다. 상한은 없다 — 실제 동시 건수는 백엔드
 *  계획이 계정 여력·가드 창으로 자른다. */
const MIN_PARALLEL_RUNS = 2;
const normalizeParallelRuns = (value: number) => Math.max(MIN_PARALLEL_RUNS, Math.round(value) || MIN_PARALLEL_RUNS);

interface PacedRecurrenceDraft {
  frequency: ScheduleFrequency;
  interval: number;
  hour: number;
  minute: number;
  weekday: number;
  cron: string;
}

/**
 * 페이싱 회차에 맞는 반복 주기 입력을 정규화해 조립한다.
 * 간격 입력을 비웠거나(0) 자동 주기처럼 간격을 쓰지 않는 상태여도 저장이 막히지 않게 유효 범위로 눌러 보낸다.
 */
function buildPacedRecurrence({
  frequency,
  interval,
  hour,
  minute,
  weekday,
  cron,
  timezone,
}: PacedRecurrenceDraft & { timezone: string }) {
  return {
    frequency,
    interval: Math.min(168, Math.max(1, Math.round(interval) || 1)),
    hour,
    minute,
    weekday,
    cron: frequency === "cron" ? cron : null,
    timezone,
  };
}

/**
 * 편집기 상태와 기존 회차에서 저장 커맨드의 입력 한 벌을 조립한다. 생성·수정 갈래가 공유하는
 * 기본값 보존 규칙을 제출 절차에서 떼어, 검증과 IPC 호출 사이에는 조립 결과만 남긴다.
 */
function buildPacedTriggerInput({
  selected,
  schedule,
  name,
  inputs,
  paced,
  maxRuns,
  recurrence,
  enabled,
}: {
  selected: SystemWorkflowSummary;
  schedule?: ScheduledRequest;
  name: string;
  inputs: Record<string, string>;
  paced: boolean;
  maxRuns: number;
  recurrence: ReturnType<typeof buildPacedRecurrence>;
  enabled: boolean;
}): ScheduledRequestInput {
  return {
    name: name.trim() || selected.displayName || selected.id,
    prompt: "",
    source: schedule?.source ?? "claude",
    accountId: "",
    useActiveAccount: false,
    cwd: "",
    model: null,
    reasoningEffort: null,
    mode: schedule?.mode ?? "workspace",
    approvalMode: schedule?.approvalMode ?? "never",
    recurrence,
    sessionStrategy: "newChat",
    resumeFailurePolicy: schedule?.resumeFailurePolicy ?? "retryThenNewChat",
    providerSessionId: null,
    enabled,
    sessionReference: null,
    workflow: {
      workflowId: selected.id,
      approvedVersion: selected.version ?? 0,
      arguments: buildWorkflowArguments(workflowInputEntries(selected), inputs),
      pacing: paced ? { maxRuns } : null,
    },
    // 활성 창은 이 편집기에 없다. 반복 요청 편집기에서 정한 창을 다시 저장하며
    // 지우지 않도록 저장본 값을 그대로 돌려보낸다.
    activeFrom: schedule?.activeFrom ?? null,
    activeUntil: schedule?.activeUntil ?? null,
  };
}

type PacedTriggerDraft = ReturnType<typeof usePacedTriggerDraft>;

/**
 * 편집기가 드는 상태 한 벌과 저장 절차. 이 파일의 자매 구역(주기 보조 입력·병렬 실행)은
 * 이미 각자 컴포넌트인데 상태만 편집기 본문에 여덟 벌로 눌러앉아 있어, 무엇이 저장되는
 * 값이고 무엇이 화면 배치인지 본문을 끝까지 읽어야 갈라졌다. 같은 탭의 이웃들이 이미
 * `useCypressRegistry`·`useWorkflowCatalog`·`useProjectRegistryState`로 같은 모양을 쓰므로
 * 여기도 상태를 훅으로 내리고 컴포넌트에는 배치만 남긴다.
 *
 * 화면에서만 쓰이는 값(자동 주기 라벨·스케줄 요약)은 훅에 넣지 않았다 — 저장 본문에 실리지
 * 않고 그리기에만 쓰이는 값이라, 여기 두면 "훅이 든 것 = 저장되는 것"이 다시 흐려진다.
 */
function usePacedTriggerDraft({ workflows, schedule, initialWorkflowId, onSaved }: {
  workflows: SystemWorkflowSummary[];
  schedule?: ScheduledRequest;
  initialWorkflowId?: string;
  onSaved: () => void;
}) {
  const saved = schedule?.workflow ?? null;
  const [workflowId, setWorkflowId] = useState(saved?.workflowId ?? initialWorkflowId ?? workflows[0]?.id ?? "");
  const selected = workflows.find((item) => item.id === workflowId) ?? null;
  const schema = workflowInputEntries(selected);
  const [name, setName] = useState(schedule?.name ?? "");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  // 새 회차는 자동 주기(가드 창 간격)로 시작한다 — 페이싱 회차의 기본 의도다.
  const [recurrenceDraft, setRecurrenceDraft] = useState<PacedRecurrenceDraft>(() => ({
    frequency: schedule?.recurrence.frequency ?? "auto",
    interval: schedule?.recurrence.interval ?? 5,
    hour: schedule?.recurrence.hour ?? 9,
    minute: schedule?.recurrence.minute ?? 0,
    weekday: schedule?.recurrence.weekday ?? 1,
    cron: schedule?.recurrence.cron ?? "0 9 * * 1-5",
  }));
  const updateRecurrenceDraft = (patch: Partial<PacedRecurrenceDraft>) => {
    setRecurrenceDraft((current) => ({ ...current, ...patch }));
  };
  // 새 회차는 인자를 확인한 뒤 켜도록 꺼진 채로 시작한다.
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  // 병렬 실행: 한 회차에 동시에 띄울 건수. 계약 입력이 아니라 이 회차의 설정이다.
  const savedMaxRuns = saved?.pacing?.maxRuns ?? 1;
  const [parallel, setParallel] = useState(savedMaxRuns > 1);
  // 입력 중에는 문자열 그대로 들고 있는다. 숫자 상태로 두면 첫 자리를 지우는 순간 빈
  // 문자열이 0으로 바뀌어 화면에 남고, 이어 친 숫자가 그 뒤에 붙어 "020"이 된다.
  const [parallelRunsText, setParallelRunsText] = useState(String(Math.max(MIN_PARALLEL_RUNS, savedMaxRuns)));
  const parallelRuns = normalizeParallelRuns(Number(parallelRunsText));
  const paced = selected?.paced ?? selected?.pacingMode === "envelope";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezone = schedule?.recurrence.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const modelCatalogs = useWorkflowModelCatalogs();

  // 계약이 선언한 기본값을 먼저 깔고, 저장된 워크플로를 고른 동안만 저장 값을 덮는다.
  useEffect(() => {
    if (!selected) return;
    const entries = workflowInputEntries(selected);
    const defaults = workflowInputDefaults(entries);
    setInputs(selected.id === saved?.workflowId
      ? { ...defaults, ...workflowInputsFromArguments(entries, saved.arguments) }
      : defaults);
  }, [saved, selected]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problems = [
      ...validateScheduleWorkflowDraft({ workflow: selected, inputs }),
      ...validateWorkflowModelInputs(schema, inputs, modelCatalogs),
    ];
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    // 워크플로를 고르지 않았으면 위 검사가 이미 막는다. 그래도 한 줄로 좁혀 두는 것은
    // 타입 단언(`selected!`)을 지우기 위해서다 — 검사 목록이 바뀌어도 여기서 터지지 않는다.
    if (!selected) return;
    // 지금 등록된 버전을 승인 버전으로 고정한다. 이후 계약이 바뀌면 백엔드가 회차를
    // 멈추고, 이 편집기에서 다시 저장하는 것이 재승인이다.
    const input = buildPacedTriggerInput({
      selected,
      schedule,
      name,
      inputs,
      paced,
      maxRuns: parallel ? parallelRuns : 1,
      recurrence: buildPacedRecurrence({ ...recurrenceDraft, timezone }),
      enabled,
    });
    setSaving(true);
    setError(null);
    try {
      if (schedule) await updateScheduledRequest(schedule.id, input);
      else await createScheduledRequest(input);
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const changeInput = (fieldName: string, value: string) => {
    setInputs((current) => ({ ...current, [fieldName]: value }));
  };

  return {
    workflowId, setWorkflowId, selected, schema, name, setName, inputs, changeInput,
    recurrenceDraft, updateRecurrenceDraft, enabled, setEnabled,
    parallel, setParallel, parallelRunsText, setParallelRunsText, parallelRuns, paced,
    saving, error, timezone, modelCatalogs, submit,
  };
}

/**
 * 워크플로 페이싱 탭에서 페이싱 회차의 트리거(반복 요청)를 만들고 고치는 편집기.
 * 채팅 화면의 반복 요청 편집기에서 워크플로 회차에 실제로 쓰이는 것(이름·주기·인자·활성)만
 * 남긴 축소판이다 — 워크플로 회차는 공급자 채팅을 띄우지 않아 계정·경로·권한·세션 참조가
 * 실행에 쓰이지 않고, 저장 시점에 백엔드가 그 값들을 비운다. 상태는 `usePacedTriggerDraft`가
 * 들고 여기에는 배치만 있다.
 */
export function PacedTriggerEditor({ workflows, schedule, initialWorkflowId, guardWindowLabel = null, quietHours = null, embedded = false, onSaved, onCancel }: {
  /** 선택지로 보여줄 페이싱이 켜진 워크플로. 수정 모드에서는 저장된 워크플로가 고정된다. */
  workflows: SystemWorkflowSummary[];
  schedule?: ScheduledRequest;
  /** 생성 모드에서 미리 골라 둘 워크플로("회차 만들기" 행에서 온 경우). */
  initialWorkflowId?: string;
  /** 예산 정책의 "함께 지킬 창" 라벨. 자동 주기의 간격이 이 창의 길이다. */
  guardWindowLabel?: string | null;
  /** 예산 정책의 페이싱 스케줄. 켜져 있으면 자동 주기 설명에 제한 시간대를 덧붙인다. */
  quietHours?: QuietHours | null;
  /** 모달 안에 넣을 때. 제목과 닫기는 모달이 그리므로 편집기 자신의 머리줄을 숨긴다. */
  embedded?: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { text } = useI18n();
  const {
    workflowId, setWorkflowId, selected, schema, name, setName, inputs, changeInput,
    recurrenceDraft, updateRecurrenceDraft, enabled, setEnabled,
    parallel, setParallel, parallelRunsText, setParallelRunsText, parallelRuns, paced,
    saving, error, timezone, modelCatalogs, submit,
  }: PacedTriggerDraft = usePacedTriggerDraft({ workflows, schedule, initialWorkflowId, onSaved });
  const autoLabel = guardWindowLabel?.trim() || "5시간";
  const quietSummary = describeQuietHours(quietHours, text);

  return (
    <form className={`schedule-editor paced-trigger-editor${embedded ? " embedded" : ""}`} onSubmit={submit}>
      {!embedded && (
        <header>
          <div>
            <strong>{schedule ? text("페이싱 회차 수정", "Edit paced round") : text("새 페이싱 회차", "New paced round")}</strong>
            <span>{timezone}</span>
          </div>
          <button type="button" onClick={onCancel} aria-label={text("닫기", "Close")}><X size={16} /></button>
        </header>
      )}
      <div className="schedule-editor-grid">
        <label>
          <span>{text("이름", "Name")}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={text("비워두면 워크플로 이름 사용", "Defaults to the workflow name")} />
        </label>
        <label>
          <span>{text("실행할 워크플로", "Workflow")}</span>
          {schedule
            ? <input value={selected?.displayName ?? workflowId} disabled />
            : (
              <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} required>
                <option value="" disabled>{text("워크플로 선택", "Select a workflow")}</option>
                {workflows.map((item) => (
                  <option value={item.id} key={item.id}>
                    {workflowOptionLabel(item, text)}
                  </option>
                ))}
              </select>
            )}
        </label>
        <label>
          <span>{text("주기", "Cadence")}</span>
          <select
            value={recurrenceDraft.frequency}
            onChange={(event) => updateRecurrenceDraft({ frequency: event.target.value as ScheduleFrequency })}
          >
            <option value="auto">{text(`자동 · ${autoLabel} 창마다`, `Auto · every ${autoLabel} window`)}</option>
            <option value="hourly">{text("매 N시간", "Every N hours")}</option>
            <option value="daily">{text("매일", "Daily")}</option>
            <option value="weekdays">{text("평일", "Weekdays")}</option>
            <option value="weekly">{text("매주", "Weekly")}</option>
            <option value="cron">{text("고급 Cron", "Cron")}</option>
          </select>
        </label>
        <PacedCadenceFields
          draft={recurrenceDraft}
          autoLabel={autoLabel}
          quietSummary={quietSummary}
          onChange={updateRecurrenceDraft}
        />
        {paced && (
          <PacedParallelSection
            parallel={parallel}
            parallelRuns={parallelRuns}
            parallelRunsText={parallelRunsText}
            onParallelChange={setParallel}
            onRunsTextChange={setParallelRunsText}
            onRunsBlur={() => setParallelRunsText(String(parallelRuns))}
          />
        )}
        {schema.length > 0 && (
          <div className="workflow-inputs wide">
            {schema.map(([fieldName, field]) => (
              <WorkflowInputControl
                key={fieldName}
                name={fieldName}
                field={field}
                value={inputs[fieldName] ?? ""}
                onChange={(next) => changeInput(fieldName, next)}
                choices={workflowModelInputChoices(fieldName, modelCatalogs)}
                multiple={workflowModelInputIsMultiple(fieldName)}
              />
            ))}
          </div>
        )}
        {selected && (
          <div className="schedule-workflow-note wide">
            <p>
              {text(
                `지금 등록된 v${selected.version ?? "?"}을 승인 버전으로 고정합니다. 이후 워크플로가 바뀌면 회차가 멈추고, 여기서 다시 저장해 승인합니다. 창·목표·가드·계정은 이 화면의 사용량 예산이 정하고, 사용량 갱신·기동 수 계산·지난 회차 정리·기동은 회차마다 스케줄러가 계약 바깥에서 수행합니다.`,
                `Pins v${selected.version ?? "?"} as the approved version. If the workflow changes later the round pauses until you re-save here. Window, target, guard, and accounts come from the usage budget on this screen; usage refresh, run-count planning, stale-run cleanup, and launching wrap the contract on every round.`,
              )}
            </p>
          </div>
        )}
        <label className="check-filter">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> {text("저장 후 활성화", "Enable after saving")}
        </label>
      </div>
      {error && <ErrorBanner message={error} />}
      <footer>
        <button className="button" type="button" onClick={onCancel}>{text("취소", "Cancel")}</button>
        <button className="button primary" type="submit" disabled={saving || !workflowId}>
          {saving ? text("저장 중…", "Saving…") : text("저장", "Save")}
        </button>
      </footer>
    </form>
  );
}

/** 워크플로 선택 옵션의 라벨(이름, 버전, 카탈로그 호환성)을 조립한다. */
function workflowOptionLabel(item: SystemWorkflowSummary, text: UiText): string {
  const name = item.displayName ?? item.id;
  const version = item.version ? ` · v${item.version}` : "";
  const incompatible = item.compatible ? "" : text(" · 카탈로그 비호환", " · incompatible");
  return `${name}${version}${incompatible}`;
}

/** 실행 시각(시·분) 설정이 필요한 반복 주기인지 판별한다. */
const isTimeCadence = (frequency: ScheduleFrequency): boolean =>
  frequency === "daily" || frequency === "weekdays" || frequency === "weekly";

/** 자동 주기 안내 문구 및 페이싱 스케줄 제한 시간대 요약 */
function PacedAutoCadenceNote({ autoLabel, quietSummary }: { autoLabel: string; quietSummary: string | null }) {
  const { text } = useI18n();
  return (
    <div className="schedule-workflow-note">
      <p>{text(
        `공급자 사용량의 짧은 창(이 화면 고급 옵션의 "함께 지킬 창", 지금 ${autoLabel})마다 한 회차가 상한입니다. 참여 계정마다 남은 건수를 리셋까지 남은 시간에 고르게 편 소비 속도를 더해, 그 박자로는 목표 사용률에 못 닿으면 간격을 자동으로 좁힙니다. 같은 참여 계정 범위를 쓰며 지금 활성 창이 열린 회차끼리만 속도를 나누고, 간격은 최소 10분입니다. 이전 실행이 남아 있으면 그 수만큼 이번 회차 기동 자리를 빼 중복 기동을 막습니다.`,
        `At most one round per short usage window (the "guard window" in this screen's advanced options, currently ${autoLabel}). Each participating account's remaining runs are spread evenly over the time left until its reset; when that pace cannot reach the target, the interval shortens automatically. Only rounds with the same account scope and an open active window share the rate, with a minimum interval of 10 minutes. Runs still in progress consume this round's launch slots to prevent duplicate launches.`,
      )}{quietSummary && text(
        ` 페이싱 스케줄(${quietSummary})의 시간대는 남은 시간에서 빼고 세며, 그 시간대에 만기가 온 회차는 재개 시각에 돕니다.`,
        ` The pacing schedule (${quietSummary}) is excluded from the remaining time, and a round due inside it runs when the quiet hours end.`,
      )}</p>
    </div>
  );
}

/** 시간 단위 반복 간격(시간) 입력 필드 */
function PacedHourlyCadenceField({ interval, onChange }: { interval: number; onChange: (interval: number) => void }) {
  const { text } = useI18n();
  return (
    <label>
      <span>{text("간격(시간)", "Interval (h)")}</span>
      <input type="number" min={1} max={168} value={interval} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

/** 일/평일/주간 주기의 실행 시각(시:분) 입력 필드 */
function PacedTimeFields({
  hour,
  minute,
  onChange,
}: {
  hour: number;
  minute: number;
  onChange: (patch: { hour?: number; minute?: number }) => void;
}) {
  const { text } = useI18n();
  return (
    <label>
      <span>{text("실행 시각", "Time")}</span>
      <div className="time-fields">
        <input type="number" min={0} max={23} value={hour} onChange={(event) => onChange({ hour: Number(event.target.value) })} />
        <b>:</b>
        <input type="number" min={0} max={59} value={minute} onChange={(event) => onChange({ minute: Number(event.target.value) })} />
      </div>
    </label>
  );
}

/** 주간 반복 주기의 요일 선택 드롭다운 */
function PacedWeeklyCadenceField({ weekday, onChange }: { weekday: number; onChange: (weekday: number) => void }) {
  const { text } = useI18n();
  return (
    <label>
      <span>{text("요일", "Weekday")}</span>
      <select value={weekday} onChange={(event) => onChange(Number(event.target.value))}>
        {WEEKDAY_NAMES.map((label, index) => <option value={index} key={label}>{text(`${label}요일`, `Weekday ${index}`)}</option>)}
      </select>
    </label>
  );
}

/** Cron 표현식 입력 필드 */
function PacedCronCadenceField({ cron, onChange }: { cron: string; onChange: (cron: string) => void }) {
  const { text } = useI18n();
  return (
    <label className="wide">
      <span>{text("Cron · 분 시 일 월 요일", "Cron · min hour day month weekday")}</span>
      <input value={cron} onChange={(event) => onChange(event.target.value)} placeholder="0 9 * * 1-5" />
    </label>
  );
}

/** 주기에 따라 필요한 보조 입력(간격, 실행 시각, 요일, cron 표현식, 자동 주기 안내) 영역 */
function PacedCadenceFields({
  draft,
  autoLabel,
  quietSummary,
  onChange,
}: {
  draft: PacedRecurrenceDraft;
  autoLabel: string;
  quietSummary: string | null;
  onChange: (patch: Partial<PacedRecurrenceDraft>) => void;
}) {
  const { frequency, interval, hour, minute, weekday, cron } = draft;

  return (
    <>
      {frequency === "auto" && <PacedAutoCadenceNote autoLabel={autoLabel} quietSummary={quietSummary} />}
      {frequency === "hourly" && <PacedHourlyCadenceField interval={interval} onChange={(next) => onChange({ interval: next })} />}
      {isTimeCadence(frequency) && (
        <PacedTimeFields
          hour={hour}
          minute={minute}
          onChange={(patch) => onChange(patch)}
        />
      )}
      {frequency === "weekly" && <PacedWeeklyCadenceField weekday={weekday} onChange={(next) => onChange({ weekday: next })} />}
      {frequency === "cron" && <PacedCronCadenceField cron={cron} onChange={(next) => onChange({ cron: next })} />}
    </>
  );
}

/** 페이싱 워크플로의 병렬 실행 여부 및 동시 기동 건수 설정 영역 */
function PacedParallelSection({
  parallel,
  parallelRuns,
  parallelRunsText,
  onParallelChange,
  onRunsTextChange,
  onRunsBlur,
}: {
  parallel: boolean;
  parallelRuns: number;
  parallelRunsText: string;
  onParallelChange: (checked: boolean) => void;
  onRunsTextChange: (value: string) => void;
  onRunsBlur: () => void;
}) {
  const { text } = useI18n();

  return (
    <div className="wide paced-parallel">
      <label className="check-filter">
        <input type="checkbox" checked={parallel} onChange={(event) => onParallelChange(event.target.checked)} />
        {" "}{text("병렬 실행", "Parallel runs")}
      </label>
      {parallel && (
        <label>
          <span>{text("동시 기동 건수", "Runs per round")}</span>
          <input
            type="number"
            min={MIN_PARALLEL_RUNS}
            value={parallelRunsText}
            onChange={(event) => onRunsTextChange(event.target.value)}
            onBlur={onRunsBlur}
          />
        </label>
      )}
      <p className="schedule-workflow-note">
        {text(
          parallel
            ? `한 회차에 최대 ${parallelRuns}건을 동시에 띄웁니다. 실제 건수는 예산이 계정별 밀린 몫으로 정하고, 지난 회차 실행이 아직 돌고 있으면 그만큼 줄어듭니다. 같은 워크트리를 여러 런타임이 만지는 작업이면 끄세요. 상한은 없지만 호스트 CPU·메모리는 확인하지 않으니 이 기기가 감당할 만큼만 두세요.`
            : "회차마다 한 건만 띄웁니다. 지난 회차 실행이 아직 돌고 있으면 이번 회차는 비웁니다.",
          parallel
            ? `Launches up to ${parallelRuns} runs per round. The actual count comes from each account's share of the budget, minus runs from the previous round that are still running. Turn this off when runs share one worktree. There is no upper bound, and host CPU/memory is not checked — keep it within what this machine can run.`
            : "One run per round. If the previous round's run is still active, this round launches nothing.",
        )}
      </p>
    </div>
  );
}
