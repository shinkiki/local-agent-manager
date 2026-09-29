import { RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { displayPath } from "../lib/displayPath";
import { useI18n, type UiText } from "../lib/i18n";
import type {
  ProjectOption,
  ProviderId,
  SessionManagementStatus,
  SessionReadDetail,
  SessionReadOrigin,
  SessionReadPeriod,
  SessionReadPolicy,
  SessionReadRedaction,
} from "../types";
import {
  describeSessionReadPolicy,
  SESSION_READ_LIMITS,
  SESSION_READ_PERIOD_CHOICES,
  SESSION_READ_PERIOD_INVERTED_TEXT,
  sessionReadDetailLabel,
  sessionReadOriginLabel,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
  sessionReadPeriodInverted,
  sessionReadRecentDaysField,
  sessionReadProviderLabel,
  sessionStatusLabel,
} from "../lib/sessionReadPolicy";

const PROVIDERS: ProviderId[] = ["codex", "claude", "antigravity"];

/** 상태 필터로 실제 쓸 만한 값만 고른다. 나머지는 비워 둔 전체 상태로 덮인다. */
const STATUSES: SessionManagementStatus[] = [
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "running",
  "archived",
];


/** 상세 수준별 안내문. 문구는 화면이 그릴 때 언어가 정해지므로 `text`를 받아 만든다. */
function detailHint(detail: SessionReadDetail, text: UiText): string {
  const hints: Record<SessionReadDetail, string> = {
    summary: text("세션 요약 항목만 읽습니다.", "Reads only the session summary fields."),
    workRationale: text(
      "요약과 수행 작업·검증 결과·미완료 항목까지 읽고, 요청 원문과 추론은 제외합니다.",
      "Reads the summary plus work done, verification results, and open items, excluding request text and reasoning.",
    ),
    limitedTranscript: text(
      "분류 제한 없이 읽되 아래 출력 예산 안에서만 읽습니다.",
      "Reads without category limits, but only within the output budget below.",
    ),
  };
  return hints[detail];
}

const DETAIL_CHOICES: PolicyChoice<SessionReadDetail>[] = (
  ["summary", "workRationale", "limitedTranscript"] as const
).map((detail) => ({ value: detail, label: sessionReadDetailLabel(detail) }));

function redactionChoices(text: UiText): PolicyChoice<SessionReadRedaction>[] {
  return [
    {
      value: "credentials",
      label: text("기본 · 토큰·키·쿠키 제거", "Standard · removes tokens, keys, and cookies"),
    },
    {
      value: "strict",
      label: text("강력 · 이메일·홈 경로까지 가림", "Strict · also masks emails and home paths"),
    },
  ];
}

/** 정책에서 상한이 걸린 숫자 속성. 이름이 그대로 `SESSION_READ_LIMITS`의 키이기도 하다. */
type SessionReadCountKey = "maxSessions" | "maxTurnsPerSession" | "pageSize";

/**
 * 한 번 읽기가 가져올 양을 정하는 숫자 칸 세 개. 셋은 정책 속성 이름·상한 이름·화면
 * 라벨이 나란히 붙는 같은 모양인데, 칸마다 그 셋을 손으로 적고 있었다. 이름 하나만
 * 어긋나도(예: 페이지 크기 칸에 최대 세션 수의 상한) 타입은 그대로 통과하고 화면만
 * 조용히 다른 상한을 강제한다. 짝은 여기 한 줄로 묶어 두고, 칸은 이 표에서 뽑는다.
 */
function sessionReadCountFields(text: UiText): { key: SessionReadCountKey; label: string }[] {
  return [
    { key: "maxSessions", label: text("최대 세션 수", "Max sessions") },
    { key: "maxTurnsPerSession", label: text("세션당 최대 턴", "Max turns per session") },
    { key: "pageSize", label: text("페이지 크기", "Page size") },
  ];
}

/**
 * 반복 요청 편집기와 채팅 입력창이 함께 쓰는 세션 참조 범위 편집기. 값 검증과 상한은
 * 서버가 다시 강제하고, 여기서는 같은 규칙으로 미리 보여 주는 일만 한다.
 */
export function SessionReadPolicyFields({
  policy,
  origin,
  recommendation,
  projects,
  ownScopeLabel,
  disabled,
  onChange,
  onReapplyRecommendation,
}: {
  policy: SessionReadPolicy;
  origin: SessionReadOrigin;
  recommendation: SessionReadPolicy | null;
  projects: ProjectOption[];
  /** `일정 작업 경로` 자리에 쓸 이름. 채팅에서는 `이 대화 작업 경로`가 된다. */
  ownScopeLabel: string;
  disabled?: boolean;
  onChange: (next: SessionReadPolicy) => void;
  onReapplyRecommendation?: () => void;
}) {
  const { text } = useI18n();
  const patch = (next: Partial<SessionReadPolicy>) => onChange({ ...policy, ...next });
  // 표에서 뽑은 칸은 고칠 속성 이름을 값으로 들고 온다. 그 이름이 정책의 숫자 속성
  // 하나임은 `SessionReadCountKey`가 보증하므로, 고르는 자리는 여기 한 줄이면 된다.
  const patchCount = (key: SessionReadCountKey, value: number) => patch({ [key]: value });
  const toggleProvider = (provider: ProviderId) =>
    patch({ providers: toggleItem(policy.providers, provider) });
  const toggleStatus = (status: SessionManagementStatus) =>
    patch({ statuses: toggleItem(policy.statuses, status) });
  const toggleProject = (path: string) =>
    patch({ projects: toggleItem(policy.projects, path) });
  const canReapply = Boolean(
    recommendation && onReapplyRecommendation && origin === "manual",
  );
  return (
    <div className="session-read-fields">
      <PolicyCheckboxField
        label={text("타 에이전트 세션 참조 사용", "Reference other agent sessions")}
        checked={policy.enabled}
        disabled={disabled}
        onChange={(enabled) => patch({ enabled })}
      />
      <p className="session-read-summary" aria-live="polite">
        <span className={`session-read-origin ${origin}`}>{sessionReadOriginLabel(origin)}</span>
        {/* 요약 한 줄은 Rust `describe_policy`와 규칙을 맞춰 두었으므로 역전은 거기에
            섞지 않고 뒤에 따로 붙인다 — 양쪽 테스트가 같은 표본으로 그 문구를 검증한다. */}
        <strong>{text("세션 참조", "Session reference")}: {describeSessionReadPolicy(policy)}{policy.enabled && sessionReadPeriodInverted(policy.period) ? ` · ${text("기간 역전", "inverted period")}` : ""}</strong>
        {canReapply && (
          <button type="button" className="button subtle" disabled={disabled} onClick={onReapplyRecommendation}>
            <RotateCcw size={12} />
            {text("AIA 추천값 다시 적용", "Reapply AIA recommendation")}
          </button>
        )}
      </p>
      {!policy.enabled ? (
        <small className="session-read-hint">
          {text(
            "켜면 이 요청이 볼 수 있는 다른 에이전트 세션의 범위를 여기서 확정합니다. 실행 중에는 이 범위를 넓힐 수 없고, 읽기 전용·짧은 만료·감사 기록·인증정보 제거는 해제할 수 없습니다.",
            "Turn this on to fix here the range of other agent sessions this request may see. The range cannot be widened while running, and read-only access, short expiry, audit logging, and credential removal cannot be disabled.",
          )}
        </small>
      ) : (
        <div className="session-read-grid">
          <PolicySelectField
            label={text("프로젝트 범위", "Project scope")}
            value={policy.projectScope}
            options={[
              { value: "scheduleCwd", label: ownScopeLabel },
              { value: "selected", label: text("선택한 등록 프로젝트", "Selected registered projects") },
              { value: "allRegistered", label: text("전체 등록 프로젝트", "All registered projects") },
            ]}
            disabled={disabled}
            onChange={(projectScope) => patch({ projectScope })}
          />
          {policy.projectScope === "selected" && (
            <SelectedProjectsField
              projects={projects}
              selectedProjects={policy.projects}
              disabled={disabled}
              onSelectAll={() => patch({ projects: projects.map((project) => project.path) })}
              onClear={() => patch({ projects: [] })}
              onToggleProject={toggleProject}
            />
          )}
          <PolicyChipGroup
            legend={text("공급자", "Providers")}
            options={PROVIDERS}
            selected={policy.providers}
            disabled={disabled}
            labelFor={sessionReadProviderLabel}
            hint={text("비워 두면 전체 공급자입니다.", "Leave empty to include every provider.")}
            onToggle={toggleProvider}
          />
          <PolicyPeriodFields
            period={policy.period}
            disabled={disabled}
            onChange={(period) => patch({ period })}
          />
          <PolicyChipGroup
            legend={text("세션 상태", "Session status")}
            options={STATUSES}
            selected={policy.statuses}
            disabled={disabled}
            labelFor={sessionStatusLabel}
            hint={text("비워 두면 전체 상태입니다.", "Leave empty to include every status.")}
            onToggle={toggleStatus}
          />
          <PolicySelectField
            label={text("상세 수준", "Detail level")}
            value={policy.detail}
            options={DETAIL_CHOICES}
            disabled={disabled}
            hint={detailHint(policy.detail, text)}
            onChange={(detail) => patch({ detail })}
          />
          {sessionReadCountFields(text).map(({ key, label }) => (
            <PolicyNumberField
              key={key}
              label={label}
              value={policy[key]}
              limit={key}
              disabled={disabled}
              onChange={(value) => patchCount(key, value)}
            />
          ))}
          <PolicySelectField
            label={text("민감정보 제거", "Sensitive data removal")}
            value={policy.redaction}
            options={redactionChoices(text)}
            disabled={disabled}
            onChange={(redaction) => patch({ redaction })}
          />
          <PolicyCheckboxField
            label={text("세션이 참조한 연결 파일도 읽기 허용", "Also allow reading files linked by the session")}
            checked={policy.includeLinkedFiles}
            disabled={disabled}
            onChange={(includeLinkedFiles) => patch({ includeLinkedFiles })}
          />
        </div>
      )}
    </div>
  );
}

/** 배열에 항목이 있으면 제거하고 없으면 추가하는 순수 토글 헬퍼 */
function toggleItem<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((current) => current !== item) : [...list, item];
}

