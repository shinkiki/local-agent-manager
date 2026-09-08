import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useEscapeToClose } from "./Shared";
import { useI18n } from "../lib/i18n";
import type {
  ChatApprovalMode,
  ChatMode,
  ChatModelCatalogOption,
  ChatReasoningOption,
  ModelOption,
  ProviderId,
  ReasoningEffort,
} from "../types";
import type { LaunchAccountChoice } from "../lib/launchAccount";
import {
  fallbackSettingFields,
  reasoningLabel,
  settingOptionLabel,
  settingOptions,
  type ChatSettingField,
} from "../lib/chatSettings";

/**
 * 실행 중 채팅에서 고를 수 있는 에이전트(공급자) 하나.
 *
 * 에이전트를 바꾸면 공급자가 달라져 세션 ID를 공유할 수 없으므로 재개가 아니라 새
 * 세션 인계가 된다. 그래서 다른 항목과 달리 선택 즉시 "새 세션"이라고 말해야 한다.
 */
export interface ChatAgentChoice {
  source: ProviderId;
  label: string;
  disabled: boolean;
  disabledReason: string | null;
}

interface ChatRuntimeSettingsMenuProps {
  panelId: string;
  contextLabel: string;
  source: ProviderId;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  modelOptions: ChatModelCatalogOption[];
  recentModels?: ModelOption[];
  reasoningEffort: ReasoningEffort | "";
  reasoningOptions: ChatReasoningOption[];
  settingFields?: ChatSettingField[];
  extraSettings?: Record<string, string>;
  /** 고를 수 있는 에이전트. 비어 있으면 항목을 그리지 않는다(시작 화면·AIA 등). */
  agentChoices?: ChatAgentChoice[];
  /** 고를 수 있는 실행 계정. 빈 선택("")은 이어가기 정책이 정하는 계정이다. */
  accountChoices?: LaunchAccountChoice[];
  /** 지금 실행 중인 계정. 모르면 null이고, 그때 계정 선택은 빈 값으로 둔다. */
  accountId?: string | null;
  locked: boolean;
  /**
   * 계획 승인 중에도 바꿀 수 있는 항목만 따로 잠그는 값. 주지 않으면 `locked`를 따른다.
   *
   * 에이전트·실행 계정·요청 모드는 실행 중에도 바꿀 수 있는 자리가 하나 더 있다 — 계획
   * 승인이다. 계획은 아직 아무것도 실행하지 않은 상태라 접고 다시 띄워도 잃을 작업이
   * 없어서, 응답 중이라는 이유로 함께 잠그면 정작 바꿀 수 있는 유일한 순간을 막게 된다.
   * 이 항목을 바꾼 호출부는 기다리는 승인을 취소로 닫고 계획을 새 실행에 넘긴다.
   */
  planRestartLocked?: boolean;
  /** 지금 바꾸면 실행을 접고 다시 띄운다는 안내. 계획 승인 중에만 채워 보낸다. */
  planRestartNote?: string;
  statusIndicator?: ReactNode;
  contextMeter?: ReactNode;
  statusLabel?: ReactNode;
  onOpen?: () => void;
  onModeChange: (mode: ChatMode) => void;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  /** 에이전트 변경. 새 세션 인계가 되므로 호출부가 그 사실을 사용자에게 확인한다. */
  onAgentChange?: (source: ProviderId) => void;
  onAccountChange?: (accountId: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | "") => void;
  onExtraSettingsApply?: (settings: Record<string, string>) => void;
}

const BUILTIN_SETTING_KEYS = new Set(["mode", "approvalMode", "model", "reasoningEffort"]);
const EMPTY_SETTINGS: Record<string, string> = {};

export function ChatRuntimeSettingsMenu({
  panelId,
  contextLabel,
  source,
  mode,
  approvalMode,
  model,
  modelOptions,
  recentModels,
  reasoningEffort,
  reasoningOptions,
  settingFields,
  extraSettings,
  agentChoices,
  accountChoices,
  accountId,
  locked,
  planRestartLocked,
  planRestartNote,
  statusIndicator,
  contextMeter,
  statusLabel,
  onOpen,
  onModeChange,
  onApprovalModeChange,
  onAgentChange,
  onAccountChange,
  onModelChange,
  onReasoningEffortChange,
  onExtraSettingsApply,
}: ChatRuntimeSettingsMenuProps) {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEscapeToClose(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  const fields = settingFields?.length ? settingFields : fallbackSettingFields(source);
  const runtimeExtraSettings = extraSettings ?? EMPTY_SETTINGS;
  const extraFields = onExtraSettingsApply
    ? fields.filter((field) => !BUILTIN_SETTING_KEYS.has(field.key))
    : [];
  const [draftExtraSettings, setDraftExtraSettings] = useState<Record<string, string>>(runtimeExtraSettings);
  useEffect(() => {
    setDraftExtraSettings(runtimeExtraSettings);
  }, [runtimeExtraSettings, source]);
  // 모델·예비 모델 select 선택지: 카탈로그 모델에 최근 세션에서 쓴 모델을 보탠다.
  // Claude처럼 CLI가 모델 목록을 내보내지 않는 공급자는 최근 사용 모델이 유일한
  // 선택지이므로, 이를 보태지 않으면 실행 중 채팅에서 모델을 바꿀 수 없다.
  const modelChoices = (() => {
    const map = new Map<string, ChatModelCatalogOption>();
    for (const option of modelOptions) map.set(option.model, option);
    for (const item of recentModels ?? []) {
      if (!map.has(item.model)) map.set(item.model, { model: item.model, displayName: item.model, description: "", isDefault: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] });
    }
    return [...map.values()];
  })();
  const modelLabel = modelChoices.find((option) => option.model === model)?.displayName
    || model
    || text("공급자 기본", "Provider default");
  // 승인 처리를 CLI로 전달할 통로가 없는 공급자는 스키마에서 항목 자체가 빠진다.
  // 고를 것이 없는 선택 박스와 요약 칩을 남기지 않고, 승인 요청은 없는 것으로 본다.
  const agents = agentChoices ?? [];
  const accounts = accountChoices ?? [];
  const planRestartDisabled = planRestartLocked ?? locked;
  const approvalOptions = settingOptions(fields, "approvalMode");
  const hasApprovalField = approvalOptions.length > 0;
  const effectiveApprovalMode: ChatApprovalMode = hasApprovalField ? approvalMode : "never";
  const summary = [
    modelLabel,
    reasoningEffort ? reasoningLabel(reasoningEffort) : text("기본 추론", "Default reasoning"),
    settingOptionLabel(fields, "mode", mode) ?? mode,
    ...(hasApprovalField ? [settingOptionLabel(fields, "approvalMode", approvalMode) ?? approvalMode] : []),
  ].join(" · ");
  const agentHandoffNote = agents.length > 0 && onAgentChange
    ? text("에이전트를 바꾸면 새 세션을 만들어 대화를 인계합니다. 원래 세션은 그대로 남습니다.", "Changing the agent creates a new session and hands the conversation over. The original session stays as is.")
    : null;
  const warning = mode === "fullAccess" && effectiveApprovalMode === "never"
    ? text("다음 요청부터 샌드박스 없이 실행됩니다.", "From the next request, runs without a sandbox.")
    : mode === "fullAccess"
      ? text("다음 요청부터 같은 대화를 전체 접근으로 다시 연결합니다.", "From the next request, reconnects this conversation with full access.")
      : effectiveApprovalMode === "never" && hasApprovalField
        ? text("승인 요청 없이 현재 권한 범위에서 실행합니다.", "Runs within the current permission scope without approval prompts.")
        : null;

  return (
    <div className="chat-runtime-settings-menu" ref={containerRef}>
      <div className="chat-runtime-settings-bar">
        {statusIndicator}
        <button
          className={`button compact session-runtime-settings-button${open ? " active" : ""}`}
          type="button"
          aria-label={text(`현재 ${contextLabel} 설정: ${summary}`, `Current ${contextLabel} settings: ${summary}`)}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            if (!open) onOpen?.();
            setOpen((current) => !current);
          }}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span>{summary}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {statusLabel}
        {contextMeter}
      </div>
      {open && <div className="session-runtime-settings-panel" id={panelId}>
        <div className="session-composer-settings" role="group" aria-label={text(`${contextLabel} 실행 설정`, `${contextLabel} run settings`)}>
          {/* 에이전트는 공급자가 달라져 세션 ID를 공유할 수 없다. 재개가 아니라 새 세션
              인계이므로 다른 항목과 문구를 다르게 쓴다. */}
          {agents.length > 0 && onAgentChange && <RuntimeSettingSelect
            className="session-agent-selector"
            title={text("에이전트를 바꾸면 새 세션을 만들어 지금까지의 대화를 인계합니다.", "Changing the agent creates a new session and hands over the conversation so far.")}
            label={text("에이전트", "Agent")}
            ariaLabel={text(`${contextLabel} 에이전트`, `${contextLabel} agent`)}
            value={source}
            disabled={planRestartDisabled}
            onChange={(value) => onAgentChange(value as ProviderId)}
          >
            {agents.map((choice) => <option value={choice.source} key={choice.source} disabled={choice.disabled} title={choice.disabledReason ?? undefined}>
              {choice.label}{choice.source === source ? text(" · 현재", " · current") : ""}{choice.disabled ? text(" · CLI 미연결", " · CLI not connected") : ""}
            </option>)}
          </RuntimeSettingSelect>}
          {accounts.length > 0 && onAccountChange && <RuntimeSettingSelect
            className="session-account-selector"
            title={text("실행 계정을 바꾸면 같은 대화를 선택한 계정으로 다시 연결합니다.", "Changing the account reconnects this conversation with the selected account.")}
            label={text("실행 계정", "Account")}
            ariaLabel={text(`${contextLabel} 실행 계정`, `${contextLabel} account`)}
            value={accountId ?? ""}
            disabled={planRestartDisabled}
            onChange={onAccountChange}
          >
            <option value="">{text("이어가기 설정에 따름", "Follow resume settings")}</option>
            {accounts.map((choice) => <option value={choice.id} key={choice.id} disabled={choice.blocked} title={choice.blockedReason ?? undefined}>
              {choice.label}{choice.blocked ? text(" · 자격증명 격리 불가", " · credential isolation unavailable") : ""}
            </option>)}
          </RuntimeSettingSelect>}
          <RuntimeSettingSelect
            className="session-model-selector"
            title={text("응답 모델을 바꾸면 같은 대화를 선택한 모델로 다시 연결합니다.", "Changing the model reconnects this conversation with the selected model.")}
            label={text("모델", "Model")}
            ariaLabel={text(`${contextLabel} 응답 모델`, `${contextLabel} model`)}
            value={model}
            disabled={locked}
            onChange={onModelChange}
          >
            <option value="">{text("공급자 기본", "Provider default")}</option>
            {model && !modelChoices.some((option) => option.model === model) && <option value={model}>{model}</option>}
            {modelChoices.map((option) => <option value={option.model} key={option.model}>{option.displayName}</option>)}
          </RuntimeSettingSelect>
          <RuntimeSettingSelect
            className="session-reasoning-selector"
            title={text("추론 수준을 바꾸면 같은 대화로 다시 연결합니다.", "Changing the reasoning level reconnects this conversation.")}
            label={text("추론 수준", "Reasoning")}
            ariaLabel={text(`${contextLabel} 추론 수준`, `${contextLabel} reasoning`)}
            value={reasoningEffort}
            disabled={locked}
            onChange={(value) => onReasoningEffortChange(value as ReasoningEffort | "")}
          >
            <option value="">{text("기본", "Default")}</option>
            {reasoningEffort && !reasoningOptions.some((option) => option.effort === reasoningEffort) && (
              <option value={reasoningEffort}>{reasoningLabel(reasoningEffort)}</option>
            )}
            {reasoningOptions.map((option) => <option value={option.effort} key={option.effort}>{reasoningLabel(option.effort)}</option>)}
          </RuntimeSettingSelect>
          <RuntimeSettingSelect
            title={text("요청 모드를 바꾸면 같은 대화를 선택한 권한 범위로 다시 연결합니다.", "Changing the request mode reconnects this conversation with the selected permission scope.")}
            label={text("요청 모드", "Request mode")}
            ariaLabel={text(`${contextLabel} 요청 모드`, `${contextLabel} request mode`)}
            value={mode}
            disabled={planRestartDisabled}
            onChange={(value) => onModeChange(value as ChatMode)}
          >
            {settingOptions(fields, "mode").map((option) => (
              <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
            ))}
          </RuntimeSettingSelect>
          {hasApprovalField && <RuntimeSettingSelect
            className="session-approval-selector"
            title={text("승인 처리를 바꾸면 같은 대화로 다시 연결합니다.", "Changing approval handling reconnects this conversation.")}
            label={text("승인 처리", "Approvals")}
            ariaLabel={text(`${contextLabel} 승인 처리`, `${contextLabel} approvals`)}
            value={approvalMode}
            disabled={locked}
            onChange={(value) => onApprovalModeChange(value as ChatApprovalMode)}
          >
            {approvalOptions.map((option) => (
              <option value={option.value} disabled={option.disabled} key={option.value}>
                {option.label}{option.disabled && option.detail ? ` · ${option.detail}` : ""}
              </option>
            ))}
          </RuntimeSettingSelect>}
          {extraFields.map((field) => <ExtraRuntimeSettingField
            field={field}
            value={draftExtraSettings[field.key] ?? ""}
            disabled={locked}
            modelChoices={field.key === "fallbackModel" ? modelChoices : undefined}
            onChange={(value) => setDraftExtraSettings((current) => ({ ...current, [field.key]: value }))}
            key={field.key}
          />)}
        </div>
        {planRestartNote && <small className="session-mode-hint">{planRestartNote}</small>}
        {agentHandoffNote && <small className="session-mode-hint">{agentHandoffNote}</small>}
        {approvalMode === "autoReview" && <small className="session-mode-hint">{text("Codex가 승인 요청의 위험도를 자동 검토하며 추가 사용량이 발생할 수 있습니다.", "Codex reviews the risk of each approval request automatically, which may use extra quota.")}</small>}
        {approvalMode === "granular" && <small className="session-mode-hint">{text("Codex가 승인 종류별 정책에 따라 직접 확인을 요청합니다.", "Codex asks you directly according to the per-approval-type policy.")}</small>}
        {approvalMode === "onFailure" && <small className="session-mode-hint">{text("Codex가 샌드박스 실행 실패 후 직접 확인을 요청합니다.", "Codex asks you directly after a sandboxed run fails.")}</small>}
        {extraFields.length > 0 && <div className="session-runtime-settings-actions">
          <small>{text("공급자가 제공한 추가 실행 설정입니다. 적용하면 다음 요청부터 같은 대화로 다시 연결합니다.", "Extra run settings provided by the provider. Applying them reconnects this conversation from the next request.")}</small>
          <button
            className="button compact"
            type="button"
            disabled={locked || sameSettings(runtimeExtraSettings, draftExtraSettings)}
            onClick={() => onExtraSettingsApply?.(cleanSettings(draftExtraSettings))}
          >{text("추가 설정 적용", "Apply extra settings")}</button>
        </div>}
      </div>}
      {warning && <small className="session-mode-warning" role="alert">{warning}</small>}
    </div>
  );
}