/** 정책의 독립적인 참·거짓 값을 고르는 넓은 체크박스 필드 */
function PolicyCheckboxField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check-filter wide">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />{" "}
      {label}
    </label>
  );
}

/**
 * 정책 상한값 등 양의 정수를 받는 숫자 입력 필드. 상한은 숫자가 아니라 이름으로 받아
 * 여기서 읽는다 — 칸마다 `SESSION_READ_LIMITS`를 풀어 넘기면 다른 칸의 상한을 집어 줘도
 * 타입이 통과하고, 저장 시점에야 서버가 거절한다.
 */
function PolicyNumberField({
  label,
  value,
  limit,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  limit: keyof typeof SESSION_READ_LIMITS;
  disabled?: boolean;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={1}
        max={SESSION_READ_LIMITS[limit]}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <small className="session-read-hint">{hint}</small>}
    </label>
  );
}

/** 고른 값 하나를 돌려주는 선택 목록의 한 항목 */
interface PolicyChoice<T extends string> {
  value: T;
  label: string;
}

/**
 * 정책 값 하나를 고르는 선택 목록. 라벨·`<select>`·안내문을 손으로 되풀이하면 필드마다
 * 형태가 조금씩 갈리므로, 값 종류만 제네릭으로 받아 한 벌로 그린다.
 */
function PolicySelectField<T extends string>({
  label,
  value,
  options,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly PolicyChoice<T>[];
  disabled?: boolean;
  hint?: string;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <small className="session-read-hint">{hint}</small>}
    </label>
  );
}

/** 체크박스 목록으로 구성된 필터 칩 묶음 */
function PolicyChipGroup<T extends string>({
  legend,
  options,
  selected,
  disabled,
  labelFor,
  hint,
  onToggle,
}: {
  legend: string;
  options: readonly T[];
  selected: readonly T[];
  disabled?: boolean;
  labelFor: (item: T) => string;
  hint: string;
  onToggle: (item: T) => void;
}) {
  return (
    <fieldset className="session-read-chips">
      <legend>{legend}</legend>
      {options.map((item) => (
        <label className="check-filter" key={item}>
          <input
            type="checkbox"
            checked={selected.includes(item)}
            disabled={disabled}
            onChange={() => onToggle(item)}
          />{" "}
          {labelFor(item)}
        </label>
      ))}
      <small>{hint}</small>
    </fieldset>
  );
}

/** `type=date` 입력값 변환. 날짜만 다루므로 로컬 자정 기준으로 왕복한다. */
function dateInputValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 로컬 날짜 문자열(YYYY-MM-DD)을 해당 일자의 시작(00:00:00) 또는 끝(23:59:59.999) 시각(ms)으로 변환 */
function dayBoundaryMs(value: string, boundary: "start" | "end"): number {
  if (!value) return 0;
  const [year, month, day] = value.split("-").map(Number);
  const [hour, minute, second, ms] = boundary === "start" ? [0, 0, 0, 0] : [23, 59, 59, 999];
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}