function ExtraRuntimeSettingField({ field, value, disabled, modelChoices, onChange }: {
  field: ChatSettingField;
  value: string;
  disabled: boolean;
  modelChoices?: ChatModelCatalogOption[];
  onChange: (value: string) => void;
}) {
  // 예비 모델처럼 자유 입력 스키마여도 모델 선택지가 주어지면 select로 고른다.
  const common = { className: "session-extra-setting-selector", title: field.detail ?? field.label, label: field.label, disabled, value, onChange } as const;
  const defaultOption = <option value="">공급자 기본{field.defaultValue ? ` · ${field.defaultValue}` : ""}</option>;
  if (modelChoices) {
    return <RuntimeSettingSelect {...common}>
      {defaultOption}
      {value && !modelChoices.some((option) => option.model === value) && <option value={value}>{value}</option>}
      {modelChoices.map((option) => <option value={option.model} key={option.model}>{option.displayName}</option>)}
    </RuntimeSettingSelect>;
  }
  if (field.kind === "enum") {
    return <RuntimeSettingSelect {...common}>
      {defaultOption}
      {field.options.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>
        {option.label}{option.detail ? ` · ${option.detail}` : ""}
      </option>)}
    </RuntimeSettingSelect>;
  }
  return <RuntimeSettingLabel className={common.className} title={common.title} label={common.label}>
    <input
      value={value}
      disabled={disabled}
      placeholder={field.detail ?? field.defaultValue ?? "공급자 기본"}
      onChange={(event) => onChange(event.target.value)}
    />
  </RuntimeSettingLabel>;
}

/** 실행 설정 항목의 공통 껍데기. 라벨 문구와 클래스만 다르고 구조는 모두 같다. */
function RuntimeSettingLabel({ className, title, label, children }: {
  className?: string;
  title: string;
  label: string;
  children: ReactNode;
}) {
  return <label className={`session-mode-selector${className ? ` ${className}` : ""}`} title={title}>
    <span>{label}</span>
    {children}
  </label>;
}

/** 선택 박스형 실행 설정 항목. 값 변환은 호출부가 onChange에서 맡는다. */
function RuntimeSettingSelect({ className, title, label, ariaLabel, value, disabled, onChange, children }: {
  className?: string;
  title: string;
  label: string;
  ariaLabel?: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return <RuntimeSettingLabel className={className} title={title} label={label}>
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  </RuntimeSettingLabel>;
}

function cleanSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim().length > 0));
}

function sameSettings(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(cleanSettings(left)).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(cleanSettings(right)).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}