/** 등록 프로젝트 선택 필드셋 */
function SelectedProjectsField({
  projects,
  selectedProjects,
  disabled,
  onSelectAll,
  onClear,
  onToggleProject,
}: {
  projects: ProjectOption[];
  selectedProjects: readonly string[];
  disabled?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onToggleProject: (path: string) => void;
}) {
  const { text } = useI18n();
  const [projectQuery, setProjectQuery] = useState("");
  const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase();
  const selectedProjectPaths = useMemo(() => new Set(selectedProjects), [selectedProjects]);
  const visibleProjects = useMemo(() => {
    if (!normalizedProjectQuery) return projects;
    return projects.filter((project) =>
      `${project.name}\n${project.path}`.toLocaleLowerCase().includes(normalizedProjectQuery),
    );
  }, [normalizedProjectQuery, projects]);
  const selectedProjectCount = projects.filter((project) => selectedProjectPaths.has(project.path)).length;

  return (
    <fieldset className="session-read-projects wide">
      <legend>{text("등록 프로젝트 선택", "Select registered projects")}</legend>
      {projects.length === 0 ? (
        <small>{text(
          "Agent Manager가 확인한 등록 프로젝트가 없습니다.",
          "Agent Manager found no registered projects.",
        )}</small>
      ) : (
        <>
          <div className="session-read-project-toolbar">
            <strong>{text(`${selectedProjectCount}개 선택`, `${selectedProjectCount} selected`)}</strong>
            <div>
              <button
                type="button"
                className="button"
                disabled={disabled || selectedProjectCount === projects.length}
                onClick={onSelectAll}
              >
                {text("모두 선택", "Select all")}
              </button>
              <button
                type="button"
                className="button"
                disabled={disabled || selectedProjects.length === 0}
                onClick={onClear}
              >
                {text("선택 해제", "Clear selection")}
              </button>
            </div>
          </div>
          <label className="session-read-project-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={projectQuery}
              disabled={disabled}
              onChange={(event) => setProjectQuery(event.target.value)}
              placeholder={text("프로젝트 이름·경로 검색", "Search project name or path")}
              aria-label={text("등록 프로젝트 검색", "Search registered projects")}
            />
          </label>
          {visibleProjects.length === 0 ? (
            <p className="session-read-project-empty">{text("검색 결과가 없습니다.", "No matching projects.")}</p>
          ) : (
            <div className="session-read-project-list">
              {visibleProjects.map((project) => {
                const selected = selectedProjectPaths.has(project.path);
                return (
                  <label
                    className={`session-read-project-option${selected ? " selected" : ""}`}
                    key={project.path}
                    title={displayPath(project.path)}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={disabled}
                      onChange={() => onToggleProject(project.path)}
                    />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{displayPath(project.path)}</small>
                    </span>
                    <em>{text(`세션 ${project.count}개`, `${project.count} session(s)`)}</em>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}
      <small>
        {text(
          "등록 프로젝트만 고를 수 있습니다. 목록에 없는 경로는 저장 시점과 실행 시점 모두 거부됩니다.",
          "Only registered projects can be chosen. Paths outside this list are rejected both when saving and when running.",
        )}
      </small>
    </fieldset>
  );
}

/**
 * 세션 참조 기간 설정 필드 묶음.
 * 기간 유형 선택(전체·최근 N일·직접 범위)과 선택된 유형에 따른 부속 입력(최근 일수 숫자 입력, 직접 범위 시작·종료일)을
 * 전용 컴포넌트로 묶어 상위 정책 편집기의 상태 관리와 렌더링 분기를 일원화한다.
 */
function PolicyPeriodFields({
  period,
  disabled,
  onChange,
}: {
  period: SessionReadPeriod;
  disabled?: boolean;
  onChange: (period: SessionReadPeriod) => void;
}) {
  const { text } = useI18n();
  const periodChoice = sessionReadPeriodChoice(period);
  // 곁들인 숫자 칸을 세울지는 선택지가 정한다. 기간 종류로 가르면 표에 없는 상대 기간
  // (`{relative, week, 3}`)이 "최근 N일"로 접힌 채 숫자 칸 없이 떠, 저장된 값을 보지도
  // 고치지도 못한다.
  const recentDays = sessionReadRecentDaysField(period);
  const patchAbsoluteRange = (key: "from" | "to", dateString: string) => {
    const range = period.kind === "absoluteRange"
      ? period
      : { kind: "absoluteRange" as const, from: 0, to: 0 };
    onChange({
      ...range,
      [key]: dayBoundaryMs(dateString, key === "from" ? "start" : "end"),
    });
  };

  return (
    <>
      <PolicySelectField
        label={text("기간", "Period")}
        value={periodChoice}
        options={SESSION_READ_PERIOD_CHOICES}
        disabled={disabled}
        onChange={(choice) => onChange(sessionReadPeriodFromChoice(choice, period))}
      />
      {recentDays !== null && (
        <PolicyNumberField
          label={text("최근 N일", "Last N days")}
          value={recentDays.days}
          limit="recentDays"
          disabled={disabled}
          // 접힌 값이 저장 상한에 걸리면 칸은 저장된 기간보다 짧게 선다. 칸만 보고 나가면
          // 실제로 집행되는 참조 창의 절반만 본 것이 되므로, 잘렸다는 사실을 칸 옆에 적는다.
          hint={recentDays.foldedFromDays === recentDays.days ? undefined : text(
            `저장된 기간은 약 ${recentDays.foldedFromDays}일입니다. 최근 N일은 ${SESSION_READ_LIMITS.recentDays}일까지만 저장할 수 있어 이 칸만 ${recentDays.days}일로 줄여 섰습니다. 고치지 않으면 저장된 기간이 그대로 쓰입니다.`,
            `The stored period is about ${recentDays.foldedFromDays} days. Last N days stores at most ${SESSION_READ_LIMITS.recentDays}, so this field alone shows ${recentDays.days}. Leave it untouched and the stored period stays in effect.`,
          )}
          onChange={(days) => onChange({ kind: "recentDays", days })}
        />
      )}
      {period.kind === "absoluteRange" && (
        <PolicyAbsoluteRangeField
          from={period.from}
          to={period.to}
          inverted={sessionReadPeriodInverted(period)}
          disabled={disabled}
          onChange={patchAbsoluteRange}
        />
      )}
    </>
  );
}

/**
 * 직접 날짜 범위를 입력하는 필드.
 *
 * 시작이 끝보다 늦은 값은 서버가 저장 시점에 거절한다. 그 사실을 저장 버튼을 눌러서야
 * 알면 늦고, 오류는 폼 맨 아래 배너로 떠 고급 옵션을 접은 사용자는 어느 칸이 문제인지
 * 모른다. 같은 편집기의 활성 창 역전(QA #49)과 같은 모양으로 칸 옆에서 알린다(QA #79).
 */
function PolicyAbsoluteRangeField({
  from,
  to,
  inverted,
  disabled,
  onChange,
}: {
  from: number;
  to: number;
  inverted: boolean;
  disabled?: boolean;
  onChange: (key: "from" | "to", dateString: string) => void;
}) {
  const { text } = useI18n();
  return (
    <label className="wide">
      <span>{text("직접 범위", "Custom range")}</span>
      <div className="session-read-range">
        <input
          type="date"
          value={dateInputValue(from)}
          disabled={disabled}
          onChange={(event) => onChange("from", event.target.value)}
        />
        <b>~</b>
        <input
          type="date"
          value={dateInputValue(to)}
          aria-invalid={inverted || undefined}
          disabled={disabled}
          onChange={(event) => onChange("to", event.target.value)}
        />
      </div>
      {inverted && (
        <p className="session-read-range-invalid" role="alert" style={{ color: "var(--danger)" }}>
          {SESSION_READ_PERIOD_INVERTED_TEXT}
        </p>
      )}
    </label>
  );
}
